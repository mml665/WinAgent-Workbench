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
    command: "qodercli",
    defaultArgs: ["-p"],
    installState: "external",
    capabilities: {
      streaming: true,
      stdin: true,
      nonInteractive: true,
      workspaceCwd: true,
      kind: "agent-runtime",
      cliMode: "print",
      commandCandidates: ["qodercli", "qoder"],
      headlessHelpFlags: ["--print", "-p"],
      authStatusArgs: ["status"],
      installHint: "Install Qoder CLI with: irm https://qoder.com/install.ps1 | iex"
    }
  },
  {
    id: "workbuddy",
    label: "CodeBuddy",
    command: "codebuddy",
    defaultArgs: ["-p"],
    installState: "external",
    capabilities: {
      streaming: true,
      stdin: true,
      nonInteractive: true,
      workspaceCwd: true,
      kind: "agent-runtime",
      cliMode: "print",
      productAlias: "WorkBuddy",
      commandCandidates: ["codebuddy", "cbc"],
      headlessHelpFlags: ["--print", "-p"],
      authLoginHint: "Run codebuddy login before using CodeBuddy as an Agent.",
      installHint: "Install CodeBuddy CLI with: npm install -g @tencent-ai/codebuddy-code"
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
      name: readiness.label,
      command: readiness.command,
      args: readiness.recommendedArgs,
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
    const resolvedCommand = resolveCommand(adapter);
    const installedPath = resolvedCommand?.installedPath;
    const command = resolvedCommand?.command ?? adapter.command;
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
        command,
        status: "missing",
        supportsStreaming,
        recommendedArgs: adapter.defaultArgs,
        profileId: profile?.id,
        message: `${adapter.label} command was not found on PATH. ${stringValue(adapter.capabilities.installHint) ?? ""}`.trim()
      };
    }
    const headlessHelpFlags = stringArray(adapter.capabilities.headlessHelpFlags);
    if (headlessHelpFlags && !supportsRequiredHelpFlag(command, headlessHelpFlags)) {
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
        command,
        status: "launcher",
        installedPath,
        supportsStreaming: false,
        recommendedArgs: adapter.defaultArgs,
        profileId: profile?.id,
        message:
          `${adapter.label} command "${command}" is installed, but it does not expose headless print mode (${headlessHelpFlags.join(
            " or "
          )}). ${stringValue(adapter.capabilities.installHint) ?? ""}`.trim()
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
        command,
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
      const auth = inspectAuth(command, authStatusArgs);
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
          command,
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
        command,
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
      command,
      status: "ready",
      installedPath,
      supportsStreaming: true,
      recommendedArgs: adapter.defaultArgs,
      profileId: profile?.id,
      message: [
        profile
          ? `${adapter.label} is ready and has a runnable profile.`
          : `${adapter.label} is installed and can be provisioned as a runnable profile.`,
        stringValue(adapter.capabilities.authLoginHint)
      ]
        .filter(Boolean)
        .join(" ")
    };
  }
}

function isProfileForAdapter(agent: AgentRecord, adapter: AgentAdapterRecord): boolean {
  return (
    agent.adapterId === adapter.id ||
    agent.name.toLowerCase() === adapter.label.toLowerCase() ||
    agent.command.toLowerCase() === adapter.command.toLowerCase() ||
    (stringArray(adapter.capabilities.commandCandidates) ?? [])
      .map((candidate) => candidate.toLowerCase())
      .includes(agent.command.toLowerCase())
  );
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function resolveCommand(adapter: AgentAdapterRecord): { command: string; installedPath: string } | undefined {
  const candidates = stringArray(adapter.capabilities.commandCandidates) ?? [adapter.command];
  for (const candidate of candidates) {
    const installedPath = findCommand(candidate);
    if (installedPath) {
      return { command: candidate, installedPath };
    }
  }
  return undefined;
}

function supportsRequiredHelpFlag(command: string, flags: string[]): boolean {
  const result = spawnSync(command, ["--help"], {
    encoding: "utf8",
    windowsHide: true,
    shell: shouldRunThroughWindowsShell(command),
    timeout: 5000
  });
  const help = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return flags.some((flag) => help.includes(flag));
}

function inspectAuth(command: string, args: string[]): { ready: true } | { ready: false; message: string } {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    shell: shouldRunThroughWindowsShell(command),
    timeout: 5000
  });
  const raw = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (/not logged in|authentication required|please .*login|sign in/i.test(raw)) {
    return {
      ready: false,
      message: `${command} is installed but not authenticated. Run "${command} login" or configure its access token before using it as an Agent.`
    };
  }
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
      message:
        raw ||
        `${command} is installed but authentication status could not be confirmed. Run "${command} login" before using it as an Agent.`
    };
  }
  return { ready: true };
}

function shouldRunThroughWindowsShell(command: string): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  return ["qodercli", "qodercli.cmd", "codebuddy", "codebuddy.cmd", "cbc", "cbc.cmd"].includes(
    command.toLowerCase()
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
