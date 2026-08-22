import type { RunStatus } from "./types";

export type RunEventType =
  | "run.started"
  | "run.output.delta"
  | "run.error.delta"
  | "run.status.changed"
  | "run.tool.called"
  | "run.file.referenced"
  | "run.completed"
  | "run.failed"
  | "run.cancelled";

export interface RunEvent {
  id: string;
  runId: string;
  sequence: number;
  type: RunEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface WebSocketEnvelope {
  kind: "run.event" | "server.ready";
  event?: RunEvent;
  status?: RunStatus;
}

export function isRunTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
