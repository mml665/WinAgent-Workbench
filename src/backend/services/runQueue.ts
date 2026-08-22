import type { RunRecord } from "../../shared/types";

interface QueueItem {
  run: RunRecord;
  execute(): void;
}

export class RunQueue {
  private readonly pending: QueueItem[] = [];
  private readonly activeByWorkspace = new Map<string, number>();
  private readonly activeByAgent = new Map<string, number>();

  constructor(
    private readonly maxRunsPerWorkspace = 2,
    private readonly maxRunsPerAgent = 1
  ) {}

  enqueue(item: QueueItem): void {
    this.pending.push(item);
    this.pump();
  }

  cancel(runId: string): boolean {
    const index = this.pending.findIndex((item) => item.run.id === runId);
    if (index < 0) {
      return false;
    }
    this.pending.splice(index, 1);
    return true;
  }

  complete(run: RunRecord): void {
    this.activeByWorkspace.set(
      run.workspaceId,
      Math.max(0, (this.activeByWorkspace.get(run.workspaceId) ?? 0) - 1)
    );
    this.activeByAgent.set(run.agentId, Math.max(0, (this.activeByAgent.get(run.agentId) ?? 0) - 1));
    this.pump();
  }

  private pump(): void {
    for (let index = 0; index < this.pending.length; index += 1) {
      const item = this.pending[index];
      if (!this.canStart(item.run)) {
        continue;
      }
      this.pending.splice(index, 1);
      this.activeByWorkspace.set(
        item.run.workspaceId,
        (this.activeByWorkspace.get(item.run.workspaceId) ?? 0) + 1
      );
      this.activeByAgent.set(item.run.agentId, (this.activeByAgent.get(item.run.agentId) ?? 0) + 1);
      item.execute();
      index -= 1;
    }
  }

  private canStart(run: RunRecord): boolean {
    return (
      (this.activeByWorkspace.get(run.workspaceId) ?? 0) < this.maxRunsPerWorkspace &&
      (this.activeByAgent.get(run.agentId) ?? 0) < this.maxRunsPerAgent
    );
  }
}
