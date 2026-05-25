# Porthole

Porthole is a Tauri desktop app for inspecting local development ports. It lists local TCP listeners, probes each HTTP service for web pages or Swagger/OpenAPI docs, groups services by their nearest Git folder, and provides quick actions for browser, folder, terminal, favorites, PID copy, and current-user process termination.

## How scanning works

Porthole does not brute-force scan every port from `1..65535`. It asks the operating system for TCP ports that are already listening, then inspects only those services.

Listener discovery uses platform tools:

- macOS: `lsof -nP -iTCP -sTCP:LISTEN -F pcun`
- Linux: `ss -ltnpH`
- Windows: `netstat -ano -p tcp`

For each listener, Porthole extracts the port, bind address, PID, process name, and owner where available. It then enriches the process with its working directory, command line, nearest `.git` folder, Docker container metadata from `docker ps`, and macOS `.app` bundle information when relevant.

Capability scanning runs asynchronously per discovered port. It probes the actual listener address, so IPv6 listeners such as `[::1]:5173` are checked through `http://[::1]:5173` rather than `127.0.0.1`. It checks for gRPC using an HTTP/2 h2c preface, probes HTTP root `/`, follows simple same-service redirects, and tries common docs paths such as `/swagger-ui`, `/api-docs`, `/docs`, `/openapi.json`, and `/swagger.json`.

Each service is classified as one of:

- Web app
- API docs
- gRPC
- API without docs
- Unknown
- Error

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
