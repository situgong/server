use crate::{AppError, AppState};
use crate::wasm_engine::WasmEngine;
use isolang::Language;
use std::path::Path;
use std::sync::Arc;
use anyhow::{Context, Result};
use std::sync::atomic::{AtomicUsize, Ordering};

pub struct Translator {
    engines: Vec<WasmEngine>,
    next_worker: AtomicUsize,
}

impl Translator {
    pub async fn new(num_workers: usize) -> Result<Self> {
        let mut engines = Vec::new();
        let wasm_path = Path::new("wasm/bergamot-translator.wasm");
        let js_path = Path::new("wasm/bergamot-translator.js");

        for i in 0..num_workers {
            println!("Initializing worker {}", i);
            let engine = WasmEngine::new(wasm_path, js_path)
                .await
                .with_context(|| format!("Failed to initialize WASM engine worker {}", i))?;
            engines.push(engine);
        }

        Ok(Self { 
            engines,
            next_worker: AtomicUsize::new(0),
        })
    }

    pub async fn load_model(&self, language_pair: &str, model_dir: &Path) -> Result<()> {
        let from_code = &language_pair[0..2];
        let to_code = &language_pair[2..4];

        for (i, engine) in self.engines.iter().enumerate() {
            engine.load_model(from_code, to_code, model_dir)
                .await
                .with_context(|| format!("Failed to load model in worker {}", i))?;
        }
        Ok(())
    }

    pub fn is_supported(&self, _from: &str, _to: &str) -> Result<bool, AppError> {
        Ok(true)
    }

    pub async fn translate(&self, from: &str, to: &str, text: &str) -> Result<String, AppError> {
        if self.engines.is_empty() {
            return Err(AppError::TranslationError("No workers available".into()));
        }

        // Round-robin
        let index = self.next_worker.fetch_add(1, Ordering::Relaxed) % self.engines.len();
        let engine = &self.engines[index];

        engine.translate(text, from, to).await
            .map_err(|e| AppError::TranslationError(e.to_string()))
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

    // We removed is_supported check or made it always true. 
    // Ideally check against state.models
    let pair = (source_lang, target_lang);
    if !state.models.contains(&pair) {
         return Err(AppError::TranslationError(format!(
            "Translation from '{}' to '{}' is not supported (model not loaded)",
            from_code, to_code
        )));
    }

    let translated_text = state.translator.translate(from_code, to_code, text).await?;

    Ok((translated_text, from_code.to_string(), to_code.to_string()))
}
