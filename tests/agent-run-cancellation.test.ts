import { describe, expect, test } from "bun:test";
import type { ProviderClient, ProviderResponse } from "../services/ai/src/provider";
import { FroshProviderAbortError } from "../services/ai/src/provider";
import { abortActiveAgentRun } from "../services/ai/src/agent-run-cancellation";
import { AGENT_RUN_TIMEOUT_ERROR } from "../services/ai/src/agent-run-timeout";
import { CodingLoop } from "../services/ai/src/coding-loop";
import { agentRunStore, CodingSessionManager } from "../services/ai/src/coding-session";

class IgnoringAbortProvider implements ProviderClient {
  async generate(): Promise<ProviderResponse> {
    await Bun.sleep(35);
    return { message: "This arrived after the execution budget." };
  }
}

class CountingProvider implements ProviderClient {
  calls = 0;

  async generate(): Promise<ProviderResponse> {
    this.calls += 1;
    return { message: "One durable result." };
  }
}

class BlockingProvider implements ProviderClient {
  signals: AbortSignal[] = [];

  async generate(
    _input: Parameters<ProviderClient["generate"]>[0],
    options?: Parameters<ProviderClient["generate"]>[1],
  ): Promise<ProviderResponse> {
    const signal = options?.signal;
    if (!signal) throw new Error("expected cancellation signal");
    this.signals.push(signal);
    return new Promise<ProviderResponse>((_resolve, reject) => {
      if (signal.aborted) {
        reject(new FroshProviderAbortError());
        return;
      }
      signal.addEventListener("abort", () => reject(new FroshProviderAbortError()), { once: true });
    });
  }
}

async function waitForRun(userId: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const runs = await agentRunStore.list({ userId, status: "running", limit: 1 });
    if (runs[0]) return runs[0];
    await Bun.sleep(5);
  }
  throw new Error("run was not created");
}

describe("agent-run cancellation", () => {
  test("does not start the provider twice when an idempotent run creation is replayed", async () => {
    const provider = new CountingProvider();
    const manager = new CodingSessionManager(provider);
    const userId = `idempotent-${crypto.randomUUID()}`;
    const input = {
      userId,
      goal: "Run this once",
      messages: [{ role: "user" as const, content: "run once" }],
      idempotencyKey: "provider-once-0001",
    };

    const first = await manager.start(input);
    const replay = await manager.start({ ...input, goal: "Ignored retry payload" });

    expect(provider.calls).toBe(1);
    expect(replay.id).toBe(first.id);
    expect(replay.goal).toBe("Run this once");
  });

  test("cancels an in-flight coding session and preserves cancellation over late writes", async () => {
    const provider = new BlockingProvider();
    const manager = new CodingSessionManager(provider);
    const userId = `session-cancel-${crypto.randomUUID()}`;
    let createdId = "";
    let createdResolve: (() => void) | undefined;
    const created = new Promise<void>((resolve) => { createdResolve = resolve; });

    const pending = manager.start({
      userId,
      goal: "Wait for the provider",
      messages: [{ role: "user", content: "wait" }],
      onRunCreated: async (run) => {
        createdId = run.id;
        createdResolve?.();
      },
    });

    await created;
    for (let attempt = 0; provider.signals.length === 0 && attempt < 40; attempt += 1) await Bun.sleep(5);
    const cancelled = await agentRunStore.cancel(createdId, userId);
    expect(cancelled?.status).toBe("cancelled");
    abortActiveAgentRun(createdId);

    const finished = await pending;
    expect(finished.status).toBe("cancelled");
    expect(provider.signals[0]?.aborted).toBe(true);

    const late = await agentRunStore.update(createdId, { status: "completed", result: "provider eventually replied" });
    expect(late.status).toBe("cancelled");
  });


  test("times out an in-flight coding session and records an honest terminal failure", async () => {
    const provider = new BlockingProvider();
    const manager = new CodingSessionManager(provider, { runTimeoutMs: 20 });
    const userId = `session-timeout-${crypto.randomUUID()}`;
    const pending = manager.start({
      userId,
      goal: "Wait until the execution budget expires",
      messages: [{ role: "user", content: "wait" }],
    });
    const run = await waitForRun(userId);

    const finished = await pending;
    expect(finished.id).toBe(run.id);
    expect(finished.status).toBe("failed");
    expect(finished.error).toBe(AGENT_RUN_TIMEOUT_ERROR);
    expect(finished.result).toContain("did not replay");
    expect(provider.signals[0]?.aborted).toBe(true);
  });

  test("does not let a late provider result overwrite a timeout", async () => {
    const manager = new CodingSessionManager(new IgnoringAbortProvider(), { runTimeoutMs: 10 });
    const run = await manager.start({
      userId: `late-timeout-${crypto.randomUUID()}`,
      goal: "Do not accept late work",
      messages: [{ role: "user", content: "wait" }],
    });

    expect(run.status).toBe("failed");
    expect(run.error).toBe(AGENT_RUN_TIMEOUT_ERROR);
    expect(run.result).toContain("did not replay");
  });

  test("times out a loop provider request before it dispatches tools", async () => {
    const provider = new BlockingProvider();
    const loop = new CodingLoop(provider, { runTimeoutMs: 20 });
    const userId = `loop-timeout-${crypto.randomUUID()}`;
    const pending = loop.start({ userId, goal: "Wait without changing anything" });

    const finished = await pending;
    expect(finished.status).toBe("failed");
    expect(finished.error).toBe(AGENT_RUN_TIMEOUT_ERROR);
    expect(finished.toolCalls).toEqual([]);
  });

  test("cancels an in-flight autonomous loop before it can dispatch tools", async () => {
    const provider = new BlockingProvider();
    const loop = new CodingLoop(provider);
    const userId = `loop-cancel-${crypto.randomUUID()}`;
    const pending = loop.start({ userId, goal: "Wait before changing anything" });
    const run = await waitForRun(userId);

    const cancelled = await agentRunStore.cancel(run.id, userId);
    expect(cancelled?.status).toBe("cancelled");
    abortActiveAgentRun(run.id);

    const finished = await pending;
    expect(finished.status).toBe("cancelled");
    expect(finished.toolCalls).toEqual([]);
  });
});
