# WinAgent Workbench

Windows-first local Agent runtime workbench inspired by Tutti's local Agent workspace model.

The project focuses on a small but engineered loop:

- Windows workspace selection and path normalization
- Agent command lifecycle management
- WebSocket streaming for run status and process output
- Skill Registry for task templates
- MCP stdio lifecycle with `initialize` and `tools/list`
- Context Provider with explicit file references and lightweight project retrieval
- Short-term working memory per Run and long-term workspace memory
- Run queue with same-Agent concurrency control, queued cancel, timeout, and retry
- SQLite persistence through Node 24 `node:sqlite`, schema migrations, adapter registry, settings, and run artifacts
- Windows smoke validation
- Automated acceptance validation with a real Codex Agent run

## Quick Start

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

Desktop window:

```powershell
npm run dev:desktop
```

The first desktop launch downloads the pinned Electron runtime through `npx`.
If that download is slow, the browser dev mode and all backend validation
commands still work normally.

Built desktop preview:

```powershell
npm run build:desktop
npm run preview:desktop
```

The workbench can run either in a browser for development or as an Electron
desktop window for demos.

## V2 Capability Boundaries

Implemented:

- Start/stop local MCP stdio servers and persist discovered tools.
- Invoke MCP tools through `tools/call` and persist arguments/results/errors.
- Attach MCP tool calls to a Run, execute them before the Agent starts, and inject results into the Agent prompt.
- Export completed or failed Runs as Markdown reports with metadata, events, stdout, and stderr.
- Build a lightweight text index for a workspace and search it for retrieval context.
- Inject skill instructions, explicit files, MCP server names, and retrieval hits into an Agent prompt.
- Persist long-term workspace memories, select relevant memories for new Runs, and build a bounded short-term working-memory snapshot before process start.
- Automatically write completed/failed Run outcomes back into long-term memory.
- Persist Agent adapter capabilities separately from runnable Agent profiles.
- Expose schema migrations, settings, and Agent adapter registry through backend system APIs.
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

Full delivery verification:

```powershell
npm run verify:all
```

`verify:all` runs TypeScript/Vite build, unit tests, Windows smoke coverage,
and a Windows acceptance check that validates the frontend page, backend APIs,
workspace files, retrieval index, long-term memory, clean Agent profiles, and a
real Codex `exec -` Agent run. Test workspaces, runs, memories, and smoke MCP
data are cleaned automatically before and after validation.

## Default Ports

- Web UI: `http://127.0.0.1:5173`
- Local backend and WebSocket: `http://127.0.0.1:8787`
- WebSocket endpoint: `ws://127.0.0.1:8787/ws`

## Resume Positioning

Reference Tutti's local Agent workspace idea, then implement a Windows-first lightweight Agent Runtime Host with WebSocket streaming, process lifecycle management, Skill Registry, MCP server configuration, Context Provider, short/long-term memory, SQLite persistence, run queue, and Windows E2E validation.
