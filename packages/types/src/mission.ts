export type FroshMissionStatus = "planning" | "running" | "waiting_approval" | "completed" | "failed" | "paused";

export interface FroshMissionStep {
  id: string;
  title: string;
  status: "pending" | "running" | "completed" | "blocked" | "failed";
  runId?: string;
  result?: string;
  context?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FroshMission {
  id: string;
  userId: string;
  goal: string;
  status: FroshMissionStatus;
  progress: number;
  steps: FroshMissionStep[];
  activeRunId?: string;
  pendingApprovalId?: string;
  leaseUntil?: string;
  result?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FroshMissionStore {
  list(userId: string): Promise<FroshMission[]>;
  get(id: string, userId: string): Promise<FroshMission | null>;
  create(input: Omit<FroshMission, "id" | "createdAt" | "updatedAt">): Promise<FroshMission>;
  update(id: string, userId: string, patch: Partial<Omit<FroshMission, "id" | "createdAt" | "updatedAt">>): Promise<FroshMission>;
  delete(id: string, userId: string): Promise<boolean>;
}
