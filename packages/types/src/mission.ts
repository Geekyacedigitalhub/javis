export type FroshMissionStatus = "planning" | "running" | "waiting_approval" | "completed" | "failed" | "paused" | "cancelled";
export type FroshMissionPriority = "low" | "normal" | "high";
export type FroshMissionBudgetProfile = "standard" | "extended" | "intensive";

export interface FroshMissionStep {
  id: string;
  title: string;
  status: "pending" | "running" | "completed" | "blocked" | "failed";
  runId?: string;
  result?: string;
  context?: string;
  retryCount?: number;
  nextRetryAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FroshMission {
  id: string;
  userId: string;
  goal: string;
  status: FroshMissionStatus;
  priority: FroshMissionPriority;
  budgetProfile: FroshMissionBudgetProfile;
  progress: number;
  steps: FroshMissionStep[];
  activeRunId?: string;
  pendingApprovalId?: string;
  leaseUntil?: string;
  leaseOwner?: string;
  result?: string;
  toolCallsUsed?: number;
  executionDurationMs?: number;
  createdAt: string;
  updatedAt: string;
}


export type FroshMissionEventType =
  | "mission.created"
  | "mission.claimed"
  | "mission.step.started"
  | "mission.step.completed"
  | "mission.step.failed"
  | "mission.step.retry"
  | "mission.approval.required"
  | "mission.paused"
  | "mission.cancelled"
  | "mission.recovered"
  | "mission.completed"
  | "mission.failed"
  | "mission.tool.completed"
  | "mission.tool.failed"
  | "mission.budget.exceeded";

export interface FroshMissionEvent {
  id: string;
  missionId: string;
  userId: string;
  type: FroshMissionEventType;
  message: string;
  stepId?: string;
  runId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface FroshMissionStore {
  list(userId: string): Promise<FroshMission[]>;
  get(id: string, userId: string): Promise<FroshMission | null>;
  create(input: Omit<FroshMission, "id" | "createdAt" | "updatedAt">): Promise<FroshMission>;
  update(id: string, userId: string, patch: Partial<Omit<FroshMission, "id" | "createdAt" | "updatedAt">>): Promise<FroshMission>;
  updateOwned(id: string, userId: string, leaseOwner: string, patch: Partial<Omit<FroshMission, "id" | "createdAt" | "updatedAt">>): Promise<FroshMission | null>;
  delete(id: string, userId: string): Promise<boolean>;
  deleteIfIdle(id: string, userId: string): Promise<boolean>;
  claim(id: string, userId: string, leaseOwner: string): Promise<FroshMission | null>;
  claimApprovalContinuation(id: string, userId: string, leaseOwner: string): Promise<FroshMission | null>;
  claimStepRetry(id: string, userId: string, leaseOwner: string): Promise<FroshMission | null>;
  recoverFailedIfIdle(id: string, userId: string, leaseOwner: string, steps: FroshMission["steps"]): Promise<FroshMission | null>;
  updatePriorityIfIdle(id: string, userId: string, priority: FroshMissionPriority): Promise<FroshMission | null>;
  updateBudgetProfileIfIdle(id: string, userId: string, budgetProfile: FroshMissionBudgetProfile): Promise<FroshMission | null>;
  renewLease(id: string, userId: string, leaseOwner: string): Promise<FroshMission | null>;
  addEvent(input: Omit<FroshMissionEvent, "id" | "createdAt">): Promise<FroshMissionEvent>;
  listEvents(missionId: string, userId: string, limit?: number): Promise<FroshMissionEvent[]>;
}
