# WinAgent Workbench

Windows-first local Agent runtime workbench inspired by Tutti's local Agent workspace model.

The project focuses on a small but engineered loop:

- Windows workspace selection and path normalization
- Agent command lifecycle management
- WebSocket streaming for run status and process output
- Skill Registry for task templates
- MCP stdio lifecycle with `initialize` and `tools/list`
- Context Provider with explicit file references and lightweight project retrieval
- Run queue with same-Agent concurrency control, queued cancel, timeout, and retry
- SQLite persistence through Node 24 `node:sqlite`
- Windows smoke validation

## Quick Start

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

The first milestone runs as a local web workbench backed by a Node local runtime.
An Electron shell scaffold is kept under `src/electron`, but Electron is not in
the default dependency set so Windows CI stays fast and reproducible.

## V2 Capability Boundaries

Implemented:

- Start/stop local MCP stdio servers and persist discovered tools.
- Invoke MCP tools through `tools/call` and persist arguments/results/errors.
- Attach MCP tool calls to a Run, execute them before the Agent starts, and inject results into the Agent prompt.
- Export completed or failed Runs as Markdown reports with metadata, events, stdout, and stderr.
- Build a lightweight text index for a workspace and search it for retrieval context.
- Inject skill instructions, explicit files, MCP server names, and retrieval hits into an Agent prompt.
- Cancel queued or running runs.
- Retry failed runs up to `maxRetries`.
- Kill timed-out runs and mark them failed.
- Replay missed run events through `GET /api/runs/:id/events?after=...` and WebSocket `ws://127.0.0.1:8787/ws?runId=...&after=...`.

Still intentionally out of scope:

- Full MCP tool invocation from the UI.
- Embedding/vector RAG.
- Cloud execution or microservices.
- Electron packaging.

Windows smoke:

```powershell
npm run smoke:windows
```

## Default Ports

- Web UI: `http://127.0.0.1:5173`
- Local backend and WebSocket: `http://127.0.0.1:8787`
- WebSocket endpoint: `ws://127.0.0.1:8787/ws`

## Resume Positioning

Reference Tutti's local Agent workspace idea, then implement a Windows-first lightweight Agent Runtime Host with WebSocket streaming, process lifecycle management, Skill Registry, MCP server configuration, Context Provider, SQLite persistence, run queue, and Windows E2E validation.
