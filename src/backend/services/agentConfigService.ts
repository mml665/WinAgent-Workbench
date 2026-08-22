import type { AgentRecord } from "../../shared/types";
import { AgentRepository } from "../repositories";

export class AgentConfigService {
  constructor(private readonly agents: AgentRepository) {}

  list(): AgentRecord[] {
    this.agents.ensureDefault();
    return this.agents.list();
  }

  get(id: string): AgentRecord {
    this.agents.ensureDefault();
    const agent = this.agents.get(id);
    if (!agent) {
      throw new Error(`Agent not found: ${id}`);
    }
    return agent;
  }

  create(input: {
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
  }): AgentRecord {
    if (!input.name.trim() || !input.command.trim()) {
      throw new Error("Agent name and command are required");
    }
    return this.agents.create(input);
  }
}
