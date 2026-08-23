import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dataDir = path.resolve(process.cwd(), "data");
mkdirSync(dataDir, { recursive: true });

export const dbPath = path.join(dataDir, "winagent.sqlite");
export const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_opened_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_adapters (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    command TEXT NOT NULL,
    default_args_json TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    install_state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    adapter_id TEXT REFERENCES agent_adapters(id),
    name TEXT NOT NULL,
    command TEXT NOT NULL,
    args_json TEXT NOT NULL,
    env_json TEXT NOT NULL,
    cwd TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    capabilities_json TEXT NOT NULL DEFAULT '{}',
    last_readiness_status TEXT,
    last_readiness_checked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    command TEXT NOT NULL,
    args_json TEXT NOT NULL,
    env_json TEXT NOT NULL,
    status TEXT NOT NULL,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mcp_tools (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    input_schema_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(server_id, name)
  );

  CREATE TABLE IF NOT EXISTS mcp_tool_calls (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
    tool_name TEXT NOT NULL,
    arguments_json TEXT NOT NULL,
    status TEXT NOT NULL,
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    agent_id TEXT NOT NULL REFERENCES agents(id),
    skill_id TEXT,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    cwd TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    max_retries INTEGER NOT NULL DEFAULT 0,
    timeout_ms INTEGER NOT NULL DEFAULT 120000,
    retrieval_query TEXT,
    started_at TEXT,
    ended_at TEXT,
    exit_code INTEGER,
    duration_ms INTEGER,
    summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS run_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(run_id, sequence)
  );

  CREATE TABLE IF NOT EXISTS run_file_refs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workspace_index (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    modified_at TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(workspace_id, path)
  );

  CREATE TABLE IF NOT EXISTS workspace_memories (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    source_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS run_working_memory (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    budget_chars INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS run_artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    content_text TEXT,
    file_path TEXT,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
  CREATE INDEX IF NOT EXISTS idx_runs_workspace ON runs(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_run_artifacts_run ON run_artifacts(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_workspace_index_workspace ON workspace_index(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_server ON mcp_tool_calls(server_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_workspace_memories_workspace ON workspace_memories(workspace_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_run_working_memory_run ON run_working_memory(run_id, created_at);
`);

for (const migration of [
  "ALTER TABLE agents ADD COLUMN adapter_id TEXT REFERENCES agent_adapters(id)",
  "ALTER TABLE agents ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE agents ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '{}'",
  "ALTER TABLE agents ADD COLUMN last_readiness_status TEXT",
  "ALTER TABLE agents ADD COLUMN last_readiness_checked_at TEXT",
  "ALTER TABLE mcp_servers ADD COLUMN last_error TEXT",
  "ALTER TABLE runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE runs ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE runs ADD COLUMN timeout_ms INTEGER NOT NULL DEFAULT 120000",
  "ALTER TABLE runs ADD COLUMN retrieval_query TEXT",
  "ALTER TABLE mcp_tool_calls ADD COLUMN run_id TEXT REFERENCES runs(id) ON DELETE SET NULL"
]) {
  try {
    db.exec(migration);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("duplicate column")) {
      throw error;
    }
  }
}

const bootstrapMigrations = [
  ["0001_initial_runtime_schema", "Initial local runtime schema"],
  ["0002_agent_adapters_settings_artifacts", "Agent adapters, settings, run artifacts, and Agent readiness columns"]
] as const;

const appliedAt = new Date().toISOString();
const insertMigration = db.prepare(
  `INSERT OR IGNORE INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)`
);
for (const [id, name] of bootstrapMigrations) {
  insertMigration.run(id, name, appliedAt);
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_agents_adapter ON agents(adapter_id);
  CREATE INDEX IF NOT EXISTS idx_run_artifacts_run ON run_artifacts(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_run ON mcp_tool_calls(run_id, created_at);
`);
