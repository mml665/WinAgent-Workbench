import type { RunRecord } from "../../shared/types";
import { EventBus } from "../eventBus";
import { AgentRepository, McpServerRepository, RunRepository, WorkspaceRepository } from "../repositories";
import { nowIso } from "../utils/time";
import { AgentProcessManager } from "./agentProcessManager";
import { ContextProvider } from "./contextProvider";
import { RunQueue } from "./runQueue";
import { SkillRegistry } from "./skillRegistry";
import { WorkspaceIndexService } from "./workspaceIndexService";

export class RunService {
  constructor(
    private readonly runs: RunRepository,
    private readonly workspaces: WorkspaceRepository,
    private readonly agents: AgentRepository,
    private readonly mcpServers: McpServerRepository,
    private readonly skills: SkillRegistry,
    private readonly contextProvider: ContextProvider,
    private readonly workspaceIndex: WorkspaceIndexService,
    private readonly processManager: AgentProcessManager,
    private readonly queue: RunQueue,
    private readonly events: EventBus
  ) {}

  list(): RunRecord[] {
    return this.runs.list();
  }

  eventsForRun(runId: string, afterSequence = 0) {
    return this.runs.events(runId).filter((event) => event.sequence > afterSequence);
  }

  create(input: {
    workspaceId: string;
    agentId: string;
    skillId?: string;
    title: string;
    prompt: string;
    fileRefs?: string[];
    maxRetries?: number;
    timeoutMs?: number;
    retrievalQuery?: string;
  }): RunRecord {
    const workspace = this.workspaces.get(input.workspaceId);
    const agent = this.agents.get(input.agentId);
    if (!workspace || !agent) {
      throw new Error("Workspace and Agent are required");
    }
    const run = this.runs.create({
      workspaceId: workspace.id,
      agentId: agent.id,
      skillId: input.skillId,
      title: input.title || input.prompt.slice(0, 80) || "Untitled run",
      prompt: input.prompt,
      cwd: agent.cwd || workspace.rootPath,
      maxRetries: input.maxRetries,
      timeoutMs: input.timeoutMs,
      retrievalQuery: input.retrievalQuery
    });
    for (const ref of input.fileRefs ?? []) {
      this.runs.addFileRef(run.id, ref);
      this.events.publish(run.id, "run.file.referenced", { path: ref });
    }
    this.events.publish(run.id, "run.status.changed", { status: "queued" });
    this.queue.enqueue({
      run,
      execute: () => this.execute(run.id, input.fileRefs ?? [])
    });
    return run;
  }

  cancel(runId: string): RunRecord {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    const removed = this.queue.cancel(runId);
    const killed = this.processManager.cancel(runId);
    if ((removed || !killed) && run.status === "queued") {
      const cancelled = this.runs.updateStatus(runId, "cancelled", { endedAt: nowIso() });
      this.events.publish(runId, "run.cancelled", { reason: "cancelled before start" });
      this.events.publish(runId, "run.status.changed", { status: "cancelled" });
      return cancelled;
    }
    this.events.publish(runId, "run.status.changed", { status: "cancelling" });
    return run;
  }

  private execute(runId: string, fileRefs: string[]): void {
    const run = this.runs.get(runId);
    if (!run || run.status === "cancelled") {
      return;
    }
    const workspace = this.workspaces.get(run.workspaceId)!;
    const agent = this.agents.get(run.agentId)!;
    const skill = this.skills.get(run.skillId);
    const mcpNames = this.mcpServers.list().map((server) => server.name);
    const startedAt = nowIso();
    const running = this.runs.updateStatus(run.id, "running", { startedAt });
    this.events.publish(run.id, "run.started", { startedAt, agent: agent.name });
    this.events.publish(run.id, "run.status.changed", { status: "running" });
    const retrievalHits = run.retrievalQuery
      ? this.workspaceIndex.search(workspace.id, run.retrievalQuery, 5)
      : this.workspaceIndex.search(workspace.id, run.prompt, 5);
    const prompt = this.contextProvider.buildPrompt({
      workspace,
      skill,
      prompt: run.prompt,
      fileRefs,
      mcpServerNames: mcpNames,
      retrievalHits
    });
    const started = Date.now();
    let output = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      this.events.publish(run.id, "run.failed", { error: "run timed out", timeoutMs: running.timeoutMs });
      this.processManager.cancel(run.id);
    }, running.timeoutMs);
    this.processManager.start(running, agent, prompt, {
      onStdout: (chunk) => {
        output += chunk;
        this.events.publish(run.id, "run.output.delta", { text: chunk });
      },
      onStderr: (chunk) => {
        stderr += chunk;
        this.events.publish(run.id, "run.error.delta", { text: chunk });
      },
      onError: (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        const endedAt = nowIso();
        this.runs.updateStatus(run.id, "failed", {
          endedAt,
          durationMs: Date.now() - started,
          summary: error.message
        });
        this.events.publish(run.id, "run.failed", { error: error.message, endedAt });
        this.queue.complete(running);
      },
      onExit: ({ code, signal }) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        const endedAt = nowIso();
        const durationMs = Date.now() - started;
        const status = code === 0 && !timedOut ? "completed" : signal && !timedOut ? "cancelled" : "failed";
        if (status === "failed" && running.attempt <= running.maxRetries) {
          const nextAttempt = running.attempt + 1;
          const retried = this.runs.requeue(run.id, nextAttempt);
          this.events.publish(run.id, "run.status.changed", {
            status: "queued",
            reason: "retry",
            attempt: nextAttempt,
            maxRetries: running.maxRetries
          });
          this.queue.complete(running);
          this.queue.enqueue({
            run: retried,
            execute: () => this.execute(run.id, fileRefs)
          });
          return;
        }
        this.runs.updateStatus(run.id, status, {
          endedAt,
          exitCode: code,
          durationMs,
          summary: summarize(output, stderr)
        });
        if (status === "completed") {
          this.events.publish(run.id, "run.completed", { code, endedAt, durationMs });
        } else if (status === "cancelled") {
          this.events.publish(run.id, "run.cancelled", { signal, endedAt, durationMs });
        } else {
          this.events.publish(run.id, "run.failed", { code, endedAt, durationMs });
        }
        this.events.publish(run.id, "run.status.changed", { status });
        this.queue.complete(running);
      }
    });
  }
}

function summarize(stdout: string, stderr: string): string {
  const text = (stdout || stderr).trim().replace(/\s+/g, " ");
  return text.slice(0, 240);
}
