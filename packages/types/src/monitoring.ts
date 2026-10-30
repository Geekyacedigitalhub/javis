export type FroshMonitorStatus = "active" | "paused";
export type FroshMonitorHealth = "unknown" | "healthy" | "degraded" | "down";
export type FroshMonitorEventType = "healthy" | "degraded" | "down" | "recovered";

/** A user-authorized public HTTPS endpoint FROSH checks on a bounded interval. */
export interface FroshHttpMonitor {
  id: string;
  userId: string;
  name: string;
  url: string;
  intervalMinutes: number;
  status: FroshMonitorStatus;
  health: FroshMonitorHealth;
  nextCheckAt?: string;
  lastCheckedAt?: string;
  lastHealthyAt?: string;
  lastStatusCode?: number;
  lastLatencyMs?: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  /** Internal distributed-runner lease. Never serialize this to clients. */
  leaseOwner?: string;
  leaseUntil?: string;
}

/** An append-only, user-visible explanation of a monitor state transition. */
export interface FroshMonitorEvent {
  id: string;
  monitorId: string;
  userId: string;
  type: FroshMonitorEventType;
  health: FroshMonitorHealth;
  message: string;
  statusCode?: number;
  latencyMs?: number;
  createdAt: string;
}

export type FroshHttpMonitorCreateInput = Pick<FroshHttpMonitor, "userId" | "name" | "url" | "intervalMinutes">;
export type FroshHttpMonitorPatch = Partial<Pick<FroshHttpMonitor, "name" | "intervalMinutes" | "status">>;
export type FroshHttpMonitorCheck = Pick<FroshHttpMonitor, "health" | "lastCheckedAt" | "lastHealthyAt" | "lastStatusCode" | "lastLatencyMs" | "lastError" | "nextCheckAt">;

export interface FroshMonitorStore {
  list(userId: string, limit?: number): Promise<FroshHttpMonitor[]>;
  get(id: string, userId: string): Promise<FroshHttpMonitor | null>;
  create(input: FroshHttpMonitorCreateInput): Promise<FroshHttpMonitor>;
  update(id: string, userId: string, patch: FroshHttpMonitorPatch): Promise<FroshHttpMonitor | null>;
  delete(id: string, userId: string): Promise<boolean>;
  listEvents(monitorId: string, userId: string, limit?: number): Promise<FroshMonitorEvent[]>;
  /** Due across all owners, so the runner can work in a multi-user deployment. */
  listDue(now: Date, limit?: number): Promise<FroshHttpMonitor[]>;
  claimDue(id: string, userId: string, owner: string, leaseMs: number): Promise<FroshHttpMonitor | null>;
  /** Explicit user-requested check; still respects active state and leases. */
  claimNow(id: string, userId: string, owner: string, leaseMs: number): Promise<FroshHttpMonitor | null>;
  recordCheck(id: string, userId: string, owner: string, check: FroshHttpMonitorCheck, event?: Omit<FroshMonitorEvent, "id" | "monitorId" | "userId" | "createdAt">): Promise<FroshHttpMonitor | null>;
  releaseLease(id: string, userId: string, owner: string): Promise<boolean>;
}
