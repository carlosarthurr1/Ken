# Contributing to KEN

Thanks for taking a look. KEN is small enough that contribution is informal.

## Development setup

```bash
git clone https://github.com/carlosarthurr1/Ken.git
cd Ken
npm install
npm run tauri:dev
```

Requirements:
- Node 20+
- Rust stable (`rustup default stable`)
- [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform

## Before opening a PR

- `npm run build` — TypeScript + Vite produce a clean build.
- `cargo check --manifest-path src-tauri/Cargo.toml` — Rust compiles.
- Run the change in `npm run tauri:dev`. UI changes need a smoke test in the actual native window — type checking does not catch behavior.
- Keep PRs focused. One feature or fix per PR.

## Code style

- **TypeScript / React**: no class components. Hooks + small functions. Avoid premature abstractions; three similar lines beats a clever helper.
- **Rust**: Tauri commands return `Result<T, String>`. Errors are surfaced to the UI, so write user-readable messages.
- **CSS**: plain CSS in `src/styles.css`. No framework, no preprocessor.
- **Comments**: only when the *why* isn't obvious from the code. Don't restate what the code does.

## Provider adapters

`src/lib/providers.ts` is the dispatcher. To add a provider:
1. Add a `ProviderKind` and entry to `MODEL_OPTIONS`.
2. Add an `ask…` function that returns `AiResult`.
3. Wire it into `askProvider`'s switch.
4. If the provider needs filesystem or network capabilities the WebView can't reach, add a Tauri command in `src-tauri/src/`.

## Reporting issues

When filing a bug, please include:
- OS + version
- KEN version (Settings → bottom of panel, or the GitHub release tag)
- Provider you were using when it broke
- Reproduction steps
- Console output if you can grab it (`npm run tauri:dev` shows it in the terminal)

## Security

Don't open public issues for security problems. Email the maintainer instead.
