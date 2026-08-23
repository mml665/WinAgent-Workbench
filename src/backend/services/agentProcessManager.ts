import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentRecord, RunRecord } from "../../shared/types";

export interface ProcessRunCallbacks {
  onStdout(chunk: string): void;
  onStderr(chunk: string): void;
  onExit(result: { code: number | null; signal: NodeJS.Signals | null }): void;
  onError(error: Error): void;
}

export class AgentProcessManager {
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();

  start(run: RunRecord, agent: AgentRecord, prompt: string, callbacks: ProcessRunCallbacks): void {
    const useShell = shouldRunThroughWindowsShell(agent.command);
    const child = spawn(agent.command, agent.args, {
      cwd: agent.cwd || run.cwd,
      env: { ...process.env, ...agent.env },
      windowsHide: true,
      shell: useShell
    });
    this.processes.set(run.id, child);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => callbacks.onStdout(String(chunk)));
    child.stderr.on("data", (chunk) => callbacks.onStderr(String(chunk)));
    child.on("error", (error) => callbacks.onError(error));
    child.on("exit", (code, signal) => {
      this.processes.delete(run.id);
      callbacks.onExit({ code, signal });
    });
    child.stdin.end(prompt);
  }

  cancel(runId: string): boolean {
    const child = this.processes.get(runId);
    if (!child) {
      return false;
    }
    child.kill();
    return true;
  }
}

function shouldRunThroughWindowsShell(command: string): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  return ["qodercli", "qodercli.cmd", "codebuddy", "codebuddy.cmd", "cbc", "cbc.cmd"].includes(
    command.toLowerCase()
  );
}
