import type {
  ApprovalRecord,
  RunArtifactRecord,
  TaskPriority,
  TaskRecord,
  TaskStatus,
  WorkspaceReferenceRecord
} from "../../shared/types";
import {
  ApprovalRepository,
  RunArtifactRepository,
  TaskRepository,
  WorkspaceReferenceRepository
} from "../repositories";

export class WorkbenchService {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly approvals: ApprovalRepository,
    private readonly references: WorkspaceReferenceRepository,
    private readonly artifacts: RunArtifactRepository
  ) {}

  listTasks(workspaceId?: string): TaskRecord[] {
    return this.tasks.list(workspaceId);
  }

  createTask(input: {
    workspaceId: string;
    title: string;
    description?: string;
    priority?: TaskPriority;
    assignedAgentId?: string;
    sourceRunId?: string;
  }): TaskRecord {
    const task = this.tasks.create(input);
    this.references.create({
      workspaceId: task.workspaceId,
      kind: "task",
      targetId: task.id,
      label: task.title,
      summary: task.description,
      metadata: { status: task.status, priority: task.priority, assignedAgentId: task.assignedAgentId }
    });
    return task;
  }

  updateTaskStatus(id: string, status: TaskStatus): TaskRecord {
    return this.tasks.updateStatus(id, status);
  }

  listApprovals(workspaceId?: string): ApprovalRecord[] {
    return this.approvals.list(workspaceId);
  }

  createApproval(input: {
    workspaceId: string;
    runId?: string;
    kind: ApprovalRecord["kind"];
    title: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }): ApprovalRecord {
    return this.approvals.create(input);
  }

  decideApproval(id: string, status: ApprovalRecord["status"]): ApprovalRecord {
    return this.approvals.decide(id, status);
  }

  listReferences(workspaceId?: string): WorkspaceReferenceRecord[] {
    return this.references.list(workspaceId);
  }

  createReference(input: {
    workspaceId: string;
    kind: WorkspaceReferenceRecord["kind"];
    targetId: string;
    label: string;
    summary?: string;
    metadata?: Record<string, unknown>;
  }): WorkspaceReferenceRecord {
    return this.references.create(input);
  }

  listRunArtifacts(runId: string): RunArtifactRecord[] {
    return this.artifacts.list(runId);
  }

  listWorkspaceArtifacts(workspaceId: string): RunArtifactRecord[] {
    return this.artifacts.listByWorkspace(workspaceId);
  }
}
