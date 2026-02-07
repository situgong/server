use anyhow::Context;
use axum::{
    Router,
    extract::Json,
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use isolang::Language;
use crate::translation::Translator;
use std::{fs, io, net::SocketAddr, path::PathBuf, sync::Arc};
use tokio::{net::TcpListener, signal};
use tower_http::{
    cors::{
        AllowCredentials, AllowHeaders, AllowMethods, AllowOrigin, AllowPrivateNetwork, CorsLayer,
    },
    trace::TraceLayer,
};
use tracing::{debug, info, warn};

mod endpoint;
// Removed wasm_engine module - now using Node.js sidecar
mod translation;

const ENV_MODELS_PATH: &str = "MODELS_DIR";
const ENV_NUM_WORKERS: &str = "NUM_WORKERS";
const ENV_SERVER_IP: &str = "IP";
const ENV_SERVER_PORT: &str = "PORT";
const ENV_API_KEY: &str = "API_KEY";
const ENV_LOG_LEVEL: &str = "RUST_LOG";
const ENV_WORKER_PORT: &str = "WORKER_PORT";

#[derive(Debug, thiserror::Error)]
enum AppError {
    #[error("Translation error: {0}")]
    TranslationError(String),

    #[error("IO error: {0}")]
    IoError(#[from] io::Error),

    #[error("Unauthorized")]
    Unauthorized,

    #[error("Configuration error: {0}")]
    ConfigError(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            AppError::TranslationError(msg) => (StatusCode::BAD_REQUEST, msg),
            AppError::IoError(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            AppError::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "Invalid or missing API key".to_string(),
            ),
            AppError::ConfigError(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg),
        };

        (status, Json(serde_json::json!({ "error": message }))).into_response()
    }
}

impl From<anyhow::Error> for AppError {
    fn from(err: anyhow::Error) -> Self {
        AppError::TranslationError(err.to_string())
    }
}

struct AppState {
    translator: Translator,
    models: Vec<(Language, Language)>,
}

async fn auth_middleware(
    headers: HeaderMap,
    request: axum::extract::Request,
    next: Next,
) -> Result<Response, AppError> {
    let expected_key = std::env::var(ENV_API_KEY).unwrap_or_default();

    if !expected_key.is_empty() {
        let header_key = headers
            .get("Authorization")
            .and_then(|header| header.to_str().ok())
            .and_then(|auth| auth.strip_prefix("Bearer "));

        let query_key = request.uri().query().and_then(|query| {
            query.split('&').find_map(|pair| {
                let mut parts = pair.split('=');
                if let Some("token") = parts.next() {
                    parts.next()
                } else {
                    None
                }
            })
        });

        if header_key != Some(&expected_key) && query_key != Some(&expected_key) {
            debug!("Invalid API key");
            return Err(AppError::Unauthorized);
        }
    }
    Ok(next.run(request).await)
}

async fn load_models_manually(
    translator: &Translator,
    models_dir: &PathBuf,
) -> Result<Vec<(Language, Language)>, AppError> {
    let mut models = Vec::new();

    for entry in fs::read_dir(models_dir)? {
        let entry = entry?;
        let model_dir_path = entry.path();
        let language_pair = entry.file_name().to_string_lossy().into_owned();

        info!("Looking for models in {}", model_dir_path.display());
        translator.load_model(&language_pair, &model_dir_path).await?;

        if language_pair.len() >= 4 {
            let from_lang = translation::parse_language_code(&language_pair[0..2])?;
            let to_lang = translation::parse_language_code(&language_pair[2..4])?;
            models.push((from_lang, to_lang));
        } else {
            return Err(AppError::ConfigError(format!(
                "Invalid language pair format: '{}'. Expected format like 'enzh', 'jpen'",
                language_pair
            )));
        }

        info!("Loaded model for language pair '{}'", language_pair);
    }

    Ok(models)
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {
            info!("Received Ctrl+C, shutting down gracefully...");
        },
        _ = terminate => {
            info!("Received SIGTERM, shutting down gracefully...");
        },
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::var(ENV_LOG_LEVEL).is_err() {
        tracing_subscriber::fmt()
            .with_max_level(tracing::Level::INFO)
            .init();
    } else {
        tracing_subscriber::fmt::init();
    }

    let models_dir = std::env::var(ENV_MODELS_PATH)
        .map(PathBuf::from)
        .context(format!(
            "Failed to get environment variable {}",
            ENV_MODELS_PATH
        ))
        .unwrap_or_else(|_| {
            let default_dir = PathBuf::from("models");
            if !default_dir.exists() {
                fs::create_dir_all(&default_dir)
                    .expect("Failed to create default models directory");
            }
            default_dir
        });

    let num_workers = std::env::var(ENV_NUM_WORKERS)
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(1);

    let server_ip = std::env::var(ENV_SERVER_IP).unwrap_or_else(|_| "127.0.0.1".to_string());
    let server_port = std::env::var(ENV_SERVER_PORT)
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(3000);

    let worker_port = std::env::var(ENV_WORKER_PORT)
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(3001);

    // Start Node.js WASM worker as a child process
    // Look for wasm-worker.js relative to current working directory (project root)
    let current_dir = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));

    // Check for wasm-worker.js in the project root
    let wasm_worker_path = current_dir.join("wasm-worker.js");

    let worker_child = if wasm_worker_path.exists() {
        info!("Starting WASM worker from: {}", wasm_worker_path.display());

        // Also set WASM_PATH and MODEL_DIR to point to project directories
        let wasm_dir = current_dir.join("wasm");
        let models_path = models_dir.to_string_lossy().to_string();

        let child = tokio::process::Command::new("node")
            .arg(wasm_worker_path.display().to_string())
            .env("WORKER_PORT", worker_port.to_string())
            .env("MODEL_DIR", models_path)
            .env("WASM_PATH", wasm_dir.join("bergamot-translator.wasm").display().to_string())
            .env("JS_PATH", wasm_dir.join("bergamot-translator.js").display().to_string())
            .kill_on_drop(true)
            .spawn()
            .context("Failed to spawn WASM worker")?;
        Some(child)
    } else {
        warn!("wasm-worker.js not found at {}, translation may fail", wasm_worker_path.display());
        None
    };

    // Give the worker a moment to start
    tokio::time::sleep(std::time::Duration::from_millis(2000)).await;

    let server_address = format!("{}:{}", server_ip, server_port);

    info!("Initializing translator with {} workers (worker port: {})", num_workers, worker_port);
    let translator = translation::Translator::new(num_workers, worker_port).await.context("Failed to initialize translator")?;

    info!("Loading translation models from {}", models_dir.display());
    let models = load_models_manually(&translator, &models_dir)
        .await
        .context("Failed to load translation models")?;

    let app_state = Arc::new(AppState { translator, models });

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::mirror_request())
        .allow_credentials(AllowCredentials::yes())
        .allow_methods(AllowMethods::mirror_request())
        .allow_headers(AllowHeaders::mirror_request())
        .allow_private_network(AllowPrivateNetwork::yes());

    let app = Router::new()
        .route("/translate", post(endpoint::translate))
        .route("/kiss", post(endpoint::translate_kiss))
        .route("/imme", post(endpoint::translate_immersive))
        .route("/hcfy", post(endpoint::translate_hcfy))
        .route("/deeplx", post(endpoint::translate_deeplx))
        .route("/detect", post(endpoint::detect_language))
        .route(
            "/health",
            get(async || {
                Json(serde_json::json!({
                    "status": "ok",
                }))
            }),
        )
        .route_layer(middleware::from_fn(auth_middleware))
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .with_state(app_state);

    let addr: SocketAddr = server_address.parse().context(format!(
        "Failed to parse server address: {}",
        server_address
    ))?;
    info!(
        "Starting server on {} (IP: {}, Port: {})",
        addr, server_ip, server_port
    );
    let listener = TcpListener::bind(addr)
        .await
        .context(format!("Failed to bind to address: {}", addr))?;

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("Server error")?;

    info!("Server has been shut down gracefully");
    Ok(())
}
