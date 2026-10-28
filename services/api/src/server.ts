import { FroshOrchestrator } from "../../ai/src";
import { ConfiguredModelAdapter, buildModelInput, isStreamingProvider, type FroshStreamEvent } from "../../ai/src/provider";
import { createProvider } from "../../ai/src/provider-factory";
import {
  buildConversationContext,
  createMemoryStore,
  getConversationMemoryStore,
  getUserMemoryStore,
  extractConversationMemories,
  createMemoryCandidate,
} from "../../memory/src";
import type { FroshMessage, FroshResponse } from "../../../packages/types/src/javis";
import type { ConversationRecord, MemoryStore } from "../../memory/src";
import { getUserPreferenceStore } from "../../preferences/src";

const provider = createProvider();
const orchestrator = new FroshOrchestrator(new ConfiguredModelAdapter(provider));
// This process owns the in-memory fallback. Creating a store for every request
// makes local chat look stateless, so keep one store for the lifetime of the
// API just as the Postgres implementation is naturally persistent.
const memory = createMemoryStore();

export interface FroshHttpRequest {
  message: string;
  conversationId?: string;
  userId?: string;
}

type PreparedConversation = {
  message: string;
  userId?: string;
  conversation: ConversationRecord;
  context: FroshMessage[];
};

function validatedMessage(input: FroshHttpRequest): string {
  const message = input.message?.trim();
  if (!message) throw new Error("message is required");
  return message;
}

async function prepareConversation(
  input: FroshHttpRequest,
  store: MemoryStore = memory,
): Promise<PreparedConversation> {
  const message = validatedMessage(input);
  const conversation = input.conversationId
    ? await store.getConversation(input.conversationId)
    : null;

  if (conversation?.userId && input.userId && conversation.userId !== input.userId) {
    throw new Error("Conversation belongs to another user");
  }

  if (conversation?.userId && !input.userId) {
    throw new Error("Conversation owner is required");
  }

  const currentConversation =
    conversation ??
    (await store.createConversation({
      id: input.conversationId,
      userId: input.userId,
    }));

  await store.appendMessage({
    conversationId: currentConversation.id,
    role: "user",
    content: message,
  });

  const context = await buildConversationContext(store, currentConversation.id, input.userId);

  if (input.userId) {
    const userMemories = await getUserMemoryStore().list(input.userId, 30);
    if (userMemories.length) {
      context.unshift({
        role: "system",
        content: [
          "Approved long-term user memory:",
          ...userMemories.map((item) => "- [" + item.kind + "] " + item.statement),
          "Use these memories only when relevant to the current request.",
        ].join("\n"),
      });
    }
  }

  const conversationMemory = await getConversationMemoryStore().get(currentConversation.id);
  if (conversationMemory && (conversationMemory.summary || conversationMemory.keyFacts.length)) {
    context.unshift({
      role: "system",
      content: [
        "Approved long-term context for this conversation:",
        ...conversationMemory.keyFacts.map((fact) => "- " + fact),
      ].join("\n"),
    });
  }

  if (input.userId) {
    const preferences = await getUserPreferenceStore().get(input.userId);
    context.unshift({
      role: "system",
      content: [
        "User-selected FROSH operating preferences:",
        `- Mode: ${preferences.mode}`,
        `- Personality: ${preferences.personality}`,
        `- Response length: ${preferences.responseLength}`,
        `- Technical depth: ${preferences.technicalDepth}`,
        `- Autonomy: ${preferences.autonomyLevel}`,
        `- Notification style: ${preferences.notificationStyle}`,
        "Apply these preferences when they are relevant, but never weaken tool permissions, approvals, or safety rules.",
      ].join("\n"),
    });
  }

  return { message, userId: input.userId, conversation: currentConversation, context };
}

async function finishConversation(
  prepared: PreparedConversation,
  response: Pick<FroshResponse, "message" | "toolCalls">,
  store: MemoryStore = memory,
): Promise<void> {
  await store.appendMessage({
    conversationId: prepared.conversation.id,
    role: "assistant",
    content: response.message,
  });

  if (!prepared.userId) return;

  const extraction = extractConversationMemories([
    {
      id: crypto.randomUUID(),
      text: prepared.message,
      conversationId: prepared.conversation.id,
    },
  ]);

  for (const candidate of extraction.candidates) {
    await createMemoryCandidate({ ...candidate, userId: prepared.userId });
  }
}

export async function handleFroshRequest(input: FroshHttpRequest): Promise<FroshResponse> {
  const prepared = await prepareConversation(input);
  const response = await orchestrator.respond(prepared.context);
  const complete = {
    conversationId: prepared.conversation.id,
    message: response.message,
    toolCalls: response.toolCalls ?? [],
  };

  await finishConversation(prepared, complete);
  return complete;
}

/**
 * Stream the same conversation pipeline used by the JSON chat route. A live
 * provider may emit events directly; the explicit development fallback emits a
 * truthful single response instead of impersonating an AI model.
 */
export async function* streamFroshRequest(
  input: FroshHttpRequest,
): AsyncGenerator<FroshStreamEvent> {
  const prepared = await prepareConversation(input);
  let complete: Pick<FroshResponse, "message" | "toolCalls"> | undefined;

  if (isStreamingProvider(provider)) {
    for await (const event of provider.stream(buildModelInput(prepared.context))) {
      if (event.type === "done") {
        complete = { message: event.message, toolCalls: event.toolCalls };
        yield { ...event, conversationId: prepared.conversation.id };
      } else {
        yield event;
      }
    }
  } else {
    const response = await orchestrator.respond(prepared.context);
    complete = { message: response.message, toolCalls: response.toolCalls ?? [] };
    if (complete.message) yield { type: "delta", text: complete.message };
    yield {
      type: "done",
      conversationId: prepared.conversation.id,
      message: complete.message,
      toolCalls: complete.toolCalls,
    };
  }

  // A provider that stops without a final event has not produced a valid chat
  // response. Do not persist an empty assistant turn or report success.
  if (!complete) throw new Error("Model stream ended without a completed response");
  await finishConversation(prepared, complete);
}

export async function listFroshConversations(userId: string, limit = 50) {
  return memory.listConversations(userId, limit);
}

export async function getFroshConversation(userId: string, conversationId: string, limit = 100) {
  const conversation = await memory.getConversation(conversationId);
  if (!conversation || conversation.userId !== userId) return null;
  return {
    conversation,
    messages: await memory.listMessages(conversationId, Math.max(1, Math.min(limit, 200))),
  };
}

export const handleJavisRequest = handleFroshRequest;
