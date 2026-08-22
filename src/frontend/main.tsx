import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AgentRecord,
  FileEntry,
  McpServerRecord,
  RunEventRecord,
  RunRecord,
  SkillRecord,
  WorkspaceRecord
} from "../shared/types";
import type { WebSocketEnvelope } from "../shared/events";
import "./styles.css";

const apiBase = "http://127.0.0.1:8787";

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

function App() {
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerRecord[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [events, setEvents] = useState<Record<string, RunEventRecord[]>>({});
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [selectedSkillId, setSelectedSkillId] = useState("");
  const [workspacePath, setWorkspacePath] = useState("E:\\WinAgent-Workbench");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [filePath, setFilePath] = useState("");
  const [fileRefs, setFileRefs] = useState<string[]>([]);
  const [title, setTitle] = useState("Smoke run");
  const [prompt, setPrompt] = useState("Summarize this workspace and print WINAGENT_DONE.");
  const [error, setError] = useState("");

  const selectedRun = runs[0];
  const selectedEvents = selectedRun ? events[selectedRun.id] ?? [] : [];

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    const ws = new WebSocket("ws://127.0.0.1:8787/ws");
    ws.onmessage = (message) => {
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
    return () => ws.close();
  }, []);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setFiles([]);
      return;
    }
    void loadFiles();
  }, [selectedWorkspaceId, filePath]);

  async function refreshAll() {
    try {
      const [nextWorkspaces, nextAgents, nextSkills, nextMcp, nextRuns] = await Promise.all([
        api<WorkspaceRecord[]>("/api/workspaces"),
        api<AgentRecord[]>("/api/agents"),
        api<SkillRecord[]>("/api/skills"),
        api<McpServerRecord[]>("/api/mcp-servers"),
        api<RunRecord[]>("/api/runs")
      ]);
      setWorkspaces(nextWorkspaces);
      setAgents(nextAgents);
      setSkills(nextSkills);
      setMcpServers(nextMcp);
      setRuns(nextRuns);
      setSelectedWorkspaceId((current) => current || nextWorkspaces[0]?.id || "");
      setSelectedAgentId((current) => current || nextAgents[0]?.id || "");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function refreshRuns() {
    setRuns(await api<RunRecord[]>("/api/runs"));
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
    try {
      await api<RunRecord>("/api/runs", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: selectedWorkspaceId,
          agentId: selectedAgentId,
          skillId: selectedSkillId || undefined,
          title,
          prompt,
          fileRefs
        })
      });
      await refreshRuns();
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function cancelRun(runId: string) {
    await api(`/api/runs/${runId}/cancel`, { method: "POST" });
    await refreshRuns();
  }

  const output = useMemo(
    () =>
      selectedEvents
        .filter((event) => event.type === "run.output.delta" || event.type === "run.error.delta")
        .map((event) => String((event.payload as any).text ?? ""))
        .join(""),
    [selectedEvents]
  );

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <h1>WinAgent Workbench</h1>
          <p>Windows-first Agent runtime host with WebSocket streaming.</p>
        </div>
        <button onClick={() => void refreshAll()}>Refresh</button>
      </section>

      {error ? <div className="error">{error}</div> : null}

      <section className="grid">
        <div className="panel">
          <h2>Workspace</h2>
          <label>
            Windows path
            <input value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} />
          </label>
          <button onClick={() => void openWorkspace()}>Open workspace</button>
          <select value={selectedWorkspaceId} onChange={(event) => setSelectedWorkspaceId(event.target.value)}>
            <option value="">No workspace</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
          <div className="muted">{workspaces.find((item) => item.id === selectedWorkspaceId)?.rootPath}</div>
        </div>

        <div className="panel">
          <h2>Agent</h2>
          <select value={selectedAgentId} onChange={(event) => setSelectedAgentId(event.target.value)}>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
          <pre>{JSON.stringify(agents.find((agent) => agent.id === selectedAgentId), null, 2)}</pre>
        </div>

        <div className="panel">
          <h2>Skill & MCP</h2>
          <select value={selectedSkillId} onChange={(event) => setSelectedSkillId(event.target.value)}>
            <option value="">No skill</option>
            {skills.map((skill) => (
              <option key={skill.id} value={skill.id}>
                {skill.name}
              </option>
            ))}
          </select>
          <div className="chips">
            {mcpServers.length === 0 ? <span className="chip">No MCP server configured</span> : null}
            {mcpServers.map((server) => (
              <span className="chip" key={server.id}>
                {server.name}: {server.status}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className="grid two">
        <div className="panel">
          <h2>Files</h2>
          <div className="file-actions">
            <button onClick={() => setFilePath(workspaces.find((item) => item.id === selectedWorkspaceId)?.rootPath ?? "")}>
              Root
            </button>
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
                <span>{file.kind === "directory" ? "[dir]" : "[file]"}</span>
                <span>{file.name}</span>
              </button>
            ))}
          </div>
          <h3>Referenced files</h3>
          <ul>
            {fileRefs.map((ref) => (
              <li key={ref}>{ref}</li>
            ))}
          </ul>
        </div>

        <div className="panel">
          <h2>Create Run</h2>
          <label>
            Title
            <input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            Prompt
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </label>
          <button disabled={!selectedWorkspaceId || !selectedAgentId} onClick={() => void createRun()}>
            Start run
          </button>
        </div>
      </section>

      <section className="grid two">
        <div className="panel">
          <h2>Runs</h2>
          <div className="run-list">
            {runs.map((run) => (
              <div className="run-row" key={run.id}>
                <div>
                  <strong>{run.title}</strong>
                  <span>{run.status}</span>
                </div>
                <small>{run.summary}</small>
                {run.status === "running" || run.status === "queued" ? (
                  <button onClick={() => void cancelRun(run.id)}>Cancel</button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
        <div className="panel terminal">
          <h2>Live Output</h2>
          <pre>{output || "No run output yet."}</pre>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
