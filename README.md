# WinAgent Workbench

Windows-first local Agent runtime workbench inspired by Tutti's local Agent workspace model.

The project focuses on a small but engineered loop:

- Windows workspace selection and path normalization
- Agent command lifecycle management
- WebSocket streaming for run status and process output
- Skill Registry for task templates
- MCP server configuration lifecycle
- Context Provider for explicit file references
- Run queue and concurrency control
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
