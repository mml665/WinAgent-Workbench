import type {
  AgentRecord,
  McpServerRecord,
  McpToolCallRecord,
  McpToolRecord,
  RetrievalHit,
  RunEventRecord,
  RunRecord,
  WorkspaceIndexRecord,
  WorkspaceRecord
} from "../shared/types";
import { db } from "./db";
import { newId } from "./utils/ids";
import { nowIso } from "./utils/time";

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
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

export class AgentRepository {
  list(): AgentRecord[] {
    return db
      .prepare(
        `SELECT id, name, command, args_json, env_json, cwd, created_at, updated_at
         FROM agents ORDER BY created_at ASC`
      )
      .all()
      .map((row: any) => ({
        id: row.id,
        name: row.name,
        command: row.command,
        args: parseJson<string[]>(row.args_json),
        env: parseJson<Record<string, string>>(row.env_json),
        cwd: row.cwd ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
  }

  get(id: string): AgentRecord | null {
    return this.list().find((agent) => agent.id === id) ?? null;
  }

  create(input: {
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
  }): AgentRecord {
    const id = newId("agent");
    const at = nowIso();
    db.prepare(
      `INSERT INTO agents (id, name, command, args_json, env_json, cwd, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.name,
      input.command,
      JSON.stringify(input.args ?? []),
      JSON.stringify(input.env ?? {}),
      input.cwd ?? null,
      at,
      at
    );
    return this.get(id)!;
  }

  ensureDefault(): void {
    if (this.list().length > 0) {
      return;
    }
    this.create({
      name: "PowerShell Demo Agent",
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "$prompt = [Console]::In.ReadToEnd(); Write-Output 'Agent received prompt:'; Write-Output $prompt; Write-Output 'WINAGENT_DONE'"
      ],
      env: {}
    });
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

  createToolCall(serverId: string, toolName: string, args: unknown): McpToolCallRecord {
    const id = newId("call");
    const at = nowIso();
    db.prepare(
      `INSERT INTO mcp_tool_calls (
        id, server_id, tool_name, arguments_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, serverId, toolName, JSON.stringify(args ?? {}), "running", at, at);
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
