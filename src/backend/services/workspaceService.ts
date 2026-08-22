import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { FileEntry, WorkspaceRecord } from "../../shared/types";
import { WorkspaceRepository } from "../repositories";
import { isPathInside, normalizeHostPath } from "../utils/windowsPaths";

export class WorkspaceService {
  constructor(private readonly workspaces: WorkspaceRepository) {}

  list(): WorkspaceRecord[] {
    return this.workspaces.list();
  }

  get(id: string): WorkspaceRecord {
    const workspace = this.workspaces.get(id);
    if (!workspace) {
      throw new Error(`Workspace not found: ${id}`);
    }
    return workspace;
  }

  open(rootPathInput: string): WorkspaceRecord {
    const rootPath = normalizeHostPath(rootPathInput);
    if (!existsSync(rootPath)) {
      throw new Error(`Workspace path does not exist: ${rootPath}`);
    }
    if (!statSync(rootPath).isDirectory()) {
      throw new Error(`Workspace path is not a directory: ${rootPath}`);
    }
    return this.workspaces.upsert(path.basename(rootPath) || rootPath, rootPath);
  }

  listFiles(workspaceId: string, requestedPath?: string): FileEntry[] {
    const workspace = this.get(workspaceId);
    const targetPath = requestedPath ? normalizeHostPath(requestedPath) : workspace.rootPath;
    if (!isPathInside(workspace.rootPath, targetPath)) {
      throw new Error("Requested path is outside the workspace");
    }
    if (!existsSync(targetPath) || !statSync(targetPath).isDirectory()) {
      throw new Error(`Directory does not exist: ${targetPath}`);
    }
    return Array.from(new Set([targetPath]))
      .flatMap(() => {
        return readdirSync(targetPath, { withFileTypes: true }).map((entry) => {
          const fullPath = path.join(targetPath, entry.name);
          const stats = statSync(fullPath);
          return {
            name: entry.name,
            path: fullPath,
            kind: entry.isDirectory() ? "directory" : "file",
            size: stats.size,
            modifiedAt: stats.mtime.toISOString()
          } satisfies FileEntry;
        });
      })
      .sort((a, b) => {
        if (a.kind !== b.kind) {
          return a.kind === "directory" ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
  }
}
