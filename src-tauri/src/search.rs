use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub provider: String,
    pub query: String,
    pub api_key: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
pub struct SearchResponse {
    pub results: Vec<SearchResult>,
}

#[tauri::command]
pub async fn search_web(request: SearchRequest) -> Result<SearchResponse, String> {
    let query = request.query.trim();
    if query.is_empty() {
        return Ok(SearchResponse {
            results: Vec::new(),
        });
    }

    let api_key = request.api_key.trim();
    if api_key.is_empty() {
        return Err(format!(
            "Add a {} API key in settings.",
            provider_label(&request.provider)
        ));
    }

    let results = match request.provider.as_str() {
        "brave" => search_brave(query, api_key).await?,
        _ => search_tavily(query, api_key).await?,
    };

    Ok(SearchResponse {
        results: results.into_iter().take(4).collect(),
    })
}

async fn search_tavily(query: &str, api_key: &str) -> Result<Vec<SearchResult>, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {api_key}"))
            .map_err(|error| format!("Invalid Tavily API key: {error}"))?,
    );
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

    let response = reqwest::Client::new()
        .post("https://api.tavily.com/search")
        .headers(headers)
        .json(&json!({
            "query": query,
            "search_depth": "basic",
            "max_results": 4,
            "include_answer": false,
            "include_raw_content": false
        }))
        .send()
        .await
        .map_err(|error| format!("Tavily search failed: {error}"))?;

    if !response.status().is_success() {
        return Err(read_search_error("Tavily search failed", response).await);
    }

    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("Tavily returned invalid JSON: {error}"))?;

    Ok(body
        .get("results")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let url = item.get("url").and_then(Value::as_str)?;
                    Some(SearchResult {
                        title: item
                            .get("title")
                            .and_then(Value::as_str)
                            .unwrap_or(url)
                            .to_string(),
                        url: url.to_string(),
                        content: item
                            .get("content")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default())
}

async fn search_brave(query: &str, api_key: &str) -> Result<Vec<SearchResult>, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        "X-Subscription-Token",
        HeaderValue::from_str(api_key)
            .map_err(|error| format!("Invalid Brave Search API key: {error}"))?,
    );
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));

    let response = reqwest::Client::new()
        .get("https://api.search.brave.com/res/v1/web/search")
        .headers(headers)
        .query(&[("q", query), ("count", "4"), ("text_decorations", "false")])
        .send()
        .await
        .map_err(|error| format!("Brave Search failed: {error}"))?;

    if !response.status().is_success() {
        return Err(read_search_error("Brave Search failed", response).await);
    }

    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("Brave Search returned invalid JSON: {error}"))?;

    Ok(body
        .get("web")
        .and_then(|web| web.get("results"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let url = item.get("url").and_then(Value::as_str)?;
                    Some(SearchResult {
                        title: item
                            .get("title")
                            .and_then(Value::as_str)
                            .unwrap_or(url)
                            .to_string(),
                        url: url.to_string(),
                        content: item
                            .get("description")
                            .or_else(|| item.get("extra_snippets").and_then(|items| items.get(0)))
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default())
}

fn provider_label(provider: &str) -> &'static str {
    match provider {
        "brave" => "Brave Search",
        _ => "Tavily",
    }
}

async fn read_search_error(prefix: &str, response: reqwest::Response) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let message = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .or_else(|| value.get("message"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| body.trim().to_string());

    if message.is_empty() {
        format!("{prefix}: {status}")
    } else {
        format!("{prefix}: {message}")
    }
}
