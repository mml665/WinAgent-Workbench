export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkspaceRecord {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
}

export interface AgentRecord {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  instructions: string;
}

export interface McpServerRecord {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  status: "configured" | "running" | "error" | "stopped";
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  id: string;
  workspaceId: string;
  agentId: string;
  skillId?: string;
  title: string;
  prompt: string;
  status: RunStatus;
  cwd: string;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number | null;
  durationMs?: number | null;
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunFileRef {
  id: string;
  runId: string;
  path: string;
  createdAt: string;
}

export interface RunEventRecord {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface FileEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
  modifiedAt: string;
}
