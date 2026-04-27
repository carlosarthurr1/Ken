use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};

const DEFAULT_OLLAMA_URL: &str = "http://localhost:11434";
const DIRECT_SYSTEM_PROMPT: &str =
  "Answer directly. Keep it under 90 words unless the user asks for depth. Prefer short bullets. No preamble.";

#[derive(Default)]
pub struct OllamaPullCancels(Mutex<HashMap<String, Arc<AtomicBool>>>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaBaseRequest {
    #[serde(default)]
    pub base_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaPullRequest {
    #[serde(default)]
    pub base_url: Option<String>,
    pub model: String,
    #[serde(default)]
    pub pull_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaCancelPullRequest {
    pub pull_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaAskRequest {
    #[serde(default)]
    pub base_url: Option<String>,
    pub prompt: String,
    pub model: String,
    #[serde(default)]
    pub history: Vec<HistoryTurn>,
    #[serde(default)]
    pub images: Vec<InputImage>,
    #[serde(default)]
    pub search_context: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HistoryTurn {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputImage {
    pub base64: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModel {
    pub name: String,
    pub size: Option<u64>,
    pub modified_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaPullResponse {
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaPullProgress {
    pub pull_id: String,
    pub model: String,
    pub status: String,
    pub completed: Option<u64>,
    pub total: Option<u64>,
    pub done: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaAskResponse {
    pub text: String,
}

#[tauri::command]
pub async fn list_ollama_models(request: OllamaBaseRequest) -> Result<Vec<OllamaModel>, String> {
    let client = reqwest::Client::new();
    let response = client
        .get(api_url(request.base_url.as_deref(), "/api/tags"))
        .send()
        .await
        .map_err(ollama_connection_error)?;

    if !response.status().is_success() {
        return Err(read_status_error("Ollama model list failed", response).await);
    }

    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("Ollama returned an invalid model list: {error}"))?;

    let models = body
        .get("models")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let name = item
                        .get("model")
                        .or_else(|| item.get("name"))
                        .and_then(Value::as_str)?;
                    Some(OllamaModel {
                        name: name.to_string(),
                        size: item.get("size").and_then(Value::as_u64),
                        modified_at: item
                            .get("modified_at")
                            .and_then(Value::as_str)
                            .map(ToString::to_string),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(models)
}

#[tauri::command]
pub async fn pull_ollama_model(
    app: AppHandle,
    state: State<'_, OllamaPullCancels>,
    request: OllamaPullRequest,
) -> Result<OllamaPullResponse, String> {
    let model = request.model.trim().to_string();
    if model.is_empty() {
        return Err("Choose a model to download.".to_string());
    }

    let pull_id = request.pull_id.unwrap_or_else(default_pull_id);
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .0
        .lock()
        .map_err(|_| "Could not track Ollama download.".to_string())?
        .insert(pull_id.clone(), cancel.clone());

    let result = pull_ollama_model_streaming(
        app,
        request.base_url,
        model.clone(),
        pull_id.clone(),
        cancel,
    )
    .await;

    if let Ok(mut pulls) = state.0.lock() {
        pulls.remove(&pull_id);
    }

    result
}

async fn pull_ollama_model_streaming(
    app: AppHandle,
    base_url: Option<String>,
    model: String,
    pull_id: String,
    cancel: Arc<AtomicBool>,
) -> Result<OllamaPullResponse, String> {
    let client = reqwest::Client::new();
    let mut response = client
        .post(api_url(base_url.as_deref(), "/api/pull"))
        .json(&json!({
            "model": model,
            "stream": true
        }))
        .send()
        .await
        .map_err(ollama_connection_error)?;

    if !response.status().is_success() {
        return Err(read_status_error("Ollama model download failed", response).await);
    }

    emit_pull_progress(
        &app,
        OllamaPullProgress {
            pull_id: pull_id.clone(),
            model: model.clone(),
            status: "Starting download".to_string(),
            completed: None,
            total: None,
            done: false,
        },
    );

    let mut buffer = String::new();
    let mut final_status = "success".to_string();

    loop {
        if cancel.load(Ordering::Relaxed) {
            let status = "Canceled".to_string();
            emit_pull_progress(
                &app,
                OllamaPullProgress {
                    pull_id,
                    model,
                    status: status.clone(),
                    completed: None,
                    total: None,
                    done: true,
                },
            );
            return Err("Model download canceled.".to_string());
        }

        let chunk = tokio::select! {
            chunk = response.chunk() => chunk.map_err(|error| format!("Ollama model download failed: {error}"))?,
            _ = tokio::time::sleep(Duration::from_millis(150)) => continue,
        };

        let Some(chunk) = chunk else {
            break;
        };

        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(newline) = buffer.find('\n') {
            let line = buffer[..newline].trim().to_string();
            buffer.drain(..=newline);
            if line.is_empty() {
                continue;
            }
            if let Some(status) = emit_pull_line(&app, &pull_id, &model, &line)? {
                final_status = status;
            }
        }
    }

    let remaining = buffer.trim();
    if !remaining.is_empty() {
        if let Some(status) = emit_pull_line(&app, &pull_id, &model, remaining)? {
            final_status = status;
        }
    }

    Ok(OllamaPullResponse {
        status: final_status,
    })
}

#[tauri::command]
pub fn cancel_ollama_pull(
    state: State<'_, OllamaPullCancels>,
    request: OllamaCancelPullRequest,
) -> Result<(), String> {
    let pulls = state
        .0
        .lock()
        .map_err(|_| "Could not cancel Ollama download.".to_string())?;
    let Some(cancel) = pulls.get(&request.pull_id) else {
        return Err("No active Ollama download found.".to_string());
    };
    cancel.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn open_ollama_models_folder() -> Result<String, String> {
    let dir = ollama_models_dir()?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create Ollama models folder: {error}"))?;
    open_path(&dir)?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn ask_ollama_model(request: OllamaAskRequest) -> Result<OllamaAskResponse, String> {
    let prompt = request.prompt.trim();
    if prompt.is_empty() && request.images.is_empty() {
        return Err("Ask something first.".to_string());
    }

    let model = request.model.trim();
    if model.is_empty() {
        return Err("Choose a local model.".to_string());
    }

    let mut messages = Vec::with_capacity(request.history.len() + 2);
    messages.push(json!({
        "role": "system",
        "content": DIRECT_SYSTEM_PROMPT
    }));

    for turn in &request.history {
        let role = if turn.role == "assistant" {
            "assistant"
        } else {
            "user"
        };
        messages.push(json!({
            "role": role,
            "content": turn.content
        }));
    }

    let mut user_content = prompt.to_string();
    if let Some(context) = request
        .search_context
        .as_deref()
        .map(str::trim)
        .filter(|context| !context.is_empty())
    {
        user_content = format!(
            "Use these web search results as context. Cite sources by number when relevant.\n\n{}\n\nUser question: {}",
            context,
            if user_content.is_empty() {
                "Describe the attached image."
            } else {
                &user_content
            }
        );
    } else if user_content.is_empty() {
        user_content = "Describe the attached image.".to_string();
    }

    let mut user_message = json!({
        "role": "user",
        "content": user_content
    });
    if !request.images.is_empty() {
        user_message["images"] = json!(request
            .images
            .iter()
            .map(|image| image.base64.trim())
            .filter(|image| !image.is_empty())
            .collect::<Vec<_>>());
    }
    messages.push(user_message);

    let client = reqwest::Client::new();
    let response = client
        .post(api_url(request.base_url.as_deref(), "/api/chat"))
        .json(&json!({
            "model": model,
            "messages": messages,
            "stream": false,
            "options": {
                "num_predict": 512
            }
        }))
        .send()
        .await
        .map_err(ollama_connection_error)?;

    if !response.status().is_success() {
        return Err(read_status_error("Ollama request failed", response).await);
    }

    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("Ollama returned invalid JSON: {error}"))?;
    let text = body
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();

    Ok(OllamaAskResponse { text })
}

fn emit_pull_line(
    app: &AppHandle,
    pull_id: &str,
    model: &str,
    line: &str,
) -> Result<Option<String>, String> {
    let value: Value = serde_json::from_str(line)
        .map_err(|error| format!("Ollama returned invalid download progress: {error}"))?;
    let status = value
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("Downloading")
        .to_string();
    let done = status.eq_ignore_ascii_case("success");
    let progress = OllamaPullProgress {
        pull_id: pull_id.to_string(),
        model: model.to_string(),
        status: status.clone(),
        completed: value.get("completed").and_then(Value::as_u64),
        total: value.get("total").and_then(Value::as_u64),
        done,
    };
    emit_pull_progress(app, progress);
    Ok(Some(status))
}

fn emit_pull_progress(app: &AppHandle, progress: OllamaPullProgress) {
    let _ = app.emit("ollama-pull-progress", progress);
}

fn default_pull_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("pull-{millis}")
}

fn ollama_models_dir() -> Result<PathBuf, String> {
    if let Ok(custom) = std::env::var("OLLAMA_MODELS") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    #[cfg(target_os = "linux")]
    {
        let standard = PathBuf::from("/usr/share/ollama/.ollama/models");
        if standard.exists() {
            return Ok(standard);
        }
    }

    let home = dirs::home_dir().ok_or_else(|| "Could not locate the home folder.".to_string())?;
    Ok(home.join(".ollama").join("models"))
}

#[cfg(target_os = "macos")]
fn open_path(path: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(path)
        .spawn()
        .map_err(|error| format!("Could not open Ollama models folder: {error}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn open_path(path: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(path)
        .spawn()
        .map_err(|error| format!("Could not open Ollama models folder: {error}"))?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_path(path: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map_err(|error| format!("Could not open Ollama models folder: {error}"))?;
    Ok(())
}

fn api_url(base_url: Option<&str>, path: &str) -> String {
    let base = base_url
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .unwrap_or(DEFAULT_OLLAMA_URL)
        .trim_end_matches('/');
    format!("{base}{path}")
}

fn ollama_connection_error(error: reqwest::Error) -> String {
    if error.is_connect() {
        "Ollama is not running. Start Ollama, then try the local model again.".to_string()
    } else {
        format!("Ollama request failed: {error}")
    }
}

async fn read_status_error(prefix: &str, response: reqwest::Response) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let message = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| body.trim().to_string());

    if status == StatusCode::NOT_FOUND && message.is_empty() {
        format!("{prefix}: model not found.")
    } else if message.is_empty() {
        format!("{prefix}: {status}")
    } else {
        format!("{prefix}: {message}")
    }
}
