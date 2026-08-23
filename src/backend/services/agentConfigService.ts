import type { AgentReadinessRecord, AgentRecord } from "../../shared/types";
import { AgentRepository } from "../repositories";
import { AgentReadinessService } from "./agentReadinessService";

export class AgentConfigService {
  private readonly readiness: AgentReadinessService;

  constructor(private readonly agents: AgentRepository) {
    this.readiness = new AgentReadinessService(agents);
  }

  list(): AgentRecord[] {
    this.readiness.ensureUsableProfiles();
    return this.agents.list();
  }

  readinessList(): AgentReadinessRecord[] {
    this.readiness.ensureUsableProfiles();
    return this.readiness.list();
  }

  get(id: string): AgentRecord {
    this.readiness.ensureUsableProfiles();
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

  provision(input: { id: string; cwd?: string }): AgentRecord {
    return this.readiness.provision(input.id, input.cwd);
  }
}
