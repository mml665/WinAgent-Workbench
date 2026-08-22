import type {
  AgentRecord,
  McpServerRecord,
  RunEventRecord,
  RunRecord,
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
        `SELECT id, name, command, args_json, env_json, status, created_at, updated_at
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
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
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
  }): RunRecord {
    const id = newId("run");
    const at = nowIso();
    db.prepare(
      `INSERT INTO runs (
        id, workspace_id, agent_id, skill_id, title, prompt, status, cwd,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.workspaceId,
      input.agentId,
      input.skillId ?? null,
      input.title,
      input.prompt,
      "queued",
      input.cwd,
      at,
      at
    );
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
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    exitCode: row.exit_code,
    durationMs: row.duration_ms,
    summary: row.summary ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
