import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import type { AgentConfigService } from "./services/agentConfigService";
import type { McpServerService } from "./services/mcpServerService";
import type { RunService } from "./services/runService";
import type { SkillRegistry } from "./services/skillRegistry";
import type { WorkspaceService } from "./services/workspaceService";

export interface HttpServices {
  workspaces: WorkspaceService;
  agents: AgentConfigService;
  skills: SkillRegistry;
  mcpServers: McpServerService;
  runs: RunService;
}

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  services: HttpServices
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "OPTIONS") {
      sendJson(res, 204, {});
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/workspaces") {
      sendJson(res, 200, services.workspaces.list());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/workspaces") {
      const body = await readJson<{ rootPath: string }>(req);
      sendJson(res, 200, services.workspaces.open(body.rootPath));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/files") {
      sendJson(
        res,
        200,
        services.workspaces.listFiles(
          required(url.searchParams.get("workspaceId"), "workspaceId"),
          url.searchParams.get("path") ?? undefined
        )
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/agents") {
      sendJson(res, 200, services.agents.list());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/agents") {
      sendJson(res, 200, services.agents.create(await readJson(req)));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/skills") {
      sendJson(res, 200, services.skills.list());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/mcp-servers") {
      sendJson(res, 200, services.mcpServers.list());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/mcp-servers") {
      sendJson(res, 200, services.mcpServers.create(await readJson(req)));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/runs") {
      sendJson(res, 200, services.runs.list());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/runs") {
      sendJson(res, 200, services.runs.create(await readJson(req)));
      return;
    }
    const cancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
    if (req.method === "POST" && cancelMatch) {
      sendJson(res, 200, services.runs.cancel(cancelMatch[1]));
      return;
    }
    const eventMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
    if (req.method === "GET" && eventMatch) {
      sendJson(res, 200, services.runs.eventsForRun(eventMatch[1]));
      return;
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

function required(value: string | null, name: string): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as T) : ({} as T);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(status === 204 ? undefined : JSON.stringify(value));
}
