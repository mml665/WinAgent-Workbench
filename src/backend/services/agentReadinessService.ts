import { spawnSync } from "node:child_process";
import type { AgentAdapterRecord, AgentReadinessRecord, AgentRecord } from "../../shared/types";
import { AgentAdapterRepository, AgentRepository } from "../repositories";

const defaultAdapters: Array<{
  id: string;
  label: string;
  command: string;
  defaultArgs: string[];
  capabilities: Record<string, unknown>;
  installState: AgentAdapterRecord["installState"];
}> = [
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    defaultArgs: ["exec", "--skip-git-repo-check", "-"],
    installState: "external",
    capabilities: {
      streaming: true,
      stdin: true,
      nonInteractive: true,
      workspaceCwd: true,
      kind: "agent-runtime"
    }
  },
  {
    id: "claude",
    label: "Claude",
    command: "claude",
    defaultArgs: ["-p"],
    installState: "external",
    capabilities: {
      streaming: true,
      stdin: true,
      nonInteractive: true,
      workspaceCwd: true,
      kind: "agent-runtime",
      cliMode: "print",
      authStatusArgs: ["auth", "status"]
    }
  },
  {
    id: "qoder",
    label: "Qoder",
    command: "qoder",
    defaultArgs: [],
    installState: "external",
    capabilities: {
      streaming: false,
      stdin: false,
      nonInteractive: false,
      launcherOnly: true,
      kind: "editor-launcher"
    }
  },
  {
    id: "workbuddy",
    label: "WorkBuddy",
    command: "workbuddy",
    defaultArgs: [],
    installState: "missing",
    capabilities: {
      streaming: true,
      stdin: true,
      nonInteractive: true,
      workspaceCwd: true,
      kind: "agent-runtime"
    }
  }
];

export class AgentReadinessService {
  constructor(
    private readonly agents: AgentRepository,
    private readonly adapters: AgentAdapterRepository
  ) {}

  list(): AgentReadinessRecord[] {
    this.ensureDefaultAdapters();
    const profiles = this.agents.list();
    return this.adapters.list().map((adapter) => this.inspect(adapter, profiles));
  }

  ensureUsableProfiles(): void {
    for (const readiness of this.list()) {
      if (readiness.status !== "ready" || readiness.profileId) {
        continue;
      }
      this.provision(readiness.id);
    }
  }

  provision(id: string, cwd?: string): AgentRecord {
    this.ensureDefaultAdapters();
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new Error(`Unsupported Agent app: ${id}`);
    }
    const readiness = this.inspect(adapter, this.agents.list());
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
      adapterId: adapter.id,
      name: adapter.label,
      command: adapter.command,
      args: adapter.defaultArgs,
      env: {},
      cwd,
      capabilities: adapter.capabilities
    });
  }

  ensureDefaultAdapters(): void {
    for (const adapter of defaultAdapters) {
      this.adapters.upsert(adapter);
    }
  }

  private inspect(adapter: AgentAdapterRecord, profiles: AgentRecord[]): AgentReadinessRecord {
    const installedPath = findCommand(adapter.command);
    const profile = profiles.find((agent) => isProfileForAdapter(agent, adapter));
    const supportsStreaming = adapter.capabilities.streaming === true;
    const launcherOnly = adapter.capabilities.launcherOnly === true;
    if (!installedPath) {
      if (profile) {
        this.agents.updateRuntimeMetadata(profile.id, {
          adapterId: adapter.id,
          capabilities: adapter.capabilities,
          readinessStatus: "missing"
        });
      }
      return {
        id: adapter.id,
        label: adapter.label,
        command: adapter.command,
        status: "missing",
        supportsStreaming,
        recommendedArgs: adapter.defaultArgs,
        profileId: profile?.id,
        message: `${adapter.label} command was not found on PATH.`
      };
    }
    if (launcherOnly) {
      if (profile) {
        this.agents.updateRuntimeMetadata(profile.id, {
          adapterId: adapter.id,
          capabilities: adapter.capabilities,
          readinessStatus: "launcher"
        });
      }
      return {
        id: adapter.id,
        label: adapter.label,
        command: adapter.command,
        status: "launcher",
        installedPath,
        supportsStreaming: false,
        recommendedArgs: adapter.defaultArgs,
        profileId: profile?.id,
        message: `${adapter.label} is installed, but this CLI opens the desktop editor instead of running a stdin/stdout Agent task.`
      };
    }
    const authStatusArgs = stringArray(adapter.capabilities.authStatusArgs);
    if (authStatusArgs) {
      const auth = inspectAuth(adapter.command, authStatusArgs);
      if (!auth.ready) {
        if (profile) {
          this.agents.updateRuntimeMetadata(profile.id, {
            adapterId: adapter.id,
            capabilities: adapter.capabilities,
            readinessStatus: "unsupported"
          });
        }
        return {
          id: adapter.id,
          label: adapter.label,
          command: adapter.command,
          status: "unsupported",
          installedPath,
          supportsStreaming,
          recommendedArgs: adapter.defaultArgs,
          profileId: profile?.id,
          message: auth.message
        };
      }
    }
    if (!supportsStreaming) {
      if (profile) {
        this.agents.updateRuntimeMetadata(profile.id, {
          adapterId: adapter.id,
          capabilities: adapter.capabilities,
          readinessStatus: "unsupported"
        });
      }
      return {
        id: adapter.id,
        label: adapter.label,
        command: adapter.command,
        status: "unsupported",
        installedPath,
        supportsStreaming: false,
        recommendedArgs: adapter.defaultArgs,
        profileId: profile?.id,
        message: `${adapter.label} is installed, but no non-interactive streaming adapter is configured.`
      };
    }
    if (profile) {
      this.agents.updateRuntimeMetadata(profile.id, {
        adapterId: adapter.id,
        capabilities: adapter.capabilities,
        readinessStatus: "ready"
      });
    }
    return {
      id: adapter.id,
      label: adapter.label,
      command: adapter.command,
      status: "ready",
      installedPath,
      supportsStreaming: true,
      recommendedArgs: adapter.defaultArgs,
      profileId: profile?.id,
      message: profile
        ? `${adapter.label} is ready and has a runnable profile.`
        : `${adapter.label} is installed and can be provisioned as a runnable profile.`
    };
  }
}

function isProfileForAdapter(agent: AgentRecord, adapter: AgentAdapterRecord): boolean {
  return (
    agent.adapterId === adapter.id ||
    agent.name.toLowerCase() === adapter.label.toLowerCase() ||
    agent.command.toLowerCase() === adapter.command.toLowerCase()
  );
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function inspectAuth(command: string, args: string[]): { ready: true } | { ready: false; message: string } {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 5000
  });
  const raw = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  try {
    const parsed = JSON.parse(raw) as { loggedIn?: boolean; authMethod?: string; apiProvider?: string };
    if (parsed.loggedIn === false) {
      return {
        ready: false,
        message: `${command} is installed but not authenticated. Run "${command} auth login" or configure its API key before using it as an Agent.`
      };
    }
    if (parsed.loggedIn === true) {
      return { ready: true };
    }
  } catch {
    // Fall through to the exit-code check below.
  }
  if (result.status !== 0) {
    return {
      ready: false,
      message: raw || `${command} authentication status check failed.`
    };
  }
  return { ready: true };
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
