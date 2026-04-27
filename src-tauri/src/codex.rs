use std::{env, fs, path::PathBuf};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CODEX_URL: &str = "https://chatgpt.com/backend-api/codex/responses";
const DIRECT_SYSTEM_PROMPT: &str =
  "Answer directly. Keep it under 90 words unless the user asks for depth. Prefer short bullets. No preamble.";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAskRequest {
    pub prompt: String,
    pub model: String,
    #[serde(default)]
    pub web_search: bool,
    #[serde(default)]
    pub image_generation: bool,
    #[serde(default)]
    pub history: Vec<HistoryTurn>,
    #[serde(default)]
    pub images: Vec<InputImage>,
}

#[derive(Debug, Deserialize)]
pub struct HistoryTurn {
    pub role: String, // "user" | "assistant"
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputImage {
    pub data_url: String,
}

#[derive(Debug, Serialize)]
pub struct CodexAskResponse {
    pub text: String,
    pub images: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct CodexAuthStatus {
    pub signed_in: bool,
    pub email: Option<String>,
    pub path: String,
}

#[tauri::command]
pub fn codex_auth_status() -> CodexAuthStatus {
    let path = match codex_auth_path() {
        Ok(p) => p,
        Err(_) => {
            return CodexAuthStatus {
                signed_in: false,
                email: None,
                path: String::new(),
            };
        }
    };
    let display_path = path.display().to_string();

    let Ok(raw) = fs::read_to_string(&path) else {
        return CodexAuthStatus {
            signed_in: false,
            email: None,
            path: display_path,
        };
    };

    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return CodexAuthStatus {
            signed_in: false,
            email: None,
            path: display_path,
        };
    };
    let tokens_value = value.get("tokens").cloned().unwrap_or(value);
    let tokens: CodexTokens = match serde_json::from_value(tokens_value) {
        Ok(t) => t,
        Err(_) => {
            return CodexAuthStatus {
                signed_in: false,
                email: None,
                path: display_path,
            };
        }
    };

    let signed_in = tokens
        .access_token
        .as_deref()
        .map(|t| !t.is_empty())
        .unwrap_or(false);
    let email = tokens.id_token.as_deref().and_then(decode_email);

    CodexAuthStatus {
        signed_in,
        email,
        path: display_path,
    }
}

#[tauri::command]
pub fn codex_login() -> Result<(), String> {
    // Open a Terminal window running `codex login`. The CLI handles the OAuth
    // browser flow itself and writes ~/.codex/auth.json on completion. Using
    // Terminal (vs spawning codex directly from Tauri) gives us the user's
    // login-shell PATH, which reliably resolves Homebrew / npm installs.
    #[cfg(target_os = "macos")]
    {
        let script = "tell application \"Terminal\"\n\
                  activate\n\
                  do script \"codex login\"\n\
                  end tell";
        std::process::Command::new("osascript")
            .arg("-e")
            .arg(script)
            .spawn()
            .map_err(|error| format!("Could not open Terminal: {error}"))?;
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Codex login from the UI is only wired on macOS right now.".to_string())
    }
}

#[tauri::command]
pub fn codex_logout() -> Result<(), String> {
    let path = codex_auth_path()?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|error| format!("Could not remove {}: {error}", path.display()))?;
    }
    Ok(())
}

fn decode_email(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let value: Value = serde_json::from_slice(&decoded).ok()?;
    value
        .get("email")
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct CodexTokens {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default)]
    account_id: Option<String>,
    #[serde(default)]
    expires_at: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct RefreshResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
}

#[tauri::command]
pub async fn ask_codex_subscription(request: CodexAskRequest) -> Result<CodexAskResponse, String> {
    let prompt = request.prompt.trim();
    if prompt.is_empty() && request.images.is_empty() {
        return Err("Ask something first.".to_string());
    }

    let client = reqwest::Client::new();
    let mut tokens = read_codex_tokens()?;

    if tokens
        .refresh_token
        .as_deref()
        .is_some_and(|token| !token.is_empty())
    {
        if let Ok(refreshed) = refresh_codex_tokens(&client, &tokens).await {
            tokens = refreshed;
        }
    }

    let access_token = tokens
        .access_token
        .as_deref()
        .filter(|token| !token.is_empty())
        .ok_or_else(|| {
            "Codex auth is missing an access token. Run `codex login` first.".to_string()
        })?;
    let account_id = tokens
        .account_id
        .clone()
        .or_else(|| tokens.id_token.as_deref().and_then(decode_account_id))
        .ok_or_else(|| {
            "Codex auth is missing `chatgpt-account-id`. Run `codex login` again.".to_string()
        })?;

    let mut input = Vec::with_capacity(request.history.len() + 1);
    for turn in &request.history {
        let part_type = if turn.role == "assistant" {
            "output_text"
        } else {
            "input_text"
        };
        input.push(json!({
          "role": turn.role,
          "content": [
            { "type": part_type, "text": turn.content }
          ]
        }));
    }
    let user_text = if prompt.is_empty() && !request.images.is_empty() {
        "Describe the attached image."
    } else {
        prompt
    };
    let mut user_content = vec![json!({ "type": "input_text", "text": user_text })];
    for image in &request.images {
        if !image.data_url.trim().is_empty() {
            user_content.push(json!({
                "type": "input_image",
                "image_url": image.data_url
            }));
        }
    }

    input.push(json!({
      "role": "user",
      "content": user_content
    }));

    let mut body = json!({
      "model": request.model,
      "store": false,
      "stream": true,
      "instructions": DIRECT_SYSTEM_PROMPT,
      "input": input,
      "text": { "verbosity": "low" },
      "include": ["reasoning.encrypted_content"],
      "tool_choice": "auto",
      "parallel_tool_calls": true
    });

    // The Codex backend accepts "web_search" (NOT "web_search_preview" — that
    // tool name errors on chatgpt.com backend). The `image_generation` tool is
    // gated to ChatGPT auth server-side, and uses gpt-image-2 billed against
    // the ChatGPT plan. See openai/codex codex-rs/tools/src/tool_spec.rs.
    let mut tools = Vec::new();
    if request.web_search {
        tools.push(json!({ "type": "web_search" }));
    }
    if request.image_generation {
        tools.push(json!({ "type": "image_generation" }));
    }
    if !tools.is_empty() {
        body["tools"] = json!(tools);
    }

    let response = client
        .post(CODEX_URL)
        .headers(codex_headers(access_token, &account_id)?)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("ChatGPT request failed: {error}"))?;

    let status = response.status();
    let response_text = response
        .text()
        .await
        .map_err(|error| format!("ChatGPT response read failed: {error}"))?;

    if !status.is_success() {
        return Err(normalize_codex_error(status.as_u16(), &response_text));
    }

    let text = parse_codex_text(&response_text);
    let images = parse_codex_images(&response_text);
    if text.trim().is_empty() && images.is_empty() {
        return Err("ChatGPT returned an empty response.".to_string());
    }

    Ok(CodexAskResponse { text, images })
}

fn parse_codex_images(body: &str) -> Vec<String> {
    let mut images: Vec<String> = Vec::new();

    if let Ok(value) = serde_json::from_str::<Value>(body) {
        collect_images(&value, &mut images);
    }

    for block in body.split("\n\n") {
        for line in block.lines() {
            let Some(data) = line.trim().strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<Value>(data) {
                collect_images(&value, &mut images);
            }
        }
    }

    let mut seen = std::collections::HashSet::new();
    images.retain(|img| seen.insert(img.clone()));
    images
}

fn collect_images(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            if matches!(
                map.get("type").and_then(Value::as_str),
                Some("image_generation_call")
            ) {
                if let Some(result) = map.get("result").and_then(Value::as_str) {
                    if !result.is_empty() && result.len() > 100 {
                        out.push(result.to_string());
                    }
                }
            }
            for v in map.values() {
                collect_images(v, out);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_images(item, out);
            }
        }
        _ => {}
    }
}

fn read_codex_tokens() -> Result<CodexTokens, String> {
    let path = codex_auth_path()?;
    let raw = fs::read_to_string(&path).map_err(|_| {
        format!(
            "No Codex auth found at {}. Run `codex login` first.",
            path.display()
        )
    })?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("Codex auth JSON is invalid: {error}"))?;
    let token_value = value.get("tokens").cloned().unwrap_or(value);

    serde_json::from_value(token_value)
        .map_err(|error| format!("Codex auth shape is invalid: {error}"))
}

fn codex_auth_path() -> Result<PathBuf, String> {
    if let Some(home) = env::var_os("CODEX_HOME") {
        return Ok(PathBuf::from(home).join("auth.json"));
    }

    env::var_os("HOME")
        .map(|home| PathBuf::from(home).join(".codex").join("auth.json"))
        .ok_or_else(|| "HOME is not set; cannot locate Codex auth.".to_string())
}

async fn refresh_codex_tokens(
    client: &reqwest::Client,
    current: &CodexTokens,
) -> Result<CodexTokens, String> {
    let refresh_token = current
        .refresh_token
        .as_deref()
        .ok_or_else(|| "No Codex refresh token available.".to_string())?;

    let response = client
        .post(OAUTH_TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", CODEX_CLIENT_ID),
            ("refresh_token", refresh_token),
        ])
        .send()
        .await
        .map_err(|error| format!("Codex token refresh failed: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Codex token refresh failed with {}",
            response.status()
        ));
    }

    let refreshed: RefreshResponse = response
        .json()
        .await
        .map_err(|error| format!("Codex token refresh response was invalid: {error}"))?;

    Ok(CodexTokens {
        access_token: Some(refreshed.access_token),
        refresh_token: refreshed
            .refresh_token
            .or_else(|| current.refresh_token.clone()),
        id_token: refreshed.id_token.or_else(|| current.id_token.clone()),
        account_id: current.account_id.clone(),
        expires_at: refreshed
            .expires_in
            .map(|expires_in| now_ms() + expires_in * 1000),
    })
}

fn codex_headers(access_token: &str, account_id: &str) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {access_token}"))
            .map_err(|error| format!("Invalid Codex access token: {error}"))?,
    );
    headers.insert(
        "chatgpt-account-id",
        HeaderValue::from_str(account_id)
            .map_err(|error| format!("Invalid ChatGPT account id: {error}"))?,
    );
    headers.insert(
        "OpenAI-Beta",
        HeaderValue::from_static("responses=experimental"),
    );
    headers.insert("originator", HeaderValue::from_static("ken"));
    headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        USER_AGENT,
        HeaderValue::from_str(&format!(
            "KEN/{} ({}; {})",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH
        ))
        .map_err(|error| format!("Invalid user agent: {error}"))?,
    );
    Ok(headers)
}

fn parse_codex_text(body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        return extract_output_text(&value);
    }

    let mut text = String::new();
    for block in body.split("\n\n") {
        for line in block.lines() {
            let Some(data) = line.trim().strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data == "[DONE]" || data.is_empty() {
                continue;
            }

            let Ok(value) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            match value.get("type").and_then(Value::as_str) {
                Some("response.output_text.delta") => {
                    if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                        text.push_str(delta);
                    }
                }
                Some("response.completed") | Some("response.done") if text.trim().is_empty() => {
                    text.push_str(&extract_output_text(&value));
                }
                _ => {}
            }
        }
    }

    text.trim().to_string()
}

fn extract_output_text(value: &Value) -> String {
    if let Some(text) = value.get("output_text").and_then(Value::as_str) {
        return text.trim().to_string();
    }

    let mut pieces = Vec::new();
    collect_text(value, &mut pieces);
    pieces.join("\n").trim().to_string()
}

fn collect_text(value: &Value, pieces: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            if matches!(
                map.get("type").and_then(Value::as_str),
                Some("output_text" | "text")
            ) {
                if let Some(text) = map.get("text").and_then(Value::as_str) {
                    pieces.push(text.to_string());
                    return;
                }
            }
            for value in map.values() {
                collect_text(value, pieces);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_text(item, pieces);
            }
        }
        _ => {}
    }
}

fn decode_account_id(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let value: Value = serde_json::from_slice(&decoded).ok()?;

    value
        .get("https://api.openai.com/auth")
        .and_then(|auth| auth.get("chatgpt_account_id"))
        .and_then(Value::as_str)
        .or_else(|| value.get("account_id").and_then(Value::as_str))
        .map(ToString::to_string)
}

fn normalize_codex_error(status: u16, body: &str) -> String {
    if body.contains("<html") || body.contains("<!DOCTYPE html") {
        return "ChatGPT rejected the Codex request with an HTML challenge. This usually means a required Codex header was rejected; run `codex login` again and retry.".to_string();
    }

    if status == 429 && body.contains("usage") {
        return "Your ChatGPT subscription usage limit was reached. Try again after the reset window.".to_string();
    }

    if let Ok(value) = serde_json::from_str::<Value>(body) {
        if let Some(message) = value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .or_else(|| value.get("message").and_then(Value::as_str))
            .or_else(|| value.get("detail").and_then(Value::as_str))
        {
            return format!("ChatGPT request failed ({status}): {message}");
        }
    }

    format!("ChatGPT request failed ({status}): {}", truncate(body, 500))
}

fn truncate(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_string();
    }
    format!("{}...", &value[..max])
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
