# Architecture

```text
React Renderer
  -> HTTP API for CRUD
  -> WebSocket subscription for live run events

Local Backend
  -> RunService
  -> RunQueue
  -> AgentProcessManager
  -> ContextProvider
  -> SkillRegistry
  -> McpServerService / MCP stdio JSON-RPC client
  -> WorkspaceIndexService
  -> SQLite repositories

Windows Host
  -> powershell.exe / cmd.exe / custom Agent commands
  -> workspace filesystem
```

## Module Boundaries

`WorkspaceService`

Owns workspace creation, path normalization, and path safety. Other modules must not compare raw Windows paths directly.

`AgentConfigService`

Stores Agent command configuration. It does not spawn processes.

`RunService`

Creates runs, assembles prompt context, updates status, and asks the queue to schedule execution.

`RunQueue`

Applies local concurrency policy. The policy is max two active runs per workspace and max one active run per Agent. It also supports queued-run cancellation; `RunService` owns timeout and retry decisions.

`AgentProcessManager`

Owns process spawn, stdin prompt delivery, stdout/stderr streaming, cancellation, and exit code capture.

`EventBus`

Publishes domain events to both WebSocket clients and SQLite persistence.

`WebSocketGateway`

Owns WebSocket connections only. It does not contain business logic.

`SkillRegistry`

Loads local skills from `skills/*/skill.json` and `README.md`.

`McpServerService`

Stores MCP server command configuration and lifecycle status. V2 starts a stdio MCP server, performs JSON-RPC `initialize`, sends `notifications/initialized`, calls `tools/list`, and persists discovered tools. Tool invocation is a later boundary.

`ContextProvider`

Builds the final prompt from user prompt, skill instructions, workspace metadata, explicit file references, MCP server names, and retrieved project snippets.

`WorkspaceIndexService`

Builds a bounded local text index from workspace files. It ignores build/output/state folders and stores compact text content in SQLite. Retrieval is keyword scored for V2; vector search is intentionally deferred.
