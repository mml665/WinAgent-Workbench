import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AgentReadinessRecord,
  AgentRecord,
  ApprovalRecord,
  FileEntry,
  McpServerRecord,
  McpToolCallRecord,
  McpToolRecord,
  MemoryType,
  RetrievalHit,
  RunArtifactRecord,
  RunEventRecord,
  RunRecord,
  RunWorkingMemoryRecord,
  RunToolCallRequest,
  SkillRecord,
  TaskRecord,
  WorkspaceMemoryRecord,
  WorkspaceReferenceRecord,
  WorkspaceRecord
} from "../shared/types";
import type { WebSocketEnvelope } from "../shared/events";
import "./styles.css";

const apiBase = "http://127.0.0.1:8787";
const memoryTypes: MemoryType[] = ["fact", "preference", "decision", "issue", "command", "run_summary"];
type DesktopWindow = "apps" | "files" | "memory" | "mcp" | "runs" | "tasks" | "artifacts" | "references" | "approvals";
type AgentAppId = "codex" | "claude" | "workbuddy" | "qoder";
type RuntimeStatus = "checking" | "online" | "degraded" | "offline";
type MentionCategory = "sessions" | "files" | "tasks" | "apps" | "agents";

const agentApps: Array<{ id: AgentAppId; label: string; icon: string; description: string }> = [
  {
    id: "codex",
    label: "Codex",
    icon: "C",
    description: "Run non-interactive Codex tasks inside this workspace."
  },
  {
    id: "claude",
    label: "Claude",
    icon: "Cl",
    description: "Run Claude Code CLI tasks through non-interactive print mode."
  },
  {
    id: "workbuddy",
    label: "CodeBuddy",
    icon: "Cb",
    description: "Run Tencent CodeBuddy CLI tasks for WorkBuddy-compatible coding workflows."
  },
  {
    id: "qoder",
    label: "Qoder",
    icon: "Q",
    description: "Launch or connect Qoder when a streaming Agent adapter is available."
  }
];

const mentionCategories: Array<{ id: MentionCategory; label: string }> = [
  { id: "sessions", label: "Sessions" },
  { id: "files", label: "Files" },
  { id: "tasks", label: "Tasks" },
  { id: "apps", label: "Apps" },
  { id: "agents", label: "Agents" }
];

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) },
    ...options
  });
  const value = await response.json();
  if (!response.ok || value.error) {
    throw new Error(value.error ?? response.statusText);
  }
  return value as T;
}

function runTimestamp(run: RunRecord): number {
  return Date.parse(run.updatedAt || run.endedAt || run.startedAt || run.createdAt) || 0;
}

function compactRunMessage(run: RunRecord): string {
  const source = (run.summary || run.prompt || "No summary yet.").trim();
  if (
    run.status === "failed" &&
    /Write-Error|ErrorException|CategoryInfo|FullyQualifiedErrorId|exit\s+\d+/i.test(source)
  ) {
    return "Run failed during execution. Open details to inspect logs.";
  }
  if (/^Agent received prompt:/i.test(source) || source.includes("# Short-Term Memo")) {
    return run.status === "completed"
      ? "Run completed. Open details to review the result."
      : "Agent run is ready. Open details to review the workspace context.";
  }
  const cleaned = source
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\+ CategoryInfo\s*:.*$/i, "")
    .replace(/\+ FullyQualifiedErrorId\s*:.*$/i, "")
    .replace(/# Workspace Root:.*?(?=# Available|# Short|$)/i, "")
    .replace(/# Available MCP Servers.*?(?=# Short|# Prompt|$)/i, "")
    .trim();
  return cleaned.length > 140 ? `${cleaned.slice(0, 137)}...` : cleaned;
}

function runAnswer(run: RunRecord, events: RunEventRecord[] = []): string {
  const stdout = events
    .filter((event) => event.type === "run.output.delta")
    .map((event) => String((event.payload as any).text ?? ""))
    .join("")
    .trim();
  if (stdout) {
    return stdout;
  }
  if (run.status === "completed" && run.summary?.trim()) {
    return run.summary.trim();
  }
  return "";
}

function runDisplayMessage(run: RunRecord, events: RunEventRecord[] = []): string {
  const answer = runAnswer(run, events);
  if (answer) {
    return answer;
  }
  if (run.status === "running" || run.status === "queued") {
    return "Agent is working. The answer will appear here automatically.";
  }
  return compactRunMessage(run);
}

function messageStatusLabel(status: RunRecord["status"]): string {
  if (status === "failed") return "Action needed";
  if (status === "running" || status === "queued") return "Running";
  if (status === "completed") return "Done";
  return status;
}

function readinessLabel(readiness?: AgentReadinessRecord): string {
  if (!readiness) return "Checking";
  if (readiness.status === "ready") return readiness.profileId ? "Ready" : "Can install";
  if (readiness.status === "launcher") return "Launcher only";
  if (readiness.status === "missing") return "Not installed";
  if (/not authenticated|not logged in|auth login/i.test(readiness.message)) return "Login required";
  return "Unsupported";
}

function readinessClass(readiness?: AgentReadinessRecord): string {
  if (!readiness) return "unknown";
  return readiness.status;
}

function runtimeStatusLabel(status: RuntimeStatus): string {
  if (status === "online") return "Runtime online";
  if (status === "degraded") return "Runtime degraded";
  if (status === "offline") return "Runtime offline";
  return "Checking runtime";
}

function summarizeRuntimeFailures(failures: string[]): string {
  if (failures.length === 0) {
    return "Backend connected. Workspace, Agents, runs, memory, and tools are synced.";
  }
  if (failures.every((failure) => /Failed to fetch|Load failed|NetworkError|refused|fetch/i.test(failure))) {
    return "Backend is not reachable. Existing screen state is preserved while WinAgent retries.";
  }
  if (failures.length > 3) {
    return `${failures.length} runtime APIs failed. Click Retry to reload the workspace state.`;
  }
  return failures.join(" · ");
}

function groupRunsByMessage(runs: RunRecord[]): Array<{ key: string; latest: RunRecord; runs: RunRecord[] }> {
  const groups = new Map<string, { key: string; latest: RunRecord; runs: RunRecord[] }>();
  for (const run of runs) {
    const key = `${run.status}:${run.title.trim() || "Untitled run"}`;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { key, latest: run, runs: [run] });
      continue;
    }
    group.runs.push(run);
    if (runTimestamp(run) > runTimestamp(group.latest)) {
      group.latest = run;
    }
  }
  return [...groups.values()].sort((left, right) => runTimestamp(right.latest) - runTimestamp(left.latest));
}

function App() {
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [agentReadiness, setAgentReadiness] = useState<AgentReadinessRecord[]>([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerRecord[]>([]);
  const [mcpTools, setMcpTools] = useState<McpToolRecord[]>([]);
  const [mcpToolCalls, setMcpToolCalls] = useState<McpToolCallRecord[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [events, setEvents] = useState<Record<string, RunEventRecord[]>>({});
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [workspaceReferences, setWorkspaceReferences] = useState<WorkspaceReferenceRecord[]>([]);
  const [artifacts, setArtifacts] = useState<RunArtifactRecord[]>([]);
  const [workspaceMemories, setWorkspaceMemories] = useState<WorkspaceMemoryRecord[]>([]);
  const [workingMemory, setWorkingMemory] = useState<RunWorkingMemoryRecord | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [selectedSkillId, setSelectedSkillId] = useState("");
  const [workspacePath, setWorkspacePath] = useState("E:\\WinAgent-Workbench");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [filePath, setFilePath] = useState("");
  const [fileRefs, setFileRefs] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [goalText, setGoalText] = useState("");
  const [plannedTasks, setPlannedTasks] = useState<Array<{ title: string; description: string }>>([]);
  const [retrievalQuery, setRetrievalQuery] = useState("workspace agent runtime");
  const [retrievalHits, setRetrievalHits] = useState<RetrievalHit[]>([]);
  const [timeoutMs, setTimeoutMs] = useState(120000);
  const [maxRetries, setMaxRetries] = useState(0);
  const [mcpName, setMcpName] = useState("Local MCP");
  const [mcpCommand, setMcpCommand] = useState("node.exe");
  const [mcpArgs, setMcpArgs] = useState("");
  const [toolArguments, setToolArguments] = useState('{"text":"hello from WinAgent"}');
  const [runToolCalls, setRunToolCalls] = useState<RunToolCallRequest[]>([]);
  const [memoryType, setMemoryType] = useState<MemoryType>("fact");
  const [memoryContent, setMemoryContent] = useState(
    "This workspace prefers Windows-compatible Agent tooling with observable runs."
  );
  const [activeWindow, setActiveWindow] = useState<DesktopWindow | null>("apps");
  const [agentWindowOpen, setAgentWindowOpen] = useState(true);
  const [activeAgentAppId, setActiveAgentAppId] = useState<AgentAppId>("codex");
  const [referencePickerOpen, setReferencePickerOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [mentionCategory, setMentionCategory] = useState<MentionCategory>("sessions");
  const [mentionQuery, setMentionQuery] = useState("");
  const [liveOutputExpanded, setLiveOutputExpanded] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>("checking");
  const [runtimeMessage, setRuntimeMessage] = useState("Connecting to the local WinAgent runtime.");
  const [lastRuntimeSyncAt, setLastRuntimeSyncAt] = useState("");
  const [error, setError] = useState("");

  const selectedWorkspace = workspaces.find((item) => item.id === selectedWorkspaceId);
  const activeAgentApp = agentApps.find((app) => app.id === activeAgentAppId) ?? agentApps[0];
  const activeAgentReadiness = agentReadiness.find((item) => item.id === activeAgentApp.id);
  const activeAgentProfile = activeAgentReadiness?.profileId
    ? agents.find((agent) => agent.id === activeAgentReadiness.profileId)
    : undefined;
  const activeRunnableProfile =
    activeAgentReadiness?.status === "ready" && activeAgentProfile ? activeAgentProfile : undefined;
  const selectedAgent = activeRunnableProfile;
  const sortedRuns = [...runs].sort((left, right) => runTimestamp(right) - runTimestamp(left));
  const scopedRuns = activeRunnableProfile
    ? sortedRuns.filter((run) => run.agentId === activeRunnableProfile.id)
    : [];
  const runningRuns = scopedRuns.filter((run) => run.status === "running" || run.status === "queued");
  const failedRuns = scopedRuns.filter((run) => run.status === "failed");
  const completedRuns = scopedRuns.filter((run) => run.status === "completed");
  const allRunningRuns = sortedRuns.filter((run) => run.status === "running" || run.status === "queued");
  const allFailedRuns = sortedRuns.filter((run) => run.status === "failed");
  const allCompletedRuns = sortedRuns.filter((run) => run.status === "completed");
  const attentionGroups = groupRunsByMessage(allFailedRuns).slice(0, 3);
  const runningGroups = groupRunsByMessage(allRunningRuns).slice(0, 3);
  const completedGroups = groupRunsByMessage(allCompletedRuns).slice(0, 2);
  const recentRuns = scopedRuns.slice(0, 8);
  const selectedRun = scopedRuns[0];
  const selectedEvents = selectedRun ? events[selectedRun.id] ?? [] : [];
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending");
  const openTasks = tasks.filter((task) => task.status !== "completed" && task.status !== "cancelled");
  const readyAgentTargets = agentApps
    .map((app) => ({ app, profile: profileForAgentApp(app.id) }))
    .filter((target): target is { app: (typeof agentApps)[number]; profile: AgentRecord } => Boolean(target.profile));

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    if (selectedWorkspaceId && agentReadiness.length > 0) {
      return;
    }
    const retry = window.setInterval(() => {
      void refreshAll();
    }, 3000);
    return () => window.clearInterval(retry);
  }, [selectedWorkspaceId, agentReadiness.length]);

  useEffect(() => {
    if (runtimeStatus !== "offline") {
      return;
    }
    const retry = window.setInterval(() => {
      void refreshAll();
    }, 5000);
    return () => window.clearInterval(retry);
  }, [runtimeStatus]);

  useEffect(() => {
    if (selectedRun) {
      void loadRunEvents(selectedRun.id);
      void loadWorkingMemory(selectedRun.id);
      setLiveOutputExpanded(false);
    } else {
      setWorkingMemory(null);
    }
  }, [selectedRun?.id, selectedRun?.status]);

  useEffect(() => {
    if (!runs.some((run) => run.status === "queued" || run.status === "running")) {
      return;
    }
    const poll = window.setInterval(() => {
      void refreshRuns();
    }, 2000);
    return () => window.clearInterval(poll);
  }, [runs]);

  useEffect(() => {
    let closed = false;
    let retryTimer: number | undefined;
    let socket: WebSocket | null = null;

    const connect = () => {
      socket = new WebSocket("ws://127.0.0.1:8787/ws");
      socket.onopen = () => {
        void refreshRuns();
      };
      socket.onmessage = (message) => {
        const envelope = JSON.parse(String(message.data)) as WebSocketEnvelope;
        if (envelope.kind === "run.event" && envelope.event) {
          const event = envelope.event;
          setEvents((previous) => ({
            ...previous,
            [event.runId]: [
              ...(previous[event.runId] ?? []),
              {
                id: event.id,
                runId: event.runId,
                sequence: event.sequence,
                type: event.type,
                payload: event.payload,
                createdAt: event.createdAt
              }
            ]
          }));
          void refreshRuns();
        }
      };
      socket.onclose = () => {
        if (!closed) {
          retryTimer = window.setTimeout(connect, 3000);
        }
      };
      socket.onerror = () => {
        socket?.close();
      };
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer) {
        window.clearTimeout(retryTimer);
      }
      socket?.close();
    };
  }, []);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setFiles([]);
      return;
    }
    void loadFiles();
    void loadWorkspaceMemories(selectedWorkspaceId);
    void loadWorkbench(selectedWorkspaceId);
  }, [selectedWorkspaceId, filePath]);

  async function refreshAll() {
    const failures: string[] = [];
    const load = async <T,>(label: string, path: string, fallback: T): Promise<T> => {
      try {
        return await api<T>(path);
      } catch (caught) {
        failures.push(`${label}: ${caught instanceof Error ? caught.message : String(caught)}`);
        return fallback;
      }
    };
    const [
      nextWorkspaces,
      nextAgents,
      nextAgentReadiness,
      nextSkills,
      nextMcp,
      nextTools,
      nextToolCalls,
      nextRuns
    ] = await Promise.all([
      load<WorkspaceRecord[]>("workspaces", "/api/workspaces", workspaces),
      load<AgentRecord[]>("agents", "/api/agents", agents),
      load<AgentReadinessRecord[]>("agent readiness", "/api/agent-readiness", agentReadiness),
      load<SkillRecord[]>("skills", "/api/skills", skills),
      load<McpServerRecord[]>("mcp servers", "/api/mcp-servers", mcpServers),
      load<McpToolRecord[]>("mcp tools", "/api/mcp-tools", mcpTools),
      load<McpToolCallRecord[]>("mcp calls", "/api/mcp-tool-calls", mcpToolCalls),
      load<RunRecord[]>("runs", "/api/runs", runs)
    ]);
    setWorkspaces(nextWorkspaces);
    setAgents(nextAgents);
    setAgentReadiness(nextAgentReadiness);
    setSkills(nextSkills);
    setMcpServers(nextMcp);
    setMcpTools(nextTools);
    setMcpToolCalls(nextToolCalls);
    setRuns(nextRuns);
    const nextWorkspaceId = nextWorkspaces.some((workspace) => workspace.id === selectedWorkspaceId)
      ? selectedWorkspaceId
      : nextWorkspaces[0]?.id || "";
    const nextActiveReadiness = nextAgentReadiness.find((item) => item.id === activeAgentAppId);
    const nextActiveProfileId = nextActiveReadiness?.status === "ready" ? nextActiveReadiness.profileId : undefined;
    const nextAgentId =
      nextActiveProfileId && nextAgents.some((agent) => agent.id === nextActiveProfileId) ? nextActiveProfileId : "";
    setSelectedWorkspaceId(nextWorkspaceId);
    setSelectedAgentId(nextAgentId);
    if (nextWorkspaceId) {
      try {
        setWorkspaceMemories(await api<WorkspaceMemoryRecord[]>(`/api/workspaces/${nextWorkspaceId}/memories`));
        await loadWorkbench(nextWorkspaceId);
      } catch (caught) {
        failures.push(`memories: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    }
    const offline = failures.length >= 6 && failures.every((failure) => /Failed to fetch|Load failed|NetworkError|refused|fetch/i.test(failure));
    setRuntimeStatus(failures.length === 0 ? "online" : offline ? "offline" : "degraded");
    setRuntimeMessage(summarizeRuntimeFailures(failures));
    setLastRuntimeSyncAt(new Date().toLocaleTimeString());
    if (failures.length === 0 && error.startsWith("Runtime")) {
      setError("");
    }
  }

  async function refreshRuns() {
    setRuns(await api<RunRecord[]>("/api/runs"));
  }

  async function loadRunEvents(runId: string) {
    const nextEvents = await api<RunEventRecord[]>(`/api/runs/${runId}/events`);
    setEvents((previous) => ({ ...previous, [runId]: nextEvents }));
  }

  async function loadWorkingMemory(runId: string) {
    setWorkingMemory(await api<RunWorkingMemoryRecord | null>(`/api/runs/${runId}/working-memory`));
  }

  async function loadWorkspaceMemories(workspaceId = selectedWorkspaceId) {
    if (!workspaceId) {
      setWorkspaceMemories([]);
      return;
    }
    setWorkspaceMemories(await api<WorkspaceMemoryRecord[]>(`/api/workspaces/${workspaceId}/memories`));
  }

  async function loadWorkbench(workspaceId = selectedWorkspaceId) {
    if (!workspaceId) {
      setTasks([]);
      setApprovals([]);
      setWorkspaceReferences([]);
      setArtifacts([]);
      return;
    }
    const [nextTasks, nextApprovals, nextReferences, nextArtifacts] = await Promise.all([
      api<TaskRecord[]>(`/api/workspaces/${workspaceId}/tasks`),
      api<ApprovalRecord[]>(`/api/workspaces/${workspaceId}/approvals`),
      api<WorkspaceReferenceRecord[]>(`/api/workspaces/${workspaceId}/references`),
      api<RunArtifactRecord[]>(`/api/workspaces/${workspaceId}/artifacts`)
    ]);
    setTasks(nextTasks);
    setApprovals(nextApprovals);
    setWorkspaceReferences(nextReferences);
    setArtifacts(nextArtifacts);
  }

  async function loadFiles() {
    try {
      const query = new URLSearchParams({ workspaceId: selectedWorkspaceId });
      if (filePath) {
        query.set("path", filePath);
      }
      setFiles(await api<FileEntry[]>(`/api/files?${query}`));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function openWorkspace() {
    try {
      const workspace = await api<WorkspaceRecord>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ rootPath: workspacePath })
      });
      await refreshAll();
      setSelectedWorkspaceId(workspace.id);
      setFilePath(workspace.rootPath);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function createRun() {
    if (!activeRunnableProfile) {
      setError(`${activeAgentApp.label} does not have a runnable local Agent profile yet.`);
      return;
    }
    try {
      const nextTitle = title.trim() || prompt.trim().slice(0, 48) || "Untitled run";
      await api<RunRecord>("/api/runs", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: selectedWorkspaceId,
          agentId: activeRunnableProfile.id,
          skillId: selectedSkillId || undefined,
          title: nextTitle,
          prompt,
          fileRefs,
          retrievalQuery,
          timeoutMs,
          maxRetries,
          toolCalls: runToolCalls
        })
      });
      await refreshRuns();
      setTitle("");
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function createMemory() {
    if (!selectedWorkspaceId || !memoryContent.trim()) {
      return;
    }
    try {
      await api<WorkspaceMemoryRecord>(`/api/workspaces/${selectedWorkspaceId}/memories`, {
        method: "POST",
        body: JSON.stringify({ type: memoryType, content: memoryContent })
      });
      setMemoryContent("");
      await loadWorkspaceMemories(selectedWorkspaceId);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function createTask() {
    if (!selectedWorkspaceId || !taskTitle.trim()) {
      return;
    }
    try {
      await api<TaskRecord>(`/api/workspaces/${selectedWorkspaceId}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          title: taskTitle,
          description: taskDescription,
          priority: "normal",
          assignedAgentId: activeRunnableProfile?.id
        })
      });
      setTaskTitle("");
      setTaskDescription("");
      await loadWorkbench(selectedWorkspaceId);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function updateTaskStatus(taskId: string, status: TaskRecord["status"]) {
    await api<TaskRecord>(`/api/tasks/${taskId}/status`, {
      method: "POST",
      body: JSON.stringify({ status })
    });
    await loadWorkbench(selectedWorkspaceId);
  }

  async function decideApproval(approvalId: string, status: ApprovalRecord["status"]) {
    await api<ApprovalRecord>(`/api/approvals/${approvalId}/decision`, {
      method: "POST",
      body: JSON.stringify({ status })
    });
    await loadWorkbench(selectedWorkspaceId);
  }

  async function createWorkspaceReference(input: {
    kind: WorkspaceReferenceRecord["kind"];
    targetId: string;
    label: string;
    summary?: string;
    metadata?: Record<string, unknown>;
  }) {
    if (!selectedWorkspaceId) {
      return;
    }
    await api<WorkspaceReferenceRecord>(`/api/workspaces/${selectedWorkspaceId}/references`, {
      method: "POST",
      body: JSON.stringify(input)
    });
    await loadWorkbench(selectedWorkspaceId);
  }

  async function cancelRun(runId: string) {
    await api(`/api/runs/${runId}/cancel`, { method: "POST" });
    await refreshRuns();
  }

  async function indexWorkspace() {
    if (!selectedWorkspaceId) {
      return;
    }
    const result = await api<{ indexed: number }>(`/api/workspaces/${selectedWorkspaceId}/index`, {
      method: "POST"
    });
    setError(`Indexed ${result.indexed} files`);
  }

  async function searchWorkspace() {
    if (!selectedWorkspaceId || !retrievalQuery.trim()) {
      return;
    }
    const query = new URLSearchParams({ q: retrievalQuery, limit: "5" });
    setRetrievalHits(await api<RetrievalHit[]>(`/api/workspaces/${selectedWorkspaceId}/search?${query}`));
  }

  async function createMcpServer() {
    await api<McpServerRecord>("/api/mcp-servers", {
      method: "POST",
      body: JSON.stringify({
        name: mcpName,
        command: mcpCommand,
        args: mcpArgs.split(/\s+/).filter(Boolean),
        env: {}
      })
    });
    await refreshAll();
  }

  async function startMcp(serverId: string) {
    await api<McpServerRecord>(`/api/mcp-servers/${serverId}/start`, { method: "POST" });
    await refreshAll();
  }

  async function stopMcp(serverId: string) {
    await api<McpServerRecord>(`/api/mcp-servers/${serverId}/stop`, { method: "POST" });
    await refreshAll();
  }

  async function callMcpTool(tool: McpToolRecord) {
    await api<McpToolCallRecord>(
      `/api/mcp-servers/${tool.serverId}/tools/${encodeURIComponent(tool.name)}/call`,
      {
        method: "POST",
        body: JSON.stringify({ arguments: JSON.parse(toolArguments || "{}") })
      }
    );
    await refreshAll();
  }

  function addToolToRun(tool: McpToolRecord) {
    setRunToolCalls([
      ...runToolCalls,
      {
        serverId: tool.serverId,
        toolName: tool.name,
        arguments: JSON.parse(toolArguments || "{}")
      }
    ]);
  }

  async function exportRun(run: RunRecord) {
    const result = await api<{ markdown: string }>(`/api/runs/${run.id}/export`);
    const blob = new Blob([result.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${run.title.replace(/[^\w.-]+/g, "_") || "run"}-${run.id}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const output = useMemo(
    () =>
      selectedEvents
        .filter((event) => event.type === "run.output.delta" || event.type === "run.error.delta")
        .map((event) => String((event.payload as any).text ?? ""))
        .join(""),
    [selectedEvents]
  );
  const selectedAnswer = selectedRun ? runAnswer(selectedRun, selectedEvents) : "";

  const visibleMcpServers = mcpServers.slice(0, 6);
  const visibleMcpTools = mcpTools.slice(0, 8);
  const visibleToolCalls = mcpToolCalls.slice(0, 5);
  const recentMemories = workspaceMemories.slice(0, 6);
  const activeMcpServers = mcpServers.filter((server) => server.status === "running").length;

  function appendPromptToken(token: string) {
    setPrompt((current) => `${current.trimEnd()} ${token} `.trimStart());
    setCommandPaletteOpen(false);
    setReferencePickerOpen(false);
  }

  function appendMention(label: string, uri: string) {
    appendPromptToken(`@[${label}](${uri})`);
  }

  function mentionUri(kind: string, id: string): string {
    const params = new URLSearchParams();
    if (selectedWorkspaceId) {
      params.set("workspaceId", selectedWorkspaceId);
    }
    return `mention://winagent/${kind}/${encodeURIComponent(id)}${params.toString() ? `?${params.toString()}` : ""}`;
  }

  function workspaceReferenceUri(reference: WorkspaceReferenceRecord): string {
    const params = new URLSearchParams({
      source: reference.kind,
      workspaceId: reference.workspaceId
    });
    return `mention://workspace-reference/${encodeURIComponent(reference.id)}?${params.toString()}`;
  }

  function agentLabelForRun(run: RunRecord): string {
    const agent = agents.find((item) => item.id === run.agentId);
    if (!agent) {
      return run.agentId;
    }
    const app = agentApps.find((candidate) => candidate.id === agent.adapterId);
    return app?.label ?? agent.name;
  }

  function profileForAgentApp(appId: AgentAppId): AgentRecord | undefined {
    const readiness = agentReadiness.find((item) => item.id === appId);
    if (readiness?.status !== "ready" || !readiness.profileId) {
      return undefined;
    }
    return agents.find((agent) => agent.id === readiness.profileId);
  }

  function handoffTargetsForRun(run: RunRecord): Array<{ app: (typeof agentApps)[number]; profile: AgentRecord }> {
    return readyAgentTargets.filter((target) => target.profile.id !== run.agentId);
  }

  function handoffPrompt(sourceRun: RunRecord, sourceEvents: RunEventRecord[], targetLabel: string): string {
    const sourceAgent = agentLabelForRun(sourceRun);
    const answer = runDisplayMessage(sourceRun, sourceEvents);
    return [
      `You are ${targetLabel}. Continue from a previous ${sourceAgent} run in the same workspace.`,
      "",
      "Use the prior run as shared context. If you disagree with the prior answer, say why and provide a better next step.",
      "",
      `Source Agent: ${sourceAgent}`,
      `Source run: ${sourceRun.title}`,
      "",
      "Original prompt:",
      sourceRun.prompt,
      "",
      "Source Agent answer / latest output:",
      answer || sourceRun.summary || "No answer captured yet.",
      "",
      "Now continue the work and return a concrete, usable result."
    ].join("\n");
  }

  async function handoffRun(sourceRun: RunRecord, targetAppId: AgentAppId) {
    const targetApp = agentApps.find((app) => app.id === targetAppId);
    const targetProfile = profileForAgentApp(targetAppId);
    if (!targetApp || !targetProfile) {
      setError(`${targetApp?.label ?? targetAppId} does not have a runnable profile.`);
      return;
    }
    try {
      const sourceEvents = events[sourceRun.id] ?? (await api<RunEventRecord[]>(`/api/runs/${sourceRun.id}/events`));
      setEvents((previous) => ({ ...previous, [sourceRun.id]: sourceEvents }));
      await api<RunRecord>("/api/runs", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: sourceRun.workspaceId,
          agentId: targetProfile.id,
          title: `Handoff to ${targetApp.label}: ${sourceRun.title}`,
          prompt: handoffPrompt(sourceRun, sourceEvents, targetApp.label),
          retrievalQuery: sourceRun.retrievalQuery || sourceRun.prompt.slice(0, 120),
          timeoutMs,
          maxRetries
        })
      });
      await Promise.all([refreshRuns(), loadWorkbench(selectedWorkspaceId)]);
      setActiveAgentAppId(targetApp.id);
      setAgentWindowOpen(true);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function renderHandoffActions(run: RunRecord) {
    const targets = handoffTargetsForRun(run);
    if (targets.length === 0) {
      return null;
    }
    return targets.slice(0, 3).map(({ app }) => (
      <button key={app.id} onClick={() => void handoffRun(run, app.id)}>
        Handoff to {app.label}
      </button>
    ));
  }

  function openAgentApp(appId: AgentAppId) {
    const app = agentApps.find((candidate) => candidate.id === appId) ?? agentApps[0];
    setActiveAgentAppId(app.id);
    setAgentWindowOpen(true);
    const readiness = agentReadiness.find((item) => item.id === app.id);
    const profile =
      readiness?.status === "ready" && readiness.profileId
        ? agents.find((agent) => agent.id === readiness.profileId)
        : undefined;
    if (profile) {
      setSelectedAgentId(profile.id);
    } else {
      setSelectedAgentId("");
    }
  }

  function openRunDetails(run: RunRecord) {
    void loadRunEvents(run.id);
    void loadWorkingMemory(run.id);
    setActiveWindow("runs");
  }

  function mentionItems(): Array<{
    key: string;
    label: string;
    description: string;
    action: () => void;
  }> {
    const query = mentionQuery.trim().toLowerCase();
    const matches = (value: string) => !query || value.toLowerCase().includes(query);
    const items: Array<{ key: string; label: string; description: string; action: () => void }> = [];
    if (mentionCategory === "sessions") {
      for (const run of sortedRuns.slice(0, 12)) {
        const label = `${agentLabelForRun(run)} · ${run.title}`;
        if (!matches(`${label} ${run.prompt} ${run.summary ?? ""}`)) continue;
        items.push({
          key: run.id,
          label,
          description: compactRunMessage(run),
          action: () => appendMention(label, mentionUri("run", run.id))
        });
      }
    }
    if (mentionCategory === "files") {
      for (const file of files.slice(0, 16)) {
        const label = file.name;
        if (!matches(`${label} ${file.path}`)) continue;
        items.push({
          key: file.path,
          label,
          description: file.path,
          action: () => {
            if (file.kind === "directory") {
              setFilePath(file.path);
              return;
            }
            if (!fileRefs.includes(file.path)) {
              setFileRefs((current) => [...current, file.path]);
            }
            appendMention(label, mentionUri("file", file.path));
          }
        });
      }
    }
    if (mentionCategory === "tasks") {
      for (const task of tasks.slice(0, 16)) {
        const label = task.title;
        if (!matches(`${label} ${task.description}`)) continue;
        items.push({
          key: task.id,
          label,
          description: `${task.status} · ${task.description || "No description"}`,
          action: () => appendMention(label, mentionUri("task", task.id))
        });
      }
    }
    if (mentionCategory === "apps") {
      for (const artifact of artifacts.slice(0, 8)) {
        const label = artifact.name;
        if (!matches(`${label} ${artifact.mimeType}`)) continue;
        items.push({
          key: artifact.id,
          label,
          description: `Artifact · ${artifact.mimeType}`,
          action: () => appendMention(label, mentionUri("artifact", artifact.id))
        });
      }
      for (const reference of workspaceReferences.slice(0, 8)) {
        const label = reference.label;
        if (!matches(`${label} ${reference.summary ?? ""}`)) continue;
        items.push({
          key: reference.id,
          label,
          description: `${reference.kind} reference · ${reference.summary || reference.targetId}`,
          action: () => appendMention(label, workspaceReferenceUri(reference))
        });
      }
    }
    if (mentionCategory === "agents") {
      for (const target of readyAgentTargets) {
        if (!matches(`${target.app.label} ${target.app.description}`)) continue;
        items.push({
          key: target.app.id,
          label: target.app.label,
          description: target.app.description,
          action: () => {
            openAgentApp(target.app.id);
            appendMention(target.app.label, mentionUri("agent", target.profile.id));
          }
        });
      }
    }
    return items;
  }

  function buildGoalPlan(): Array<{ title: string; description: string }> {
    const goal = goalText.trim();
    if (!goal) {
      return [];
    }
    return [
      {
        title: `Clarify scope: ${goal.slice(0, 44)}`,
        description: `Define acceptance criteria, required files, constraints, and expected output for: ${goal}`
      },
      {
        title: `Collect context for: ${goal.slice(0, 44)}`,
        description: `Inspect workspace files, memories, recent runs, artifacts, and reusable references related to: ${goal}`
      },
      {
        title: `Implement core deliverable: ${goal.slice(0, 44)}`,
        description: `Build the smallest complete result that satisfies the goal, preserving existing workspace behavior.`
      },
      {
        title: `Verify and package: ${goal.slice(0, 44)}`,
        description: `Run relevant checks, summarize changes, create reusable artifacts, and mark follow-up risks.`
      }
    ];
  }

  async function createPlannedTasks() {
    const plan = plannedTasks.length > 0 ? plannedTasks : buildGoalPlan();
    if (!selectedWorkspaceId || plan.length === 0) {
      return;
    }
    try {
      for (const item of plan) {
        await api<TaskRecord>(`/api/workspaces/${selectedWorkspaceId}/tasks`, {
          method: "POST",
          body: JSON.stringify({
            title: item.title,
            description: item.description,
            priority: "normal",
            assignedAgentId: activeRunnableProfile?.id
          })
        });
      }
      setPlannedTasks([]);
      setGoalText("");
      await loadWorkbench(selectedWorkspaceId);
      setActiveWindow("tasks");
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function sendTaskToAgent(task: TaskRecord, target: { app: (typeof agentApps)[number]; profile: AgentRecord }) {
    if (!selectedWorkspaceId) {
      return;
    }
    try {
      await updateTaskStatus(task.id, "in_progress");
      await api<RunRecord>("/api/runs", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: selectedWorkspaceId,
          agentId: target.profile.id,
          title: `${task.title} · ${target.app.label}`,
          prompt: [
            `You are ${target.app.label}. Complete this workspace task.`,
            "",
            `Task: ${task.title}`,
            "",
            task.description || "No description provided.",
            "",
            "Use workspace files, memories, artifacts, and previous runs when relevant. Return concrete output and verification steps."
          ].join("\n"),
          retrievalQuery: task.description || task.title,
          timeoutMs,
          maxRetries
        })
      });
      await Promise.all([refreshRuns(), loadWorkbench(selectedWorkspaceId)]);
      setActiveAgentAppId(target.app.id);
      setAgentWindowOpen(true);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function createAgentProfile(appId: AgentAppId) {
    const app = agentApps.find((candidate) => candidate.id === appId) ?? agentApps[0];
    try {
      const agent = await api<AgentRecord>("/api/agents/provision", {
        method: "POST",
        body: JSON.stringify({
          id: appId,
          cwd: selectedWorkspace?.rootPath
        })
      });
      await refreshAll();
      setSelectedAgentId(agent.id);
      openAgentApp(app.id);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <main className="tutti-shell">
      <div className="ambient-grid" />
      <div className="ambient-horse ambient-horse-left">▦</div>
      <div className="ambient-horse ambient-horse-right">▦</div>

      <header className="workspace-menubar">
        <div className="brand-lockup">
          <span className="brand-mark">W</span>
          <div>
            <strong>WinAgent.</strong>
            <small>Windows-first shared Agent workspace</small>
          </div>
        </div>
        <div className="workspace-status">
          <span className={`status-pill runtime ${runtimeStatus}`}>{runtimeStatusLabel(runtimeStatus)}</span>
          <button className="glass-button" onClick={() => void refreshAll()}>
            Refresh
          </button>
          <span className="status-pill">{allRunningRuns.length} running</span>
          <span className="status-pill">{allFailedRuns.length} waiting</span>
          <span className="status-pill">{activeMcpServers} MCP online</span>
        </div>
      </header>

      {runtimeStatus !== "online" ? (
        <section className={`runtime-banner ${runtimeStatus}`} role="status">
          <div>
            <strong>{runtimeStatusLabel(runtimeStatus)}</strong>
            <p>{runtimeMessage}</p>
            {lastRuntimeSyncAt ? <small>Last check: {lastRuntimeSyncAt}</small> : null}
          </div>
          <button onClick={() => void refreshAll()}>Retry now</button>
        </section>
      ) : null}

      {error ? <div className="toast-error">{error}</div> : null}

      <section className="desktop-stage">
        {agentWindowOpen ? (
        <article className="workspace-window agent-window">
          <div className="window-titlebar">
            <div className="window-app-id">
              <span className="window-app-icon">{activeAgentApp.icon}</span>
              <strong>{activeAgentApp.label}</strong>
            </div>
            <span className="window-spacer" />
            <button className="title-action" onClick={() => setActiveWindow("runs")}>Session history</button>
            <div className="windows-controls">
              <button className="win-control" onClick={() => setAgentWindowOpen(false)} aria-label="Minimize Agent window">
                —
              </button>
              <span aria-hidden="true">□</span>
              <button className="win-control close" onClick={() => setAgentWindowOpen(false)} aria-label="Close Agent window">
                ×
              </button>
            </div>
          </div>

          <div className="agent-layout">
            <aside className="session-sidebar">
              <div className="sidebar-head">
                <input
                  aria-label="Workspace path"
                  value={workspacePath}
                  onChange={(event) => setWorkspacePath(event.target.value)}
                />
                <button onClick={() => void openWorkspace()}>Open</button>
              </div>
              <div className="sidebar-section">
                <span>Projects</span>
                <select value={selectedWorkspaceId} onChange={(event) => setSelectedWorkspaceId(event.target.value)}>
                  <option value="">No workspace</option>
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
                </select>
                <small>{selectedWorkspace?.rootPath ?? "No project selected"}</small>
              </div>
              <div className="sidebar-section">
                <span>Agents</span>
                <div className="agent-app-switcher">
                  {agentApps.map((app) => (
                    <button
                      key={app.id}
                      className={activeAgentAppId === app.id ? "active" : ""}
                      onClick={() => openAgentApp(app.id)}
                    >
                      {app.label}
                    </button>
                  ))}
                </div>
                <div className={`agent-readiness ${readinessClass(activeAgentReadiness)}`}>
                  <strong>{readinessLabel(activeAgentReadiness)}</strong>
                  <span>{activeAgentReadiness?.message ?? "Checking local Agent runtime."}</span>
                </div>
                <select
                  value={activeRunnableProfile?.id ?? ""}
                  disabled={!activeRunnableProfile}
                  onChange={(event) => setSelectedAgentId(event.target.value)}
                >
                  <option value="">No runnable profile</option>
                  {activeRunnableProfile ? (
                    <option value={activeRunnableProfile.id}>{activeRunnableProfile.name}</option>
                  ) : null}
                </select>
                <small>
                  {selectedAgent
                    ? `${selectedAgent.name} is selected for this run.`
                    : `${activeAgentApp.label} is not runnable in this environment.`}
                </small>
                {!activeAgentProfile && activeAgentReadiness?.status === "ready" ? (
                  <button className="profile-action" onClick={() => void createAgentProfile(activeAgentApp.id)}>
                    Create {activeAgentApp.label} profile
                  </button>
                ) : null}
                {activeAgentReadiness && activeAgentReadiness.status !== "ready" ? (
                  <button className="profile-action" disabled>
                    {readinessLabel(activeAgentReadiness)}
                  </button>
                ) : null}
              </div>
              <div className="session-list">
                {recentRuns.length === 0 ? (
                  <p className="empty-state">
                    {activeRunnableProfile ? "No runs for this Agent yet." : "No runnable profile for this Agent."}
                  </p>
                ) : null}
                {recentRuns.map((run) => (
                  <button key={run.id} className="session-item" onClick={() => void loadRunEvents(run.id)}>
                    <strong>{run.title}</strong>
                    <span>{run.status}</span>
                    <small>{run.summary || run.prompt}</small>
                  </button>
                ))}
              </div>
            </aside>

            <section className="agent-canvas">
              <div className="agent-hero">
                <div className="agent-orb">›_</div>
                <h1>What can your Agent help you with?</h1>
                <p>Reference files, memories, app outputs, MCP tools, and run history from one workspace.</p>
              </div>

              <div className="composer-card">
                {commandPaletteOpen ? (
                  <div className="command-palette">
                    <nav>
                      {mentionCategories.map((category) => (
                        <button
                          key={category.id}
                          className={mentionCategory === category.id ? "active" : ""}
                          onClick={() => setMentionCategory(category.id)}
                        >
                          {category.label}
                        </button>
                      ))}
                    </nav>
                    <input
                      value={mentionQuery}
                      onChange={(event) => setMentionQuery(event.target.value)}
                      placeholder="Search sessions, files, tasks, apps, or agents"
                    />
                    {mentionItems().length === 0 ? <p className="empty-state">No matching workspace references.</p> : null}
                    {mentionItems().map((item) => (
                      <button key={item.key} onClick={item.action}>
                        <strong>{item.label}</strong>
                        <small>{item.description}</small>
                      </button>
                    ))}
                  </div>
                ) : null}

                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onFocus={() => setCommandPaletteOpen(false)}
                  placeholder="Ask the Agent what you need. The answer will appear below automatically."
                />

                <div className="reference-chips">
                  {fileRefs.map((ref) => (
                    <span className="reference-chip file" key={ref}>
                      file · {ref.split(/[\\/]/).pop()}
                    </span>
                  ))}
                  {runToolCalls.map((tool, index) => (
                    <span className="reference-chip tool" key={`${tool.serverId}-${tool.toolName}-${index}`}>
                      tool · {tool.toolName}
                    </span>
                  ))}
                  {retrievalHits.map((hit) => (
                    <span className="reference-chip search" key={hit.path}>
                      search · {hit.path.split(/[\\/]/).pop()}
                    </span>
                  ))}
                </div>

                <div className="composer-toolbar">
                  <button className="round-button" onClick={() => setReferencePickerOpen(true)}>
                    +
                  </button>
                  <button className="ghost-action" onClick={() => setCommandPaletteOpen((open) => !open)}>
                    @ Workspace
                  </button>
                  <select value={selectedSkillId} onChange={(event) => setSelectedSkillId(event.target.value)}>
                    <option value="">Auto-review</option>
                    {skills.map((skill) => (
                      <option key={skill.id} value={skill.id}>
                        {skill.name}
                      </option>
                    ))}
                  </select>
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    aria-label="Run title"
                    placeholder="Optional title"
                  />
                  <button
                    className="send-button"
                    disabled={!selectedWorkspaceId || !activeRunnableProfile || !prompt.trim()}
                    onClick={() => void createRun()}
                  >
                    Send
                  </button>
                </div>

                <div className="workspace-strip">
                  <button onClick={() => setActiveWindow("files")}>{selectedWorkspace?.name ?? "Set workspace"}</button>
                  <span>Tips: use + to attach context, @ to call tools or agents.</span>
                  <button onClick={() => void indexWorkspace()}>Build index</button>
                  <button onClick={() => void searchWorkspace()}>Search</button>
                </div>
              </div>

              <div className={liveOutputExpanded ? "live-terminal expanded" : "live-terminal collapsed"}>
                <div className="live-terminal-head">
                  <strong>Run activity</strong>
                  <span>{selectedRun ? `${selectedRun.title} · ${messageStatusLabel(selectedRun.status)}` : "No active run"}</span>
                </div>
                <div className="run-activity-card">
                  <div className="card-head">
                    <strong>{selectedRun?.title ?? "No run selected"}</strong>
                    <span>{selectedRun ? messageStatusLabel(selectedRun.status) : "Idle"}</span>
                  </div>
                  {selectedRun ? (
                    <div className="answer-card">
                      <small>You asked</small>
                      <p>{selectedRun.prompt}</p>
                      <small>Agent answer</small>
                      <p>{runDisplayMessage(selectedRun, selectedEvents)}</p>
                    </div>
                  ) : (
                    <p>
                      {activeRunnableProfile
                        ? "Start a run or open run details from the message center."
                        : `${activeAgentApp.label} is not runnable yet, so it cannot show a Codex answer.`}
                    </p>
                  )}
                  <div className="message-actions">
                    <button disabled={!selectedRun} onClick={() => selectedRun ? openRunDetails(selectedRun) : undefined}>
                      Open details
                    </button>
                    <button disabled={!output} onClick={() => setLiveOutputExpanded((expanded) => !expanded)}>
                      {liveOutputExpanded ? "Hide logs" : "Show logs"}
                    </button>
                  </div>
                </div>
                {liveOutputExpanded ? <pre>{output || "No run output yet."}</pre> : null}
              </div>
            </section>
          </div>
        </article>
        ) : null}

        <aside className="control-center">
          <div className="control-head">
            <h2>Agent messages</h2>
            <button onClick={() => setActiveWindow("runs")}>Open Runs</button>
          </div>

          <section className="message-overview" aria-label="Run status summary">
            <div className="metric-card attention">
              <strong>{allFailedRuns.length}</strong>
              <span>Need review</span>
            </div>
            <div className="metric-card">
              <strong>{allRunningRuns.length}</strong>
              <span>Running</span>
            </div>
            <div className="metric-card">
              <strong>{allCompletedRuns.length}</strong>
              <span>Completed</span>
            </div>
            <div className="metric-card">
              <strong>{openTasks.length}</strong>
              <span>Open tasks</span>
            </div>
            <div className="metric-card attention">
              <strong>{pendingApprovals.length}</strong>
              <span>Approvals</span>
            </div>
          </section>

          <section>
            <h3>Approvals · {pendingApprovals.length}</h3>
            {pendingApprovals.length === 0 ? <p className="empty-state">No pending approvals.</p> : null}
            {pendingApprovals.slice(0, 3).map((approval) => (
              <div className="message-card attention" key={approval.id}>
                <div className="card-head">
                  <strong>{approval.title}</strong>
                  <span>{approval.kind}</span>
                </div>
                <p>{approval.description || "Review this item before continuing."}</p>
                <div className="message-actions">
                  <button onClick={() => void decideApproval(approval.id, "approved")}>Approve</button>
                  <button onClick={() => void decideApproval(approval.id, "rejected")}>Reject</button>
                  <button onClick={() => setActiveWindow("approvals")}>Open</button>
                </div>
              </div>
            ))}
          </section>

          <section>
            <h3>Tasks · {openTasks.length}</h3>
            {openTasks.length === 0 ? <p className="empty-state">No open tasks.</p> : null}
            {openTasks.slice(0, 3).map((task) => (
              <div className="message-card compact" key={task.id}>
                <div className="card-head">
                  <strong>{task.title}</strong>
                  <span>{task.status}</span>
                </div>
                <p>{task.description || "No description."}</p>
                <div className="message-actions">
                  <button onClick={() => setActiveWindow("tasks")}>Open tasks</button>
                  <button onClick={() => void updateTaskStatus(task.id, "completed")}>Complete</button>
                </div>
              </div>
            ))}
          </section>

          <section>
            <h3>Needs attention · {attentionGroups.length}</h3>
            {attentionGroups.length === 0 ? <p className="empty-state">No failed runs waiting.</p> : null}
            {attentionGroups.map((group) => (
              <div className="message-card attention" key={group.key}>
                <div className="card-head">
                  <strong>{group.latest.title}</strong>
                  <span>{messageStatusLabel(group.latest.status)}</span>
                </div>
                <small>From {agentLabelForRun(group.latest)}</small>
                <p>{compactRunMessage(group.latest)}</p>
                <div className="message-meta">
                  <small>{group.runs.length > 1 ? `${group.runs.length} related runs` : "Latest failure"}</small>
                  <small>{group.latest.exitCode !== null && group.latest.exitCode !== undefined ? `exit ${group.latest.exitCode}` : "no exit code"}</small>
                </div>
                <div className="message-actions">
                  <button onClick={() => openRunDetails(group.latest)}>Open details</button>
                  <button onClick={() => void exportRun(group.latest)}>Export</button>
                  {renderHandoffActions(group.latest)}
                </div>
              </div>
            ))}
          </section>

          {runningGroups.length > 0 ? (
            <section>
              <h3>Running · {runningGroups.length}</h3>
              {runningGroups.map((group) => (
              <div className="message-card status-running" key={group.key}>
                <div className="card-head">
                  <strong>{group.latest.title}</strong>
                  <span>{messageStatusLabel(group.latest.status)}</span>
                </div>
                <small>From {agentLabelForRun(group.latest)}</small>
                <p>{compactRunMessage(group.latest)}</p>
                <div className="message-actions">
                  <button onClick={() => openRunDetails(group.latest)}>Open details</button>
                  <button onClick={() => void cancelRun(group.latest.id)}>Cancel</button>
                  {renderHandoffActions(group.latest)}
                </div>
              </div>
              ))}
            </section>
          ) : null}

          <section>
            <h3>Recent completed · {completedGroups.length}</h3>
            {completedGroups.length === 0 ? <p className="empty-state">No completed runs yet.</p> : null}
            {completedGroups.map((group) => (
              <div className="message-card compact" key={group.key}>
                <div className="card-head">
                  <strong>{group.latest.title}</strong>
                  <span>{messageStatusLabel(group.latest.status)}</span>
                </div>
                <small>From {agentLabelForRun(group.latest)}</small>
                <p>{compactRunMessage(group.latest)}</p>
                <div className="message-actions">
                  <button onClick={() => openRunDetails(group.latest)}>Open details</button>
                  {renderHandoffActions(group.latest)}
                </div>
              </div>
            ))}
          </section>
        </aside>
      </section>

      {referencePickerOpen ? (
        <div className="modal-backdrop" onClick={() => setReferencePickerOpen(false)}>
          <section className="reference-picker" onClick={(event) => event.stopPropagation()}>
            <div className="window-titlebar">
              <div className="window-app-id">
                <span className="window-app-icon">+</span>
                <strong>Pick workspace references</strong>
              </div>
              <span className="window-spacer" />
              <div className="windows-controls">
                <span aria-hidden="true">—</span>
                <span aria-hidden="true">□</span>
                <button className="win-control close" onClick={() => setReferencePickerOpen(false)} aria-label="Close reference picker">
                  ×
                </button>
              </div>
            </div>
            <div className="reference-picker-grid">
              <aside>
                <button className="active" onClick={() => setActiveWindow("files")}>Local files</button>
                <button onClick={() => setActiveWindow("memory")}>Memories</button>
                <button onClick={() => setActiveWindow("runs")}>Runs</button>
                <button onClick={() => setActiveWindow("artifacts")}>Artifacts</button>
                <button onClick={() => setActiveWindow("references")}>References</button>
                <button onClick={() => setActiveWindow("mcp")}>MCP tools</button>
              </aside>
              <div className="reference-results">
                <input
                  value={retrievalQuery}
                  onChange={(event) => setRetrievalQuery(event.target.value)}
                  placeholder="Search files, memories, and runs"
                />
                <div className="reference-section-title">Recent Agent outputs</div>
                {sortedRuns.slice(0, 5).map((run) => (
                  <button
                    key={run.id}
                    className="reference-result"
                    onClick={() => appendMention(`${agentLabelForRun(run)} · ${run.title}`, mentionUri("run", run.id))}
                  >
                    <span>{run.status}</span>
                    <strong>{agentLabelForRun(run)} · {run.title}</strong>
                    <small>{compactRunMessage(run)}</small>
                  </button>
                ))}
                <div className="reference-section-title">Tasks</div>
                {openTasks.slice(0, 5).map((task) => (
                  <button
                    key={task.id}
                    className="reference-result"
                    onClick={() => appendMention(task.title, mentionUri("task", task.id))}
                  >
                    <span>{task.status}</span>
                    <strong>{task.title}</strong>
                    <small>{task.description || "No description"}</small>
                  </button>
                ))}
                <div className="reference-section-title">Memories</div>
                {recentMemories.slice(0, 4).map((memory) => (
                  <button
                    key={memory.id}
                    className="reference-result"
                    onClick={() => appendMention(`${memory.type} memory`, mentionUri("memory", memory.id))}
                  >
                    <span>{memory.type}</span>
                    <strong>{memory.content.slice(0, 64)}</strong>
                    <small>{memory.createdAt}</small>
                  </button>
                ))}
                <div className="reference-section-title">Local files</div>
                {files.slice(0, 10).map((file) => (
                  <button
                    key={file.path}
                    className="reference-result"
                    onClick={() => {
                      if (file.kind === "directory") {
                        setFilePath(file.path);
                      } else if (!fileRefs.includes(file.path)) {
                        setFileRefs([...fileRefs, file.path]);
                      }
                    }}
                  >
                    <span>{file.kind}</span>
                    <strong>{file.name}</strong>
                    <small>{file.path}</small>
                  </button>
                ))}
                <div className="reference-section-title">Artifacts</div>
                {artifacts.slice(0, 5).map((artifact) => (
                  <button
                    key={artifact.id}
                    className="reference-result"
                    onClick={() => {
                      appendPromptToken(`@artifact:${artifact.name}`);
                      void createWorkspaceReference({
                        kind: "artifact",
                        targetId: artifact.id,
                        label: artifact.name,
                        summary: artifact.contentText?.slice(0, 160),
                        metadata: { runId: artifact.runId, mimeType: artifact.mimeType }
                      });
                    }}
                  >
                    <span>artifact</span>
                    <strong>{artifact.name}</strong>
                    <small>{artifact.mimeType}</small>
                  </button>
                ))}
                <div className="reference-section-title">Workspace references</div>
                {workspaceReferences.slice(0, 5).map((reference) => (
                  <button
                    key={reference.id}
                    className="reference-result"
                    onClick={() => appendMention(reference.label, workspaceReferenceUri(reference))}
                  >
                    <span>{reference.kind}</span>
                    <strong>{reference.label}</strong>
                    <small>{reference.summary}</small>
                  </button>
                ))}
              </div>
              <aside className="reference-preview">
                <strong>Selected</strong>
                {fileRefs.length === 0 ? <p>No files selected.</p> : null}
                {fileRefs.map((ref) => (
                  <span className="reference-chip file" key={ref}>{ref}</span>
                ))}
                <button onClick={() => setFileRefs([])}>Clear references</button>
                <button className="primary" onClick={() => setReferencePickerOpen(false)}>
                  Use selected references
                </button>
              </aside>
            </div>
          </section>
        </div>
      ) : null}

      {activeWindow ? (
      <section className="workspace-window floating-window">
        <div className="window-titlebar">
          <div className="window-app-id">
            <span className="window-app-icon">
              {activeWindow === "apps" ? "A" : null}
              {activeWindow === "files" ? "F" : null}
              {activeWindow === "memory" ? "M" : null}
              {activeWindow === "mcp" ? "T" : null}
              {activeWindow === "runs" ? "R" : null}
              {activeWindow === "tasks" ? "Ta" : null}
              {activeWindow === "artifacts" ? "Ar" : null}
              {activeWindow === "references" ? "Re" : null}
              {activeWindow === "approvals" ? "Ap" : null}
            </span>
            <strong>
              {activeWindow === "apps" ? "Applications" : null}
              {activeWindow === "files" ? "Files" : null}
              {activeWindow === "memory" ? "Memory" : null}
              {activeWindow === "mcp" ? "Skill & MCP" : null}
              {activeWindow === "runs" ? "Runs" : null}
              {activeWindow === "tasks" ? "Task Center" : null}
              {activeWindow === "artifacts" ? "Artifacts" : null}
              {activeWindow === "references" ? "References" : null}
              {activeWindow === "approvals" ? "Approvals" : null}
            </strong>
          </div>
          <span className="window-spacer" />
          <button className="title-action" onClick={() => setActiveWindow("apps")}>Home</button>
          <div className="windows-controls">
            <button className="win-control" onClick={() => setActiveWindow(null)} aria-label="Minimize window">
              —
            </button>
            <span aria-hidden="true">□</span>
            <button className="win-control close" onClick={() => setActiveWindow(null)} aria-label="Close window">
              ×
            </button>
          </div>
        </div>

        {activeWindow === "apps" ? (
          <div className="app-market">
            {agentApps.map((app) => (
              (() => {
                const readiness = agentReadiness.find((item) => item.id === app.id);
                return (
                  <button className="app-card agent-app-card" key={app.id} onClick={() => openAgentApp(app.id)}>
                    <span className="app-icon">{app.icon}</span>
                    <strong>{app.label}</strong>
                    <p>{app.description}</p>
                    <small>{activeAgentAppId === app.id && agentWindowOpen ? "Open" : readinessLabel(readiness)}</small>
                  </button>
                );
              })()
            ))}
            {[
              ["Task Center", "Break goals into sub-tasks and send them to agents.", "Open"],
              ["Goal Planner", "Describe an outcome, review generated sub-tasks, and assign them to Agents.", "Open"],
              ["Reference Picker", "Attach files, memories, tool calls, and run outputs.", "Open"],
              ["Artifacts", "Review generated outputs and reuse them as context.", "Open"],
              ["Approvals", "Review failed runs and pending human decisions.", "Open"],
              ["Memory Hub", "Curate long-term memory and inspect working memory.", "Open"],
              ["MCP Tools", "Start local tool servers and attach calls to a run.", "Open"],
              ["Run Reports", "Review execution history and export artifacts.", "Open"],
              ["Desktop Preview", "Electron shell for local demos.", "Coming soon"]
            ].map(([name, description, action]) => (
              <button
                className="app-card"
                key={name}
                onClick={() => {
                  if (name === "Reference Picker") setReferencePickerOpen(true);
                  if (name === "Goal Planner") setActiveWindow("tasks");
                  if (name === "Artifacts") setActiveWindow("artifacts");
                  if (name === "Approvals") setActiveWindow("approvals");
                  if (name === "Memory Hub") setActiveWindow("memory");
                  if (name === "MCP Tools") setActiveWindow("mcp");
                  if (name === "Run Reports") setActiveWindow("runs");
                  if (name === "Task Center") setActiveWindow("tasks");
                }}
              >
                <span className="app-icon">{name.slice(0, 2)}</span>
                <strong>{name}</strong>
                <p>{description}</p>
                <small>{action}</small>
              </button>
            ))}
          </div>
        ) : null}

        {activeWindow === "files" ? (
          <div className="window-content split-content">
            <div>
              <div className="file-actions">
                <button onClick={() => setFilePath(selectedWorkspace?.rootPath ?? "")}>Root</button>
                <button onClick={() => setFileRefs([])}>Clear refs</button>
              </div>
              <div className="file-list">
                {files.map((file) => (
                  <button
                    key={file.path}
                    className="file-row"
                    onClick={() => {
                      if (file.kind === "directory") {
                        setFilePath(file.path);
                      } else if (!fileRefs.includes(file.path)) {
                        setFileRefs([...fileRefs, file.path]);
                      }
                    }}
                  >
                    <span>{file.kind}</span>
                    <strong>{file.name}</strong>
                  </button>
                ))}
              </div>
            </div>
            <div className="preview-pane">
              <h3>Referenced files</h3>
              {fileRefs.map((ref) => (
                <span className="reference-chip file" key={ref}>{ref}</span>
              ))}
            </div>
          </div>
        ) : null}

        {activeWindow === "memory" ? (
          <div className="window-content split-content">
            <div className="memory-editor">
              <label>
                Memory type
                <select value={memoryType} onChange={(event) => setMemoryType(event.target.value as MemoryType)}>
                  {memoryTypes.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </label>
              <label>
                Memory content
                <textarea value={memoryContent} onChange={(event) => setMemoryContent(event.target.value)} />
              </label>
              <div className="file-actions">
                <button disabled={!selectedWorkspaceId || !memoryContent.trim()} onClick={() => void createMemory()}>
                  Add memory
                </button>
                <button disabled={!selectedWorkspaceId} onClick={() => void loadWorkspaceMemories()}>
                  Reload
                </button>
              </div>
              <h3>Short-term working memory</h3>
              <pre>{workingMemory?.content ?? "No working memory for the selected run yet."}</pre>
            </div>
            <div className="memory-list">
              {recentMemories.map((memory) => (
                <button className="memory-row" key={memory.id} onClick={() => appendPromptToken(`@memory:${memory.type}`)}>
                  <div>
                    <strong>{memory.type}</strong>
                    <small>{memory.createdAt}</small>
                  </div>
                  <p>{memory.content}</p>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {activeWindow === "mcp" ? (
          <div className="window-content split-content">
            <div>
              <label>MCP name<input value={mcpName} onChange={(event) => setMcpName(event.target.value)} /></label>
              <label>MCP command<input value={mcpCommand} onChange={(event) => setMcpCommand(event.target.value)} /></label>
              <label>MCP args<input value={mcpArgs} onChange={(event) => setMcpArgs(event.target.value)} /></label>
              <button onClick={() => void createMcpServer()}>Add MCP server</button>
              <div className="mcp-list">
                {visibleMcpServers.map((server) => (
                  <div key={server.id} className="mcp-row">
                    <strong>{server.name}</strong>
                    <span>{server.status}</span>
                    <button onClick={() => void startMcp(server.id)}>Start</button>
                    <button onClick={() => void stopMcp(server.id)}>Stop</button>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <label>Tool arguments JSON<input value={toolArguments} onChange={(event) => setToolArguments(event.target.value)} /></label>
              <div className="tool-grid">
                {visibleMcpTools.map((tool) => (
                  <div className="tool-card" key={tool.id}>
                    <strong>{tool.name}</strong>
                    <p>{tool.description}</p>
                    <button onClick={() => void callMcpTool(tool)}>Call</button>
                    <button onClick={() => addToolToRun(tool)}>Use in Run</button>
                  </div>
                ))}
              </div>
              <h3>Recent tool calls</h3>
              {visibleToolCalls.map((call) => (
                <pre key={call.id}>{JSON.stringify(call.result ?? call.error ?? call.arguments, null, 2)}</pre>
              ))}
            </div>
          </div>
        ) : null}

        {activeWindow === "tasks" ? (
          <div className="window-content split-content">
            <div className="memory-editor">
              <div className="goal-planner">
                <span className="section-kicker">Goal to tasks</span>
                <label>
                  Goal
                  <textarea
                    value={goalText}
                    onChange={(event) => setGoalText(event.target.value)}
                    placeholder="Describe the outcome. WinAgent will break it into reviewable tasks."
                  />
                </label>
                <div className="file-actions">
                  <button
                    disabled={!goalText.trim()}
                    onClick={() => setPlannedTasks(buildGoalPlan())}
                  >
                    Break down
                  </button>
                  <button disabled={plannedTasks.length === 0 && !goalText.trim()} onClick={() => void createPlannedTasks()}>
                    Create tasks
                  </button>
                </div>
                {plannedTasks.length > 0 ? (
                  <div className="planned-task-list">
                    {plannedTasks.map((item, index) => (
                      <div className="planned-task" key={`${item.title}-${index}`}>
                        <strong>{index + 1}. {item.title}</strong>
                        <small>{item.description}</small>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
              <label>
                Task title
                <input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} />
              </label>
              <label>
                Task description
                <textarea value={taskDescription} onChange={(event) => setTaskDescription(event.target.value)} />
              </label>
              <div className="file-actions">
                <button disabled={!selectedWorkspaceId || !taskTitle.trim()} onClick={() => void createTask()}>
                  Create task
                </button>
                <button onClick={() => void loadWorkbench()}>Reload</button>
              </div>
              <p className="empty-state">
                Tasks are durable workspace objects. Assign one to the active Agent by creating a run from its prompt.
              </p>
            </div>
            <div className="run-list">
              {tasks.length === 0 ? <p className="empty-state">No tasks yet.</p> : null}
              {tasks.map((task) => (
                <div className="run-row" key={task.id}>
                  <div>
                    <strong>{task.title}</strong>
                    <span>{task.status}</span>
                  </div>
                  <small>{task.description || "No description."}</small>
                  <div className="message-actions">
                    <button onClick={() => void updateTaskStatus(task.id, "in_progress")}>Start</button>
                    <button onClick={() => void updateTaskStatus(task.id, "review")}>Review</button>
                    <button onClick={() => void updateTaskStatus(task.id, "completed")}>Done</button>
                    {readyAgentTargets.slice(0, 3).map((target) => (
                      <button key={target.app.id} onClick={() => void sendTaskToAgent(task, target)}>
                        Send to {target.app.label}
                      </button>
                    ))}
                    <button
                      onClick={() => {
                        setPrompt(task.description || task.title);
                        setTitle(task.title);
                        setActiveWindow(null);
                      }}
                    >
                      Use as prompt
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {activeWindow === "artifacts" ? (
          <div className="window-content split-content">
            <div className="run-list">
              {artifacts.length === 0 ? <p className="empty-state">No artifacts yet. Completed runs will create outputs here.</p> : null}
              {artifacts.map((artifact) => (
                <div className="run-row" key={artifact.id}>
                  <div>
                    <strong>{artifact.name}</strong>
                    <span>{artifact.kind}</span>
                  </div>
                  <small>{artifact.mimeType}</small>
                  <div className="message-actions">
                    <button onClick={() => appendPromptToken(`@artifact:${artifact.name}`)}>Mention</button>
                    <button
                      onClick={() =>
                        void createWorkspaceReference({
                          kind: "artifact",
                          targetId: artifact.id,
                          label: artifact.name,
                          summary: artifact.contentText?.slice(0, 160),
                          metadata: { runId: artifact.runId }
                        })
                      }
                    >
                      Save reference
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="preview-pane">
              <h3>Latest artifact</h3>
              <pre>{artifacts[0]?.contentText ?? "No artifact selected."}</pre>
            </div>
          </div>
        ) : null}

        {activeWindow === "references" ? (
          <div className="window-content split-content">
            <div className="run-list">
              {workspaceReferences.length === 0 ? <p className="empty-state">No reusable references yet.</p> : null}
              {workspaceReferences.map((reference) => (
                <div className="run-row" key={reference.id}>
                  <div>
                    <strong>{reference.label}</strong>
                    <span>{reference.kind}</span>
                  </div>
                  <small>{reference.summary || reference.targetId}</small>
                  <button onClick={() => appendPromptToken(`@${reference.kind}:${reference.label}`)}>Mention</button>
                </div>
              ))}
            </div>
            <div className="preview-pane">
              <h3>Reference model</h3>
              <p>References normalize files, runs, memories, artifacts, tasks, and agents into one reusable context list.</p>
            </div>
          </div>
        ) : null}

        {activeWindow === "approvals" ? (
          <div className="window-content split-content">
            <div className="run-list">
              {approvals.length === 0 ? <p className="empty-state">No approvals yet.</p> : null}
              {approvals.map((approval) => (
                <div className="run-row" key={approval.id}>
                  <div>
                    <strong>{approval.title}</strong>
                    <span>{approval.status}</span>
                  </div>
                  <small>{approval.description || approval.kind}</small>
                  {approval.status === "pending" ? (
                    <div className="message-actions">
                      <button onClick={() => void decideApproval(approval.id, "approved")}>Approve</button>
                      <button onClick={() => void decideApproval(approval.id, "rejected")}>Reject</button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="preview-pane">
              <h3>Approval queue</h3>
              <p>Failed runs and human decisions land here instead of being buried inside logs.</p>
            </div>
          </div>
        ) : null}

        {activeWindow === "runs" ? (
          <div className="window-content split-content">
            <div className="run-list">
              {runs.map((run) => (
                <div className="run-row" key={run.id}>
                  <div>
                    <strong>{run.title}</strong>
                    <span>{run.status}</span>
                  </div>
                  <small>{run.summary || run.prompt}</small>
                  {run.status === "running" || run.status === "queued" ? (
                    <button onClick={() => void cancelRun(run.id)}>Cancel</button>
                  ) : null}
                  <button onClick={() => void exportRun(run)}>Export</button>
                </div>
              ))}
            </div>
            <div className="preview-pane">
              <h3>Selected run answer</h3>
              <pre>{selectedAnswer || output || "No run selected."}</pre>
              <h3>Working memory</h3>
              <pre>{workingMemory?.content ?? "No working memory for the selected run yet."}</pre>
            </div>
          </div>
        ) : null}
      </section>
      ) : null}

      <nav className="workspace-dock" aria-label="Workspace applications">
        <button className="start-button" onClick={() => setActiveWindow("apps")}>⊞</button>
        {agentApps.map((app) => (
          <button
            key={app.id}
            className={agentWindowOpen && activeAgentAppId === app.id ? "active agent-task" : "agent-task"}
            onClick={() => openAgentApp(app.id)}
            title={`Open ${app.label}`}
          >
            <span>{app.icon}</span>
            {app.label}
          </button>
        ))}
        <button className={activeWindow === "apps" ? "active" : ""} onClick={() => setActiveWindow("apps")}>Apps</button>
        <button className={activeWindow === "files" ? "active" : ""} onClick={() => setActiveWindow("files")}>Files</button>
        <button className={activeWindow === "tasks" ? "active" : ""} onClick={() => setActiveWindow("tasks")}>Tasks</button>
        <button className={activeWindow === "memory" ? "active" : ""} onClick={() => setActiveWindow("memory")}>Memory</button>
        <button className={activeWindow === "artifacts" ? "active" : ""} onClick={() => setActiveWindow("artifacts")}>Artifacts</button>
        <button className={activeWindow === "mcp" ? "active" : ""} onClick={() => setActiveWindow("mcp")}>MCP</button>
        <button className={activeWindow === "runs" ? "active" : ""} onClick={() => setActiveWindow("runs")}>Runs</button>
        <button onClick={() => setReferencePickerOpen(true)}>+</button>
      </nav>
    </main>
  );
}

const rootElement = document.getElementById("root")!;
const root =
  ((globalThis as any).__winagentRoot as ReturnType<typeof createRoot> | undefined) ??
  createRoot(rootElement);
(globalThis as any).__winagentRoot = root;
root.render(<App />);
