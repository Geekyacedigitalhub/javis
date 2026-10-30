import { handleFroshRequest } from "./server";

export async function postChat(body: unknown, authenticatedUserId: string) {
  if (!body || typeof body !== "object") throw new Error("invalid request body");

  const value = body as Record<string, unknown>;

  return handleFroshRequest({
    message: typeof value.message === "string" ? value.message : "",
    conversationId:
      typeof value.conversationId === "string" ? value.conversationId : undefined,
    // The request body can never choose a data owner. HTTP authentication
    // supplies this identity, and the model sees it only as server context.
    userId: authenticatedUserId,
  });
}
