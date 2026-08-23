import path from "node:path";
import type { RunRecord, RunToolCallRequest, WorkspaceReferenceRecord } from "../../shared/types";
import { EventBus } from "../eventBus";
import {
  AgentRepository,
  ApprovalRepository,
  McpServerRepository,
  RunArtifactRepository,
  RunRepository,
  TaskRepository,
  WorkspaceReferenceRepository,
  WorkspaceRepository
} from "../repositories";
import { nowIso } from "../utils/time";
import { isPathInside, normalizeHostPath } from "../utils/windowsPaths";
import { AgentProcessManager } from "./agentProcessManager";
import { ContextProvider } from "./contextProvider";
import { RunQueue } from "./runQueue";
import { SkillRegistry } from "./skillRegistry";
import { WorkspaceIndexService } from "./workspaceIndexService";
import { McpServerService } from "./mcpServerService";
import { MemoryService } from "./memoryService";

export class RunService {
  constructor(
    private readonly runs: RunRepository,
    private readonly workspaces: WorkspaceRepository,
    private readonly agents: AgentRepository,
    private readonly mcpServers: McpServerRepository,
    private readonly skills: SkillRegistry,
    private readonly mcpService: McpServerService,
    private readonly memory: MemoryService,
    private readonly artifacts: RunArtifactRepository,
    private readonly approvals: ApprovalRepository,
    private readonly references: WorkspaceReferenceRepository,
    private readonly tasks: TaskRepository,
    private readonly contextProvider: ContextProvider,
    private readonly workspaceIndex: WorkspaceIndexService,
    private readonly processManager: AgentProcessManager,
    private readonly queue: RunQueue,
    private readonly events: EventBus
  ) {}

  list(): RunRecord[] {
    return this.runs.list();
  }

  get(runId: string): RunRecord {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    return run;
  }

  eventsForRun(runId: string, afterSequence = 0) {
    return this.runs.events(runId).filter((event) => event.sequence > afterSequence);
  }

  artifactsForRun(runId: string) {
    return this.artifacts.list(runId);
  }

  exportMarkdown(runId: string): string {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    const events = this.runs.events(runId);
    const stdout = events
      .filter((event) => event.type === "run.output.delta")
      .map((event) => String((event.payload as any).text ?? ""))
      .join("");
    const stderr = events
      .filter((event) => event.type === "run.error.delta")
      .map((event) => String((event.payload as any).text ?? ""))
      .join("");
    const workingMemory = this.memory.getRunWorkingMemory(runId);
    const eventTable = events
      .map((event) => `| ${event.sequence} | ${event.type} | ${event.createdAt} |`)
      .join("\n");
    return [
      `# Run Report: ${run.title}`,
      "",
      `- Run ID: ${run.id}`,
      `- Status: ${run.status}`,
      `- Attempt: ${run.attempt}/${run.maxRetries + 1}`,
      `- Timeout: ${run.timeoutMs} ms`,
      `- Created: ${run.createdAt}`,
      `- Started: ${run.startedAt ?? "-"}`,
      `- Ended: ${run.endedAt ?? "-"}`,
      `- Duration: ${run.durationMs ?? "-"} ms`,
      `- Exit code: ${run.exitCode ?? "-"}`,
      "",
      "## Prompt",
      "",
      "```text",
      run.prompt,
      "```",
      "",
      "## Short-Term Working Memory",
      "",
      "```text",
      workingMemory?.content.trim() || "(empty)",
      "```",
      "",
      "## Events",
      "",
      "| Seq | Type | Time |",
      "| --- | --- | --- |",
      eventTable,
      "",
      "## Stdout",
      "",
      "```text",
      stdout.trim() || "(empty)",
      "```",
      "",
      "## Stderr",
      "",
      "```text",
      stderr.trim() || "(empty)",
      "```"
    ].join("\n");
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
    toolCalls?: RunToolCallRequest[];
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
      execute: () => {
        void this.execute(run.id, input.fileRefs ?? [], input.toolCalls ?? []);
      }
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

  private async execute(runId: string, fileRefs: string[], toolCalls: RunToolCallRequest[]): Promise<void> {
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
    const longTermMemories = this.memory.searchLongTerm(
      workspace.id,
      run.retrievalQuery || run.prompt,
      5
    );
    const mentionResolution = this.resolveMentionContext(run.prompt, workspace.id, workspace.rootPath);
    if (mentionResolution.context || mentionResolution.unresolved.length > 0) {
      this.events.publish(run.id, "run.mentions.resolved", {
        resolved: mentionResolution.resolved,
        unresolved: mentionResolution.unresolved,
        fileRefs: mentionResolution.fileRefs
      });
    }
    const toolResults = [];
    for (const request of toolCalls) {
      const server = this.mcpServers.get(request.serverId);
      let toolResult;
      let callId: string | undefined;
      try {
        const call = await this.mcpService.callTool(request.serverId, request.toolName, request.arguments, {
          runId: run.id
        });
        callId = call.id;
        toolResult = {
          serverName: server?.name ?? request.serverId,
          toolName: request.toolName,
          status: call.status,
          result: call.result,
          error: call.error
        };
      } catch (error) {
        toolResult = {
          serverName: server?.name ?? request.serverId,
          toolName: request.toolName,
          status: "failed",
          error: error instanceof Error ? error.message : String(error)
        };
      }
      toolResults.push(toolResult);
      this.events.publish(run.id, "run.tool.called", {
        serverId: request.serverId,
        serverName: toolResult.serverName,
        toolName: request.toolName,
        status: toolResult.status,
        callId
      });
    }
    const prompt = this.contextProvider.buildPrompt({
      workspace,
      skill,
      prompt: run.prompt,
      fileRefs: uniqueStrings([...fileRefs, ...mentionResolution.fileRefs]),
      mcpServerNames: mcpNames,
      retrievalHits,
      shortTermMemory: this.memory.buildWorkingMemory({
        run,
        retrievalHits,
        toolResults,
        longTermMemories
      }),
      longTermMemories,
      mentionContext: mentionResolution.context,
      toolResults
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
        const failed = this.runs.updateStatus(run.id, "failed", {
          endedAt,
          durationMs: Date.now() - started,
          summary: error.message
        });
        this.memory.rememberRunOutcome(failed);
        this.recordTerminalArtifacts(failed, output, error.message);
        this.recordFailedApproval(failed, error.message);
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
            execute: () => {
              void this.execute(run.id, fileRefs, toolCalls);
            }
          });
          return;
        }
        const finished = this.runs.updateStatus(run.id, status, {
          endedAt,
          exitCode: code,
          durationMs,
          summary: summarize(output, stderr)
        });
        this.memory.rememberRunOutcome(finished);
        this.recordTerminalArtifacts(finished, output, stderr);
        if (status === "failed") {
          this.recordFailedApproval(finished, stderr || finished.summary || "Run failed.");
        }
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

  private recordTerminalArtifacts(run: RunRecord, stdout: string, stderr: string): void {
    const content = stdout.trim() || stderr.trim() || run.summary?.trim();
    if (!content) {
      return;
    }
    const existing = this.artifacts
      .list(run.id)
      .some((artifact) => artifact.metadata.source === "run-terminal-output");
    if (existing) {
      return;
    }
    const artifact = this.artifacts.create({
      runId: run.id,
      kind: "markdown",
      name: `${run.title} output`,
      mimeType: "text/markdown;charset=utf-8",
      contentText: [
        `# ${run.title}`,
        "",
        `- Run: ${run.id}`,
        `- Status: ${run.status}`,
        "",
        "## Output",
        "",
        "```text",
        content,
        "```"
      ].join("\n"),
      metadata: {
        source: "run-terminal-output",
        status: run.status,
        summary: run.summary ?? ""
      }
    });
    this.references.create({
      workspaceId: run.workspaceId,
      kind: "artifact",
      targetId: artifact.id,
      label: artifact.name,
      summary: run.summary ?? content.slice(0, 180),
      metadata: { runId: run.id, mimeType: artifact.mimeType }
    });
  }

  private recordFailedApproval(run: RunRecord, description: string): void {
    const exists = this.approvals
      .list(run.workspaceId)
      .some((approval) => approval.runId === run.id && approval.kind === "failed_run");
    if (exists) {
      return;
    }
    this.approvals.create({
      workspaceId: run.workspaceId,
      runId: run.id,
      kind: "failed_run",
      title: `Review failed run: ${run.title}`,
      description,
      metadata: { runId: run.id, status: run.status, exitCode: run.exitCode }
    });
  }

  private resolveMentionContext(
    prompt: string,
    workspaceId: string,
    workspaceRoot: string
  ): {
    context: string;
    fileRefs: string[];
    resolved: Array<{ uri: string; kind: string; id: string }>;
    unresolved: Array<{ uri: string; reason: string }>;
  } {
    const uris = extractMentionUris(prompt);
    if (uris.length === 0) {
      return { context: "", fileRefs: [], resolved: [], unresolved: [] };
    }

    const chunks: string[] = [];
    const fileRefs: string[] = [];
    const resolved: Array<{ uri: string; kind: string; id: string }> = [];
    const unresolved: Array<{ uri: string; reason: string }> = [];

    for (const uri of uris) {
      const parsed = parseMentionUri(uri);
      if (!parsed) {
        unresolved.push({ uri, reason: "Unsupported mention URI" });
        continue;
      }
      const result = this.describeMentionTarget(parsed.kind, parsed.id, workspaceId, workspaceRoot);
      if (!result) {
        unresolved.push({ uri, reason: "Target not found or outside workspace" });
        continue;
      }
      resolved.push({ uri, kind: parsed.kind, id: parsed.id });
      chunks.push(result.context);
      fileRefs.push(...result.fileRefs);
    }

    if (unresolved.length > 0) {
      chunks.push(
        [
          "## Unresolved mentions",
          ...unresolved.map((item) => `- ${item.uri}: ${item.reason}`)
        ].join("\n")
      );
    }

    return {
      context: chunks.join("\n\n"),
      fileRefs: uniqueStrings(fileRefs),
      resolved,
      unresolved
    };
  }

  private describeMentionTarget(
    kind: string,
    id: string,
    workspaceId: string,
    workspaceRoot: string
  ): { context: string; fileRefs: string[] } | null {
    if (kind === "workspace-reference") {
      const reference = this.references.get(id);
      if (!reference || reference.workspaceId !== workspaceId) {
        return null;
      }
      const target = this.describeMentionTarget(reference.kind, reference.targetId, workspaceId, workspaceRoot);
      return {
        context: [
          `## Workspace reference: ${reference.label}`,
          `Kind: ${reference.kind}`,
          `Reference ID: ${reference.id}`,
          `Target ID: ${reference.targetId}`,
          reference.summary ? `Summary: ${reference.summary}` : "",
          formatMetadata(reference.metadata),
          target?.context ? "\n### Resolved target\n" + target.context : ""
        ]
          .filter(Boolean)
          .join("\n"),
        fileRefs: target?.fileRefs ?? []
      };
    }

    if (kind === "run") {
      const run = this.runs.get(id);
      if (!run || run.workspaceId !== workspaceId) {
        return null;
      }
      const events = this.runs.events(run.id);
      const output = events
        .filter((event) => event.type === "run.output.delta")
        .map((event) => String((event.payload as any).text ?? ""))
        .join("");
      const errors = events
        .filter((event) => event.type === "run.error.delta")
        .map((event) => String((event.payload as any).text ?? ""))
        .join("");
      return {
        context: [
          `## Run: ${run.title}`,
          `Run ID: ${run.id}`,
          `Status: ${run.status}`,
          `Agent ID: ${run.agentId}`,
          `Created: ${run.createdAt}`,
          run.summary ? `Summary: ${run.summary}` : "",
          "Prompt:",
          "```text",
          truncate(run.prompt, 1200),
          "```",
          output.trim()
            ? ["Output excerpt:", "```text", truncate(output.trim(), 3000), "```"].join("\n")
            : "",
          errors.trim()
            ? ["Error excerpt:", "```text", truncate(errors.trim(), 2000), "```"].join("\n")
            : ""
        ]
          .filter(Boolean)
          .join("\n"),
        fileRefs: []
      };
    }

    if (kind === "task") {
      const task = this.tasks.get(id);
      if (!task || task.workspaceId !== workspaceId) {
        return null;
      }
      return {
        context: [
          `## Task: ${task.title}`,
          `Task ID: ${task.id}`,
          `Status: ${task.status}`,
          `Priority: ${task.priority}`,
          task.assignedAgentId ? `Assigned Agent ID: ${task.assignedAgentId}` : "",
          task.sourceRunId ? `Source Run ID: ${task.sourceRunId}` : "",
          task.description ? `Description: ${task.description}` : ""
        ]
          .filter(Boolean)
          .join("\n"),
        fileRefs: []
      };
    }

    if (kind === "artifact") {
      const artifact = this.artifacts.get(id);
      if (!artifact) {
        return null;
      }
      const run = this.runs.get(artifact.runId);
      if (!run || run.workspaceId !== workspaceId) {
        return null;
      }
      const artifactFileRefs = artifact.filePath ? resolveMentionFileRef(artifact.filePath, workspaceRoot) : [];
      return {
        context: [
          `## Artifact: ${artifact.name}`,
          `Artifact ID: ${artifact.id}`,
          `Run ID: ${artifact.runId}`,
          `Kind: ${artifact.kind}`,
          `MIME: ${artifact.mimeType}`,
          artifact.filePath ? `File: ${artifact.filePath}` : "",
          formatMetadata(artifact.metadata),
          artifact.contentText
            ? ["Content excerpt:", "```", truncate(artifact.contentText, 4000), "```"].join("\n")
            : ""
        ]
          .filter(Boolean)
          .join("\n"),
        fileRefs: artifactFileRefs
      };
    }

    if (kind === "memory") {
      const memory = this.memory.getWorkspaceMemory(id);
      if (!memory || memory.workspaceId !== workspaceId) {
        return null;
      }
      return {
        context: [
          `## Memory: ${memory.type}`,
          `Memory ID: ${memory.id}`,
          memory.sourceRunId ? `Source Run ID: ${memory.sourceRunId}` : "",
          memory.content
        ]
          .filter(Boolean)
          .join("\n"),
        fileRefs: []
      };
    }

    if (kind === "agent") {
      const agent = this.agents.get(id);
      if (!agent) {
        return null;
      }
      return {
        context: [
          `## Agent: ${agent.name}`,
          `Agent ID: ${agent.id}`,
          `Command: ${agent.command}`,
          `Args: ${agent.args.join(" ") || "(none)"}`,
          `Enabled: ${agent.enabled ? "yes" : "no"}`,
          agent.lastReadinessStatus ? `Readiness: ${agent.lastReadinessStatus}` : ""
        ]
          .filter(Boolean)
          .join("\n"),
        fileRefs: []
      };
    }

    if (kind === "file") {
      const resolved = resolveMentionFileRef(id, workspaceRoot);
      if (resolved.length === 0) {
        return null;
      }
      return {
        context: [
          `## File reference`,
          `Path: ${path.relative(workspaceRoot, resolved[0]) || resolved[0]}`,
          "The file content is included in # Referenced Files."
        ].join("\n"),
        fileRefs: resolved
      };
    }

    return null;
  }
}

function summarize(stdout: string, stderr: string): string {
  const text = (stdout || stderr).trim().replace(/\s+/g, " ");
  return text.slice(0, 240);
}

function extractMentionUris(text: string): string[] {
  const uris = new Set<string>();
  for (const match of text.matchAll(/\]\((mention:\/\/[^)\s]+)\)/g)) {
    uris.add(cleanMentionUri(match[1]));
  }
  for (const match of text.matchAll(/mention:\/\/[^\s)]+/g)) {
    uris.add(cleanMentionUri(match[0]));
  }
  return [...uris].filter(Boolean);
}

function cleanMentionUri(uri: string): string {
  return uri.replace(/[.,;，。；]+$/u, "");
}

function parseMentionUri(uri: string): { kind: string; id: string } | null {
  const workspaceReference = /^mention:\/\/workspace-reference\/([^?]+)/u.exec(uri);
  if (workspaceReference) {
    return {
      kind: "workspace-reference",
      id: safeDecode(workspaceReference[1])
    };
  }

  const winAgent = /^mention:\/\/winagent\/([^/]+)\/([^?]+)/u.exec(uri);
  if (!winAgent) {
    return null;
  }
  return {
    kind: safeDecode(winAgent[1]),
    id: safeDecode(winAgent[2])
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolveMentionFileRef(value: string, workspaceRoot: string): string[] {
  const filePath = normalizeHostPath(value);
  return isPathInside(workspaceRoot, filePath) ? [filePath] : [];
}

function formatMetadata(metadata: WorkspaceReferenceRecord["metadata"]): string {
  const keys = Object.keys(metadata ?? {});
  if (keys.length === 0) {
    return "";
  }
  return ["Metadata:", "```json", JSON.stringify(metadata, null, 2), "```"].join("\n");
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n... [truncated]` : text;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
