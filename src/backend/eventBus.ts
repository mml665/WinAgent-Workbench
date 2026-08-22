import { EventEmitter } from "node:events";
import type { RunEvent } from "../shared/events";
import { RunRepository } from "./repositories";

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor(private readonly runs: RunRepository) {}

  publish(runId: string, type: RunEvent["type"], payload: Record<string, unknown>): RunEvent {
    const stored = this.runs.addEvent(runId, type, payload);
    const event: RunEvent = {
      id: stored.id,
      runId: stored.runId,
      sequence: stored.sequence,
      type,
      payload,
      createdAt: stored.createdAt
    };
    this.emitter.emit("run.event", event);
    return event;
  }

  onRunEvent(listener: (event: RunEvent) => void): () => void {
    this.emitter.on("run.event", listener);
    return () => this.emitter.off("run.event", listener);
  }
}
