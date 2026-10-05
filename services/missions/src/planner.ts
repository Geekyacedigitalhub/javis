import type { FroshMissionStep } from "../../../packages/types/src/mission";

export function planMission(goal: string): FroshMissionStep[] {
  const now = new Date().toISOString();
  const lower = goal.toLowerCase();
  const titles = [
    "Understand the objective and inspect the relevant context",
    lower.includes("website") || lower.includes("code") ? "Inspect the relevant project and current state" : "Gather the information needed for the objective",
    lower.includes("research") ? "Analyze the findings against the objective" : "Carry out the required work",
    "Verify the result and identify any remaining work"
  ];
  return titles.map((title) => ({
    id: crypto.randomUUID(),
    title,
    status: "pending",
    createdAt: now,
    updatedAt: now
  }));
}
