import type { McpServerRecord } from "../../shared/types";
import { McpServerRepository } from "../repositories";

export class McpServerService {
  constructor(private readonly servers: McpServerRepository) {}

  list(): McpServerRecord[] {
    return this.servers.list();
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
}
