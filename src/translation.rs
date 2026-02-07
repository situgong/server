use crate::{AppError, AppState};
use isolang::Language;
use std::path::Path;
use std::sync::Arc;
use anyhow::{Context, Result};
use std::sync::atomic::{AtomicUsize, Ordering};
use reqwest;
use tokio::sync::Mutex;
use std::collections::HashMap;

pub struct Translator {
    worker_url: String,
    client: reqwest::Client,
    // Cache for loaded models
    loaded_models: Mutex<HashMap<String, bool>>,
    next_worker: AtomicUsize,
}

impl Translator {
    pub async fn new(num_workers: usize, worker_port: u16) -> Result<Self> {
        let worker_url = format!("http://127.0.0.1:{}", worker_port);

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .context("Failed to create HTTP client")?;

        // Pre-warm: check if worker is available
        let health_url = format!("{}/health", worker_url);
        for i in 0..30 {
            match client.get(&health_url).send().await {
                Ok(resp) => {
                    if resp.status() == reqwest::StatusCode::OK {
                        println!("[Translator] Worker connected at {}", worker_url);
                        break;
                    }
                }
                Err(_) => {}
            }
            if i == 29 {
                return Err(anyhow::anyhow!(
                    "Worker at {} did not respond after 30s",
                    worker_url
                ));
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }

        Ok(Self {
            worker_url,
            client,
            loaded_models: Mutex::new(HashMap::new()),
            next_worker: AtomicUsize::new(0),
        })
    }

    pub async fn load_model(&self, language_pair: &str, model_dir: &Path) -> Result<()> {
        let from_code = &language_pair[0..2];
        let to_code = &language_pair[2..4];

        // Check if already loaded
        {
            let loaded = self.loaded_models.lock().await;
            if loaded.contains_key(language_pair) {
                return Ok(());
            }
        }

        let url = format!("{}/load-model", self.worker_url);
        let response = self.client
            .post(&url)
            .json(&serde_json::json!({
                "from": from_code,
                "to": to_code,
                "modelDir": model_dir.to_string_lossy()
            }))
            .send()
            .await
            .context("Failed to send load model request")?;

        if !response.status().is_success() {
            let error = response.text().await.unwrap_or_else(|_| "Unknown error".to_string());
            return Err(anyhow::anyhow!("Failed to load model: {}", error));
        }

        let mut loaded = self.loaded_models.lock().await;
        loaded.insert(language_pair.to_string(), true);

        println!("[Translator] Loaded model: {}", language_pair);
        Ok(())
    }

    pub fn is_supported(&self, _from: &str, _to: &str) -> Result<bool, AppError> {
        Ok(true)
    }

    pub async fn translate(&self, from: &str, to: &str, text: &str) -> Result<String, AppError> {
        let url = format!("{}/translate", self.worker_url);

        let response = self.client
            .post(&url)
            .json(&serde_json::json!({
                "text": text,
                "from": from,
                "to": to
            }))
            .send()
            .await
            .context("Failed to send translation request")?;

        if !response.status().is_success() {
            let error = response.text().await.unwrap_or_else(|_| "Unknown error".to_string());
            return Err(AppError::TranslationError(format!("Translation failed: {}", error)));
        }

        let result: serde_json::Value = response.json().await
            .context("Failed to parse translation response")?;

        result["text"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| AppError::TranslationError("Invalid response format".to_string()))
    }
}

// Helpers from original translation.rs
pub fn parse_language_code(code: &str) -> Result<Language, AppError> {
    Language::from_639_1(code.split('-').next().unwrap_or(code)).ok_or_else(|| {
        AppError::TranslationError(format!(
            "Invalid language code: '{}'. Please use ISO 639-1 format.",
            code
        ))
    })
}

fn get_iso_code(lang: &Language) -> Result<&'static str, AppError> {
    if lang.to_639_3() == "cmn" {
        return Ok("zh");
    }
    lang.to_639_1().ok_or_else(|| {
        AppError::TranslationError(format!(
            "Language '{}' doesn't have an ISO 639-1 code",
            lang
        ))
    })
}

pub fn detect_language_code(text: &str) -> Result<&'static str, AppError> {
    get_iso_code(
        &Language::from_639_3(whichlang::detect_language(text).three_letter_code()).ok_or_else(
            || {
                AppError::TranslationError(format!(
                    "Failed to identify language for text: '{}'",
                    text
                ))
            },
        )?,
    )
}

pub async fn perform_translation(
    state: &Arc<AppState>,
    text: &str,
    from_lang: Option<String>,
    to_lang: &str,
) -> Result<(String, String, String), AppError> {
    let source_lang = match from_lang.as_deref() {
        None | Some("") | Some("auto") => {
            if state.models.len() == 1 {
                state.models.first().map(|model| model.0).unwrap_or(Language::Eng)
            } else {
                Language::from_639_3(whichlang::detect_language(text).three_letter_code())
                    .ok_or_else(|| {
                        AppError::TranslationError(format!(
                            "Failed to detect language for text: '{}'",
                            text
                        ))
                    })?
            }
        }
        Some(code) => parse_language_code(code)?,
    };

    let target_lang = parse_language_code(to_lang)?;

    let from_code = get_iso_code(&source_lang)?;
    let to_code = get_iso_code(&target_lang)?;

    if from_code == to_code {
        return Ok((text.to_string(), from_code.to_string(), to_code.to_string()));
    }

    let pair = (source_lang, target_lang);
    if !state.models.contains(&pair) {
         return Err(AppError::TranslationError(format!(
            "Translation from '{}' to '{}' is not supported (model not loaded)",
            from_code, to_code
        )));
    }

    let translated_text = state.translator.translate(from_code, to_code, text).await
        .map_err(|e| AppError::TranslationError(e.to_string()))?;

    Ok((translated_text, from_code.to_string(), to_code.to_string()))
}