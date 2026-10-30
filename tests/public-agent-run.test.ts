import { describe, expect, test } from "bun:test";
import type { FroshAgentRun } from "../packages/types/src/agent-run";
import { publicAgentRun } from "../services/api/src/public-agent-run";

const privateRun: FroshAgentRun = {
  id: "run-private-state",
  userId: "owner",
  goal: "Send the approved report",
  message: "Send the approved report",
  mode: "session",
  status: "waiting_approval",
  toolCalls: [],
  pendingApprovalId: "approval-1",
  // This deliberately distinctive persisted state models the provider replay
  // payload that is needed by the server but must not reach an HTTP/SSE client.
  providerContinuation: {
    provider: "gemini",
    contents: [{ role: "model", parts: [{ functionCall: { name: "send_email", args: { body: "private replay state" } } }] }],
    pendingCallId: "provider-call-private",
    pendingToolName: "send_email",
  },
  createdAt: "2026-10-29T00:00:00.000Z",
  updatedAt: "2026-10-29T00:00:01.000Z",
};

describe("public agent-run serialization", () => {
  test("removes server-only provider continuation state without altering the durable run", () => {
    const publicRun = publicAgentRun(privateRun);

    expect(publicRun).not.toHaveProperty("providerContinuation");
    expect(JSON.stringify(publicRun)).not.toContain("private replay state");
    expect(JSON.stringify(publicRun)).not.toContain("provider-call-private");
    // The store's object remains safe to resume; serialization is a projection,
    // not a destructive mutation of execution state.
    expect(privateRun.providerContinuation).toEqual(expect.objectContaining({ pendingCallId: "provider-call-private" }));
  });
});
