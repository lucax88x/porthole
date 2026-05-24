# Porthole

Porthole is a Tauri desktop app for inspecting local development ports. It lists local TCP listeners, probes each HTTP service for web pages or Swagger/OpenAPI docs, groups services by their nearest Git folder, and provides quick actions for browser, folder, terminal, favorites, PID copy, and current-user process termination.

## Setup

```sh
mise trust
bun install
```

Bun is pinned through `mise.toml`.

## Development

```sh
bun run tauri dev
```

The Tauri webview uses Vite at `http://localhost:1420/`.

## Checks

```sh
bun run build
cd src-tauri && cargo check
```
