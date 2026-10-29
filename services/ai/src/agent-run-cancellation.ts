/*
 * Process-local handles for work which is currently awaiting a model response.
 * The durable source of truth is the agent-run store; these handles simply let
 * a successful durable cancellation interrupt an in-flight provider request
 * immediately rather than waiting for its network timeout.
 */
const activeControllers = new Map<string, Set<AbortController>>();

export function registerAgentRunAbortController(runId: string, controller: AbortController): () => void {
  const controllers = activeControllers.get(runId) ?? new Set<AbortController>();
  controllers.add(controller);
  activeControllers.set(runId, controllers);

  return () => {
    controllers.delete(controller);
    if (controllers.size === 0) activeControllers.delete(runId);
  };
}

export function abortActiveAgentRun(runId: string): void {
  const controllers = activeControllers.get(runId);
  if (!controllers) return;
  for (const controller of controllers) controller.abort();
}
