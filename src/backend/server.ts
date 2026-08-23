import http from "node:http";
import {
  AgentAdapterRepository,
  AgentRepository,
  ApprovalRepository,
  MemoryRepository,
  McpServerRepository,
  RunArtifactRepository,
  RunRepository,
  SettingRepository,
  TaskRepository,
  WorkspaceIndexRepository,
  WorkspaceReferenceRepository,
  WorkspaceRepository
} from "./repositories";
import { EventBus } from "./eventBus";
import { handleApi } from "./http";
import { AgentConfigService } from "./services/agentConfigService";
import { AgentProcessManager } from "./services/agentProcessManager";
import { ContextProvider } from "./services/contextProvider";
import { McpServerService } from "./services/mcpServerService";
import { RunQueue } from "./services/runQueue";
import { RunService } from "./services/runService";
import { SkillRegistry } from "./services/skillRegistry";
import { WorkspaceService } from "./services/workspaceService";
import { WorkspaceIndexService } from "./services/workspaceIndexService";
import { MemoryService } from "./services/memoryService";
import { SystemService } from "./services/systemService";
import { WorkbenchService } from "./services/workbenchService";
import { WebSocketGateway } from "./websocketGateway";

const workspaceRepo = new WorkspaceRepository();
const agentAdapterRepo = new AgentAdapterRepository();
const agentRepo = new AgentRepository();
const runRepo = new RunRepository();
const mcpRepo = new McpServerRepository();
const workspaceIndexRepo = new WorkspaceIndexRepository();
const memoryRepo = new MemoryRepository();
const settingRepo = new SettingRepository();
const taskRepo = new TaskRepository();
const approvalRepo = new ApprovalRepository();
const referenceRepo = new WorkspaceReferenceRepository();
const artifactRepo = new RunArtifactRepository();

const events = new EventBus(runRepo);
const skills = new SkillRegistry();
const workspaceIndex = new WorkspaceIndexService(workspaceRepo, workspaceIndexRepo);
const mcpServers = new McpServerService(mcpRepo);
const memory = new MemoryService(memoryRepo, runRepo);
const workbench = new WorkbenchService(taskRepo, approvalRepo, referenceRepo, artifactRepo);
const services = {
  workspaces: new WorkspaceService(workspaceRepo),
  agents: new AgentConfigService(agentRepo, agentAdapterRepo),
  system: new SystemService(agentAdapterRepo, settingRepo),
  skills,
  mcpServers,
  workspaceIndex,
  memory,
  workbench,
  runs: new RunService(
    runRepo,
    workspaceRepo,
    agentRepo,
    mcpRepo,
    skills,
    mcpServers,
    memory,
    artifactRepo,
    approvalRepo,
    referenceRepo,
    new ContextProvider(),
    workspaceIndex,
    new AgentProcessManager(),
    new RunQueue(),
    events
  )
};

const server = http.createServer((req, res) => {
  void handleApi(req, res, services);
});

new WebSocketGateway(server, events, runRepo);

const port = Number(process.env.WINAGENT_PORT ?? 8787);
server.listen(port, "127.0.0.1", () => {
  console.log(`[winagent] backend ready at http://127.0.0.1:${port}`);
});
