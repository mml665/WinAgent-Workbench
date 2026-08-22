import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type {
  RetrievalHit,
  RunWorkingMemoryRecord,
  SkillRecord,
  WorkspaceMemoryRecord,
  WorkspaceRecord
} from "../../shared/types";
import { isPathInside, normalizeHostPath } from "../utils/windowsPaths";

const MAX_FILE_CHARS = 8000;

export class ContextProvider {
  buildPrompt(input: {
    workspace: WorkspaceRecord;
    skill?: SkillRecord;
    prompt: string;
    fileRefs: string[];
    mcpServerNames: string[];
    retrievalHits?: RetrievalHit[];
    shortTermMemory?: RunWorkingMemoryRecord;
    longTermMemories?: WorkspaceMemoryRecord[];
    toolResults?: Array<{
      serverName: string;
      toolName: string;
      status: string;
      result?: unknown;
      error?: string;
    }>;
  }): string {
    const sections: string[] = [];
    sections.push("# Workspace");
    sections.push(`Root: ${input.workspace.rootPath}`);
    if (input.skill) {
      sections.push("\n# Skill");
      sections.push(`Name: ${input.skill.name}`);
      sections.push(input.skill.instructions.trim());
    }
    if (input.mcpServerNames.length > 0) {
      sections.push("\n# Available MCP Servers");
      sections.push(input.mcpServerNames.map((name) => `- ${name}`).join("\n"));
    }
    if (input.shortTermMemory) {
      sections.push("\n# Short-Term Memory");
      sections.push(input.shortTermMemory.content);
    }
    if (input.longTermMemories && input.longTermMemories.length > 0) {
      sections.push("\n# Long-Term Workspace Memory");
      sections.push(
        input.longTermMemories
          .map((memory) => `## ${memory.type}\n${memory.content}`)
          .join("\n\n")
      );
    }
    const fileContext = this.readFileRefs(input.workspace, input.fileRefs);
    if (fileContext) {
      sections.push("\n# Referenced Files");
      sections.push(fileContext);
    }
    if (input.retrievalHits && input.retrievalHits.length > 0) {
      sections.push("\n# Retrieved Project Context");
      sections.push(
        input.retrievalHits
          .map(
            (hit) =>
              `## ${path.relative(input.workspace.rootPath, hit.path)}\nScore: ${hit.score}\n\`\`\`\n${hit.snippet}\n\`\`\``
          )
          .join("\n\n")
      );
    }
    if (input.toolResults && input.toolResults.length > 0) {
      sections.push("\n# MCP Tool Results");
      sections.push(
        input.toolResults
          .map((tool) =>
            [
              `## ${tool.serverName}.${tool.toolName}`,
              `Status: ${tool.status}`,
              "```json",
              JSON.stringify(tool.result ?? { error: tool.error }, null, 2),
              "```"
            ].join("\n")
          )
          .join("\n\n")
      );
    }
    sections.push("\n# User Task");
    sections.push(input.prompt.trim());
    return sections.join("\n");
  }

  private readFileRefs(workspace: WorkspaceRecord, refs: string[]): string {
    const chunks: string[] = [];
    for (const ref of refs) {
      const filePath = normalizeHostPath(ref);
      if (!isPathInside(workspace.rootPath, filePath)) {
        chunks.push(`## ${filePath}\nSkipped: outside workspace.`);
        continue;
      }
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        chunks.push(`## ${filePath}\nSkipped: missing or not a file.`);
        continue;
      }
      const text = readFileSync(filePath, "utf8");
      const relative = path.relative(workspace.rootPath, filePath);
      const truncated = text.length > MAX_FILE_CHARS;
      chunks.push(
        [
          `## ${relative}`,
          truncated ? `Truncated to ${MAX_FILE_CHARS} chars.` : "Full file included.",
          "```",
          text.slice(0, MAX_FILE_CHARS),
          "```"
        ].join("\n")
      );
    }
    return chunks.join("\n\n");
  }
}
