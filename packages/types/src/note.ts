export interface FroshNote {
  id: string;
  userId: string;
  title: string;
  content: string;
  /** User-supplied organizational labels; normalized and deduplicated. */
  tags: string[];
  pinned: boolean;
  /** Optional owner-scoped task this note gives context to. */
  taskId?: string;
  createdAt: string;
  updatedAt: string;
}

export type FroshNoteCreateInput = Omit<FroshNote, "id" | "createdAt" | "updatedAt">;
export type FroshNotePatch = Partial<Pick<FroshNote, "title" | "content" | "tags" | "pinned" | "taskId">>;

export interface FroshNoteStore {
  list(userId: string, options?: { query?: string; tag?: string; pinned?: boolean; limit?: number }): Promise<FroshNote[]>;
  get(id: string, userId: string): Promise<FroshNote | null>;
  create(input: FroshNoteCreateInput): Promise<FroshNote>;
  update(id: string, userId: string, patch: FroshNotePatch): Promise<FroshNote | null>;
  delete(id: string, userId: string): Promise<boolean>;
}
