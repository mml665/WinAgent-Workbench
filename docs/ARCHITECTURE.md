# Architecture

WinAgent follows a Windows-first, local-daemon shape inspired by Tutti's
desktop architecture:

- keep durable state and product policy in the local backend;
- keep Agent lifecycle orchestration out of the React renderer;
- keep provider/runtime differences behind Agent adapters;
- treat event streaming as a replayable transport, not as the source of truth;
- keep Windows process/path handling inside narrow backend boundaries.

```text
React Renderer
  -> HTTP API for CRUD
  -> WebSocket subscription for live run events

Local Backend
  -> AgentConfigService / AgentReadinessService
  -> RunService
  -> RunQueue
  -> AgentProcessManager
  -> ContextProvider
  -> SkillRegistry
  -> McpServerService / MCP stdio JSON-RPC client
  -> WorkspaceIndexService
  -> MemoryService
  -> SystemService
  -> SQLite repositories

Windows Host
  -> powershell.exe / cmd.exe / custom Agent commands
  -> workspace filesystem
```

## Module Boundaries

`WorkspaceService`

Owns workspace creation, path normalization, and path safety. Other modules must not compare raw Windows paths directly.

`AgentConfigService`

Stores runnable Agent profiles. It does not spawn processes.

`AgentReadinessService`

Owns the Agent adapter registry and local readiness checks. Adapter capability
records define whether a tool is a real stdin/stdout Agent runtime, a launcher,
or missing. Existing profiles are adopted into their adapter record so UI state
does not depend on name matching.

`RunService`

Creates runs, assembles prompt context, updates status, asks the queue to schedule execution, and records terminal Run outcomes into long-term memory.

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

Stores MCP server command configuration and lifecycle status. V2 starts a stdio MCP server, performs JSON-RPC `initialize`, sends `notifications/initialized`, calls `tools/list`, persists discovered tools, invokes `tools/call`, and stores call arguments/results/errors for audit.

`ContextProvider`

Builds the final prompt from user prompt, skill instructions, workspace metadata, explicit file references, MCP server names, retrieved project snippets, selected long-term memories, short-term working memory, and pre-run MCP tool results.

`Run Export`

`RunService` can produce a Markdown report for any Run. The report includes lifecycle metadata, short-term working memory, event timeline, stdout, and stderr, giving each Agent execution an auditable artifact for review or resume evidence.

`SystemService`

Exposes system metadata: schema migrations, settings, and Agent adapter
registry. This is intentionally read-oriented so operational checks can verify
system integrity without directly opening SQLite.

`WorkspaceIndexService`

Builds a bounded local text index from workspace files. It ignores build/output/state folders and stores compact text content in SQLite. Retrieval is keyword scored for V2; vector search is intentionally deferred.

`MemoryService`

Owns Agent memory. Long-term memory is workspace scoped and persisted in SQLite with `fact`, `preference`, `decision`, `issue`, `command`, and `run_summary` types. Short-term memory is a per-Run bounded snapshot created before process start; it combines current Run metadata, recent Run summaries, retrieval hits, MCP tool results, and selected long-term memories. It is stored separately from the Run log so the exact context used by a Run can be inspected later.

## Database Design

SQLite is the local durable store at `data/winagent.sqlite`. WAL mode and
foreign keys are enabled on startup.

Core tables:

- `schema_migrations`: applied schema version records.
- `settings`: keyed JSON system settings.
- `workspaces`: local project roots.
- `agent_adapters`: provider/runtime capabilities such as Codex, Qoder, and
  WorkBuddy.
- `agents`: runnable Agent profiles linked to adapters through `adapter_id`.
- `runs`: one Agent execution request and its terminal summary.
- `run_events`: ordered, replayable event stream for each Run.
- `run_file_refs`: explicit files attached to a Run.
- `run_artifacts`: durable outputs derived from a Run; this keeps results
  separate from transient event deltas.
- `workspace_index`: bounded text index for local retrieval.
- `workspace_memories`: long-term workspace memory.
- `run_working_memory`: per-Run short-term memory snapshot.
- `mcp_servers`, `mcp_tools`, `mcp_tool_calls`: MCP configuration, discovered
  tool contracts, and audit records.

Important relationships:

```text
workspaces 1 -> many runs
agents 1 -> many runs
agent_adapters 1 -> many agents
runs 1 -> many run_events
runs 1 -> many run_file_refs
runs 1 -> many run_artifacts
runs 1 -> many run_working_memory snapshots
workspaces 1 -> many workspace_index rows
workspaces 1 -> many workspace_memories
mcp_servers 1 -> many mcp_tools
mcp_servers 1 -> many mcp_tool_calls
runs 1 -> many mcp_tool_calls
```

Design rules:

- Process output belongs in `run_events`; durable generated files or reports
  belong in `run_artifacts`.
- Provider capability belongs in `agent_adapters`; user-selected runnable
  configuration belongs in `agents`.
- A Run records execution facts only. It does not infer adapter capability from
  names or UI labels.
- Workspace memory and per-Run working memory are separate. Long-term memory is
  reusable; working memory is exact run evidence.
- Tests and smoke data must be cleaned through `npm run cleanup:mock`; product
  startup must not seed demo data.

## Delivery Verification

The acceptance gate is:

```powershell
npm run verify:all
```

It runs build, unit tests, Windows smoke, frontend/backend availability,
database metadata checks, adapter registry checks, settings persistence, memory,
indexing, clean-data checks, and a real Codex `exec -` Agent run.
