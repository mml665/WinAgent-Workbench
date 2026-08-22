import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { McpServerRecord, McpToolCallRecord } from "../../shared/types";
import { McpServerRepository } from "../repositories";

export class McpServerService {
  private readonly sessions = new Map<string, McpSession>();

  constructor(private readonly servers: McpServerRepository) {}

  list(): McpServerRecord[] {
    return this.servers.list();
  }

  tools(serverId?: string) {
    return this.servers.tools(serverId);
  }

  toolCalls(serverId?: string): McpToolCallRecord[] {
    return this.servers.toolCalls(serverId);
  }

  create(input: {
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }): McpServerRecord {
    if (!input.name.trim() || !input.command.trim()) {
      throw new Error("MCP server name and command are required");
    }
    return this.servers.create(input);
  }

  async start(serverId: string): Promise<McpServerRecord> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`MCP server not found: ${serverId}`);
    }
    this.stop(serverId);
    const session = new McpSession(server);
    this.sessions.set(serverId, session);
    this.servers.updateStatus(serverId, "running");
    try {
      const tools = await session.initializeAndListTools();
      this.servers.replaceTools(serverId, tools);
      return this.servers.updateStatus(serverId, "running");
    } catch (error) {
      session.stop();
      this.sessions.delete(serverId);
      return this.servers.updateStatus(
        serverId,
        "error",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  stop(serverId: string): McpServerRecord {
    const session = this.sessions.get(serverId);
    if (session) {
      session.stop();
      this.sessions.delete(serverId);
    }
    const server = this.servers.get(serverId);
    return server ? this.servers.updateStatus(serverId, "stopped") : server!;
  }

  async callTool(serverId: string, toolName: string, args: unknown): Promise<McpToolCallRecord> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`MCP server not found: ${serverId}`);
    }
    const session = this.sessions.get(serverId);
    if (!session) {
      throw new Error(`MCP server is not running: ${server.name}`);
    }
    const call = this.servers.createToolCall(serverId, toolName, args ?? {});
    try {
      const result = await session.callTool(toolName, args ?? {});
      return this.servers.completeToolCall(call.id, result);
    } catch (error) {
      return this.servers.failToolCall(call.id, error instanceof Error ? error.message : String(error));
    }
  }
}

interface RpcResponse {
  id?: number;
  result?: any;
  error?: { message?: string };
}

interface McpToolShape {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

class McpSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(value: RpcResponse): void; reject(error: Error): void }>();

  constructor(private readonly server: McpServerRecord) {
    this.child = spawn(server.command, server.args, {
      env: { ...process.env, ...server.env },
      windowsHide: true,
      shell: false
    });
    this.child.stdout.on("data", (chunk) => this.accept(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.on("exit", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("MCP server exited"));
      }
      this.pending.clear();
    });
    this.child.on("error", (error) => {
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  async initializeAndListTools(): Promise<McpToolShape[]> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "WinAgent Workbench", version: "0.2.0" }
    });
    this.notify("notifications/initialized", {});
    const response = await this.request("tools/list", {});
    return Array.isArray(response.result?.tools) ? response.result.tools : [];
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    const response = await this.request("tools/call", {
      name,
      arguments: args ?? {}
    });
    return response.result ?? null;
  }

  stop(): void {
    this.child.kill();
  }

  private request(method: string, params: unknown): Promise<RpcResponse> {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 5000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          if (value.error) {
            reject(new Error(value.error.message ?? `MCP request failed: ${method}`));
          } else {
            resolve(value);
          }
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  private notify(method: string, params: unknown): void {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method, params }), "utf8");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  private accept(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      const bodyLength = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + bodyLength;
      if (this.buffer.length < bodyEnd) {
        return;
      }
      const message = JSON.parse(this.buffer.slice(bodyStart, bodyEnd).toString("utf8")) as RpcResponse;
      this.buffer = this.buffer.slice(bodyEnd);
      if (typeof message.id === "number") {
        this.pending.get(message.id)?.resolve(message);
        this.pending.delete(message.id);
      }
    }
  }
}
