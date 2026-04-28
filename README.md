# KEN

A lightweight cross-platform AI search palette. Double-tap **Option/Alt** (or click the menu-bar icon) and KEN drops in from the top of your screen ready for a question. Plug in ChatGPT (Codex login), an OpenAI API key, or run fully local with Ollama / GGUF.

- **Native shell** — Tauri 2, tray-resident, ~10 MB binary.
- **Bring your own model** — ChatGPT subscription via Codex OAuth, OpenAI API (BYOK), Ollama (local), or any GGUF KEN can find on disk.
- **Vision + image generation** — drag-and-drop images into the bar; generate via `gpt-image-2` or describe via Gemma/Qwen vision.
- **Web search** — optional Tavily / Brave / OpenAI web search for grounded answers.
- **No telemetry, no accounts** — your keys live in `localStorage`, your Codex tokens stay in `~/.codex/auth.json`.

## Install

### macOS

Download the latest `.dmg` from [Releases](https://github.com/carlosarthurr1/Ken/releases) → drag KEN to Applications.

The build is native Apple Silicon and runs under Rosetta 2 on Intel Macs.

> KEN is unsigned right now. The first launch needs `System Settings → Privacy & Security → Open Anyway`. Global key listening also asks for **Accessibility** permission.

### Windows

Download the latest `.msi` from [Releases](https://github.com/carlosarthurr1/Ken/releases) → run the installer.

### Linux

Build from source (see below). Wayland may restrict the global double-Alt listener — the tray icon and palette window still work.

## Build from source

Requires Node 20+, Rust (stable), and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
git clone https://github.com/carlosarthurr1/Ken.git
cd Ken
npm install
npm run tauri:dev          # development
npm run tauri:build        # release installers for current OS
```

Bundles land in `src-tauri/target/release/bundle/`:
- macOS → `dmg/KEN_<version>_<arch>.dmg` and `macos/KEN.app`
- Windows → `msi/KEN_<version>_x64_en-US.msi`
- Linux → `appimage/`, `deb/`

Cross-OS builds happen on CI — see `.github/workflows/release.yml`. Pushing a tag like `v0.1.0` builds and uploads installers to a draft GitHub Release.

## Using it

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Show palette | Double-tap `⌥` Option, or click tray icon | Double-tap `Alt`, or click tray icon |
| Focus input | `⌘K` | `Ctrl+K` |
| Hide / back | `Esc` | `Esc` |
| Submit | `Enter` | `Enter` |
| Attach image | Paste, drop, or click 📎 | Same |

### Providers

KEN ships with four provider adapters. Choose one in **Settings**:

1. **ChatGPT (Codex subscription)** — uses the OAuth tokens written by the official [Codex CLI](https://github.com/openai/codex). Run `codex login` once, then KEN reads `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`).
2. **OpenAI API (BYOK)** — paste an `sk-…` key. Hits the public Responses API. Web search uses `web_search_preview`.
3. **Ollama** — KEN talks to `http://localhost:11434` for models like `gemma3:4b` or `qwen2.5vl:3b`. Vision works for vision-capable models.
4. **Local GGUF** — drops in via [llama.cpp](https://github.com/ggml-org/llama.cpp). KEN auto-discovers GGUF files in its own data dir, plus shared dirs from sibling apps (Oat / Sumi) when present.

### Generated images

Images come back as base64, get persisted to `~/Pictures/KEN/Generated Images/`, and render inline. Each card has:
- **Show** — reveal in Finder/Explorer
- **Download** — copy to your Downloads folder

## Architecture

```
src/                        React palette UI
  App.tsx                   single-window state machine
  lib/providers.ts          provider dispatcher (Codex / OpenAI / local / mock)
src-tauri/                  Rust shell
  main.rs                   tray, window lifecycle, file ops
  codex.rs                  Codex OAuth + chatgpt.com responses backend
  ollama.rs                 Ollama CRUD + streaming
  llm.rs / local.rs         direct llama.cpp inference
  search.rs                 Tavily + Brave web search
.github/workflows/          cross-OS release pipeline
```

The Tauri shell is the source of truth for filesystem access, native dialogs, the tray icon, and the global key listener. The React side never touches the filesystem directly.

## Privacy

- API keys live in `localStorage` and are sent only to the provider you select.
- Codex tokens stay in `~/.codex/auth.json` — KEN never copies, uploads, or logs them.
- Generated images are written under `~/Pictures/KEN/Generated Images/`. Nothing leaves your machine without a network call you can see.
- No analytics, no remote config, no auto-update calls.

## Contributing

PRs welcome. Before submitting:
- `npm run build` — TypeScript + Vite must pass.
- `cargo check --manifest-path src-tauri/Cargo.toml`.
- Try the change in `npm run tauri:dev` before opening the PR.

See [CONTRIBUTING.md](CONTRIBUTING.md) for more.

## License

[MIT](LICENSE) © Carlos Arthur
