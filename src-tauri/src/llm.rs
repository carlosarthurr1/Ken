//! In-process llama.cpp wrapper — identical pattern to Sumi/Oat. The
//! backend is initialized once per process; the loaded model stays
//! resident between palette invocations so the cold start hits only the
//! first query.

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
#[allow(deprecated)]
use llama_cpp_2::model::Special;
use llama_cpp_2::model::{AddBos, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use std::path::Path;
use std::sync::Mutex;

struct LlmState {
    backend: LlamaBackend,
    model: Option<LoadedModel>,
}

struct LoadedModel {
    model: LlamaModel,
    path: String,
}

static LLM_STATE: Mutex<Option<LlmState>> = Mutex::new(None);

fn ensure_backend() {
    let mut state = LLM_STATE.lock().unwrap();
    if state.is_none() {
        let backend = LlamaBackend::init().expect("Failed to init llama backend");
        *state = Some(LlmState {
            backend,
            model: None,
        });
    }
}

pub fn load_model(model_path: &Path) -> Result<(), String> {
    ensure_backend();
    let mut state = LLM_STATE.lock().map_err(|error| error.to_string())?;
    let state = state.as_mut().ok_or("Backend not initialized")?;

    let path_str = model_path.to_string_lossy().to_string();
    if let Some(ref loaded) = state.model {
        if loaded.path == path_str {
            return Ok(());
        }
    }

    let params = LlamaModelParams::default();
    let model = LlamaModel::load_from_file(&state.backend, model_path, &params)
        .map_err(|error| format!("Failed to load LLM: {:?}", error))?;

    state.model = Some(LoadedModel {
        model,
        path: path_str,
    });
    Ok(())
}

pub fn generate(prompt: &str, max_tokens: u32) -> Result<String, String> {
    let mut state = LLM_STATE.lock().map_err(|error| error.to_string())?;
    let state = state.as_mut().ok_or("Backend not initialized")?;
    let loaded = state.model.as_ref().ok_or("No LLM model loaded")?;

    let ctx_params = LlamaContextParams::default().with_n_ctx(std::num::NonZeroU32::new(8192));
    let mut ctx = loaded
        .model
        .new_context(&state.backend, ctx_params)
        .map_err(|error| format!("Failed to create context: {:?}", error))?;

    let tokens = loaded
        .model
        .str_to_token(prompt, AddBos::Always)
        .map_err(|error| format!("Tokenization failed: {:?}", error))?;
    if tokens.is_empty() {
        return Ok(String::new());
    }

    let mut batch = LlamaBatch::new(8192, 1);
    for (i, &token) in tokens.iter().enumerate() {
        let is_last = i == tokens.len() - 1;
        batch
            .add(token, i as i32, &[0], is_last)
            .map_err(|error| format!("Batch add failed: {:?}", error))?;
    }
    ctx.decode(&mut batch)
        .map_err(|error| format!("Prompt decode failed: {:?}", error))?;

    let mut output = String::new();
    let mut n_cur = tokens.len() as i32;
    let mut sampler = LlamaSampler::chain_simple([
        LlamaSampler::temp(0.7),
        LlamaSampler::top_p(0.9, 1),
        LlamaSampler::dist(42),
    ]);

    for _ in 0..max_tokens {
        let token = sampler.sample(&ctx, batch.n_tokens() - 1);
        if loaded.model.is_eog_token(token) {
            break;
        }

        #[allow(deprecated)]
        let piece = loaded
            .model
            .token_to_str(token, Special::Tokenize)
            .unwrap_or_default();
        output.push_str(&piece);

        batch.clear();
        batch
            .add(token, n_cur, &[0], true)
            .map_err(|error| format!("Batch add failed: {:?}", error))?;
        ctx.decode(&mut batch)
            .map_err(|error| format!("Decode failed: {:?}", error))?;

        n_cur += 1;
    }

    Ok(output)
}
