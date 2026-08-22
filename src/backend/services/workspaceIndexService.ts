import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { RetrievalHit } from "../../shared/types";
import { WorkspaceIndexRepository, WorkspaceRepository } from "../repositories";
import { isPathInside } from "../utils/windowsPaths";

const IGNORE_DIRS = new Set([
  ".git",
  ".tmp",
  "coverage",
  "data",
  "dist",
  "dist-electron",
  "node_modules"
]);

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".ps1",
  ".py",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml"
]);

const MAX_FILES = 400;
const MAX_FILE_BYTES = 96_000;
const MAX_CONTENT_CHARS = 24_000;

export class WorkspaceIndexService {
  constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly index: WorkspaceIndexRepository
  ) {}

  build(workspaceId: string): { indexed: number } {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
    const entries: Array<{ path: string; size: number; modifiedAt: string; content: string }> = [];
    this.walk(workspace.rootPath, workspace.rootPath, entries);
    return { indexed: this.index.replaceWorkspaceIndex(workspaceId, entries) };
  }

  search(workspaceId: string, query: string, limit = 5): RetrievalHit[] {
    return this.index.search(workspaceId, query, limit);
  }

  private walk(
    rootPath: string,
    currentPath: string,
    entries: Array<{ path: string; size: number; modifiedAt: string; content: string }>
  ): void {
    if (entries.length >= MAX_FILES || !isPathInside(rootPath, currentPath)) {
      return;
    }
    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      if (entries.length >= MAX_FILES) {
        return;
      }
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) {
          this.walk(rootPath, fullPath, entries);
        }
        continue;
      }
      if (!entry.isFile() || !TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      if (!existsSync(fullPath)) {
        continue;
      }
      const stats = statSync(fullPath);
      if (stats.size > MAX_FILE_BYTES) {
        continue;
      }
      entries.push({
        path: fullPath,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
        content: readFileSync(fullPath, "utf8").slice(0, MAX_CONTENT_CHARS)
      });
    }
  }
}
