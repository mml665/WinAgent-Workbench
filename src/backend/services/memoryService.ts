import type {
  RetrievalHit,
  RunRecord,
  WorkspaceMemoryRecord,
  RunWorkingMemoryRecord
} from "../../shared/types";
import { MemoryRepository, RunRepository } from "../repositories";

const WORKING_MEMORY_BUDGET_CHARS = 8000;

export class MemoryService {
  constructor(
    private readonly memories: MemoryRepository,
    private readonly runs: RunRepository
  ) {}

  listWorkspaceMemories(workspaceId: string): WorkspaceMemoryRecord[] {
    return this.memories.listWorkspaceMemories(workspaceId);
  }

  createWorkspaceMemory(input: {
    workspaceId: string;
    type: WorkspaceMemoryRecord["type"];
    content: string;
  }): WorkspaceMemoryRecord {
    if (!input.content.trim()) {
      throw new Error("Memory content is required");
    }
    return this.memories.createWorkspaceMemory({
      workspaceId: input.workspaceId,
      type: input.type,
      content: input.content.trim()
    });
  }

  searchLongTerm(workspaceId: string, query: string, limit = 5): WorkspaceMemoryRecord[] {
    return this.memories.searchWorkspaceMemories(workspaceId, query, limit);
  }

  getRunWorkingMemory(runId: string): RunWorkingMemoryRecord | null {
    return this.memories.getRunWorkingMemory(runId);
  }

  buildWorkingMemory(input: {
    run: RunRecord;
    retrievalHits: RetrievalHit[];
    toolResults: Array<{ serverName: string; toolName: string; status: string; result?: unknown; error?: string }>;
    longTermMemories: WorkspaceMemoryRecord[];
  }): RunWorkingMemoryRecord {
    const recentRuns = this.runs
      .listByWorkspace(input.run.workspaceId, 6)
      .filter((run) => run.id !== input.run.id && run.summary)
      .slice(0, 3);
    const content = [
      "# Short-Term Working Memory",
      "",
      "## Current Run",
      `Title: ${input.run.title}`,
      `Prompt: ${input.run.prompt}`,
      input.run.retrievalQuery ? `Retrieval query: ${input.run.retrievalQuery}` : "",
      "",
      "## Recent Run Summaries",
      recentRuns.length === 0
        ? "(none)"
        : recentRuns
            .map((run) => `- ${run.status}: ${run.title} -> ${run.summary}`)
            .join("\n"),
      "",
      "## Current Retrieval Hits",
      input.retrievalHits.length === 0
        ? "(none)"
        : input.retrievalHits
            .map((hit) => `- ${hit.score}: ${hit.path}\n  ${hit.snippet.slice(0, 220)}`)
            .join("\n"),
      "",
      "## Current MCP Tool Results",
      input.toolResults.length === 0
        ? "(none)"
        : input.toolResults
            .map(
              (tool) =>
                `- ${tool.serverName}.${tool.toolName} [${tool.status}]: ${JSON.stringify(
                  tool.result ?? { error: tool.error }
                ).slice(0, 500)}`
            )
            .join("\n"),
      "",
      "## Long-Term Memories Selected For This Run",
      input.longTermMemories.length === 0
        ? "(none)"
        : input.longTermMemories
            .map((memory) => `- ${memory.type}: ${memory.content}`)
            .join("\n")
    ]
      .filter((line) => line !== "")
      .join("\n");
    return this.memories.createRunWorkingMemory(
      input.run.id,
      content,
      WORKING_MEMORY_BUDGET_CHARS
    );
  }

  rememberRunOutcome(run: RunRecord): WorkspaceMemoryRecord | null {
    if (!run.summary || run.status === "cancelled") {
      return null;
    }
    const type = run.status === "completed" ? "run_summary" : "issue";
    return this.memories.createWorkspaceMemory({
      workspaceId: run.workspaceId,
      type,
      sourceRunId: run.id,
      content: [
        `${run.status.toUpperCase()} run: ${run.title}`,
        `Prompt: ${run.prompt}`,
        `Summary: ${run.summary}`,
        `Attempt: ${run.attempt}/${run.maxRetries + 1}`,
        run.durationMs ? `Duration: ${run.durationMs}ms` : ""
      ]
        .filter(Boolean)
        .join("\n")
    });
  }
}
