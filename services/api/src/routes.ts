import { handleFroshRequest } from "./server";

export async function postChat(body: unknown) {
  if (!body || typeof body !== "object") throw new Error("invalid request body");

  const value = body as Record<string, unknown>;

  return handleFroshRequest({
    message: typeof value.message === "string" ? value.message : "",
    conversationId:
      typeof value.conversationId === "string" ? value.conversationId : undefined,
    userId: typeof value.userId === "string" ? value.userId : undefined,
  });
}
