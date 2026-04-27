//! KEN-side local model inference. One-shot only — no streaming — which
//! matches the palette's single-answer UX.

use crate::{llm, models};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const DIRECT_SYSTEM_PROMPT: &str =
  "Answer directly. Keep it under 90 words unless the user asks for depth. Prefer short bullets. No preamble.";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAskRequest {
    pub prompt: String,
    /// Bare model id (e.g. "qwen2.5-1.5b"), not "local/qwen2.5-1.5b".
    pub model: String,
    #[serde(default)]
    pub history: Vec<HistoryTurn>,
}

#[derive(Debug, Deserialize)]
pub struct HistoryTurn {
    pub role: String, // "user" | "assistant"
    pub content: String,
}

#[derive(Debug, Serialize)]
pub struct LocalAskResponse {
    pub text: String,
    /// If the model file lived in another app's data dir, we surface the
    /// label ("oat" / "sumi") so the UI can show "shared from oat".
    pub source: String,
}

#[derive(Debug, Serialize)]
pub struct LocalModelListEntry {
    pub id: String,
    pub name: String,
    pub is_downloaded: bool,
    pub source: String,
}

#[tauri::command]
pub fn list_local_models(app: AppHandle) -> Result<Vec<LocalModelListEntry>, String> {
    let dir = own_models_dir(&app)?;
    Ok(models::list_models(&dir)
        .into_iter()
        .map(|m| LocalModelListEntry {
            id: m.id,
            name: m.name,
            is_downloaded: m.is_downloaded,
            source: m.source,
        })
        .collect())
}

#[tauri::command]
pub async fn ask_local_model(
    app: AppHandle,
    request: LocalAskRequest,
) -> Result<LocalAskResponse, String> {
    let prompt = request.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("Ask something first.".to_string());
    }

    let dir = own_models_dir(&app)?;
    eprintln!(
        "[ken local] request model={} own_dir={}",
        request.model,
        dir.display()
    );

    let meta = models::get_model(&dir, &request.model).ok_or_else(|| {
        eprintln!("[ken local] unknown model id: {}", request.model);
        format!("Unknown local model: {}", request.model)
    })?;

    if !meta.is_downloaded {
        eprintln!(
            "[ken local] not downloaded: filename={} looked in own dir + oat + sumi",
            meta.filename
        );
        return Err(format!(
      "{} is not downloaded. KEN looks in its own models dir and in Sumi's + Oat's dirs. Run `ls \"$HOME/Library/Application Support/com.bentopop.oat/models\"` to confirm the file is there, or download it from Sumi's Providers tab.",
      meta.name
    ));
    }

    let path = models::model_path(&dir, &request.model)
        .ok_or_else(|| format!("Model \"{}\" path unavailable.", request.model))?;

    eprintln!(
        "[ken local] resolved path={} source={}",
        path.display(),
        if meta.source.is_empty() {
            "ken"
        } else {
            &meta.source
        }
    );

    let formatted = format_prompt(
        &meta.template,
        DIRECT_SYSTEM_PROMPT,
        &request.history,
        &prompt,
    );
    let source = meta.source.clone();
    let started = std::time::Instant::now();

    let text = tokio::task::spawn_blocking(move || {
        llm::load_model(&path)?;
        llm::generate(&formatted, 320)
    })
    .await
    .map_err(|error| {
        eprintln!("[ken local] task join error: {error}");
        format!("Local task failed: {error}")
    })?
    .map_err(|error| {
        eprintln!("[ken local] llama error: {error}");
        error
    })?;

    eprintln!(
        "[ken local] ← {} chars in {:.2}s",
        text.chars().count(),
        started.elapsed().as_secs_f64()
    );

    Ok(LocalAskResponse {
        text: text.trim().to_string(),
        source,
    })
}

fn own_models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("models");
    let _ = std::fs::create_dir_all(&dir);
    Ok(dir)
}

fn format_prompt(template: &str, system: &str, history: &[HistoryTurn], user: &str) -> String {
    match template {
        "gemma" => {
            // Gemma has no system role — fold the system prompt into the first
            // user turn, same as Sumi.
            let mut out = String::new();
            let mut first_user_done = false;
            for turn in history {
                let role = if turn.role == "assistant" {
                    "model"
                } else {
                    "user"
                };
                let text = if role == "user" && !first_user_done && !system.is_empty() {
                    first_user_done = true;
                    format!("{}\n\n{}", system, turn.content)
                } else {
                    if role == "user" {
                        first_user_done = true;
                    }
                    turn.content.clone()
                };
                out.push_str(&format!("<start_of_turn>{}\n{}<end_of_turn>\n", role, text));
            }
            let user_text = if !first_user_done && !system.is_empty() {
                format!("{}\n\n{}", system, user)
            } else {
                user.to_string()
            };
            out.push_str(&format!(
                "<start_of_turn>user\n{}<end_of_turn>\n<start_of_turn>model\n",
                user_text
            ));
            out
        }
        _ => {
            let mut out = format!("<|im_start|>system\n{}<|im_end|>\n", system);
            for turn in history {
                let role = if turn.role == "assistant" {
                    "assistant"
                } else {
                    "user"
                };
                out.push_str(&format!(
                    "<|im_start|>{}\n{}<|im_end|>\n",
                    role, turn.content
                ));
            }
            out.push_str(&format!(
                "<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n",
                user
            ));
            out
        }
    }
}
