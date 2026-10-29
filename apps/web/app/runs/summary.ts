/**
 * The evidence rules, kept apart from the page so they can be tested.
 *
 * These mirror the server: a validation only counts once it has reported a real
 * exit code, and "Verified" means that code was zero. The page must not soften
 * that, or the whole point of the loop is lost in the UI.
 */

export type RunStatus = "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: "planned" | "completed" | "failed";
  result?: unknown;
};

export type RunLike = {
  goal: string;
  status: RunStatus;
  toolCalls: ToolCall[];
  createdAt: string;
  updatedAt: string;
};

const VALIDATION_TOOLS = new Set(["workspace_validate"]);
const EDIT_TOOLS = new Set(["workspace_write"]);

export function exitCodeOf(call: ToolCall): number | null {
  const value = call.result;
  if (typeof value !== "object" || value === null) return null;
  const code = (value as { exitCode?: unknown }).exitCode;
  return typeof code === "number" ? code : null;
}

export interface RunEvidence {
  edits: number;
  validations: number;
  lastCommand: string;
  exitCode: number | null;
}

export function summarise(run: RunLike): RunEvidence {
  const edits = run.toolCalls.filter((call) => EDIT_TOOLS.has(call.name) && call.status === "completed").length;
  const validations = run.toolCalls.filter((call) => VALIDATION_TOOLS.has(call.name) && exitCodeOf(call) !== null);
  const last = validations[validations.length - 1];
  return {
    edits,
    validations: validations.length,
    lastCommand: last ? String(last.arguments.command ?? "") : "",
    exitCode: last ? exitCodeOf(last) : null,
  };
}

/** Only a zero exit count as verification. */
export function isVerified(run: RunLike): boolean {
  return summarise(run).exitCode === 0;
}

export type EvidenceLabel = "verified" | "failed_validation" | "unvalidated" | "none";

export function evidenceLabel(run: RunLike): EvidenceLabel {
  const evidence = summarise(run);
  if (evidence.exitCode === 0) return "verified";
  if (evidence.validations > 0) return "failed_validation";
  if (evidence.edits > 0) return "unvalidated";
  return "none";
}

export function when(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function duration(run: RunLike): string {
  const start = Date.parse(run.createdAt);
  const end = Date.parse(run.updatedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "";
  const seconds = Math.round((end - start) / 1000);
  return seconds < 60 ? seconds + "s" : Math.floor(seconds / 60) + "m " + (seconds % 60) + "s";
}
