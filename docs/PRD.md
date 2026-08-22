# WinAgent Workbench PRD

## Goal

Build a Windows-first local Agent workbench that keeps project files, Agent runs, terminal/process output, task state, skills, MCP server configuration, and execution history in one local workspace.

The product is not a generic chatbot. It is a local runtime host that makes Agent execution observable, recoverable, and testable on Windows.

## MVP

1. Workspace management
   - Add and reopen Windows project folders.
   - Normalize drive-letter paths, paths with spaces, Chinese paths, and missing paths.

2. Agent runtime host
   - Configure local Agent commands such as `codex`, `claude`, or custom scripts.
   - Start, cancel, and observe each run.
   - Capture stdout, stderr, exit code, duration, and terminal status.

3. WebSocket streaming
   - Push run events without frontend polling.
   - Stream `run.output.delta`, `run.error.delta`, and status transitions.

4. Skill Registry
   - Load local skill directories from `skills/*`.
   - Inject skill instructions into the final Agent prompt.

5. MCP server manager
   - Store local MCP server command configuration.
   - Start and stop stdio MCP servers.
   - Run MCP `initialize` and `tools/list`.
   - Persist discovered tools and lifecycle errors.
   - Call MCP tools and persist arguments, result, status, and error.
   - Attach selected MCP tool calls to a Run and inject the results before Agent execution.
   - Keep lifecycle management separate from Agent process execution.

6. Context Provider
   - Support explicit file references.
   - Build a lightweight text index for project files.
   - Search indexed files and inject top project snippets.
   - Inject selected file content into the prompt with path and truncation metadata.

7. Run queue and concurrency
   - Limit active runs per workspace.
   - Limit active runs per Agent.
   - Support queued, running, completed, failed, and cancelled states.
   - Support queued cancel, process timeout, and retry on failure.

8. Persistence
   - Store workspaces, agents, runs, run events, file references, and MCP servers in SQLite.
   - Restore history after application restart.

9. Run artifact export
   - Export a Run as Markdown with metadata, event timeline, stdout, and stderr.

10. Windows validation
   - Cover paths with spaces, Chinese paths, PowerShell execution, cancellation, failed commands, and restart recovery.

## Non-goals

- Multi-user collaboration
- Cloud sync
- App marketplace
- Full MCP protocol implementation
- Full RAG product
- Microservice deployment
- Remote sandbox execution
