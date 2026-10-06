export type FroshAutomationSchedule =
  | { type: "once"; runAt: string }
  | { type: "daily"; hour: number; minute: number }
  | { type: "weekly"; dayOfWeek: number; hour: number; minute: number }
  | { type: "interval"; minutes: number };

export type FroshAutomationStatus = "active" | "paused" | "completed";

export interface FroshAutomation {
  id: string;
  userId: string;
  name: string;
  prompt: string;
  schedule: FroshAutomationSchedule;
  status: FroshAutomationStatus;
  nextRunAt?: string;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
  leaseOwner?: string;
  leaseUntil?: string;
}

export interface FroshAutomationStore {
  list(userId: string): Promise<FroshAutomation[]>;
  get(id: string, userId: string): Promise<FroshAutomation | null>;
  create(input: Omit<FroshAutomation, "id" | "createdAt" | "updatedAt">): Promise<FroshAutomation | null>;
  update(id: string, userId: string, patch: Partial<Pick<FroshAutomation, "name" | "prompt" | "schedule" | "status" | "nextRunAt" | "lastRunAt">>): Promise<FroshAutomation>;
  updateIfIdle(id: string, userId: string, patch: Partial<Pick<FroshAutomation, "name" | "prompt" | "schedule" | "status" | "nextRunAt" | "lastRunAt">>): Promise<FroshAutomation | null>;
  updateOwned(id: string, userId: string, owner: string, patch: Partial<Pick<FroshAutomation, "name" | "prompt" | "schedule" | "status" | "nextRunAt" | "lastRunAt">>): Promise<FroshAutomation | null>;
  delete(id: string, userId: string): Promise<boolean>;
  deleteIfIdle(id: string, userId: string): Promise<boolean>;
  claimDue(id: string, userId: string, owner: string, leaseMs: number): Promise<FroshAutomation | null>;
  renewLease(id: string, userId: string, owner: string, leaseMs: number): Promise<boolean>;
  releaseLease(id: string, userId: string, owner: string): Promise<boolean>;
}
