import { spawnSync } from "node:child_process";
import type { AgentReadinessRecord, AgentRecord } from "../../shared/types";
import { AgentRepository } from "../repositories";

interface AgentDefinition {
  id: AgentReadinessRecord["id"];
  label: string;
  command: string;
  recommendedArgs: string[];
  supportsStreaming: boolean;
  launcherOnly?: boolean;
}

const definitions: AgentDefinition[] = [
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    recommendedArgs: ["exec", "--skip-git-repo-check", "-"],
    supportsStreaming: true
  },
  {
    id: "qoder",
    label: "Qoder",
    command: "qoder",
    recommendedArgs: [],
    supportsStreaming: false,
    launcherOnly: true
  },
  {
    id: "workbuddy",
    label: "WorkBuddy",
    command: "workbuddy",
    recommendedArgs: [],
    supportsStreaming: true
  }
];

export class AgentReadinessService {
  constructor(private readonly agents: AgentRepository) {}

  list(): AgentReadinessRecord[] {
    const profiles = this.agents.list();
    return definitions.map((definition) => this.inspect(definition, profiles));
  }

  ensureUsableProfiles(): void {
    for (const readiness of this.list()) {
      if (readiness.status !== "ready" || readiness.profileId) {
        continue;
      }
      this.agents.create({
        name: readiness.label,
        command: readiness.command,
        args: readiness.recommendedArgs,
        env: {}
      });
    }
  }

  provision(id: string, cwd?: string): AgentRecord {
    const definition = definitions.find((candidate) => candidate.id === id);
    if (!definition) {
      throw new Error(`Unsupported Agent app: ${id}`);
    }
    const readiness = this.inspect(definition, this.agents.list());
    if (readiness.status !== "ready") {
      throw new Error(readiness.message);
    }
    if (readiness.profileId) {
      const profile = this.agents.get(readiness.profileId);
      if (profile) {
        return profile;
      }
    }
    return this.agents.create({
      name: definition.label,
      command: definition.command,
      args: definition.recommendedArgs,
      env: {},
      cwd
    });
  }

  private inspect(definition: AgentDefinition, profiles: AgentRecord[]): AgentReadinessRecord {
    const installedPath = findCommand(definition.command);
    const profile = profiles.find((agent) => isProfileForDefinition(agent, definition));
    if (!installedPath) {
      return {
        id: definition.id,
        label: definition.label,
        command: definition.command,
        status: "missing",
        supportsStreaming: definition.supportsStreaming,
        recommendedArgs: definition.recommendedArgs,
        profileId: profile?.id,
        message: `${definition.label} command was not found on PATH.`
      };
    }
    if (definition.launcherOnly) {
      return {
        id: definition.id,
        label: definition.label,
        command: definition.command,
        status: "launcher",
        installedPath,
        supportsStreaming: false,
        recommendedArgs: definition.recommendedArgs,
        profileId: profile?.id,
        message: `${definition.label} is installed, but this CLI opens the desktop editor instead of running a stdin/stdout Agent task.`
      };
    }
    if (!definition.supportsStreaming) {
      return {
        id: definition.id,
        label: definition.label,
        command: definition.command,
        status: "unsupported",
        installedPath,
        supportsStreaming: false,
        recommendedArgs: definition.recommendedArgs,
        profileId: profile?.id,
        message: `${definition.label} is installed, but no non-interactive streaming adapter is configured.`
      };
    }
    return {
      id: definition.id,
      label: definition.label,
      command: definition.command,
      status: "ready",
      installedPath,
      supportsStreaming: true,
      recommendedArgs: definition.recommendedArgs,
      profileId: profile?.id,
      message: profile
        ? `${definition.label} is ready and has a runnable profile.`
        : `${definition.label} is installed and can be provisioned as a runnable profile.`
    };
  }
}

function isProfileForDefinition(agent: AgentRecord, definition: AgentDefinition): boolean {
  return (
    agent.name.toLowerCase() === definition.label.toLowerCase() ||
    agent.command.toLowerCase() === definition.command.toLowerCase()
  );
}

function findCommand(command: string): string | undefined {
  const finder = process.platform === "win32" ? "where.exe" : "command";
  const args = process.platform === "win32" ? [command] : ["-v", command];
  const result = spawnSync(finder, args, {
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform !== "win32"
  });
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}
