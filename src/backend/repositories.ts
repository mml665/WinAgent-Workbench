import type {
  AgentAdapterRecord,
  AgentRecord,
  McpServerRecord,
  McpToolCallRecord,
  McpToolRecord,
  MemoryType,
  ApprovalRecord,
  RetrievalHit,
  RunArtifactRecord,
  RunWorkingMemoryRecord,
  RunEventRecord,
  RunRecord,
  SettingRecord,
  TaskPriority,
  TaskRecord,
  TaskStatus,
  WorkspaceIndexRecord,
  WorkspaceMemoryRecord,
  WorkspaceReferenceRecord,
  WorkspaceRecord
} from "../shared/types";
import { db } from "./db";
import { newId } from "./utils/ids";
import { nowIso } from "./utils/time";

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function mapAgent(row: any): AgentRecord {
  return {
    id: row.id,
    adapterId: row.adapter_id ?? undefined,
    name: row.name,
    command: row.command,
    args: parseJson<string[]>(row.args_json),
    env: parseJson<Record<string, string>>(row.env_json),
    cwd: row.cwd ?? undefined,
    enabled: row.enabled !== 0,
    capabilities: parseJson<Record<string, unknown>>(row.capabilities_json ?? "{}"),
    lastReadinessStatus: row.last_readiness_status ?? undefined,
    lastReadinessCheckedAt: row.last_readiness_checked_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class SettingRepository {
  list(): SettingRecord[] {
    return db
      .prepare(`SELECT key, value_json, updated_at FROM settings ORDER BY key ASC`)
      .all()
      .map((row: any) => ({
        key: row.key,
        value: parseJson<unknown>(row.value_json),
        updatedAt: row.updated_at
      }));
  }

  get(key: string): SettingRecord | null {
    return this.list().find((setting) => setting.key === key) ?? null;
  }

  set(key: string, value: unknown): SettingRecord {
    const at = nowIso();
    db.prepare(
      `INSERT INTO settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    ).run(key, JSON.stringify(value ?? null), at);
    return this.get(key)!;
  }
}

export class WorkspaceRepository {
  list(): WorkspaceRecord[] {
    return db
      .prepare(
        `SELECT id, name, root_path, created_at, updated_at, last_opened_at
         FROM workspaces ORDER BY last_opened_at DESC`
      )
      .all()
      .map((row: any) => ({
        id: row.id,
        name: row.name,
        rootPath: row.root_path,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastOpenedAt: row.last_opened_at
      }));
  }

  get(id: string): WorkspaceRecord | null {
    const row = db
      .prepare(
        `SELECT id, name, root_path, created_at, updated_at, last_opened_at
         FROM workspaces WHERE id = ?`
      )
      .get(id) as any;
    return row
      ? {
          id: row.id,
          name: row.name,
          rootPath: row.root_path,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          lastOpenedAt: row.last_opened_at
        }
      : null;
  }

  upsert(name: string, rootPath: string): WorkspaceRecord {
    const existing = db
      .prepare(`SELECT id FROM workspaces WHERE root_path = ?`)
      .get(rootPath) as { id: string } | undefined;
    const at = nowIso();
    if (existing) {
      db.prepare(
        `UPDATE workspaces SET name = ?, updated_at = ?, last_opened_at = ? WHERE id = ?`
      ).run(name, at, at, existing.id);
      return this.get(existing.id)!;
    }
    const id = newId("ws");
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, created_at, updated_at, last_opened_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, name, rootPath, at, at, at);
    return this.get(id)!;
  }
}

export class AgentAdapterRepository {
  list(): AgentAdapterRecord[] {
    return db
      .prepare(
        `SELECT id, label, command, default_args_json, capabilities_json, install_state, created_at, updated_at
         FROM agent_adapters ORDER BY label ASC`
      )
      .all()
      .map((row: any) => ({
        id: row.id,
        label: row.label,
        command: row.command,
        defaultArgs: parseJson<string[]>(row.default_args_json),
        capabilities: parseJson<Record<string, unknown>>(row.capabilities_json),
        installState: row.install_state,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
  }

  get(id: string): AgentAdapterRecord | null {
    return this.list().find((adapter) => adapter.id === id) ?? null;
  }

  upsert(input: {
    id: string;
    label: string;
    command: string;
    defaultArgs?: string[];
    capabilities?: Record<string, unknown>;
    installState?: AgentAdapterRecord["installState"];
  }): AgentAdapterRecord {
    const at = nowIso();
    db.prepare(
      `INSERT INTO agent_adapters (
        id, label, command, default_args_json, capabilities_json, install_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        command = excluded.command,
        default_args_json = excluded.default_args_json,
        capabilities_json = excluded.capabilities_json,
        install_state = excluded.install_state,
        updated_at = excluded.updated_at`
    ).run(
      input.id,
      input.label,
      input.command,
      JSON.stringify(input.defaultArgs ?? []),
      JSON.stringify(input.capabilities ?? {}),
      input.installState ?? "external",
      at,
      at
    );
    return this.get(input.id)!;
  }
}

export class AgentRepository {
  list(): AgentRecord[] {
    return db
      .prepare(
        `SELECT id, adapter_id, name, command, args_json, env_json, cwd, enabled,
                capabilities_json, last_readiness_status, last_readiness_checked_at,
                created_at, updated_at
         FROM agents ORDER BY created_at ASC`
      )
      .all()
      .map(mapAgent);
  }

  get(id: string): AgentRecord | null {
    return this.list().find((agent) => agent.id === id) ?? null;
  }

  create(input: {
    adapterId?: string;
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    enabled?: boolean;
    capabilities?: Record<string, unknown>;
  }): AgentRecord {
    const id = newId("agent");
    const at = nowIso();
    db.prepare(
      `INSERT INTO agents (
        id, adapter_id, name, command, args_json, env_json, cwd, enabled, capabilities_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.adapterId ?? null,
      input.name,
      input.command,
      JSON.stringify(input.args ?? []),
      JSON.stringify(input.env ?? {}),
      input.cwd ?? null,
      input.enabled === false ? 0 : 1,
      JSON.stringify(input.capabilities ?? {}),
      at,
      at
    );
    return this.get(id)!;
  }

  updateReadiness(id: string, status: string, checkedAt = nowIso()): AgentRecord {
    db.prepare(
      `UPDATE agents SET last_readiness_status = ?, last_readiness_checked_at = ?, updated_at = ? WHERE id = ?`
    ).run(status, checkedAt, checkedAt, id);
    return this.get(id)!;
  }

  updateRuntimeMetadata(
    id: string,
    input: {
      adapterId?: string;
      capabilities?: Record<string, unknown>;
      readinessStatus?: string;
      checkedAt?: string;
    }
  ): AgentRecord {
    const at = input.checkedAt ?? nowIso();
    db.prepare(
      `UPDATE agents
       SET adapter_id = COALESCE(?, adapter_id),
           capabilities_json = COALESCE(?, capabilities_json),
           last_readiness_status = COALESCE(?, last_readiness_status),
           last_readiness_checked_at = COALESCE(?, last_readiness_checked_at),
           updated_at = ?
       WHERE id = ?`
    ).run(
      input.adapterId ?? null,
      input.capabilities ? JSON.stringify(input.capabilities) : null,
      input.readinessStatus ?? null,
      input.checkedAt ?? at,
      at,
      id
    );
    return this.get(id)!;
  }
}

export class McpServerRepository {
  list(): McpServerRecord[] {
    return db
      .prepare(
        `SELECT id, name, command, args_json, env_json, status, last_error, created_at, updated_at
         FROM mcp_servers ORDER BY created_at ASC`
      )
      .all()
      .map((row: any) => ({
        id: row.id,
        name: row.name,
        command: row.command,
        args: parseJson<string[]>(row.args_json),
        env: parseJson<Record<string, string>>(row.env_json),
        status: row.status,
        lastError: row.last_error ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
  }

  get(id: string): McpServerRecord | null {
    return this.list().find((server) => server.id === id) ?? null;
  }

  create(input: {
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }): McpServerRecord {
    const id = newId("mcp");
    const at = nowIso();
    db.prepare(
      `INSERT INTO mcp_servers (id, name, command, args_json, env_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.name,
      input.command,
      JSON.stringify(input.args ?? []),
      JSON.stringify(input.env ?? {}),
      "configured",
      at,
      at
    );
    return this.list().find((server) => server.id === id)!;
  }

  updateStatus(id: string, status: McpServerRecord["status"], lastError?: string): McpServerRecord {
    db.prepare(`UPDATE mcp_servers SET status = ?, last_error = ?, updated_at = ? WHERE id = ?`).run(
      status,
      lastError ?? null,
      nowIso(),
      id
    );
    return this.get(id)!;
  }

  replaceTools(serverId: string, tools: Array<{ name: string; description?: string; inputSchema?: unknown }>): void {
    const at = nowIso();
    db.prepare(`DELETE FROM mcp_tools WHERE server_id = ?`).run(serverId);
    const insert = db.prepare(
      `INSERT INTO mcp_tools (
        id, server_id, name, description, input_schema_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const tool of tools) {
      insert.run(
        newId("tool"),
        serverId,
        tool.name,
        tool.description ?? "",
        JSON.stringify(tool.inputSchema ?? {}),
        at,
        at
      );
    }
  }

  tools(serverId?: string): McpToolRecord[] {
    const sql = serverId
      ? `SELECT * FROM mcp_tools WHERE server_id = ? ORDER BY name ASC`
      : `SELECT * FROM mcp_tools ORDER BY server_id ASC, name ASC`;
    const rows = serverId ? db.prepare(sql).all(serverId) : db.prepare(sql).all();
    return rows.map((row: any) => ({
      id: row.id,
      serverId: row.server_id,
      name: row.name,
      description: row.description,
      inputSchema: parseJson<unknown>(row.input_schema_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  createToolCall(serverId: string, toolName: string, args: unknown, runId?: string): McpToolCallRecord {
    const id = newId("call");
    const at = nowIso();
    db.prepare(
      `INSERT INTO mcp_tool_calls (
        id, server_id, run_id, tool_name, arguments_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, serverId, runId ?? null, toolName, JSON.stringify(args ?? {}), "running", at, at);
    return this.toolCalls().find((call) => call.id === id)!;
  }

  completeToolCall(id: string, result: unknown): McpToolCallRecord {
    db.prepare(
      `UPDATE mcp_tool_calls
       SET status = 'completed', result_json = ?, error = NULL, updated_at = ?
       WHERE id = ?`
    ).run(JSON.stringify(result ?? null), nowIso(), id);
    return this.toolCalls().find((call) => call.id === id)!;
  }

  failToolCall(id: string, error: string): McpToolCallRecord {
    db.prepare(
      `UPDATE mcp_tool_calls
       SET status = 'failed', error = ?, updated_at = ?
       WHERE id = ?`
    ).run(error, nowIso(), id);
    return this.toolCalls().find((call) => call.id === id)!;
  }

  toolCalls(serverId?: string): McpToolCallRecord[] {
    const sql = serverId
      ? `SELECT * FROM mcp_tool_calls WHERE server_id = ? ORDER BY created_at DESC LIMIT 50`
      : `SELECT * FROM mcp_tool_calls ORDER BY created_at DESC LIMIT 50`;
    const rows = serverId ? db.prepare(sql).all(serverId) : db.prepare(sql).all();
    return rows.map((row: any) => ({
      id: row.id,
      serverId: row.server_id,
      runId: row.run_id ?? undefined,
      toolName: row.tool_name,
      arguments: parseJson<unknown>(row.arguments_json),
      status: row.status,
      result: row.result_json ? parseJson<unknown>(row.result_json) : undefined,
      error: row.error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }
}

export class RunRepository {
  list(): RunRecord[] {
    return db
      .prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT 100`)
      .all()
      .map(mapRun);
  }

  listByWorkspace(workspaceId: string, limit = 10): RunRecord[] {
    return db
      .prepare(`SELECT * FROM runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(workspaceId, limit)
      .map(mapRun);
  }

  get(id: string): RunRecord | null {
    const row = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as any;
    return row ? mapRun(row) : null;
  }

  create(input: {
    workspaceId: string;
    agentId: string;
    skillId?: string;
    title: string;
    prompt: string;
    cwd: string;
    maxRetries?: number;
    timeoutMs?: number;
    retrievalQuery?: string;
  }): RunRecord {
    const id = newId("run");
    const at = nowIso();
    db.prepare(
      `INSERT INTO runs (
        id, workspace_id, agent_id, skill_id, title, prompt, status, cwd,
        max_retries, timeout_ms, retrieval_query,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.workspaceId,
      input.agentId,
      input.skillId ?? null,
      input.title,
      input.prompt,
      "queued",
      input.cwd,
      Math.max(0, input.maxRetries ?? 0),
      Math.max(1000, input.timeoutMs ?? 120000),
      input.retrievalQuery ?? null,
      at,
      at
    );
    return this.get(id)!;
  }

  requeue(id: string, attempt: number): RunRecord {
    db.prepare(
      `UPDATE runs
       SET status = 'queued', attempt = ?, started_at = NULL, ended_at = NULL,
           exit_code = NULL, duration_ms = NULL, updated_at = ?
       WHERE id = ?`
    ).run(attempt, nowIso(), id);
    return this.get(id)!;
  }

  updateStatus(
    id: string,
    status: RunRecord["status"],
    patch: Partial<Pick<RunRecord, "startedAt" | "endedAt" | "exitCode" | "durationMs" | "summary">> = {}
  ): RunRecord {
    db.prepare(
      `UPDATE runs
       SET status = ?, started_at = COALESCE(?, started_at), ended_at = COALESCE(?, ended_at),
           exit_code = ?, duration_ms = ?, summary = COALESCE(?, summary), updated_at = ?
       WHERE id = ?`
    ).run(
      status,
      patch.startedAt ?? null,
      patch.endedAt ?? null,
      patch.exitCode ?? null,
      patch.durationMs ?? null,
      patch.summary ?? null,
      nowIso(),
      id
    );
    return this.get(id)!;
  }

  addFileRef(runId: string, filePath: string): void {
    db.prepare(
      `INSERT INTO run_file_refs (id, run_id, path, created_at) VALUES (?, ?, ?, ?)`
    ).run(newId("file"), runId, filePath, nowIso());
  }

  addEvent(runId: string, type: string, payload: unknown): RunEventRecord {
    const row = db
      .prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM run_events WHERE run_id = ?`)
      .get(runId) as { next_sequence: number };
    const event: RunEventRecord = {
      id: newId("evt"),
      runId,
      sequence: row.next_sequence,
      type,
      payload,
      createdAt: nowIso()
    };
    db.prepare(
      `INSERT INTO run_events (id, run_id, sequence, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(event.id, runId, event.sequence, event.type, JSON.stringify(payload), event.createdAt);
    return event;
  }

  events(runId: string): RunEventRecord[] {
    return db
      .prepare(
        `SELECT id, run_id, sequence, type, payload_json, created_at
         FROM run_events WHERE run_id = ? ORDER BY sequence ASC`
      )
      .all(runId)
      .map((row: any) => ({
        id: row.id,
        runId: row.run_id,
        sequence: row.sequence,
        type: row.type,
        payload: parseJson<unknown>(row.payload_json),
        createdAt: row.created_at
      }));
  }
}

export class RunArtifactRepository {
  get(id: string): RunArtifactRecord | null {
    const row = db.prepare(`SELECT * FROM run_artifacts WHERE id = ?`).get(id) as any;
    return row ? mapRunArtifact(row) : null;
  }

  list(runId: string): RunArtifactRecord[] {
    return db
      .prepare(`SELECT * FROM run_artifacts WHERE run_id = ? ORDER BY created_at DESC`)
      .all(runId)
      .map(mapRunArtifact);
  }

  listByWorkspace(workspaceId: string, limit = 100): RunArtifactRecord[] {
    return db
      .prepare(
        `SELECT a.*
         FROM run_artifacts a
         JOIN runs r ON r.id = a.run_id
         WHERE r.workspace_id = ?
         ORDER BY a.created_at DESC
         LIMIT ?`
      )
      .all(workspaceId, limit)
      .map(mapRunArtifact);
  }

  create(input: {
    runId: string;
    kind: RunArtifactRecord["kind"];
    name: string;
    mimeType: string;
    contentText?: string;
    filePath?: string;
    metadata?: Record<string, unknown>;
  }): RunArtifactRecord {
    const id = newId("artifact");
    const at = nowIso();
    db.prepare(
      `INSERT INTO run_artifacts (
        id, run_id, kind, name, mime_type, content_text, file_path, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.runId,
      input.kind,
      input.name,
      input.mimeType,
      input.contentText ?? null,
      input.filePath ?? null,
      JSON.stringify(input.metadata ?? {}),
      at
    );
    return this.list(input.runId).find((artifact) => artifact.id === id)!;
  }
}

export class TaskRepository {
  list(workspaceId?: string): TaskRecord[] {
    const rows = workspaceId
      ? db
          .prepare(`SELECT * FROM tasks WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 200`)
          .all(workspaceId)
      : db.prepare(`SELECT * FROM tasks ORDER BY created_at DESC LIMIT 200`).all();
    return rows.map(mapTask);
  }

  get(id: string): TaskRecord | null {
    const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as any;
    return row ? mapTask(row) : null;
  }

  create(input: {
    workspaceId: string;
    title: string;
    description?: string;
    priority?: TaskPriority;
    assignedAgentId?: string;
    sourceRunId?: string;
  }): TaskRecord {
    const id = newId("task");
    const at = nowIso();
    db.prepare(
      `INSERT INTO tasks (
        id, workspace_id, title, description, status, priority,
        assigned_agent_id, source_run_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.workspaceId,
      input.title.trim() || "Untitled task",
      input.description?.trim() ?? "",
      "todo",
      input.priority ?? "normal",
      input.assignedAgentId ?? null,
      input.sourceRunId ?? null,
      at,
      at
    );
    return this.get(id)!;
  }

  updateStatus(id: string, status: TaskStatus): TaskRecord {
    db.prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`).run(status, nowIso(), id);
    const task = this.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }
    return task;
  }
}

export class ApprovalRepository {
  list(workspaceId?: string): ApprovalRecord[] {
    const rows = workspaceId
      ? db
          .prepare(`SELECT * FROM approvals WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 200`)
          .all(workspaceId)
      : db.prepare(`SELECT * FROM approvals ORDER BY created_at DESC LIMIT 200`).all();
    return rows.map(mapApproval);
  }

  get(id: string): ApprovalRecord | null {
    const row = db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as any;
    return row ? mapApproval(row) : null;
  }

  create(input: {
    workspaceId: string;
    runId?: string;
    kind: ApprovalRecord["kind"];
    title: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }): ApprovalRecord {
    const id = newId("approval");
    const at = nowIso();
    db.prepare(
      `INSERT INTO approvals (
        id, workspace_id, run_id, kind, title, description, status, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.workspaceId,
      input.runId ?? null,
      input.kind,
      input.title.trim() || "Review required",
      input.description?.trim() ?? "",
      "pending",
      JSON.stringify(input.metadata ?? {}),
      at,
      at
    );
    return this.get(id)!;
  }

  decide(id: string, status: ApprovalRecord["status"]): ApprovalRecord {
    if (status === "pending") {
      throw new Error("Approval decision must be approved or rejected");
    }
    db.prepare(`UPDATE approvals SET status = ?, updated_at = ? WHERE id = ?`).run(status, nowIso(), id);
    const approval = this.get(id);
    if (!approval) {
      throw new Error(`Approval not found: ${id}`);
    }
    return approval;
  }
}

export class WorkspaceReferenceRepository {
  get(id: string): WorkspaceReferenceRecord | null {
    const row = db.prepare(`SELECT * FROM workspace_references WHERE id = ?`).get(id) as any;
    return row ? mapWorkspaceReference(row) : null;
  }

  list(workspaceId?: string): WorkspaceReferenceRecord[] {
    const rows = workspaceId
      ? db
          .prepare(`SELECT * FROM workspace_references WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 200`)
          .all(workspaceId)
      : db.prepare(`SELECT * FROM workspace_references ORDER BY created_at DESC LIMIT 200`).all();
    return rows.map(mapWorkspaceReference);
  }

  create(input: {
    workspaceId: string;
    kind: WorkspaceReferenceRecord["kind"];
    targetId: string;
    label: string;
    summary?: string;
    metadata?: Record<string, unknown>;
  }): WorkspaceReferenceRecord {
    const id = newId("ref");
    const at = nowIso();
    db.prepare(
      `INSERT INTO workspace_references (
        id, workspace_id, kind, target_id, label, summary, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.workspaceId,
      input.kind,
      input.targetId,
      input.label.trim() || input.targetId,
      input.summary?.trim() ?? "",
      JSON.stringify(input.metadata ?? {}),
      at
    );
    return this.list(input.workspaceId).find((reference) => reference.id === id)!;
  }
}

export class MemoryRepository {
  getWorkspaceMemory(id: string): WorkspaceMemoryRecord | null {
    const row = db.prepare(`SELECT * FROM workspace_memories WHERE id = ?`).get(id) as any;
    return row ? mapWorkspaceMemory(row) : null;
  }

  createWorkspaceMemory(input: {
    workspaceId: string;
    type: MemoryType;
    content: string;
    sourceRunId?: string;
  }): WorkspaceMemoryRecord {
    const id = newId("mem");
    const at = nowIso();
    db.prepare(
      `INSERT INTO workspace_memories (
        id, workspace_id, type, content, source_run_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, input.workspaceId, input.type, input.content, input.sourceRunId ?? null, at, at);
    return this.listWorkspaceMemories(input.workspaceId).find((memory) => memory.id === id)!;
  }

  listWorkspaceMemories(workspaceId: string): WorkspaceMemoryRecord[] {
    return db
      .prepare(`SELECT * FROM workspace_memories WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100`)
      .all(workspaceId)
      .map(mapWorkspaceMemory);
  }

  searchWorkspaceMemories(workspaceId: string, query: string, limit = 5): WorkspaceMemoryRecord[] {
    const terms = tokenize(query);
    if (terms.length === 0) {
      return this.listWorkspaceMemories(workspaceId).slice(0, limit);
    }
    return this.listWorkspaceMemories(workspaceId)
      .map((memory) => ({
        memory,
        score: terms.reduce(
          (sum, term) => sum + countOccurrences(`${memory.type}\n${memory.content}`.toLowerCase(), term),
          0
        )
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || b.memory.createdAt.localeCompare(a.memory.createdAt))
      .slice(0, limit)
      .map((candidate) => candidate.memory);
  }

  createRunWorkingMemory(runId: string, content: string, budgetChars: number): RunWorkingMemoryRecord {
    db.prepare(`DELETE FROM run_working_memory WHERE run_id = ?`).run(runId);
    const id = newId("wm");
    const at = nowIso();
    db.prepare(
      `INSERT INTO run_working_memory (id, run_id, content, budget_chars, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, runId, content.slice(0, budgetChars), budgetChars, at);
    return this.getRunWorkingMemory(runId)!;
  }

  getRunWorkingMemory(runId: string): RunWorkingMemoryRecord | null {
    const row = db
      .prepare(`SELECT * FROM run_working_memory WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(runId) as any;
    return row
      ? {
          id: row.id,
          runId: row.run_id,
          content: row.content,
          budgetChars: row.budget_chars,
          createdAt: row.created_at
        }
      : null;
  }
}

function mapWorkspaceMemory(row: any): WorkspaceMemoryRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.type,
    content: row.content,
    sourceRunId: row.source_run_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapRun(row: any): RunRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    skillId: row.skill_id ?? undefined,
    title: row.title,
    prompt: row.prompt,
    status: row.status,
    cwd: row.cwd,
    attempt: row.attempt ?? 1,
    maxRetries: row.max_retries ?? 0,
    timeoutMs: row.timeout_ms ?? 120000,
    retrievalQuery: row.retrieval_query ?? undefined,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    exitCode: row.exit_code,
    durationMs: row.duration_ms,
    summary: row.summary ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapRunArtifact(row: any): RunArtifactRecord {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    name: row.name,
    mimeType: row.mime_type,
    contentText: row.content_text ?? undefined,
    filePath: row.file_path ?? undefined,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json),
    createdAt: row.created_at
  };
}

function mapTask(row: any): TaskRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assignedAgentId: row.assigned_agent_id ?? undefined,
    sourceRunId: row.source_run_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapApproval(row: any): ApprovalRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id ?? undefined,
    kind: row.kind,
    title: row.title,
    description: row.description,
    status: row.status,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapWorkspaceReference(row: any): WorkspaceReferenceRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    targetId: row.target_id,
    label: row.label,
    summary: row.summary,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json),
    createdAt: row.created_at
  };
}

export class WorkspaceIndexRepository {
  replaceWorkspaceIndex(
    workspaceId: string,
    entries: Array<{ path: string; size: number; modifiedAt: string; content: string }>
  ): number {
    db.prepare(`DELETE FROM workspace_index WHERE workspace_id = ?`).run(workspaceId);
    const at = nowIso();
    const insert = db.prepare(
      `INSERT INTO workspace_index (
        id, workspace_id, path, size, modified_at, content, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const entry of entries) {
      insert.run(
        newId("idx"),
        workspaceId,
        entry.path,
        entry.size,
        entry.modifiedAt,
        entry.content,
        at,
        at
      );
    }
    return entries.length;
  }

  list(workspaceId: string): WorkspaceIndexRecord[] {
    return db
      .prepare(`SELECT * FROM workspace_index WHERE workspace_id = ? ORDER BY path ASC`)
      .all(workspaceId)
      .map((row: any) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        path: row.path,
        size: row.size,
        modifiedAt: row.modified_at,
        content: row.content,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
  }

  search(workspaceId: string, query: string, limit = 5): RetrievalHit[] {
    const terms = tokenize(query);
    if (terms.length === 0) {
      return [];
    }
    return this.list(workspaceId)
      .map((entry) => {
        const haystack = `${entry.path}\n${entry.content}`.toLowerCase();
        const score = terms.reduce((sum, term) => sum + countOccurrences(haystack, term), 0);
        return {
          path: entry.path,
          score,
          snippet: makeSnippet(entry.content, terms)
        };
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, limit);
  }
}

function tokenize(query: string): string[] {
  return Array.from(new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])).slice(0, 12);
}

function countOccurrences(text: string, term: string): number {
  let count = 0;
  let index = text.indexOf(term);
  while (index >= 0) {
    count += 1;
    index = text.indexOf(term, index + term.length);
  }
  return count;
}

function makeSnippet(content: string, terms: string[]): string {
  const lower = content.toLowerCase();
  const firstHit = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstHit - 160);
  return content.slice(start, start + 520).trim();
}
