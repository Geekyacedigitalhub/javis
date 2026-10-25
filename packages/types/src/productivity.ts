export type FroshTaskStatus = "open" | "in_progress" | "completed" | "cancelled";
export type FroshTaskPriority = "low" | "normal" | "high";

export interface FroshTask {
  id: string;
  userId: string;
  title: string;
  notes?: string;
  dueAt?: string;
  status: FroshTaskStatus;
  priority: FroshTaskPriority;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface FroshTaskStore {
  list(userId: string, options?: { status?: FroshTaskStatus; limit?: number }): Promise<FroshTask[]>;
  get(id: string, userId: string): Promise<FroshTask | null>;
  create(input: Omit<FroshTask, "id" | "createdAt" | "updatedAt" | "completedAt">): Promise<FroshTask>;
  update(id: string, userId: string, patch: Partial<Pick<FroshTask, "title" | "notes" | "dueAt" | "status" | "priority">>): Promise<FroshTask | null>;
  delete(id: string, userId: string): Promise<boolean>;
}
