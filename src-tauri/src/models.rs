//! Local model catalog. Same shape and Oat-shared detection as Sumi's
//! managers/models.rs — we check Sumi's dir, then Oat's, then our own app
//! data dir, so a single Qwen GGUF is enough for the whole Bentopop
//! ecosystem.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalModelInfo {
    pub id: String,
    pub name: String,
    pub filename: String,
    pub template: String,
    pub is_downloaded: bool,
    /// "" when it lives in KEN's own dir, otherwise a label like "oat" or
    /// "sumi" — shown in the picker so the user knows it's shared.
    pub source: String,
}

pub fn available_models() -> Vec<LocalModelInfo> {
    vec![
        LocalModelInfo {
            id: "qwen2.5-1.5b".into(),
            name: "Qwen 2.5 1.5B".into(),
            filename: "qwen2.5-1.5b-instruct-q4_k_m.gguf".into(),
            template: "chatml".into(),
            is_downloaded: false,
            source: String::new(),
        },
        LocalModelInfo {
            id: "qwen2.5-3b".into(),
            name: "Qwen 2.5 3B".into(),
            filename: "qwen2.5-3b-instruct-q4_k_m.gguf".into(),
            template: "chatml".into(),
            is_downloaded: false,
            source: String::new(),
        },
        LocalModelInfo {
            id: "gemma4-2b".into(),
            name: "Gemma 4 2B".into(),
            filename: "gemma-4-2b-it-Q4_K_M.gguf".into(),
            template: "gemma".into(),
            is_downloaded: false,
            source: String::new(),
        },
        LocalModelInfo {
            id: "gemma4-4b".into(),
            name: "Gemma 4 4B".into(),
            filename: "gemma-4-4b-it-Q4_K_M.gguf".into(),
            template: "gemma".into(),
            is_downloaded: false,
            source: String::new(),
        },
    ]
}

/// Directories that may already contain compatible GGUFs. Checked in
/// order; first hit wins.
fn search_paths(own: &Path) -> Vec<(PathBuf, String)> {
    let mut paths = vec![(own.to_path_buf(), String::new())];
    if let Some(data) = dirs::data_dir() {
        paths.push((data.join("com.bentopop.oat").join("models"), "oat".into()));
        paths.push((
            data.join("com.carlosdomingues.sumi").join("models"),
            "sumi".into(),
        ));
    }
    paths
}

fn resolve_existing(own_dir: &Path, filename: &str) -> Option<(PathBuf, String)> {
    for (dir, source) in search_paths(own_dir) {
        let candidate = dir.join(filename);
        if candidate.exists() {
            return Some((candidate, source));
        }
    }
    None
}

pub fn list_models(own_dir: &Path) -> Vec<LocalModelInfo> {
    available_models()
        .into_iter()
        .map(|mut model| {
            if let Some((_, source)) = resolve_existing(own_dir, &model.filename) {
                model.is_downloaded = true;
                model.source = source;
            }
            model
        })
        .collect()
}

pub fn get_model(own_dir: &Path, model_id: &str) -> Option<LocalModelInfo> {
    available_models()
        .into_iter()
        .find(|m| m.id == model_id)
        .map(|mut m| {
            if let Some((_, source)) = resolve_existing(own_dir, &m.filename) {
                m.is_downloaded = true;
                m.source = source;
            }
            m
        })
}

pub fn model_path(own_dir: &Path, model_id: &str) -> Option<PathBuf> {
    let model = available_models().into_iter().find(|m| m.id == model_id)?;
    resolve_existing(own_dir, &model.filename).map(|(p, _)| p)
}
