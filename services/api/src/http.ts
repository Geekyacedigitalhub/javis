import { postChat } from "./routes";
import { approvalStore } from "../../tools/src";
import { CodingSessionManager, agentRunStore } from "../../ai/src";
import { OpenAIProvider } from "../../ai/src/openai-provider";
import { authenticateDevice, issueDeviceCredential, listDevices, registerDevice, getDevice, revokeDeviceCredential, initializeDeviceStore, purgeExpiredDeviceCredentials, purgeExpiredDeviceCommandLedger, markAllDevicesOffline, closeDeviceStore } from "./devices";
import { addRealtimeClient, disconnectDeviceClients, handleDeviceCommandResult, realtimeClientCount, shutdownRealtime } from "./realtime";
import { getUserMemoryStore } from "../../memory/src/user-memory-factory";
import { listUserMemoryCandidates, resolveUserMemoryCandidate } from "../../memory/src/memory-candidates";

const codingSessions = new CodingSessionManager(new OpenAIProvider());
const port = Number(process.env.PORT ?? 3001);
await initializeDeviceStore();
await markAllDevicesOffline();
void purgeExpiredDeviceCredentials().catch((error) => logOperationalError("Initial device credential cleanup failed", error));
void purgeExpiredDeviceCommandLedger().catch((error) => logOperationalError("Initial device command ledger cleanup failed", error));
const credentialCleanupTimer = setInterval(() => {
  void purgeExpiredDeviceCredentials().catch((error) => logOperationalError("Scheduled device credential cleanup failed", error));
  void purgeExpiredDeviceCommandLedger().catch((error) => logOperationalError("Scheduled device command ledger cleanup failed", error));
}, 60 * 60 * 1000);
import { startAutomationRunner } from "../../automation/src";
import { startMissionRunner } from "../../missions/src";
startAutomationRunner();
startMissionRunner();

async function recoverMissionsOnStartup(){
  const userId=process.env.FROSH_AUTOMATION_USER_ID?.trim();
  if(!userId) return;
  try{
    const {getMissionStore}=await import("../../missions/src");
    const store=getMissionStore();
    const missions=await store.list(userId);
    for(const mission of missions){
      if(mission.status==="waiting_approval"||mission.status==="completed"||mission.status==="paused") continue;
      try{
        const url="http://localhost:"+String(port)+"/v1/missions/users/"+encodeURIComponent(userId)+"/"+encodeURIComponent(mission.id)+"/recover";
        const configuredTimeout=Number(process.env.FROSH_STARTUP_RECOVERY_TIMEOUT_MS??60_000);
        const timeoutMs=Number.isFinite(configuredTimeout)
          ? Math.min(120_000,Math.max(5_000,Math.floor(configuredTimeout)))
          : 60_000;
        const controller=new AbortController();
        const timeout=setTimeout(()=>controller.abort(),timeoutMs);
        try{
          const response=await fetch(url,{
            method:"POST",
            headers:{"x-frosh-web-token":process.env.FROSH_WEB_TOKEN??""},
            signal:controller.signal
          });
          if(!response.ok)console.error("FROSH startup mission recovery failed",mission.id,response.status);
        }catch(error){
          if(controller.signal.aborted){
            console.error("FROSH startup mission recovery timed out",mission.id,timeoutMs);
          }else{
            logOperationalError("FROSH startup mission recovery request failed", error);
          }
        }finally{
          clearTimeout(timeout);
        }
      }catch{}
    }
  }catch(error){
    logOperationalError("FROSH mission startup recovery failed", error);
  }
}
setTimeout(()=>void recoverMissionsOnStartup(),2000);

let shuttingDown = false;
async function shutdownApi() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(credentialCleanupTimer);
  try {
    shutdownRealtime();
    await server.stop(true);
  } catch (error) {
    logOperationalError("FROSH realtime/API server shutdown failed", error);
  } finally {
    try {
      await closeDeviceStore();
    } catch (error) {
      logOperationalError("FROSH device store shutdown failed", error);
    }
    process.exit(0);
  }
}
process.once("SIGTERM", () => { void shutdownApi(); });
process.once("SIGINT", () => { void shutdownApi(); });


async function addMissionEventWithRetry(store:FroshMissionStore,input:Omit<FroshMissionEvent,"id"|"createdAt">){
  let lastError:unknown;
  for(let attempt=1;attempt<=3;attempt++){
    try{
      return await store.addEvent(input);
    }catch(error){
      lastError=error;
      if(attempt<3) await new Promise((resolve)=>setTimeout(resolve,100*attempt));
    }
  }
  throw lastError instanceof Error?lastError:new Error("Mission audit event could not be persisted");
}

function isSafetyPausedMission(mission:FroshMission){
  return mission.status==="paused" && (mission.result??"").startsWith("Mission paused after restart because an approval outcome or approved action was not durably reconciled.");
}

const MAX_DEVICE_COMMAND_HTTP_BODY_BYTES = 64 * 1024;

function safeErrorMessage(fallback: string): string {
  return fallback;
}

function logOperationalError(context: string, error: unknown): void {
  const name = error instanceof Error && error.name ? error.name : "UnknownError";
  console.error(context, name);
}

const MAX_USER_ID_LENGTH = 200;

function decodeBoundedUserId(value: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (
    !decoded ||
    decoded.length > MAX_USER_ID_LENGTH ||
    new TextEncoder().encode(decoded).byteLength > 512 ||
    /[\u0000-\u001f\u007f]/.test(decoded)
  ) {
    return null;
  }
  return decoded;
}

function publicMissionResponse(mission: FroshMission | null | undefined): FroshMission | null {
  if (!mission) return null;
  const { leaseOwner: _, leaseUntil: __, ...publicMission } = mission;
  return publicMission;
}

function decodeBoundedResourceId(value: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { return null; }
  if (!decoded || decoded.length > 200 || new TextEncoder().encode(decoded).byteLength > 512 || /[\u0000-\u001f\u007f]/.test(decoded)) return null;
  return decoded;
}

async function parseBoundedJson(request: Request, maxBytes = MAX_DEVICE_COMMAND_HTTP_BODY_BYTES): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > maxBytes) {
      throw new Error("request_body_too_large");
    }
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw new Error("request_body_too_large");
  }
  return JSON.parse(raw);
}

const server = Bun.serve({
  port,
  websocket: {
    open(ws) {
      // Authentication is completed by the first realtime auth message.
      const authTimeout = setTimeout(() => {
        if (!ws.data?.authenticated && !ws.data?.closed) {
          ws.data = { ...ws.data, closed: true, authenticating: false };
          try { ws.send(JSON.stringify({ type: "error", message: "Realtime authentication timed out" })); } catch { /* socket may already be closing */ }
          try { ws.close(); } catch { /* already closed */ }
        }
      }, 10000);
      ws.data = { authenticated: false, authenticating: false, closed: false, malformedMessages: 0, deviceId: undefined as string | undefined, realtimeClientId: undefined as string | undefined, authTimeout };
      ws.send(JSON.stringify({ type: "connected", timestamp: new Date().toISOString() }));
    },
    close(ws) {
      clearTimeout(ws.data?.authTimeout);
      ws.data = { ...ws.data, closed: true, authenticating: false };
    },
    async message(ws, message) {
      try {
        const rawMessage = String(message);
        const MAX_REALTIME_FRAME_BYTES = 128 * 1024;
        if (new TextEncoder().encode(rawMessage).byteLength > MAX_REALTIME_FRAME_BYTES) {
          ws.data = { ...ws.data, closed: true, authenticating: false };
          try { ws.send(JSON.stringify({ type: "error", message: "Realtime message is too large" })); } catch { /* socket may already be closing */ }
          try { ws.close(); } catch { /* already closed */ }
          return;
        }
        const parsed = JSON.parse(rawMessage);
        if (parsed?.type === "auth") {
          if (ws.data?.authenticated || ws.data?.authenticating) {
            ws.send(JSON.stringify({ type: "error", message: ws.data?.authenticated ? "Realtime socket is already authenticated" : "Realtime authentication is already in progress" }));
            return;
          }
          if (ws.data?.closed) return;
          ws.data = { ...ws.data, authenticating: true };
          if (typeof parsed.deviceId !== "string" || typeof parsed.token !== "string" || !(await authenticateDevice(parsed.deviceId, parsed.token))) {
            if (!ws.data?.closed) {
              ws.data = { ...ws.data, authenticating: false, closed: true };
              try { ws.send(JSON.stringify({ type: "error", message: "Realtime authentication failed" })); } catch { /* socket may already be closing */ }
              try { ws.close(); } catch { /* already closed */ }
            }
            return;
          }
          if (ws.data?.closed) return;
          clearTimeout(ws.data?.authTimeout);
          const realtimeClientId = addRealtimeClient(ws, parsed.deviceId, parsed.token);
          ws.data = { authenticated: true, authenticating: false, closed: false, malformedMessages: 0, deviceId: parsed.deviceId, realtimeClientId, authTimeout: undefined };
          ws.send(JSON.stringify({ type: "connected", authenticated: true, timestamp: new Date().toISOString() }));
          return;
        }
        if (parsed?.type === "device.command.result") {
          if (!ws.data?.authenticated || ws.data.deviceId !== parsed.deviceId) return;
          handleDeviceCommandResult(ws.data.realtimeClientId, parsed);
          return;
        }
        if (parsed?.type === "ping") {
          if (!ws.data?.authenticated) return;
          ws.send(JSON.stringify({ type: "connected", timestamp: new Date().toISOString() }));
        }
      } catch {
        const malformedMessages = (ws.data?.malformedMessages ?? 0) + 1;
        ws.data = { ...ws.data, malformedMessages };
        try { ws.send(JSON.stringify({ type: "error", message: "Invalid realtime message" })); } catch { /* socket may already be closing */ }
        if (malformedMessages >= 3 && !ws.data?.closed) {
          ws.data = { ...ws.data, closed: true, authenticating: false };
          try { ws.close(); } catch { /* already closed */ }
        }
      }
    },
  },
  async fetch(request) {
    const url = new URL(request.url);

    const deviceId = request.headers.get("x-frosh-device-id");
    const deviceToken = request.headers.get("x-frosh-device-token");
    const webToken = process.env.FROSH_WEB_TOKEN?.trim();
    const suppliedWebToken = request.headers.get("x-frosh-web-token");
    const enrollmentToken = process.env.FROSH_DEVICE_ENROLLMENT_TOKEN?.trim();
    const suppliedEnrollmentToken = request.headers.get("x-frosh-device-enrollment-token");
    const validEnrollmentToken = Boolean(
      enrollmentToken &&
      enrollmentToken.length <= 512 &&
      !/[\u0000-\u001f\u007f]/.test(enrollmentToken) &&
      suppliedEnrollmentToken &&
      suppliedEnrollmentToken.length <= 512 &&
      !/[\u0000-\u001f\u007f]/.test(suppliedEnrollmentToken) &&
      suppliedEnrollmentToken === enrollmentToken
    );
    const webAuthenticated = Boolean(webToken && suppliedWebToken && suppliedWebToken === webToken);
    const deviceEnrollmentAuthorized = validEnrollmentToken;
    const enrollmentRequest =
      request.method === "POST" &&
      url.pathname === "/v1/devices" &&
      deviceEnrollmentAuthorized;
    const publicPath =
      url.pathname === "/health" ||
      url.pathname === "/v1/realtime";
    if (!publicPath && !enrollmentRequest && !webAuthenticated && (!deviceId || !deviceToken || !(await authenticateDevice(deviceId, deviceToken)))) {
      return Response.json({ error: "FROSH authentication required" }, { status: 401 });
    }

    const configuredUserId = process.env.FROSH_USER_ID?.trim() || "default-user";
    const userScopedPath = url.pathname.match(/\/users\/([^/]+)/);
    if (!webAuthenticated && deviceId && userScopedPath && decodeBoundedUserId(userScopedPath[1]) !== configuredUserId) {
      return Response.json({ error: "Device credential cannot access another configured user." }, { status: 403 });
    }

    if (request.method === "GET" && url.pathname === "/v1/missions/budgets") {
      const maxSteps = Math.max(1, Number(process.env.FROSH_MISSION_MAX_STEPS ?? 12) || 12);
      const maxToolCalls = Math.max(1, Number(process.env.FROSH_MISSION_MAX_TOOL_CALLS ?? 40) || 40);
      const maxDurationMs = Math.max(60000, Number(process.env.FROSH_MISSION_MAX_DURATION_MS ?? 1800000) || 1800000);
      const multipliers = { standard: 1, extended: 1.5, intensive: 2 };
      const profiles = Object.fromEntries(Object.entries(multipliers).map(([name, multiplier]) => [
        name,
        {
          maxSteps: Math.min(24, Math.ceil(maxSteps * multiplier)),
          maxToolCalls: Math.min(80, Math.ceil(maxToolCalls * multiplier)),
          maxDurationMs: Math.min(3600000, Math.ceil(maxDurationMs * multiplier))
        }
      ]));
      return Response.json({ maxSteps, maxToolCalls, maxDurationMs, profiles });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "frosh-api", realtimeClients: realtimeClientCount() });
    }

    if (request.method === "GET" && url.pathname === "/v1/realtime") {
      if (server.upgrade(request, { data: {} })) return undefined;
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    if (request.method === "POST" && url.pathname === "/v1/chat/stream") {
      try {
        const body = await parseBoundedJson(request);
        const message = typeof body?.message === "string" ? body.message.trim() : "";
        if (!message) return Response.json({ error: "message is required" }, { status: 400 });

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            const send = (event: unknown) => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\\n\\n`));
            };

            try {
              const { buildConversationContext, getUserMemoryStore, getConversationMemoryStore, createMemoryStore, extractConversationMemories, createMemoryCandidate } = await import("../../memory/src");
              const { buildModelInput } = await import("../../ai/src/provider");
              const { OpenAIProvider } = await import("../../ai/src/openai-provider");

              const requestedUserId = typeof body?.userId === "string" ? body.userId : undefined;
              const userId = webAuthenticated ? requestedUserId : configuredUserId;
              if (!webAuthenticated && requestedUserId && requestedUserId !== configuredUserId) {
                send({ type: "error", message: "Device credential cannot access another configured user." });
                controller.close();
                return;
              }
              const conversationId = typeof body?.conversationId === "string" ? body.conversationId : undefined;
              const memory = createMemoryStore();
              const conversation = conversationId ? await memory.getConversation(conversationId) : null;
              if (conversation?.userId && userId && conversation.userId !== userId) {
                send({ type: "error", message: "Conversation belongs to another user." });
                controller.close();
                return;
              }
              if (conversation?.userId && !userId) {
                send({ type: "error", message: "Conversation owner is required." });
                controller.close();
                return;
              }
              const currentConversation = conversation ?? await memory.createConversation({ id: conversationId, userId });
              await memory.appendMessage({ conversationId: currentConversation.id, role: "user", content: message });

              const context = await buildConversationContext(memory, currentConversation.id, userId);
              if (userId) {
                const memories = await getUserMemoryStore().list(userId, 30);
                if (memories.length) {
                  context.unshift({
                    role: "system",
                    content: ["Approved long-term user memory:", ...memories.map((item) => "- [" + item.kind + "] " + item.statement)].join("\\n")
                  });
                }
              }

              const conversationMemory = await getConversationMemoryStore().get(currentConversation.id);
              if (conversationMemory && (conversationMemory.summary || conversationMemory.keyFacts.length)) {
                context.unshift({
                  role: "system",
                  content: ["Approved long-term context for this conversation:", ...conversationMemory.keyFacts.map((fact) => "- " + fact)].join("\\n")
                });
              }

              const provider = new OpenAIProvider();
              let finalMessage = "";
              let finalTools: any[] = [];

              for await (const event of provider.stream(
                buildModelInput(context),
                {}
              )) {
                if (event.type === "delta") {
                  finalMessage += event.text;
                  send(event);
                } else {
                  if (event.type === "tool") send(event);
                  if (event.type === "approval") send(event);
                  if (event.type === "done") {
                    finalMessage = event.message;
                    finalTools = event.toolCalls;
                    send({ type: "done", conversationId: currentConversation.id, message: event.message, toolCalls: event.toolCalls });
                  }
                }
              }

              await memory.appendMessage({ conversationId: currentConversation.id, role: "assistant", content: finalMessage });

              if (userId) {
                const extraction = extractConversationMemories([{ id: crypto.randomUUID(), text: message, conversationId: currentConversation.id }]);
                for (const candidate of extraction.candidates) {
                  await createMemoryCandidate({ ...candidate, userId });
                }
              }
            } catch (error) {
              send({ type: "error", message: "Streaming request failed" });
            } finally {
              controller.close();
            }
          }
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            "connection": "keep-alive",
          }
        });
      } catch (error) {
        return Response.json({ error: "Streaming request failed" }, { status: 500 });
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/chat") {
      try {
        const body = await parseBoundedJson(request);
        const chatBody =
          body && typeof body === "object" && !Array.isArray(body)
            ? { ...(body as Record<string, unknown>) }
            : body;
        if (!webAuthenticated && deviceId && chatBody && typeof chatBody === "object") {
          const requestedUserId = typeof (chatBody as Record<string, unknown>).userId === "string"
            ? (chatBody as Record<string, unknown>).userId
            : undefined;
          if (requestedUserId && requestedUserId !== configuredUserId) {
            return Response.json({ error: "Device credential cannot access another configured user." }, { status: 403 });
          }
          (chatBody as Record<string, unknown>).userId = configuredUserId;
        }
        return Response.json(await postChat(chatBody));
      } catch (error) {
        const message = "Request failed";
        return Response.json(
          { error: message },
          { status: message === "message is required" ? 400 : 500 },
        );
      }
    }


    const memoryUserMatch = url.pathname.match(/^\/v1\/memory\/users\/([^/]+)$/);
    if (memoryUserMatch && request.method === "GET") {
      const userId = decodeBoundedUserId(memoryUserMatch[1]);
      if (!userId) return Response.json({ error: "Invalid user ID" }, { status: 400 });
      return Response.json({ memories: await getUserMemoryStore().list(userId, 100) });
    }

    const memoryCandidatesMatch = url.pathname.match(/^\/v1\/memory\/users\/([^/]+)\/candidates$/);
    if (memoryCandidatesMatch && request.method === "GET") {
      const userId = decodeBoundedUserId(memoryCandidatesMatch[1]);
      if (!userId) return Response.json({ error: "Invalid user ID" }, { status: 400 });
      return Response.json({ candidates: await listUserMemoryCandidates(userId) });
    }

    if (memoryCandidatesMatch && request.method === "POST") {
      if (!webAuthenticated) {
        return Response.json({ error: "Trusted web authentication required for memory candidate decisions." }, { status: 403 });
      }
      try {
        const userId = decodeBoundedUserId(memoryCandidatesMatch[1]);
      if (!userId) return Response.json({ error: "Invalid user ID" }, { status: 400 });
        const body = await parseBoundedJson(request);
        const candidateId = typeof body?.candidateId === "string" ? body.candidateId.trim() : "";
        const status = body?.status === "approved" || body?.status === "rejected" ? body.status : "";
        if (!candidateId || !status) {
          return Response.json({ error: "candidateId and status are required" }, { status: 400 });
        }
        const candidate = await resolveUserMemoryCandidate(userId, candidateId, status);
        return Response.json(candidate);
      } catch (error) {
        return Response.json({ error: "Memory candidate update failed" }, { status: 400 });
      }
    }

    const memoryDeleteMatch = url.pathname.match(/^\/v1\/memory\/users\/([^/]+)\/([^/]+)$/);
    if (memoryDeleteMatch && request.method === "DELETE") {
      if (!webAuthenticated) {
        return Response.json({ error: "Trusted web authentication required to delete memory." }, { status: 403 });
      }
      const userId = decodeBoundedUserId(memoryDeleteMatch[1]);
      if (!userId) return Response.json({ error: "Invalid user ID" }, { status: 400 });
      const memoryId = decodeURIComponent(memoryDeleteMatch[2]);
      const deleted = await getUserMemoryStore().delete(memoryId, userId);
      return deleted
        ? Response.json({ deleted: true })
        : Response.json({ error: "Memory not found for this user" }, { status: 404 });
    }

    const messagesMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/messages$/);
    if (messagesMatch && request.method === "GET") {
      try {
        if (!webAuthenticated && deviceId !== messagesMatch[1]) {
          return Response.json({ error: "Device credential cannot access another device." }, { status: 403 });
        }
        const { requestMessageInbox } = await import("./realtime");
        return Response.json(await requestMessageInbox(messagesMatch[1]));
      } catch (error) {
        return Response.json({ accepted: false, message: "Message inbox failed" }, { status: 400 });
      }
    }

    const replySuggestionsMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/messages\/suggest-replies$/);
    if (replySuggestionsMatch && request.method === "POST") {
      try {
        if (!webAuthenticated && deviceId !== replySuggestionsMatch[1]) {
          return Response.json({ error: "Device credential cannot access another device." }, { status: 403 });
        }
        const body = await parseBoundedJson(request);
        const message = typeof body?.message === "string" ? body.message.trim() : "";
        const provider = typeof body?.provider === "string" ? body.provider : "other";
        const sender = typeof body?.sender === "string" ? body.sender : undefined;
        if (!message) return Response.json({ error: "message is required" }, { status: 400 });
        const { suggestMessageReplies } = await import("../../ai/src/message-replies");
        return Response.json({ suggestions: await suggestMessageReplies({ provider, sender, message }) });
      } catch (error) {
        return Response.json({ error: "Reply suggestion failed" }, { status: 400 });
      }
    }

    const messageIntelligenceMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/messages\/intelligence$/);
    if (messageIntelligenceMatch && request.method === "GET") {
      try {
        if (!webAuthenticated && deviceId !== messageIntelligenceMatch[1]) {
          return Response.json({ error: "Device credential cannot access another device." }, { status: 403 });
        }
        const { requestMessageInbox } = await import("./realtime");
        const inbox = await requestMessageInbox(messageIntelligenceMatch[1]);
        if (!inbox.accepted) return Response.json(inbox);
        const data = inbox.data as { messages?: Array<{ id: string; provider: string; sender?: string; text?: string; receivedAt: string; canReply: boolean }> } | undefined;
        const messages = data?.messages ?? [];
        const rank = { urgent: 4, high: 3, normal: 2, low: 1 } as const;
        const insights = messages.map((item) => {
          const text = (item.text ?? "").trim();
          const lower = text.toLowerCase();
          const urgent = /urgent|asap|emergency|immediately|911|help/.test(lower);
          const question = /\?|\\bcan you\\b|\\bcould you\\b|\\bplease\\b|\\blet me know\\b|\\bwhen\\b|\\bwhere\\b/.test(lower);
          const priority = urgent ? "urgent" : question ? "high" : item.canReply ? "normal" : "low";
          return {
            ...item,
            priority,
            likelyNeedsReply: Boolean(item.canReply && (question || text.length > 0)),
            reason: urgent ? "Urgency signal detected." : question ? "Looks like a question or request." : undefined
          };
        }).sort((a,b) => rank[b.priority as keyof typeof rank] - rank[a.priority as keyof typeof rank]);
        return Response.json({
          total: insights.length,
          needsReply: insights.filter((item) => item.likelyNeedsReply).length,
          urgent: insights.filter((item) => item.priority === "urgent").length,
          highlights: insights.slice(0, 30)
        });
      } catch (error) {
        return Response.json({ accepted: false, message: "Message intelligence failed" }, { status: 400 });
      }
    }

    const messageReplyMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/messages\/([^/]+)\/reply$/);
    if (messageReplyMatch && request.method === "POST") {
      try {
        if (!webAuthenticated && deviceId !== messageReplyMatch[1]) {
          return Response.json({ error: "Device credential cannot access another device." }, { status: 403 });
        }
        const body = await parseBoundedJson(request);
        const message = typeof body?.message === "string" ? body.message.trim() : "";
        if (!message) return Response.json({ error: "message is required" }, { status: 400 });
        const idempotencyKey =
          (typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim() : "") ||
          request.headers.get("Idempotency-Key")?.trim() ||
          undefined;
        const { replyToMessageCommand } = await import("./realtime");
        return Response.json(await replyToMessageCommand(messagesMatch?.[1] ?? messageReplyMatch[1], decodeURIComponent(messageReplyMatch[2]), message, idempotencyKey));
      } catch (error) {
        return Response.json({ accepted: false, message: "Message reply failed" }, { status: 400 });
      }
    }

    const commandMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/command$/);
    if (commandMatch && request.method === "POST") {
      try {
        if (!webAuthenticated && deviceId !== commandMatch[1]) {
          return Response.json({ error: "Device credential cannot command another device." }, { status: 403 });
        }
        const body = await parseBoundedJson(request);
        const command = typeof body?.command === "string" ? body.command : "";
        const allowed = ["open_dialer", "media_control", "media_state", "open_app", "contacts_search", "message_inbox"];
        if (!allowed.includes(command)) {
          return Response.json({ error: "Command is not available from the web console." }, { status: 403 });
        }
        const { sendDeviceCommand } = await import("./realtime");
        const value =
          command === "media_control" ? (typeof body?.action === "string" ? body.action : "") :
          command === "open_app" ? (typeof body?.appName === "string" ? body.appName : "") :
          command === "contacts_search" ? (typeof body?.query === "string" ? body.query : "") :
          undefined;
        if (command === "media_control" && !["play","pause","toggle","next","previous","stop","volume_up","volume_down"].includes(value ?? "")) {
          return Response.json({ error: "Invalid media action." }, { status: 400 });
        }
        if (command === "open_app" && !value?.trim()) {
          return Response.json({ error: "appName is required." }, { status: 400 });
        }
        if (command === "contacts_search" && !value?.trim()) {
          return Response.json({ error: "query is required." }, { status: 400 });
        }
        const idempotencyKey =
          (typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim() : "") ||
          request.headers.get("Idempotency-Key")?.trim() ||
          undefined;
        const result = await sendDeviceCommand(
          commandMatch[1],
          command as "open_dialer" | "media_control" | "media_state" | "open_app" | "contacts_search" | "message_inbox",
          value,
          idempotencyKey,
        );
        return Response.json(result);
      } catch (error) {
        return Response.json({ error: "Device command failed" }, { status: 400 });
      }
    }

    if (request.method === "GET" && url.pathname === "/v1/devices") {
      if (webAuthenticated) return Response.json({ devices: await listDevices() });
      const device = deviceId ? await getDevice(deviceId) : null;
      return Response.json({ devices: device ? [device] : [] });
    }

    if (request.method === "POST" && url.pathname === "/v1/devices") {
      if (!webAuthenticated && !deviceEnrollmentAuthorized) {
        return Response.json(
          { error: "Device enrollment authorization required." },
          { status: 401 }
        );
      }
      try {
        const body = await parseBoundedJson(request);
        if (
          typeof body?.name !== "string" ||
          (body?.platform !== "android" &&
            body?.platform !== "windows" &&
            body?.platform !== "web") ||
          !Array.isArray(body?.capabilities)
        ) {
          return Response.json(
            { error: "name, platform, and capabilities are required" },
            { status: 400 },
          );
        }

        const name = body.name.trim();
        const platform = body.platform;
        const capabilities = body.capabilities.filter(
          (capability: unknown): capability is string => typeof capability === "string",
        );
        if (!name || name.length > 120 || new TextEncoder().encode(name).byteLength > 512) {
          return Response.json({ error: "Device name is invalid or too large." }, { status: 400 });
        }
        if (capabilities.length > 100 || capabilities.some((item) => item.length > 100 || new TextEncoder().encode(item).byteLength > 256)) {
          return Response.json({ error: "Device capabilities are invalid or too large." }, { status: 400 });
        }
        const existingDevice = (await listDevices()).find(
          (item) => item.name === name && item.platform === platform,
        );
        if (existingDevice && !webAuthenticated) {
          return Response.json(
            { error: "A device with this name and platform is already registered. Use the trusted web console to re-enroll it." },
            { status: 409 },
          );
        }
        const device = await registerDevice({
          name,
          platform,
          allowExisting: webAuthenticated,
          capabilities,
        });
        const credential = await issueDeviceCredential(device.id);
        return Response.json({ device, credential }, { status: 201 });
      } catch (error) {
        const message = "Device registration failed";
        const code = typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
        if (code === "23505") {
          return Response.json(
            { error: "A device with this name and platform is already registered. Use the trusted web console to re-enroll it." },
            { status: 409 },
          );
        }
        return Response.json({ error: message }, { status: 400 });
      }
    }

    const capabilityMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/capabilities$/);
    if (capabilityMatch && request.method === "POST") {
      try {
        // Capabilities are trust policy, not device-reported authority. Only the
        // trusted web console may grant/revoke them; a device credential must
        // never be able to self-escalate into a privileged capability.
        if (!webAuthenticated) {
          return Response.json({ error: "Only trusted web authentication may change device capabilities." }, { status: 403 });
        }
        const body = await parseBoundedJson(request);
        if (!Array.isArray(body?.capabilities) || body.capabilities.length > 100) {
          return Response.json({ error: "capabilities must be an array of at most 100 items" }, { status: 400 });
        }
        const capabilities = body.capabilities.filter((item: unknown): item is { capability: string; availability: "available" | "permission_required" | "unsupported"; detail?: string } =>
          typeof item === "object" && item !== null &&
          typeof (item as { capability?: unknown }).capability === "string" &&
          (item as { capability: string }).capability.length <= 100 &&
          ["available", "permission_required", "unsupported"].includes(String((item as { availability?: unknown }).availability)),
        );
        const device = await updateDeviceCapabilities(capabilityMatch[1], capabilities);
        return device
          ? Response.json(device)
          : Response.json({ error: "Device not found" }, { status: 404 });
      } catch (error) {
        return Response.json({ error: "Capability update failed" }, { status: 400 });
      }
    }

    const credentialRevokeMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/credential$/);
    if (credentialRevokeMatch && request.method === "DELETE") {
      if (!webAuthenticated) {
        return Response.json({ error: "Trusted web authentication required." }, { status: 401 });
      }
      const revoked = await revokeDeviceCredential(credentialRevokeMatch[1]);
      if (!revoked) {
        return Response.json({ error: "Device not found" }, { status: 404 });
      }
      const disconnectedClients = disconnectDeviceClients(credentialRevokeMatch[1]);
      return Response.json({ revoked: true, disconnectedClients });
    }

    const deviceMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)$/);
    if (deviceMatch && request.method === "GET") {
      if (!webAuthenticated && deviceId !== deviceMatch[1]) {
        return Response.json({ error: "Device credential cannot access another device." }, { status: 403 });
      }
      const device = await getDevice(deviceMatch[1]);
      return device
        ? Response.json(device)
        : Response.json({ error: "Device not found" }, { status: 404 });
    }

    const automationUsers = url.pathname.match(/^\/v1\/automations\/users\/([^/]+)$/);
    if (automationUsers && request.method === "GET") {
      const { getAutomationStore } = await import("../../automation/src");
      const userId = decodeBoundedUserId(automationUsers[1]);
      if (!userId) return Response.json({ error: "Invalid user ID" }, { status: 400 });
      return Response.json({ automations: await getAutomationStore().list(userId) });
    }

    if (automationUsers && request.method === "POST") {
      try {
        const userId = decodeBoundedUserId(automationUsers[1]);
        if (!userId) return Response.json({ error: "Invalid user ID" }, { status: 400 });
        const body = await parseBoundedJson(request);
        const name = typeof body?.name === "string" ? body.name.trim() : "";
        const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
        const schedule = body?.schedule;
        if (!name || !prompt || !schedule?.type) return Response.json({ error: "name, prompt and schedule are required" }, { status: 400 });
        if (name.length > 120 || new TextEncoder().encode(name).byteLength > 512) return Response.json({ error: "Automation name is too large." }, { status: 400 });
        if (prompt.length > 8000 || new TextEncoder().encode(prompt).byteLength > 32 * 1024) return Response.json({ error: "Automation prompt is too large." }, { status: 400 });
        if (new TextEncoder().encode(JSON.stringify(schedule)).byteLength > 8 * 1024) return Response.json({ error: "Automation schedule is too large." }, { status: 400 });

        const { calculateNextRun, getAutomationStore, validateAutomationSchedule } = await import("../../automation/src");
        const valid =
          schedule.type === "once" && typeof schedule.runAt === "string" ||
          schedule.type === "daily" && Number.isInteger(schedule.hour) && Number.isInteger(schedule.minute) ||
          schedule.type === "weekly" && Number.isInteger(schedule.dayOfWeek) && Number.isInteger(schedule.hour) && Number.isInteger(schedule.minute) ||
          schedule.type === "interval" && Number.isInteger(schedule.minutes) && schedule.minutes >= 60;
        if (!valid) return Response.json({ error: "Invalid schedule. Interval must be at least 60 minutes." }, { status: 400 });

        const nextRunAt = calculateNextRun(schedule);
        const automation = await getAutomationStore().create({ userId, name, prompt, schedule, status: "active", nextRunAt });
        return Response.json({ automation }, { status: 201 });
      } catch (error) {
        return Response.json({ error: "Automation creation failed" }, { status: 400 });
      }
    }

    const automationMatch = url.pathname.match(/^\/v1\/automations\/users\/([^/]+)\/([^/]+)$/);
    if (automationMatch && request.method === "PATCH") {
      try {
        const userId = decodeBoundedUserId(automationMatch[1]);
        if (!userId) return Response.json({ error: "Invalid user ID" }, { status: 400 });
        let id: string;
        try {
          id = decodeURIComponent(automationMatch[2]);
        } catch {
          return Response.json({ error: "Invalid automation ID" }, { status: 400 });
        }
        if (!id || id.length > 200 || new TextEncoder().encode(id).byteLength > 512 || /[\u0000-\u001f\u007f]/.test(id)) {
          return Response.json({ error: "Invalid automation ID" }, { status: 400 });
        }
        const body = await parseBoundedJson(request);
        const patch: Record<string, unknown> = {};
        if (body && typeof body === "object" && !Array.isArray(body) && Object.keys(body as Record<string, unknown>).length > 10) return Response.json({ error: "Automation update contains too many fields." }, { status: 400 });
        if (typeof body?.name === "string") patch.name = body.name.trim();
        if (typeof body?.prompt === "string") patch.prompt = body.prompt.trim();
        if (typeof patch.name === "string" && (patch.name.length > 120 || new TextEncoder().encode(patch.name).byteLength > 512)) return Response.json({ error: "Automation name is too large." }, { status: 400 });
        if (typeof patch.prompt === "string" && (patch.prompt.length > 8000 || new TextEncoder().encode(patch.prompt).byteLength > 32 * 1024)) return Response.json({ error: "Automation prompt is too large." }, { status: 400 });
        if (body?.status === "active" || body?.status === "paused" || body?.status === "completed") patch.status = body.status;
        if (body?.schedule?.type) patch.schedule = body.schedule;
        const { calculateNextRun, getAutomationStore, validateAutomationSchedule } = await import("../../automation/src");
        if (patch.schedule) {
          if (new TextEncoder().encode(JSON.stringify(patch.schedule)).byteLength > 8 * 1024) return Response.json({ error: "Automation schedule is too large." }, { status: 400 });
          if (!validateAutomationSchedule(patch.schedule)) return Response.json({ error: "Invalid automation schedule." }, { status: 400 });
          patch.nextRunAt = calculateNextRun(patch.schedule as any);
        }
        const automation = await getAutomationStore().update(id, userId, patch as any);
        return Response.json({ automation });
      } catch (error) {
        return Response.json({ error: "Automation update failed" }, { status: 400 });
      }
    }

    if (automationMatch && request.method === "DELETE") {
      try {
        const userId = decodeBoundedUserId(automationMatch[1]);
        if (!userId) return Response.json({ error: "Invalid user ID" }, { status: 400 });
        const id = decodeURIComponent(automationMatch[2]);
        if (!id || id.length > 200 || new TextEncoder().encode(id).byteLength > 512 || /[\u0000-\u001f\u007f]/.test(id)) {
          return Response.json({ error: "Invalid automation ID" }, { status: 400 });
        }
        const deleted = await (await import("../../automation/src")).getAutomationStore().delete(id, userId);
        return deleted ? Response.json({ deleted: true }) : Response.json({ error: "Automation not found" }, { status: 404 });
      } catch {
        return Response.json({ error: "Automation deletion failed" }, { status: 400 });
      }
    }

    const missionUsers = url.pathname.match(/^\/v1\/missions\/users\/([^/]+)$/);
    if (missionUsers && request.method === "GET") {
      const userId=decodeBoundedUserId(missionUsers[1]);
      if(!userId)return Response.json({error:"Invalid user ID"},{status:400});
      const { getMissionStore } = await import("../../missions/src");
      return Response.json({ missions: (await getMissionStore().list(userId)).map(publicMissionResponse) });
    }

    if (missionUsers && request.method === "POST") {
      try {
        const userId=decodeBoundedUserId(missionUsers[1]);
        if (!userId) return Response.json({error:"Invalid user ID"},{status:400});
        const body=await parseBoundedJson(request);
        if(!body||typeof body!=="object"||Array.isArray(body))return Response.json({error:"Mission request body must be an object"},{status:400});
        if(Object.keys(body as Record<string,unknown>).length>3)return Response.json({error:"Mission creation contains too many fields"},{status:400});
        const goal=typeof body?.goal==="string"?body.goal.trim():"";
        if(!goal)return Response.json({error:"goal is required"},{status:400});        const { getMissionStore }=await import("../../missions/src");
        const priority=body?.priority==="high"||body?.priority==="low"?""+body.priority:"normal";
      const budgetProfile=body?.budgetProfile==="extended"||body?.budgetProfile==="intensive"?body.budgetProfile:"standard";
        const mission=await getMissionStore().create({userId,goal,status:"planning",priority,budgetProfile,progress:0,steps:[]});
        if(!mission)return Response.json({error:"Mission limit reached for this user; pause, complete, or delete an existing mission before creating another."},{status:429});
      await getMissionStore().addEvent({missionId:mission.id,userId,type:"mission.created",message:"Mission created: "+goal});
        return Response.json({mission:publicMissionResponse(mission)},{status:201});
      } catch(error){return Response.json({error:"Mission creation failed"},{status:400});}
    }

    const missionControlMatch=url.pathname.match(/^\/v1\/missions\/users\/([^/]+)\/([^/]+)\/(pause|resume|cancel)$/);
    if(missionControlMatch && request.method==="POST"){
      const {getMissionStore}=await import("../../missions/src");
      const userId=decodeBoundedUserId(missionControlMatch[1]);
      if (!userId) return Response.json({error:"Invalid user ID"},{status:400});
      const id=decodeBoundedResourceId(missionControlMatch[2]);
      const action=missionControlMatch[3];
      const store=getMissionStore();
      const mission=await store.get(id,userId);
      if(!mission)return Response.json({error:"Mission not found"},{status:404});
      if(action==="pause"){
        if(["completed","failed","cancelled"].includes(mission.status))return Response.json({error:"Mission cannot be paused in its current state"},{status:409});
        const updated=await store.pauseIfIdle(id,userId);
        if(!updated)return Response.json({error:"Mission is currently being executed; wait for the active worker to finish"},{status:409});
        await addMissionEventWithRetry(store, {missionId:id,userId,type:"mission.paused",message:"Mission paused by user."});
        return Response.json({mission:publicMissionResponse(updated)});
      }
      if(action==="resume"){
        if(mission.status!=="paused")return Response.json({error:"Only paused missions can be resumed"},{status:409});
        if(isSafetyPausedMission(mission))return Response.json({error:"Mission is paused for safety review after an unreconciled approval/action outcome; review the mission before resuming it."},{status:409});
        const updated=await store.resumeIfPaused(id,userId);
        if(!updated)return Response.json({error:"Mission is no longer paused; refresh and try again"},{status:409});
        await addMissionEventWithRetry(store, {missionId:id,userId,type:"mission.recovered",message:updated.status==="waiting_approval"?"Mission resumed into its pending approval state.":"Mission resumed by user.",metadata:{resumedStatus:updated.status}});
        return Response.json({mission:publicMissionResponse(updated)});
      }
      if(["completed","cancelled"].includes(mission.status))return Response.json({mission:publicMissionResponse(mission)});
      let cancelledApprovalId:string|undefined;
      let cancelledApprovalRunId:string|undefined;
      if(mission.pendingApprovalId){
        const approval=await approvalStore.get(mission.pendingApprovalId);
        if(approval){
          cancelledApprovalId=approval.id;
          cancelledApprovalRunId=approval.runId;
        }
      }
      const updated=await store.cancelIfIdle(id,userId);
      if(!updated)return Response.json({error:"Mission is currently being executed; wait for the active worker to finish"},{status:409});
      let approvalRunStopped=false;
      if(cancelledApprovalId && cancelledApprovalRunId){
        const approval=await approvalStore.get(cancelledApprovalId);
        if(approval?.status==="pending"){
          try{
            await approvalStore.resolve(cancelledApprovalId,"rejected");
          }catch(error){
            logOperationalError("FROSH cancelled mission approval rejection raced after mission cancellation", error);
          }
        }
        try{
          const stopped=await agentRunStore.stopWaitingApproval(
            cancelledApprovalRunId,
            cancelledApprovalId,
            "The mission was cancelled before the approval action could continue.",
            "Mission cancelled by user",
          );
          approvalRunStopped=Boolean(stopped);
          if(!stopped)console.warn("FROSH cancelled mission approval run was not waiting anymore",id,cancelledApprovalRunId);
        }catch(error){
          logOperationalError("FROSH cancelled mission approval run cleanup failed", error);
        }
      }
      await addMissionEventWithRetry(store, {
        missionId:id,
        userId,
        type:"mission.cancelled",
        message:"Mission cancelled by user.",
        metadata:{approvalCancelled:Boolean(cancelledApprovalId),approvalRunStopped}
      });
      return Response.json({mission:publicMissionResponse(updated)});
    }

    const missionRerunStepMatch=url.pathname.match(/^\/v1\/missions\/users\/([^/]+)\/([^/]+)\/rerun-from-step\/([^/]+)$/);
    if(missionRerunStepMatch && request.method==="POST"){
      const userId=decodeBoundedUserId(missionRerunStepMatch[1]);
      if (!userId) return Response.json({error:"Invalid user ID"},{status:400});
      const id=decodeBoundedResourceId(missionRerunStepMatch[2]);
      const stepId=decodeBoundedResourceId(missionRerunStepMatch[3]);
      const store=(await import("../../missions/src")).getMissionStore();
      const source=await store.get(id,userId);
      if(!source)return Response.json({error:"Mission not found"},{status:404});
      if(!["completed","failed","cancelled"].includes(source.status))return Response.json({error:"Only completed, failed, or cancelled missions can be partially rerun"},{status:409});
      const stepIndex=source.steps.findIndex((step)=>step.id===stepId);
      if(stepIndex<0)return Response.json({error:"Mission step not found"},{status:404});
      const now=new Date().toISOString();
      const steps=source.steps.map((step,index)=>({
        ...step,
        status:index<stepIndex?"completed":"pending",
        runId:undefined,
        result:index<stepIndex?step.result:undefined,
        retryCount:0,
        nextRetryAt:undefined,
        createdAt:now,
        updatedAt:now
      }));
      const completedBefore=steps.filter((step)=>step.status==="completed").length;
      const rerunMission=await store.create({
        userId,
        goal:source.goal,
        status:"planning",
        priority:source.priority,
        budgetProfile:source.budgetProfile,
        progress:steps.length?completedBefore/steps.length:0,
        steps
      });
      if(!rerunMission)return Response.json({error:"Mission limit reached for this user; pause, complete, or delete an existing mission before creating another."},{status:429});
      await addMissionEventWithRetry(store, {
        missionId:rerunMission.id,
        userId,
        type:"mission.created",
        message:"Mission rerun from step "+source.steps[stepIndex].title,
        metadata:{sourceMissionId:source.id,sourceStepId:stepId,rerunFromStepId:stepId}
      });
      return Response.json({mission:publicMissionResponse(rerunMission)});
    }

    const missionRerunMatch=url.pathname.match(/^\/v1\/missions\/users\/([^/]+)\/([^/]+)\/rerun$/);
    if(missionRerunMatch && request.method==="POST"){
      const userId=decodeBoundedUserId(missionRerunMatch[1]);
      if (!userId) return Response.json({error:"Invalid user ID"},{status:400});
      const id=decodeBoundedResourceId(missionRerunMatch[2]);
      const store=(await import("../../missions/src")).getMissionStore();
      const source=await store.get(id,userId);
      if(!source)return Response.json({error:"Mission not found"},{status:404});
      if(!["completed","failed","cancelled"].includes(source.status))return Response.json({error:"Only completed, failed, or cancelled missions can be rerun"},{status:409});
      const rerunMission=await store.create({userId,goal:source.goal,status:"planning",priority:source.priority,budgetProfile:source.budgetProfile,progress:0,steps:[]});
      await addMissionEventWithRetry(store, {missionId:rerunMission.id,userId,type:"mission.created",message:"Mission rerun created from "+source.id,metadata:{sourceMissionId:source.id}});
      return Response.json({mission:publicMissionResponse(rerunMission)});
    }

    const missionMatch=url.pathname.match(/^\/v1\/missions\/users\/([^/]+)\/([^/]+)$/);
    const missionEventStreamMatch=url.pathname.match(/^\/v1\/missions\/users\/([^/]+)\/([^/]+)\/events\/stream$/);
    if(missionEventStreamMatch && request.method==="GET"){
      const userId=decodeBoundedUserId(missionEventStreamMatch[1]);
      if (!userId) return Response.json({error:"Invalid user ID"},{status:400});
      const id=decodeBoundedResourceId(missionEventStreamMatch[2]);
      const {getMissionStore}=await import("../../missions/src");
      const mission=await getMissionStore().get(id,userId);
      if(!mission)return Response.json({error:"Mission not found"},{status:404});
      const encoder=new TextEncoder();
      const stream=new ReadableStream({
        async start(controller){
          let closed=false;
          const send=(event:unknown)=>{if(!closed)controller.enqueue(encoder.encode("data: "+JSON.stringify(event)+"\n\n"));};
          const initial=await getMissionStore().listEvents(id,userId,20);
          for(const event of initial.reverse())send(event);
          let seen=new Set(initial.map((event)=>event.id));
          const timer=setInterval(async()=>{
            try{
              const latest=await getMissionStore().listEvents(id,userId,50);
              for(const event of latest.reverse())if(!seen.has(event.id)){seen.add(event.id);send(event);}
              if(seen.size>200)seen=new Set(latest.map((event)=>event.id));
            }catch{}
          },2000);
          const heartbeat=setInterval(()=>send({type:"heartbeat",createdAt:new Date().toISOString()}),15000);
          request.signal.addEventListener("abort",()=>{closed=true;clearInterval(timer);clearInterval(heartbeat);controller.close();},{once:true});
        }
      });
      return new Response(stream,{headers:{"content-type":"text/event-stream","cache-control":"no-cache","connection":"keep-alive"}});
    }

    const missionEventsMatch=url.pathname.match(/^\/v1\/missions\/users\/([^/]+)\/([^/]+)\/events$/);
    if(missionEventsMatch && request.method==="GET"){
      const {getMissionStore}=await import("../../missions/src");
      const userId=decodeBoundedUserId(missionEventsMatch[1]);
      if (!userId) return Response.json({error:"Invalid user ID"},{status:400});
      const id=decodeBoundedResourceId(missionEventsMatch[2]);
      const mission=await getMissionStore().get(id,userId);
      if(!mission)return Response.json({error:"Mission not found"},{status:404});
      const limit=Number(url.searchParams.get("limit")??"100");
      return Response.json({events:await getMissionStore().listEvents(id,userId,Number.isFinite(limit)?limit:100)});
    }

    if(missionMatch && request.method==="GET"){
      const {getMissionStore}=await import("../../missions/src");
      const mission=await getMissionStore().get(decodeBoundedResourceId(missionMatch[2]),decodeBoundedUserId(missionMatch[1]));
      return mission?Response.json({mission:publicMissionResponse(mission)}):Response.json({error:"Mission not found"},{status:404});
    }

    const missionPriorityMatch=url.pathname.match(/^\/v1\/missions\/users\/([^/]+)\/([^/]+)\/priority$/);
    if(missionPriorityMatch && request.method==="POST"){
      try{
        const userId=decodeBoundedUserId(missionPriorityMatch[1]);
        if (!userId) return Response.json({error:"Invalid user ID"},{status:400});
        const id=decodeBoundedResourceId(missionPriorityMatch[2]);
        const body=await parseBoundedJson(request);
        if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body as Record<string,unknown>).length!==1)return Response.json({error:"Priority request must contain only priority"},{status:400});
        const priority=body?.priority;
        if(priority!=="low"&&priority!=="normal"&&priority!=="high")return Response.json({error:"priority must be low, normal, or high"},{status:400});
        const {getMissionStore}=await import("../../missions/src");
        const store=getMissionStore();
        const mission=await store.get(id,userId);
        if(!mission)return Response.json({error:"Mission not found"},{status:404});
        const updated=await store.updatePriorityIfIdle(id,userId,priority);
        if(!updated)return Response.json({error:"Mission is currently being executed or cannot be reconfigured"},{status:409});
        await addMissionEventWithRetry(store, {missionId:id,userId,type:"mission.updated",message:"Priority changed to "+priority+".",metadata:{field:"priority",value:priority}});
        return Response.json({mission:publicMissionResponse(updated)});
      }catch(error){return Response.json({error:"Priority update failed"},{status:400});}
    }

    const missionBudgetProfileMatch=url.pathname.match(/^\/v1\/missions\/users\/([^/]+)\/([^/]+)\/budget-profile$/);
    if(missionBudgetProfileMatch && request.method==="POST"){
      try{
        const userId=decodeBoundedUserId(missionBudgetProfileMatch[1]);
        if (!userId) return Response.json({error:"Invalid user ID"},{status:400});
        const id=decodeBoundedResourceId(missionBudgetProfileMatch[2]);
        const body=await parseBoundedJson(request);
        if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body as Record<string,unknown>).length!==1)return Response.json({error:"Budget request must contain only budgetProfile"},{status:400});
        const budgetProfile=body?.budgetProfile;
        if(budgetProfile!=="standard"&&budgetProfile!=="extended"&&budgetProfile!=="intensive")return Response.json({error:"invalid budget profile"},{status:400});
        const {getMissionStore}=await import("../../missions/src");
        const store=getMissionStore();
        const mission=await store.get(id,userId);
        if(!mission)return Response.json({error:"Mission not found"},{status:404});
        const updated=await store.updateBudgetProfileIfIdle(id,userId,budgetProfile);
        if(!updated)return Response.json({error:"Mission is currently being executed or cannot be reconfigured"},{status:409});
        await addMissionEventWithRetry(store, {missionId:id,userId,type:"mission.updated",message:"Budget profile changed to "+budgetProfile+".",metadata:{field:"budgetProfile",value:budgetProfile}});
        return Response.json({mission:publicMissionResponse(updated)});
      }catch(error){return Response.json({error:"Budget profile update failed"},{status:400});}
    }

    if(missionMatch && request.method==="DELETE"){
      const {getMissionStore}=await import("../../missions/src");
      const store=getMissionStore();
      const userId=decodeBoundedUserId(missionMatch[1]);
       if (!userId) return Response.json({error:"Invalid user ID"},{status:400});
      const id=decodeBoundedResourceId(missionMatch[2]);
      const mission=await store.get(id,userId);
      if(!mission)return Response.json({error:"Mission not found"},{status:404});
      const deleted=await store.deleteIfIdle(id,userId);
      if(!deleted)return Response.json({error:"Mission is currently being executed; wait for the active worker to finish"},{status:409});
      return Response.json({deleted:true});
    }

    if(missionMatch && request.method==="POST"){
      try{
        const userId=decodeBoundedUserId(missionMatch[1]);
       if (!userId) return Response.json({error:"Invalid user ID"},{status:400});
        const id=decodeBoundedResourceId(missionMatch[2]);
        const {getMissionStore, planMission, createRecoveryStep}=await import("../../missions/src");
        const missionEvaluator=new OpenAIProvider();
        const store=getMissionStore();
        let mission=await store.get(id,userId);
        if(!mission)return Response.json({error:"Mission not found"},{status:404});
        if(mission.status==="completed")return Response.json({mission:publicMissionResponse(mission)});
        const requestedWorkerId=request.headers.get("x-frosh-mission-worker-id")?.trim();
        const executionOwner=requestedWorkerId||("http-"+crypto.randomUUID());
        const updateOwned=async(patch:Partial<Omit<FroshMission,"id"|"createdAt"|"updatedAt">>)=>{const updated=await store.updateOwned(id,userId,executionOwner,patch);if(!updated)throw new Error("Mission execution lease was lost before mission state update");return updated;};
        if(requestedWorkerId){
          if(mission.leaseOwner!==requestedWorkerId || !mission.leaseUntil || Date.parse(mission.leaseUntil)<=Date.now()){
            return Response.json({error:"Mission lease is missing or expired"},{status:409});
          }
        }else{
          const claimed=await store.claim(id,userId,executionOwner);
          if(!claimed)return Response.json({error:"Mission is already being executed by another worker"},{status:409});
          mission=claimed;
        }

        let steps=mission.steps.length?mission.steps:planMission(mission.goal);
        const staleRunningSteps=steps.filter(step=>step.status==="running");
        if(staleRunningSteps.length){
          const reconciled=new Set<string>();
          let recoveryRequiresReview=false;
          for(const staleStep of staleRunningSteps){
            if(!staleStep.runId){
              steps=steps.map(step=>step.id===staleStep.id?{
                ...step,
                status:"failed",
                result:"The mission step was marked running but has no durable agent run reference. It was stopped and requires recovery instead of being replayed blindly.",
                updatedAt:new Date().toISOString()
              }:step);
              recoveryRequiresReview=true;
              reconciled.add(staleStep.id);
              continue;
            }
            const savedRun=await agentRunStore.get(staleStep.runId);
            if(savedRun?.status==="completed"){
              steps=steps.map(step=>step.id===staleStep.id?{...step,status:"completed",result:savedRun.result??step.result,context:[step.context??"",savedRun.result??""].filter(Boolean).join("\n\n").slice(-12000),updatedAt:new Date().toISOString()}:step);
              reconciled.add(staleStep.id);
            }else if(savedRun?.status==="waiting_approval" && savedRun.pendingApprovalId){
              const approval=await approvalStore.get(savedRun.pendingApprovalId);
              if(approval?.status==="pending"){
                await updateOwned({status:"waiting_approval",steps,activeRunId:savedRun.id,pendingApprovalId:savedRun.pendingApprovalId,result:savedRun.result,leaseUntil:undefined,leaseOwner:undefined});
                await addMissionEventWithRetry(store, {missionId:id,userId,type:"mission.recovered",message:"Recovered an approval-blocked agent run after execution restart.",stepId:staleStep.id,runId:savedRun.id});
                return Response.json({mission:publicMissionResponse(await store.get(id,userId))});
              }
              if(approval?.status==="approved" || approval?.status==="rejected" || approval?.status==="expired"){
                const outcome=approval.status==="approved"
                  ?"Approval was already accepted before execution restarted, but the agent run did not reach a durable completion state. The action outcome is unknown, so FROSH will not replay it automatically."
                  :approval.status==="rejected"
                    ?"The pending approval was rejected before execution restarted. The interrupted agent run was stopped safely."
                    :"The pending approval expired before execution restarted. The interrupted agent run was stopped safely.";
                steps=steps.map(step=>step.id===staleStep.id?{...step,status:"failed",result:outcome,updatedAt:new Date().toISOString()}:step);
                reconciled.add(staleStep.id);
                recoveryRequiresReview=true;
                await store.update(savedRun.id,userId,{
                  status:"failed",
                  pendingApprovalId:undefined,
                  result:outcome,
                  error:approval.status==="approved"?"Approved action outcome is unknown after execution restart":`Approval was ${approval.status} before execution restart`
                }).catch(()=>undefined);
              }
            }else if(!savedRun){
              steps=steps.map(step=>step.id===staleStep.id?{
                ...step,
                status:"failed",
                result:"The mission step references an agent run that no longer exists. The step was stopped and requires recovery review.",
                updatedAt:new Date().toISOString()
              }:step);
              recoveryRequiresReview=true;
              reconciled.add(staleStep.id);
              continue;
            }else if(savedRun.status==="running" || savedRun.status==="failed"){
              const approvedActionCall=savedRun.toolCalls.find(call=>call.id.startsWith("approved-") && call.status!=="planned");
              const approvedActionId=approvedActionCall?.id.slice("approved-".length);
              const approvedAction=approvedActionId?await approvalStore.get(approvedActionId):null;
              if(approvedAction?.status==="approved"){
                const outcome="An approved action was recorded in the agent run before execution stopped, but the mission did not durably reconcile the final continuation state. FROSH will not replay the action automatically.";
                steps=steps.map(step=>step.id===staleStep.id?{...step,status:"failed",result:outcome,updatedAt:new Date().toISOString()}:step);
                reconciled.add(staleStep.id);
                recoveryRequiresReview=true;
                await store.update(savedRun.id,userId,{
                  status:"failed",
                  pendingApprovalId:undefined,
                  result:outcome,
                  error:"Approved action requires safety review after interrupted continuation"
                }).catch(()=>undefined);
                continue;
              }
              if(savedRun.status==="running"){
              let orphanApproval:null|Awaited<ReturnType<typeof approvalStore.findPendingByRun>>=null;
              for(const toolCall of savedRun.toolCalls){
                if(toolCall.status!=="planned") continue;
                orphanApproval=await approvalStore.findPendingByRun(savedRun.id,toolCall.name,JSON.stringify(toolCall.arguments));
                if(orphanApproval) break;
              }
              if(orphanApproval){
                const restored=await agentRunStore.restoreApprovalWait(savedRun.id,orphanApproval.id,savedRun.toolCalls);
                if(restored){
                  steps=steps.map(step=>step.id===staleStep.id?{...step,status:"blocked",runId:savedRun.id,result:restored.result,updatedAt:new Date().toISOString()}:step);
                  await updateOwned({
                    status:"waiting_approval",
                    steps,
                    activeRunId:savedRun.id,
                    pendingApprovalId:orphanApproval.id,
                    result:restored.result,
                    leaseUntil:undefined,
                    leaseOwner:undefined
                  });
                  await addMissionEventWithRetry(store, {
                    missionId:id,
                    userId,
                    type:"mission.recovered",
                    message:"Recovered a pending approval that was created before the agent run durably recorded its approval wait state.",
                    stepId:staleStep.id,
                    runId:savedRun.id,
                    metadata:{approvalId:orphanApproval.id}
                  });
                  return Response.json({mission:publicMissionResponse(await store.get(id,userId))});
                }
              }
              const plannedApproval=savedRun.toolCalls.find(call=>call.status==="planned" && call.id.startsWith("approved-"));
              const plannedApprovalId=plannedApproval?.id.slice("approved-".length);
              const approval=plannedApprovalId?await approvalStore.get(plannedApprovalId):null;
              if(approval?.status==="approved"){
                steps=steps.map(step=>step.id===staleStep.id?{...step,status:"failed",result:"An approved action was in progress when execution stopped. Its outcome is unknown, so FROSH will not replay it automatically.",updatedAt:new Date().toISOString()}:step);
                reconciled.add(staleStep.id);
                recoveryRequiresReview=true;
                await store.update(savedRun.id,userId,{
                  status:"failed",
                  pendingApprovalId:undefined,
                  result:"An approved action was in progress when execution stopped, but its outcome is unknown. The run was stopped safely to prevent duplicate execution.",
                  error:"Approved action outcome is unknown after execution restart"
                }).catch(()=>undefined);
                continue;
              }
              const heartbeatAgeMs=Date.now()-Date.parse(savedRun.updatedAt);
              if(Number.isFinite(heartbeatAgeMs) && heartbeatAgeMs<180000){
                await store.releaseLeaseIfOwned(id,userId,executionOwner);
                return Response.json({error:"Mission agent run is still active"},{status:409});
              }
              }
            }
          }
          const interrupted=staleRunningSteps.filter(step=>!reconciled.has(step.id));
          if(interrupted.length){
            steps=steps.map(step=>interrupted.some(item=>item.id===step.id)?{...step,status:"pending",runId:undefined,retryCount:(step.retryCount??0)+1,nextRetryAt:undefined,updatedAt:new Date().toISOString()}:step);
          }
          await addMissionEventWithRetry(store, {missionId:id,userId,type:"mission.recovered",message:"Reconciled "+reconciled.size+" interrupted run(s); reset "+interrupted.length+" unfinished step(s).",metadata:{reconciledStepIds:[...reconciled],resetStepIds:interrupted.map(step=>step.id)}});
        }
        const blockedSteps=steps.filter(step=>step.status==="blocked"&&step.runId);
        for(const blockedStep of blockedSteps){
          const blockedRun=await agentRunStore.get(blockedStep.runId!);
          if(blockedRun?.status==="waiting_approval"&&blockedRun.pendingApprovalId){
            const approval=await approvalStore.get(blockedRun.pendingApprovalId);
            if(approval?.status==="pending"){
              await updateOwned({
                status:"waiting_approval",
                steps,
                activeRunId:blockedRun.id,
                pendingApprovalId:blockedRun.pendingApprovalId,
                result:blockedRun.result,
                leaseUntil:undefined,
                leaseOwner:undefined
              });
              await addMissionEventWithRetry(store, {missionId:id,userId,type:"mission.recovered",message:"Recovered a blocked step that is still waiting for approval.",stepId:blockedStep.id,runId:blockedRun.id});
              return Response.json({mission:publicMissionResponse(await store.get(id,userId))});
            }
            if(approval?.status==="approved"){
              const outcome="An approval was accepted before execution restarted, but the blocked agent run did not durably record whether the approved action executed. The mission is paused for safety review to prevent duplicate execution.";
              steps=steps.map(step=>step.id===blockedStep.id?{...step,status:"failed",result:outcome,updatedAt:new Date().toISOString()}:step);
              recoveryRequiresReview=true;
              await store.update(blockedRun.id,userId,{status:"failed",pendingApprovalId:undefined,result:outcome,error:"Approved action outcome is unknown after execution restart"}).catch(()=>undefined);
            }
          }
        }
        const recoverableInterruptedSteps=steps.filter(step=>step.status==="failed"||step.status==="blocked");
        if(recoverableInterruptedSteps.length&&!mission.pendingApprovalId&&!recoveryRequiresReview){
          const now=new Date().toISOString();
          steps=steps.map(step=>recoverableInterruptedSteps.some(item=>item.id===step.id)?{
            ...step,
            status:"pending",
            runId:undefined,
            nextRetryAt:undefined,
            updatedAt:now
          }:step);
          await addMissionEventWithRetry(store, {
            missionId:id,
            userId,
            type:"mission.recovered",
            message:"Reset failed or blocked steps into explicit recovery work.",
            metadata:{stepIds:recoverableInterruptedSteps.map(step=>step.id)}
          });
        }
        if(recoveryRequiresReview){
          const paused=await updateOwned({
            status:"paused",
            progress:steps.length?steps.filter(item=>item.status==="completed").length/steps.length:0,
            steps,
            activeRunId:mission.activeRunId,
            pendingApprovalId:undefined,
            result:"Mission paused after restart because an approval outcome or approved action was not durably reconciled. Review the mission before allowing another execution attempt.",
            leaseUntil:undefined,
            leaseOwner:undefined
          });
          await addMissionEventWithRetry(store, {missionId:id,userId,type:"mission.paused",message:"Mission paused after restart because an approval/action outcome could not be safely reconciled."});
          return Response.json({mission:publicMissionResponse(paused)});
        }
        if(steps.length>0 && steps.every(step=>step.status==="completed")){
          const recoveredResult=steps[steps.length-1]?.result??mission.result;
          const completedMission=await updateOwned({status:"completed",progress:1,steps,activeRunId:mission.activeRunId,pendingApprovalId:undefined,result:recoveredResult,leaseUntil:undefined,leaseOwner:undefined});
          await addMissionEventWithRetry(store, {missionId:id,userId,type:"mission.completed",message:"Mission completed during recovery reconciliation."});
          return Response.json({mission:publicMissionResponse(completedMission)});
        }
        let lastRunId=mission.activeRunId;
        let lastApproval=mission.pendingApprovalId;
        let lastResult=mission.result;
        const profileMultiplier=mission.budgetProfile==="extended"?1.5:mission.budgetProfile==="intensive"?2:1;
        const maxSteps=Math.min(24,Math.max(1,Math.round((Number(process.env.FROSH_MISSION_MAX_STEPS??12)||12)*profileMultiplier)));
        const configuredMaxRetries=Number(process.env.FROSH_MISSION_MAX_RETRIES??2);
        const maxRetries=Number.isFinite(configuredMaxRetries)?Math.max(0,Math.floor(configuredMaxRetries)):2;
        const retryPollMs=Math.max(5000,Number(process.env.FROSH_MISSION_RETRY_POLL_MS??10000)||10000);
        const maxTools=Math.min(80,Math.max(1,Math.round((Number(process.env.FROSH_MISSION_MAX_TOOL_CALLS??40)||40)*profileMultiplier)));
        const maxDurationMs=Math.min(3600000,Math.max(60000,Math.round((Number(process.env.FROSH_MISSION_MAX_DURATION_MS??1800000)||1800000)*profileMultiplier)));
        const missionStartedAt=Date.now();
        const initialToolCount=mission.toolCallsUsed??0;        const initialDurationMs=mission.executionDurationMs??0;
        let toolCount=initialToolCount;
        const emit=async(type:"mission.created"|"mission.claimed"|"mission.step.started"|"mission.step.completed"|"mission.step.failed"|"mission.step.retry"|"mission.approval.required"|"mission.paused"|"mission.cancelled"|"mission.recovered"|"mission.completed"|"mission.failed"|"mission.tool.completed"|"mission.tool.failed"|"mission.budget.exceeded",message:string,stepId?:string,runId?:string,metadata?:Record<string,unknown>)=>{try{await addMissionEventWithRetry(store, {missionId:id,userId,type,message,stepId,runId,metadata});}catch(error){logOperationalError("FROSH mission telemetry error", error);}};
        await emit("mission.claimed","Mission execution started.");

        for(let cycle=0;cycle<8;cycle++){
          const renewed=await store.renewLease(id,userId,executionOwner);
          if(!renewed){
            await store.releaseLeaseIfOwned(id,userId,executionOwner);
            return Response.json({error:"Mission execution lease was lost"},{status:409});
          }
          const leaseCheck=await store.get(id,userId);
          if(!leaseCheck || leaseCheck.leaseOwner!==executionOwner || !leaseCheck.leaseUntil || Date.parse(leaseCheck.leaseUntil)<=Date.now()){
            await store.releaseLeaseIfOwned(id,userId,executionOwner);
            return Response.json({error:"Mission execution lease was lost before agent execution"},{status:409});
          }
          if(steps.length>maxSteps||initialDurationMs+(Date.now()-missionStartedAt)>maxDurationMs||toolCount>=maxTools){
            await emit("mission.budget.exceeded","Mission execution budget reached.");
            mission=await updateOwned({status:"paused",steps,progress:steps.length?steps.filter(item=>item.status==="completed").length/steps.length:0,activeRunId:lastRunId,pendingApprovalId:lastApproval,result:lastResult,toolCallsUsed:toolCount,executionDurationMs:initialDurationMs+(Date.now()-missionStartedAt),leaseUntil:undefined,leaseOwner:undefined});
            return Response.json({mission:publicMissionResponse(mission),budgetExceeded:true});
          }
          const index=steps.findIndex(step=>step.status==="pending" && (!step.nextRetryAt || Date.parse(step.nextRetryAt)<=Date.now()));
          if(index<0){
            const hasPending=steps.some(step=>step.status==="pending");
            const hasFailed=steps.some(step=>step.status==="failed");
            const hasBlocked=steps.some(step=>step.status==="blocked");
            if(!hasPending && !hasFailed && !hasBlocked && steps.length>0){
              mission=await updateOwned({status:"completed",progress:1,steps,activeRunId:lastRunId,pendingApprovalId:undefined,result:lastResult,toolCallsUsed:toolCount,executionDurationMs:initialDurationMs+(Date.now()-missionStartedAt),leaseUntil:undefined,leaseOwner:undefined});
              await emit("mission.completed","Mission completed.");
              return Response.json({mission:publicMissionResponse(mission)});
            }
            break;
          }

          const now=new Date().toISOString();
          steps=steps.map((step,i)=>i===index?{...step,status:"running",updatedAt:now}:step);
          const step=steps[index];
          await updateOwned({status:"running",steps,activeRunId:lastRunId,pendingApprovalId:lastApproval,result:lastResult});
          await emit("mission.step.started","Started: "+step.title,step.id);
          const runStartedAt=Date.now();
          let leaseLost=false;
          let leaseRenewing=false;
          let activeRunId:string|undefined;
          const leaseRenewTimer=setInterval(async()=>{
            if(leaseLost||leaseRenewing)return;
            leaseRenewing=true;
            try{
              const renewed=await store.renewLease(id,userId,executionOwner);
              if(!renewed){
                leaseLost=true;
              }else if(activeRunId){
                try{
                  await agentRunStore.touch(activeRunId);
                }catch(error){
                  logOperationalError("FROSH mission agent run heartbeat failed", error);
                }
              }
            }catch(error){leaseLost=true;logOperationalError("FROSH mission execution lease renewal error", error);}
            finally{leaseRenewing=false;}
          },30000);
          let run;
          try{
            try{
              run=await codingSessions.start({
                goal:step.title+"\nOverall objective: "+mission.goal,
                messages:[{role:"user",content:[step.title,"Overall objective: "+mission.goal,"Step context:",step.context??"No prior context stored for this step.","Previous mission findings:",steps.filter(item=>item.status==="completed").map(item=>"- "+item.title+": "+(item.result??"")).join("\n")||"None yet"].join("\n")}],
                canPersist:async()=>{
                  const current=await store.get(id,userId);
                  return Boolean(current && current.leaseOwner===executionOwner && current.leaseUntil && Date.parse(current.leaseUntil)>Date.now());
                },
                onRunCreated:async(createdRun)=>{
                  activeRunId=createdRun.id;
                  const updated=await updateOwned({
                    status:"running",
                    steps:steps.map((item,i)=>i===index?{...item,runId:createdRun.id,updatedAt:new Date().toISOString()}:item),
                    activeRunId:createdRun.id,
                    pendingApprovalId:lastApproval,
                    result:lastResult
                  });
                  steps=updated.steps;
                }
              });
            }catch(error){
              if(leaseLost){
                await store.releaseLeaseIfOwned(id,userId,executionOwner);
                return Response.json({error:"Mission execution lease was lost before an agent run could be established"},{status:409});
              }
              if(!activeRunId){
                const message="Agent run creation failed";
                steps=steps.map((item,i)=>i===index?{
                  ...item,
                  status:"failed",
                  runId:undefined,
                  result:message,
                  updatedAt:new Date().toISOString()
                }:item);
                await updateOwned({
                  status:"running",
                  steps,
                  activeRunId:lastRunId,
                  pendingApprovalId:lastApproval,
                  result:message
                });
                await emit("mission.step.failed","Agent run creation failed: "+message,step.id);
              }
              throw error;
            }
          }finally{
            clearInterval(leaseRenewTimer);
          }
          if(!run){
            return Response.json({error:"Agent run was not established for the mission step"},{status:500});
          }
          if(activeRunId!==run.id){
            const message="Mission step agent-run binding is inconsistent; execution was stopped to prevent state corruption.";
            if(!leaseLost){
              steps=steps.map((item,i)=>i===index?{...item,status:"failed",runId:undefined,result:message,updatedAt:new Date().toISOString()}:item);
              await updateOwned({status:"running",steps,activeRunId:lastRunId,pendingApprovalId:lastApproval,result:message}).catch(()=>undefined);
              await agentRunStore.update(run.id,{status:"failed",result:message,error:message}).catch(()=>undefined);
            }
            await store.releaseLeaseIfOwned(id,userId,executionOwner);
            return Response.json({error:message},{status:409});
          }
          const runDurationMs=Date.now()-runStartedAt;
          if(leaseLost){
            await store.releaseLeaseIfOwned(id,userId,executionOwner);
            return Response.json({error:"Mission execution lease was lost during agent execution"},{status:409});
          }
          toolCount+=run.toolCalls.length;
          const executionDurationMs=initialDurationMs+(Date.now()-missionStartedAt);
          for(const toolCall of run.toolCalls){
            await emit(toolCall.status==="failed"?"mission.tool.failed":"mission.tool.completed","Tool "+toolCall.name+" "+toolCall.status,step.id,run.id,{toolName:toolCall.name,status:toolCall.status,durationMs:toolCall.durationMs??runDurationMs});
          }
          const stepStatus=run.status==="waiting_approval"?"blocked":run.status==="completed"?"completed":run.status==="failed"?"failed":"running";
          steps=steps.map((item,i)=>i===index?{...item,status:stepStatus,runId:run.id,result:run.result,context:[item.context??"",run.result??""].filter(Boolean).join("\n\n").slice(-12000),updatedAt:new Date().toISOString()}:item);
          if(toolCount>maxTools || executionDurationMs>maxDurationMs){
            const reason=toolCount>maxTools?"Mission tool-call budget was exceeded.":"Mission execution time budget was exceeded.";
            await emit("mission.budget.exceeded",reason,step.id,run.id,{toolCount,maxTools,executionDurationMs,maxDurationMs});
            mission=await updateOwned({status:"paused",steps,progress:steps.length?steps.filter(item=>item.status==="completed").length/steps.length:0,activeRunId:run.id,pendingApprovalId:undefined,result:run.result,toolCallsUsed:toolCount,executionDurationMs,leaseUntil:undefined,leaseOwner:undefined});
            return Response.json({mission:publicMissionResponse(mission),budgetExceeded:true});
          }

          if(stepStatus==="completed") await emit("mission.step.completed","Completed: "+step.title,step.id,run.id);
          if(stepStatus==="failed"){
            await emit("mission.step.failed","Failed: "+step.title,step.id,run.id);
            const retries=step.retryCount??0;
            if(retries<maxRetries){
              const retryDelayMs=Math.min(60000,Math.max(5000,retryPollMs/2)*Math.pow(2,retries));
              const retryAt=new Date(Date.now()+retryDelayMs).toISOString();
              steps=steps.map(item=>item.id===step.id?{...item,status:"pending",retryCount:retries+1,nextRetryAt:retryAt,updatedAt:new Date().toISOString()}:item);
              await emit("mission.step.retry","Automatic retry scheduled in "+Math.ceil(retryDelayMs/1000)+"s: "+step.title,step.id,run.id,{retryCount:retries+1,retryAt});
            }else{
              const recovery=createRecoveryStep(step.title,run.result);
              const recoveryNow=new Date().toISOString();
              steps=steps.map(item=>item.id===step.id?{...recovery,id:item.id,context:[item.context??"","Previous attempt failed and exhausted automatic retries.",run.result??""].filter(Boolean).join("\n\n").slice(-12000),createdAt:item.createdAt,updatedAt:recoveryNow}:item);
              await emit("mission.recovered","Retry limit reached; converted the failed step into explicit recovery work: "+step.title,step.id,run.id);
            }
          }
          if(run.status==="waiting_approval") await emit("mission.approval.required","Approval required to continue: "+step.title,step.id,run.id);

          lastRunId=run.id;
          lastApproval=run.pendingApprovalId;
          lastResult=run.result;
          if(run.status==="completed"){
            const evaluation=await missionEvaluator.evaluateMission({
              goal:mission.goal,
              step:step.title,
              result:run.result??""
            });
            if(evaluation.nextAction==="finish"||evaluation.complete){
              steps=steps.map((item,i)=>i===index?{...item,status:"completed",result:(run.result??"")+"\nEvaluation: "+evaluation.reason,updatedAt:new Date().toISOString()}:item);
            }else if(evaluation.nextAction==="recover"){
              const recovery=createRecoveryStep(step.title,evaluation.reason);
              const recoveryNow=new Date().toISOString();
              steps=steps.map(item=>item.id===step.id?{
                ...recovery,
                id:item.id,
                context:[item.context??"","Evaluator requested recovery work.",evaluation.reason].filter(Boolean).join("\n\n").slice(-12000),
                createdAt:item.createdAt,
                updatedAt:recoveryNow
              }:item);
            }else if(evaluation.nextStep?.trim()){
              const nextTitle=evaluation.nextStep.trim();
              const duplicatePending=steps.some(item=>item.title===nextTitle && (item.status==="pending"||item.status==="running"||item.status==="blocked"));
              if(!duplicatePending){
                if(steps.length>=maxSteps){
                  const durationAtPause=initialDurationMs+(Date.now()-missionStartedAt);
                  await emit("mission.budget.exceeded","Mission step budget reached before evaluator could add the next step.",step.id,run.id,{stepCount:steps.length,maxSteps});
                  mission=await updateOwned({
                    status:"paused",
                    progress:steps.length?steps.filter(item=>item.status==="completed").length/steps.length:0,
                    steps,
                    activeRunId:run.id,
                    pendingApprovalId:undefined,
                    result:run.result,
                    toolCallsUsed:toolCount,
                    executionDurationMs:durationAtPause,
                    leaseUntil:undefined,
                    leaseOwner:undefined
                  });
                  return Response.json({mission:publicMissionResponse(mission),budgetExceeded:true});
                }
                const timestamp=new Date().toISOString();
                steps.push({id:crypto.randomUUID(),title:nextTitle,status:"pending",createdAt:timestamp,updatedAt:timestamp});
              }
            }
          }

          const completed=steps.filter(item=>item.status==="completed").length;
          const progress=steps.length?completed/steps.length:0;

          if(run.status==="waiting_approval"){
            mission=await updateOwned({status:"waiting_approval",progress,steps,activeRunId:lastRunId,pendingApprovalId:lastApproval,result:lastResult,toolCallsUsed:toolCount,executionDurationMs:initialDurationMs+(Date.now()-missionStartedAt),leaseUntil:undefined,leaseOwner:undefined});
            return Response.json({mission:publicMissionResponse(mission)});
          }
          if(run.status==="failed"){
            mission=await updateOwned({status:"running",progress,steps,activeRunId:lastRunId,pendingApprovalId:undefined,result:lastResult,toolCallsUsed:toolCount,executionDurationMs:initialDurationMs+(Date.now()-missionStartedAt),leaseUntil:undefined,leaseOwner:undefined});
            return Response.json({mission:publicMissionResponse(mission)});
          }
          if(progress>=1){
            mission=await updateOwned({status:"completed",progress:1,steps,activeRunId:lastRunId,pendingApprovalId:undefined,result:lastResult,toolCallsUsed:toolCount,executionDurationMs:initialDurationMs+(Date.now()-missionStartedAt),leaseUntil:undefined,leaseOwner:undefined});
            await emit("mission.completed","Mission completed.");
            return Response.json({mission:publicMissionResponse(mission)});
          }
        }

        const completed=steps.filter(item=>item.status==="completed").length;
        mission=await updateOwned({status:"running",progress:steps.length?completed/steps.length:0,steps,activeRunId:lastRunId,pendingApprovalId:lastApproval,result:lastResult,toolCallsUsed:toolCount,executionDurationMs:initialDurationMs+(Date.now()-missionStartedAt)});
        return Response.json({mission:publicMissionResponse(mission)});
      }catch(error){
        try{
          const current=await store.get(id,userId);
          if(current && current.status==="running" && current.leaseOwner===executionOwner){
            await updateOwned({leaseUntil:undefined,leaseOwner:undefined});
          }
        }catch{}
        return Response.json({error:"Mission execution failed"},{status:400});
      }
    }
    const missionRetryMatch=url.pathname.match(/^\/v1\/missions\/users\/([^/]+)\/([^/]+)\/steps\/([^/]+)\/retry$/);
    if(missionRetryMatch && request.method==="POST"){
      try{
        const userId=decodeBoundedUserId(missionRetryMatch[1]);
        if (!userId) return Response.json({error:"Invalid user ID"},{status:400});
        const id=decodeBoundedResourceId(missionRetryMatch[2]);
        const stepId=decodeBoundedResourceId(missionRetryMatch[3]);
        const {getMissionStore}=await import("../../missions/src");
        const store=getMissionStore();
        const mission=await store.get(id,userId);
        if(!mission)return Response.json({error:"Mission not found"},{status:404});
        if(["completed","cancelled"].includes(mission.status))return Response.json({error:"Mission cannot be retried in its current state"},{status:409});
        if(mission.status==="waiting_approval")return Response.json({error:"Resolve the pending approval before retrying a mission step"},{status:409});
        if(isSafetyPausedMission(mission))return Response.json({error:"Mission is paused for safety review after an unreconciled approval/action outcome; review the mission before retrying it."},{status:409});
        const step=mission.steps.find(item=>item.id===stepId);
        if(!step)return Response.json({error:"Mission step not found"},{status:404});
        if(step.status==="running")return Response.json({error:"Mission step is already running"},{status:409});
        const executionOwner="manual-retry:"+crypto.randomUUID();
        const claimed=await store.claimStepRetry(id,userId,executionOwner);
        if(!claimed)return Response.json({error:"Mission is currently being executed; wait for the active worker to finish"},{status:409});
        const now=new Date().toISOString();
        const steps=claimed.steps.map(item=>item.id===stepId?{...item,status:"pending",runId:undefined,result:undefined,retryCount:0,nextRetryAt:undefined,updatedAt:now}:item);
        const updated=await store.updateOwned(id,userId,executionOwner,{status:"running",steps,pendingApprovalId:undefined});
        if(!updated){
          await store.releaseLeaseIfOwned(id,userId,executionOwner);
          return Response.json({error:"Mission retry lease was lost before the retry could be recorded"},{status:409});
        }
        await addMissionEventWithRetry(store, {missionId:id,userId,type:"mission.step.retry",message:"Retry requested: "+step.title,stepId});
        await store.releaseLeaseIfOwned(id,userId,executionOwner);
        return Response.json({mission:publicMissionResponse(await store.get(id,userId))});
      }catch(error){return Response.json({error:"Mission retry failed"},{status:400});}
    }

    const missionRecoveryMatch=url.pathname.match(/^\/v1\/missions\/users\/([^/]+)\/([^/]+)\/recover$/);
    if(missionRecoveryMatch && request.method==="POST"){
      try{
        const userId=decodeBoundedUserId(missionRecoveryMatch[1]);
        if (!userId) return Response.json({error:"Invalid user ID"},{status:400});
        const id=decodeBoundedResourceId(missionRecoveryMatch[2]);
        const {getMissionStore}=await import("../../missions/src");
        const mission=await getMissionStore().get(id,userId);
        if(!mission)return Response.json({error:"Mission not found"},{status:404});
        if(["completed","waiting_approval","paused","cancelled"].includes(mission.status))return Response.json({mission:publicMissionResponse(mission)});
        const requestedWorkerId=request.headers.get("x-frosh-mission-worker-id")?.trim();
        if(mission.leaseUntil && Date.parse(mission.leaseUntil)>Date.now() && mission.leaseOwner!==requestedWorkerId)return Response.json({mission:publicMissionResponse(mission)});
        if(mission.leaseUntil && Date.parse(mission.leaseUntil)>Date.now() && mission.leaseOwner===requestedWorkerId){
          const next=await fetch(new URL("/v1/missions/users/"+encodeURIComponent(userId)+"/"+encodeURIComponent(id),request.url),{method:"POST",headers:request.headers});
          return next;
        }
        if(mission.status==="failed"){
          const recoverableSteps=mission.steps.filter(step=>step.status==="failed"||step.status==="running");
          if(recoverableSteps.length){
            const now=new Date().toISOString();
            const steps=mission.steps.map(step=>recoverableSteps.some(item=>item.id===step.id)?{...step,status:"pending",runId:undefined,nextRetryAt:undefined,updatedAt:now}:step);
            const executionOwner="manual-recovery:"+crypto.randomUUID();
            const recovered=await getMissionStore().recoverFailedIfIdle(id,userId,executionOwner,steps);
            if(!recovered)return Response.json({error:"Mission is currently being executed; wait for the active worker to finish"},{status:409});
            await getMissionStore().addEvent({missionId:id,userId,type:"mission.recovered",message:"Recovered failed mission for another execution attempt.",metadata:{stepIds:recoverableSteps.map(step=>step.id)}});
            const handoffHeaders=new Headers(request.headers);
            handoffHeaders.set("x-frosh-mission-worker-id",executionOwner);
            return fetch(new URL("/v1/missions/users/"+encodeURIComponent(userId)+"/"+encodeURIComponent(id),request.url),{
              method:"POST",
              headers:handoffHeaders
            });
          }
        }
        const next=await fetch(new URL("/v1/missions/users/"+encodeURIComponent(userId)+"/"+encodeURIComponent(id),request.url),{method:"POST",headers:request.headers});
        return next;
      }catch(error){return Response.json({error:"Mission recovery failed"},{status:400});}
    }

    const missionContinueMatch=url.pathname.match(/^\/v1\/missions\/users\/([^/]+)\/([^/]+)\/continue$/);
    if(missionContinueMatch && request.method==="POST"){
      try{
        const userId=decodeBoundedUserId(missionContinueMatch[1]);
        if (!userId) return Response.json({error:"Invalid user ID"},{status:400});
        const id=decodeBoundedResourceId(missionContinueMatch[2]);
        const {getMissionStore}=await import("../../missions/src");
        const store=getMissionStore();
        const mission=await store.get(id,userId);
        if(!mission)return Response.json({error:"Mission not found"},{status:404});
        if(["paused","cancelled","completed"].includes(mission.status)){
          return Response.json({error:"Mission cannot continue in its current state; resume a paused mission or recover it through the appropriate control."},{status:409});
        }
        if(mission.status==="waiting_approval" && mission.pendingApprovalId){
          const profileMultiplier=mission.budgetProfile==="extended"?1.5:mission.budgetProfile==="intensive"?2:1;
          const maxSteps=Math.min(24,Math.max(1,Math.round((Number(process.env.FROSH_MISSION_MAX_STEPS??12)||12)*profileMultiplier)));
          const maxTools=Math.min(80,Math.max(1,Math.round((Number(process.env.FROSH_MISSION_MAX_TOOL_CALLS??40)||40)*profileMultiplier)));
          const maxDurationMs=Math.min(3600000,Math.max(60000,Math.round((Number(process.env.FROSH_MISSION_MAX_DURATION_MS??1800000)||1800000)*profileMultiplier)));
          const existingToolCount=mission.toolCallsUsed??0;
          const existingDurationMs=mission.executionDurationMs??0;
          const emit=async(type:"mission.approval.required"|"mission.budget.exceeded"|"mission.failed",message:string,runId?:string,metadata?:Record<string,unknown>)=>{try{await addMissionEventWithRetry(store, {missionId:id,userId,type,message,runId,metadata});}catch(error){logOperationalError("FROSH mission telemetry error", error);}};
          const executionOwner="approval-continuation:"+crypto.randomUUID();
          if(!mission.activeRunId){
            return Response.json({error:"Mission has no active agent run for the pending approval"},{status:409});
          }
          const approvalRun=await agentRunStore.get(mission.activeRunId);
          if(!approvalRun || approvalRun.status!=="waiting_approval" || approvalRun.pendingApprovalId!==mission.pendingApprovalId){
            return Response.json({error:"Mission approval state does not match its active agent run"},{status:409});
          }
          const claimed=await store.claimApprovalContinuation(id,userId,executionOwner);
          if(!claimed)return Response.json({error:"Mission is currently being executed; wait for the active worker to finish"},{status:409});
          const updateOwned=async(patch:Partial<Omit<FroshMission,"id"|"createdAt"|"updatedAt">>)=>{const updated=await store.updateOwned(id,userId,executionOwner,patch);if(!updated)throw new Error("Mission continuation lease was lost before mission state update");return updated;};
          if(mission.steps.length>maxSteps || existingToolCount>=maxTools || existingDurationMs>=maxDurationMs){
            await emit("mission.budget.exceeded","Mission approval continuation cannot start because the mission budget is already exhausted.",mission.activeRunId,{toolCount:existingToolCount,maxTools,executionDurationMs:existingDurationMs,maxDurationMs});
            const paused=await updateOwned({status:"paused",pendingApprovalId:mission.pendingApprovalId,toolCallsUsed:existingToolCount,executionDurationMs:existingDurationMs,leaseUntil:undefined,leaseOwner:undefined});
            return Response.json({mission:publicMissionResponse(paused),budgetExceeded:true},{status:409});
          }

          const continuationStartedAt=Date.now();
          const continuationBaseRun=mission.activeRunId?await agentRunStore.get(mission.activeRunId):null;
          const continuationBaseToolCount=continuationBaseRun?.toolCalls.length??0;
          let continuationLeaseLost=false;
          let continuationLeaseRenewing=false;
          const leaseRenewTimer=setInterval(async()=>{
            if(continuationLeaseLost||continuationLeaseRenewing)return;
            continuationLeaseRenewing=true;
            try{
              const renewed=await store.renewLease(id,userId,executionOwner);
              if(!renewed)continuationLeaseLost=true;
            }catch(error){
              continuationLeaseLost=true;
              logOperationalError("FROSH mission continuation lease renewal error", error);
            }finally{
              continuationLeaseRenewing=false;
            }
          },30000);
          let run;
          try {
            run=await codingSessions.approveAndResume(mission.pendingApprovalId,async()=>{
              const current=await store.get(id,userId);
              return Boolean(current && current.leaseOwner===executionOwner && current.leaseUntil && Date.parse(current.leaseUntil)>Date.now());
            });
          } catch(error) {
              clearInterval(leaseRenewTimer);
            const continuationDurationMs=Date.now()-continuationStartedAt;
            const executionDurationMs=existingDurationMs+continuationDurationMs;
            if(continuationLeaseLost){
              await store.releaseLeaseIfOwned(id,userId,executionOwner);
              return Response.json({error:"Mission execution lease was lost during approval continuation"},{status:409});
            }
            const failed=await updateOwned({
              status:"failed",
              pendingApprovalId:undefined,
              leaseUntil:undefined,
              leaseOwner:undefined,
              executionDurationMs,
              toolCallsUsed:existingToolCount,
              result:"Mission approval continuation failed"
            });
            await emit("mission.failed","Approval continuation failed: "+("Unknown error"),mission.activeRunId,{executionDurationMs});
            return Response.json({mission:publicMissionResponse(failed)},{status:500});
          }

          clearInterval(leaseRenewTimer);
          const continuationDurationMs=Date.now()-continuationStartedAt;
          const executionDurationMs=existingDurationMs+continuationDurationMs;
          if(continuationLeaseLost){
            await store.releaseLeaseIfOwned(id,userId,executionOwner);
            return Response.json({error:"Mission execution lease was lost during approval continuation"},{status:409});
          }
          const continuationToolCalls=Math.max(0,run.toolCalls.length-continuationBaseToolCount);
          const toolCallsUsed=existingToolCount+continuationToolCalls;
          const steps=mission.steps.map(step=>step.runId===run.id?{...step,status:run.status==="completed"?"completed":run.status==="failed"?"failed":"blocked",result:run.result,updatedAt:new Date().toISOString()}:step);
          const completed=steps.filter(step=>step.status==="completed").length;
          const progress=steps.length?completed/steps.length:0;

          if(toolCallsUsed>maxTools || executionDurationMs>maxDurationMs){
            const reason=toolCallsUsed>maxTools?"Mission tool-call budget was exceeded during approval continuation.":"Mission execution time budget was exceeded during approval continuation.";
            await emit("mission.budget.exceeded",reason,run.id,{toolCount:toolCallsUsed,maxTools,executionDurationMs,maxDurationMs});
            const paused=await updateOwned({
              status:"paused",
              progress,
              steps,
              toolCallsUsed,
              executionDurationMs,
              activeRunId:run.id,
              pendingApprovalId:run.pendingApprovalId,
              result:run.result,
              leaseUntil:undefined,
              leaseOwner:undefined
            });
            return Response.json({mission:publicMissionResponse(paused),run,budgetExceeded:true});
          }

          const continuationStatus=run.status==="failed"
            ?"failed"
            :run.status==="waiting_approval"
              ?"waiting_approval"
              :progress===1
                ?"completed"
                :"running";
          const updated=await updateOwned({
            status:continuationStatus,
            progress,
            steps,
            toolCallsUsed,
            executionDurationMs,
            pendingApprovalId:run.pendingApprovalId,
            activeRunId:run.id,
            result:run.result,
            leaseUntil:undefined,
            leaseOwner:undefined
          });
          if(updated.status==="waiting_approval"){
            await emit("mission.approval.required","Another approval is required to continue the mission.",run.id,{toolCallsUsed,executionDurationMs});
            return Response.json({mission:publicMissionResponse(updated),run});
          }
          if(updated.status==="running"){
            return fetch(new URL("/v1/missions/users/"+encodeURIComponent(userId)+"/"+encodeURIComponent(id),request.url),{method:"POST",headers:request.headers});
          }
          return Response.json({mission:publicMissionResponse(updated),run});
        }
        const response=await fetch(new URL("/v1/missions/users/"+encodeURIComponent(userId)+"/"+encodeURIComponent(id),request.url),{method:"POST",headers:request.headers});
        return response;
      }catch(error){return Response.json({error:"Mission continuation failed"},{status:400});}
    }

    if (request.method === "POST" && url.pathname === "/v1/agent-runs") {
      if (!webAuthenticated) {
        return Response.json({ error: "Direct agent runs require trusted web authentication." }, { status: 403 });
      }
      try {
        const body = await parseBoundedJson(request);
        const goal = typeof body?.goal === "string" ? body.goal.trim() : "";
        const message =
          typeof body?.message === "string" && body.message.trim()
            ? body.message.trim()
            : goal;

        if (!goal) {
          return Response.json({ error: "goal is required" }, { status: 400 });
        }

        const run = await codingSessions.start({
          goal,
          conversationId:
            typeof body?.conversationId === "string" ? body.conversationId : undefined,
          messages: [{ role: "user", content: message }],
        });

        return Response.json(run, { status: 201 });
      } catch (error) {
        const message = "Agent run failed";
        return Response.json({ error: message }, { status: 500 });
      }
    }
