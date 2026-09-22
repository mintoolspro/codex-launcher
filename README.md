# Codex Launcher

Codex Launcher is a macOS menu-bar application that starts a second, isolated copy of the official Codex Desktop app and routes its model traffic through a local BYOK gateway. The initial providers are OpenRouter and DeepSeek.

The launcher does **not** modify, copy, patch, or re-sign the official application. It starts the installed app with isolated state directories:

```text
Official Codex                       Launcher-managed Codex
~/.codex                             ~/.codex-launcher/codex
~/Library/Application Support/Codex  ~/.codex-launcher/desktop
OpenAI/default provider              Local authenticated gateway
```

## Requirements

- macOS on Apple Silicon (the packaged artifact in this repository is arm64)
- Node.js 20 or newer for development
- The official Codex Desktop app installed in `/Applications`
- An OpenRouter or DeepSeek API key

The launcher finds `/Applications/ChatGPT.app` and `/Applications/Codex.app`. Set `CODEX_DESKTOP_APP` to override discovery.

## Run from source

```sh
npm install
./run-app.sh
```

The window lets you save a provider URL/key, fetch the live model catalog, search it, select models, and launch Codex. Closing the window leaves the menu-bar app active.

Keys are stored in macOS Keychain under service `pro.mintools.codex-launcher`. If Keychain is unavailable, the fallback is an AES-GCM encrypted, machine-bound file with mode `0600`. Local control APIs expose only `hasKey`.

## Isolation and launch behavior

The official Codex configuration lives under `CODEX_HOME`, which defaults to `~/.codex`. Launcher uses `~/.codex-launcher/codex` and generates:

- `config.toml`
- `model_catalog.json`

It starts a new official Desktop instance using macOS `open -n` with both `CODEX_HOME` and `CODEX_ELECTRON_USER_DATA_PATH`. The second variable is supported by the currently inspected Codex Desktop build but is an internal desktop capability, not a documented public compatibility promise. Launcher also supplies a unique `--user-data-dir`, detects running processes by that exact path, and never targets the normal official instance.

Four layers are isolated:

1. State: separate Codex and Electron user-data directories.
2. Authentication: provider keys stay in Launcher storage; Codex receives only a random loopback-gateway token.
3. Network: Codex talks to `127.0.0.1` on a random port.
4. Processes: macOS launches a new Desktop instance; Stop targets only processes carrying Launcher's unique user-data path.

## Protocol gateway

Current Codex custom providers support only `wire_api = "responses"`. OpenRouter and DeepSeek are therefore configured as Chat Completions upstreams and translated locally.

Supported bridge behavior:

- text input/output, instructions, function tools and tool results
- non-streaming Responses ↔ Chat Completions conversion
- stateful streaming SSE events, including text deltas and function-call argument deltas
- tool argument reassembly and `call_id` preservation
- provider/model namespace routing such as `openrouter/anthropic/claude-...`
- input/output/total usage capture on native and bridged, streaming and non-streaming paths

The Responses API is broader than Chat Completions. Unsupported features are not silently emulated. The bridge focuses on the request and event forms used by Codex and should be extended explicitly as providers add capabilities.

Official references:

- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Codex advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)

## Model catalogs

Provider model results are normalized and cached. Only checked models are written to `model_catalog.json`. Model IDs are namespaced as `providerId/model`, while the gateway removes the first namespace segment before forwarding upstream.

The launcher uses the current `model_catalog_json` configuration key rather than relying on an undocumented `models.json` filename.

## Usage overview

The gateway stores daily and per-model aggregates in `~/.codex-launcher/usage.json`. The UI shows total/input/output tokens, request count, model share, last use, and 7/14/30-day charts. Reset removes only these local aggregates.

## Tests

```sh
npm run check
npm test
```

The tests use real loopback HTTP servers and cover routing/auth interception, non-streaming conversion, streaming text, streaming tool calls, argument reconstruction, `call_id`, all four usage paths, daily buckets, and descending aggregation.

## Packaging

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack
```

This creates an unsigned `.app` and `.zip` in `dist/`. If npm/Electron caches are not writable, redirect them before installing:

```sh
export npm_config_cache="$(mktemp -d)"
export ELECTRON_CACHE="$(mktemp -d)"
export ELECTRON_BUILDER_CACHE="$(mktemp -d)"
npm install
npm run pack
```

To create a local DMG on a Mac after packaging:

```sh
hdiutil create -volname "Codex Launcher" -srcfolder "dist/mac-arm64/Codex Launcher.app" -ov -format UDZO "dist/Codex-Launcher.dmg"
```

Unsigned local builds may require Control-click → Open on first launch. Distribution to other users should use an Apple Developer ID signature and notarization.

## Project layout

- `electron/main.js`: menu bar, window, and application lifecycle
- `src/controller.js`: gateway/Desktop orchestration
- `src/gateway.js`: authenticated loopback Responses endpoint
- `src/translate.js`: Responses/Chat conversion and streaming state machine
- `src/providers.js`: provider presets and model normalization
- `src/generate.js`, `src/catalog.js`: Codex configuration/catalog generation
- `src/store.js`: configuration and secret storage
- `src/usage.js`: usage aggregation and persistence
- `src/panel.js`, `ui/index.html`: same-origin local control panel
- `bin/codex-launcher.mjs`: standalone CLI runner

## Security notes

- The gateway binds only to `127.0.0.1` and requires a random Bearer token.
- Provider keys are never written to generated Codex configuration and are never returned by panel APIs.
- The generated gateway token is process-local and changes when Launcher restarts.
- Configuration and fallback secret files use mode `0600`; state directories use `0700`.
- This project is independent and is not affiliated with or endorsed by OpenAI.
