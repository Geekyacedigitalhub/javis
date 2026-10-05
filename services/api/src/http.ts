import { postChat } from "./routes";
import { approvalStore } from "../../tools/src";
import { CodingSessionManager, agentRunStore } from "../../ai/src";
import { OpenAIProvider } from "../../ai/src/openai-provider";
import { authenticateDevice, issueDeviceCredential, listDevices, registerDevice, getDevice } from "./devices";
import { addRealtimeClient, handleDeviceCommandResult, realtimeClientCount } from "./realtime";
import { getUserMemoryStore } from "../../memory/src/user-memory-factory";
import { listUserMemoryCandidates, resolveUserMemoryCandidate } from "../../memory/src/memory-candidates";

const codingSessions = new CodingSessionManager(new OpenAIProvider());
const port = Number(process.env.PORT ?? 3001);
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
        await fetch(url,{method:"POST",headers:{"x-frosh-web-token":process.env.FROSH_WEB_TOKEN??""}});
      }catch{}
    }
  }catch(error){
    console.error("FROSH mission startup recovery failed:",error);
  }
}
setTimeout(()=>void recoverMissionsOnStartup(),2000);


const server = Bun.serve({
  port,
  websocket: {
    open(ws) {
      // Authentication is completed by the first realtime auth message.
      ws.data = { authenticated: false, deviceId: undefined as string | undefined };
      ws.send(JSON.stringify({ type: "connected", timestamp: new Date().toISOString() }));
    },
    message(ws, message) {
      try {
        const parsed = JSON.parse(String(message));
        if (parsed?.type === "auth") {
          if (typeof parsed.deviceId !== "string" || typeof parsed.token !== "string" || !authenticateDevice(parsed.deviceId, parsed.token)) {
            ws.send(JSON.stringify({ type: "error", message: "Realtime authentication failed" }));
            ws.close();
            return;
          }
          ws.data = { authenticated: true, deviceId: parsed.deviceId };
          addRealtimeClient(ws, parsed.deviceId);
          ws.send(JSON.stringify({ type: "connected", timestamp: new Date().toISOString() }));
          return;
        }
        if (parsed?.type === "device.command.result") {
          if (!ws.data?.authenticated || ws.data.deviceId !== parsed.deviceId) return;
          handleDeviceCommandResult(parsed);
          return;
        }
        if (parsed?.type === "ping") {
          ws.send(JSON.stringify({ type: "connected", timestamp: new Date().toISOString() }));
        }
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid realtime message" }));
      }
    },
  },
  async fetch(request) {
    const url = new URL(request.url);

    const deviceId = request.headers.get("x-frosh-device-id");
    const deviceToken = request.headers.get("x-frosh-device-token");
    const webToken = process.env.FROSH_WEB_TOKEN?.trim();
    const suppliedWebToken = request.headers.get("x-frosh-web-token");
    const webAuthenticated = Boolean(webToken && suppliedWebToken && suppliedWebToken === webToken);
    const publicPath =
      url.pathname === "/health" ||
      (request.method === "POST" && url.pathname === "/v1/devices") ||
      url.pathname === "/v1/realtime";
    if (!publicPath && !webAuthenticated && (!deviceId || !deviceToken || !authenticateDevice(deviceId, deviceToken))) {
      return Response.json({ error: "FROSH authentication required" }, { status: 401 });
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
        const body = await request.json();
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

              const userId = typeof body?.userId === "string" ? body.userId : undefined;
              const conversationId = typeof body?.conversationId === "string" ? body.conversationId : undefined;
              const memory = createMemoryStore();
              const conversation = conversationId ? await memory.getConversation(conversationId) : null;
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
              send({ type: "error", message: error instanceof Error ? error.message : "Streaming request failed" });
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
        return Response.json({ error: error instanceof Error ? error.message : "Streaming request failed" }, { status: 500 });
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/chat") {
      try {
        const body = await request.json();
        return Response.json(await postChat(body));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Request failed";
        return Response.json(
          { error: message },
          { status: message === "message is required" ? 400 : 500 },
        );
      }
    }


    const memoryUserMatch = url.pathname.match(/^\/v1\/memory\/users\/([^/]+)$/);
    if (memoryUserMatch && request.method === "GET") {
      const userId = decodeURIComponent(memoryUserMatch[1]);
      return Response.json({ memories: await getUserMemoryStore().list(userId, 100) });
    }

    const memoryCandidatesMatch = url.pathname.match(/^\/v1\/memory\/users\/([^/]+)\/candidates$/);
    if (memoryCandidatesMatch && request.method === "GET") {
      const userId = decodeURIComponent(memoryCandidatesMatch[1]);
      return Response.json({ candidates: await listUserMemoryCandidates(userId) });
    }

    if (memoryCandidatesMatch && request.method === "POST") {
      try {
        const userId = decodeURIComponent(memoryCandidatesMatch[1]);
        const body = await request.json();
        const candidateId = typeof body?.candidateId === "string" ? body.candidateId.trim() : "";
        const status = body?.status === "approved" || body?.status === "rejected" ? body.status : "";
        if (!candidateId || !status) {
          return Response.json({ error: "candidateId and status are required" }, { status: 400 });
        }
        const candidate = await resolveUserMemoryCandidate(userId, candidateId, status);
        return Response.json(candidate);
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "Memory candidate update failed" }, { status: 400 });
      }
    }

    const memoryDeleteMatch = url.pathname.match(/^\/v1\/memory\/users\/([^/]+)\/([^/]+)$/);
    if (memoryDeleteMatch && request.method === "DELETE") {
      const userId = decodeURIComponent(memoryDeleteMatch[1]);
      const memoryId = decodeURIComponent(memoryDeleteMatch[2]);
      const deleted = await getUserMemoryStore().delete(memoryId, userId);
      return deleted
        ? Response.json({ deleted: true })
        : Response.json({ error: "Memory not found for this user" }, { status: 404 });
    }

    const messagesMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/messages$/);
    if (messagesMatch && request.method === "GET") {
      try {
        const { requestMessageInbox } = await import("./realtime");
        return Response.json(await requestMessageInbox(messagesMatch[1]));
      } catch (error) {
        return Response.json({ accepted: false, message: error instanceof Error ? error.message : "Message inbox failed" }, { status: 400 });
      }
    }

    const replySuggestionsMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/messages\/suggest-replies$/);
    if (replySuggestionsMatch && request.method === "POST") {
      try {
        const body = await request.json();
        const message = typeof body?.message === "string" ? body.message.trim() : "";
        const provider = typeof body?.provider === "string" ? body.provider : "other";
        const sender = typeof body?.sender === "string" ? body.sender : undefined;
        if (!message) return Response.json({ error: "message is required" }, { status: 400 });
        const { suggestMessageReplies } = await import("../../ai/src/message-replies");
        return Response.json({ suggestions: await suggestMessageReplies({ provider, sender, message }) });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "Reply suggestion failed" }, { status: 400 });
      }
    }

    const messageIntelligenceMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/messages\/intelligence$/);
    if (messageIntelligenceMatch && request.method === "GET") {
      try {
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
        return Response.json({ accepted: false, message: error instanceof Error ? error.message : "Message intelligence failed" }, { status: 400 });
      }
    }

    const messageReplyMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/messages\/([^/]+)\/reply$/);
    if (messageReplyMatch && request.method === "POST") {
      try {
        const body = await request.json();
        const message = typeof body?.message === "string" ? body.message.trim() : "";
        if (!message) return Response.json({ error: "message is required" }, { status: 400 });
        const { replyToMessageCommand } = await import("./realtime");
        return Response.json(await replyToMessageCommand(messagesMatch?.[1] ?? messageReplyMatch[1], decodeURIComponent(messageReplyMatch[2]), message));
      } catch (error) {
        return Response.json({ accepted: false, message: error instanceof Error ? error.message : "Message reply failed" }, { status: 400 });
      }
    }

    const commandMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/command$/);
    if (commandMatch && request.method === "POST") {
      try {
        const body = await request.json();
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
        const result = await sendDeviceCommand(
          commandMatch[1],
          command as "open_dialer" | "media_control" | "media_state" | "open_app" | "contacts_search" | "message_inbox",
          value,
        );
        return Response.json(result);
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "Device command failed" }, { status: 400 });
      }
    }

    if (request.method === "GET" && url.pathname === "/v1/devices") {
      return Response.json({ devices: listDevices() });
    }

    if (request.method === "POST" && url.pathname === "/v1/devices") {
      try {
        const body = await request.json();
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

        const device = registerDevice({
          name: body.name.trim(),
          platform: body.platform,
          capabilities: body.capabilities.filter(
            (capability: unknown): capability is string =>
              typeof capability === "string",
          ),
        });
        const credential = issueDeviceCredential(device.id);
        return Response.json({ device, credential }, { status: 201 });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Device registration failed";
        return Response.json({ error: message }, { status: 400 });
      }
    }

    const capabilityMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/capabilities$/);
    if (capabilityMatch && request.method === "POST") {
      try {
        const body = await request.json();
        if (!Array.isArray(body?.capabilities)) {
          return Response.json({ error: "capabilities must be an array" }, { status: 400 });
        }
        const device = updateDeviceCapabilities(
          capabilityMatch[1],
          body.capabilities.filter((item: unknown): item is { capability: string; availability: "available" | "permission_required" | "unsupported"; detail?: string } =>
            typeof item === "object" && item !== null &&
            typeof (item as { capability?: unknown }).capability === "string" &&
            ["available", "permission_required", "unsupported"].includes(String((item as { availability?: unknown }).availability)),
          ),
        );
        return device
          ? Response.json(device)
          : Response.json({ error: "Device not found" }, { status: 404 });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "Capability update failed" }, { status: 400 });
      }
    }

    const deviceMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)$/);
    if (deviceMatch && request.method === "GET") {
      const device = getDevice(deviceMatch[1]);
      return device
        ? Response.json(device)
        : Response.json({ error: "Device not found" }, { status: 404 });
    }

    const automationUsers = url.pathname.match(/^\/v1\/automations\/users\/([^/]+)$/);
    if (automationUsers && request.method === "GET") {
      const { getAutomationStore } = await import("../../automation/src");
      return Response.json({ automations: await getAutomationStore().list(decodeURIComponent(automationUsers[1])) });
    }

    if (automationUsers && request.method === "POST") {
      try {
        const userId = decodeURIComponent(automationUsers[1]);
        const body = await request.json();
        const name = typeof body?.name === "string" ? body.name.trim() : "";
        const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
        const schedule = body?.schedule;
        if (!name || !prompt || !schedule?.type) return Response.json({ error: "name, prompt and schedule are required" }, { status: 400 });

        const { calculateNextRun, getAutomationStore } = await import("../../automation/src");
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
        return Response.json({ error: error instanceof Error ? error.message : "Automation creation failed" }, { status: 400 });
      }
    }

    const automationMatch = url.pathname.match(/^\/v1\/automations\/users\/([^/]+)\/([^/]+)$/);
    if (automationMatch && request.method === "PATCH") {
      try {
        const userId = decodeURIComponent(automationMatch[1]);
        const id = decodeURIComponent(automationMatch[2]);
        const body = await request.json();
        const patch: Record<string, unknown> = {};
        if (typeof body?.name === "string") patch.name = body.name.trim();
        if (typeof body?.prompt === "string") patch.prompt = body.prompt.trim();
        if (body?.status === "active" || body?.status === "paused" || body?.status === "completed") patch.status = body.status;
        if (body?.schedule?.type) patch.schedule = body.schedule;
        const { calculateNextRun, getAutomationStore } = await import("../../automation/src");
        if (patch.schedule) patch.nextRunAt = calculateNextRun(patch.schedule as any);
        const automation = await getAutomationStore().update(id, userId, patch as any);
        return Response.json({ automation });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "Automation update failed" }, { status: 400 });
      }
    }

    if (automationMatch && request.method === "DELETE") {
      const deleted = await (await import("../../automation/src")).getAutomationStore().delete(decodeURIComponent(automationMatch[2]), decodeURIComponent(automationMatch[1]));
      return deleted ? Response.json({ deleted: true }) : Response.json({ error: "Automation not found" }, { status: 404 });
    }

    const missionUsers = url.pathname.match(/^\/v1\/missions\/users\/([^/]+)$/);
    if (missionUsers && request.method === "GET") {
      const { getMissionStore } = await import("../../missions/src");
      return Response.json({ missions: await getMissionStore().list(decodeURIComponent(missionUsers[1])) });
    }

    if (missionUsers && request.method === "POST") {
      try {
        const userId=decodeURIComponent(missionUsers[1]);
        const body=await request.json();
        const goal=typeof body?.goal==="string"?body.goal.trim():"";
        if(!goal)return Response.json({error:"goal is required"},{status:400});
        const { getMissionStore }=await import("../../missions/src");
        const priority=body?.priority==="high"||body?.priority==="low"?""+body.priority:"normal";
      const budgetProfile=body?.budgetProfile==="extended"||body?.budgetProfile==="intensive"?body.budgetProfile:"standard";
        const mission=await getMissionStore().create({userId,goal,status:"planning",priority,budgetProfile,progress:0,steps:[]});
      await getMissionStore().addEvent({missionId:mission.id,userId,type:"mission.created",message:"Mission created: "+goal});
        return Response.json({mission},{status:201});
      } catch(error){return Response.json({error:error instanceof Error?error.message:"Mission creation failed"},{status:400});}
    }

    const missionControlMatch=url.pathname.match(/^\/v1\/missions\/users\/([^/]+)\/([^/]+)\/(pause|resume|cancel)$/);
    if(missionControlMatch && request.method==="POST"){
      const {getMissionStore}=await import("../../missions/src");
      const userId=decodeURIComponent(missionControlMatch[1]);
      const id=decodeURIComponent(missionControlMatch[2]);
      const action=missionControlMatch[3];
      const store=getMissionStore();
      const mission=await store.get(id,userId);
      if(!mission)return Response.json({error:"Mission not found"},{status:404});
      if(action==="pause"){
        if(["completed","failed","cancelled"].includes(mission.status))return Response.json({error:"Mission cannot be paused in its current state"},{status:409});
        const updated=await store.update(id,userId,{status:"paused",leaseUntil:undefined,leaseOwner:undefined});
        await store.addEvent({missionId:id,userId,type:"mission.paused",message:"Mission paused by user."});
        return Response.json({mission:updated});
      }
      if(action==="resume"){
        if(mission.status!=="paused")return Response.json({error:"Only paused missions can be resumed"},{status:409});
        const updated=await store.update(id,userId,{status:"running"});
        await store.addEvent({missionId:id,userId,type:"mission.recovered",message:"Mission resumed by user."});
        return Response.json({mission:updated});
      }
      if(["completed","cancelled"].includes(mission.status))return Response.json({mission});
      const updated=await store.update(id,userId,{status:"cancelled",leaseUntil:undefined,pendingApprovalId:undefined});
      await store.addEvent({missionId:id,userId,type:"mission.cancelled",message:"Mission cancelled by user."});
      return Response.json({mission:updated});
    }

    const missionRerunStepMatch=url.pathname.match(/^\/v1\/missions\/users\/([^/]+)\/([^/]+)\/rerun-from-step\/([^/]+)$/);
    if(missionRerunStepMatch && request.method==="POST"){
      const userId=decodeURIComponent(missionRerunStepMatch[1]);
      const id=decodeURIComponent(missionRerunStepMatch[2]);
      const stepId=decodeURIComponent(missionRerunStepMatch[3]);
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
      await store.addEvent({
        missionId:rerunMission.id,
        userId,
        type:"mission.created",
        message:"Mission rerun from step "+source.steps[stepIndex].title,
        metadata:{sourceMissionId:source.id,sourceStepId:stepId,rerunFromStepId:stepId}
      });
      return Response.json({mission:rerunMission});
    }

    const missionRerunMatch=url.pathname.match(/^\/v1\/missions\/users\/([^/]+)\/([^/]+)\/rerun$/);
    if(missionRerunMatch && request.method==="POST"){
      const userId=decodeURIComponent(missionRerunMatch[1]);
      const id=decodeURIComponent(missionRerunMatch[2]);
      const store=(await import("../../missions/src")).getMissionStore();
      const source=await store.get(id,userId);
      if(!source)return Response.json({error:"Mission not found"},{status:404});
      if(!["completed","failed","cancelled"].includes(source.status))return Response.json({error:"Only completed, failed, or cancelled missions can be rerun"},{status:409});
      const rerunMission=await store.create({userId,goal:source.goal,status:"planning",priority:source.priority,budgetProfile:source.budgetProfile,progress:0,steps:[]});
      await store.addEvent({missionId:rerunMission.id,userId,type:"mission.created",message:"Mission rerun created from "+source.id,metadata:{sourceMissionId:source.id}});
      return Response.json({mission:rerunMission});
    }

    const missionMatch=url.pathname.match(/^\/v1\/missions\/users\/([^/]+)\/([^/]+)$/);
    const missionEventStreamMatch=url.pathname.match(/^\/v1\/missions\/users\/([^/]+)\/([^/]+)\/events\/stream$/);
    if(missionEventStreamMatch && request.method==="GET"){
      const userId=decodeURIComponent(missionEventStreamMatch[1]);
      const id=decodeURIComponent(missionEventStreamMatch[2]);
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
      const userId=decodeURIComponent(missionEventsMatch[1]);
      const id=decodeURIComponent(missionEventsMatch[2]);
      const mission=await getMissionStore().get(id,userId);
      if(!mission)return Response.json({error:"Mission not found"},{status:404});
      const limit=Number(url.searchParams.get("limit")??"100");
      return Response.json({events:await getMissionStore().listEvents(id,userId,Number.isFinite(limit)?limit:100)});
    }

    if(missionMatch && request.method==="GET"){
      const {getMissionStore}=await import("../../missions/src");
      const mission=await getMissionStore().get(decodeURIComponent(missionMatch[2]),decodeURIComponent(missionMatch[1]));
      return mission?Response.json({mission}):Response.json({error:"Mission not found"},{status:404});
    }

    const missionPriorityMatch=url.pathname.match(/^\/v1\/missions\/users\/([^/]+)\/([^/]+)\/priority$/);
    if(missionPriorityMatch && request.method==="POST"){
      try{
        const userId=decodeURIComponent(missionPriorityMatch[1]);
        const id=decodeURIComponent(missionPriorityMatch[2]);
        const body=await request.json();
        const priority=body?.priority;
        if(priority!=="low"&&priority!=="normal"&&priority!=="high")return Response.json({error:"priority must be low, normal, or high"},{status:400});
        const {getMissionStore}=await import("../../missions/src");
        const store=getMissionStore();
        const mission=await store.get(id,userId);
        if(!mission)return Response.json({error:"Mission not found"},{status:404});
        const updated=await store.update(id,userId,{priority});
        await store.addEvent({missionId:id,userId,type:"mission.recovered",message:"Priority changed to "+priority+"."});
        return Response.json({mission:updated});
      }catch(error){return Response.json({error:error instanceof Error?error.message:"Priority update failed"},{status:400});}
    }

    const missionBudgetProfileMatch=url.pathname.match(/^\/v1\/missions\/users\/([^/]+)\/([^/]+)\/budget-profile$/);
    if(missionBudgetProfileMatch && request.method==="POST"){
      try{
        const userId=decodeURIComponent(missionBudgetProfileMatch[1]);
        const id=decodeURIComponent(missionBudgetProfileMatch[2]);
        const body=await request.json();
        const budgetProfile=body?.budgetProfile;
        if(budgetProfile!=="standard"&&budgetProfile!=="extended"&&budgetProfile!=="intensive")return Response.json({error:"invalid budget profile"},{status:400});
        const {getMissionStore}=await import("../../missions/src");
        const store=getMissionStore();
        const mission=await store.get(id,userId);
        if(!mission)return Response.json({error:"Mission not found"},{status:404});
        const updated=await store.update(id,userId,{budgetProfile});
        await store.addEvent({missionId:id,userId,type:"mission.recovered",message:"Budget profile changed to "+budgetProfile+"."});
        return Response.json({mission:updated});
      }catch(error){return Response.json({error:error instanceof Error?error.message:"Budget profile update failed"},{status:400});}
    }

    if(missionMatch && request.method==="DELETE"){
      const {getMissionStore}=await import("../../missions/src");
      const deleted=await getMissionStore().delete(decodeURIComponent(missionMatch[2]),decodeURIComponent(missionMatch[1]));
      return deleted?Response.json({deleted:true}):Response.json({error:"Mission not found"},{status:404});
    }

    if(missionMatch && request.method==="POST"){
      try{
        const userId=decodeURIComponent(missionMatch[1]);
        const id=decodeURIComponent(missionMatch[2]);
        const {getMissionStore, planMission, createRecoveryStep}=await import("../../missions/src");
        const missionEvaluator=new OpenAIProvider();
        const store=getMissionStore();
        let mission=await store.get(id,userId);
        if(!mission)return Response.json({error:"Mission not found"},{status:404});
        if(mission.status==="completed")return Response.json({mission});
        const requestedWorkerId=request.headers.get("x-frosh-mission-worker-id")?.trim();
        const executionOwner=requestedWorkerId||("http-"+crypto.randomUUID());
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
          for(const staleStep of staleRunningSteps){
            if(!staleStep.runId) continue;
            const savedRun=await agentRunStore.get(staleStep.runId);
            if(savedRun?.status==="completed"){
              steps=steps.map(step=>step.id===staleStep.id?{...step,status:"completed",result:savedRun.result??step.result,context:[step.context??"",savedRun.result??""].filter(Boolean).join("\n\n").slice(-12000),updatedAt:new Date().toISOString()}:step);
              reconciled.add(staleStep.id);
            }else if(savedRun?.status==="waiting_approval" && savedRun.pendingApprovalId){
              await store.update(id,userId,{status:"waiting_approval",steps,activeRunId:savedRun.id,pendingApprovalId:savedRun.pendingApprovalId,result:savedRun.result,leaseUntil:undefined,leaseOwner:undefined});
              await store.addEvent({missionId:id,userId,type:"mission.recovered",message:"Recovered an approval-blocked agent run after execution restart.",stepId:staleStep.id,runId:savedRun.id});
              return Response.json({mission:await store.get(id,userId)});
            }
          }
          const interrupted=staleRunningSteps.filter(step=>!reconciled.has(step.id));
          if(interrupted.length){
            steps=steps.map(step=>interrupted.some(item=>item.id===step.id)?{...step,status:"pending",runId:undefined,retryCount:(step.retryCount??0)+1,nextRetryAt:undefined,updatedAt:new Date().toISOString()}:step);
          }
          await store.addEvent({missionId:id,userId,type:"mission.recovered",message:"Reconciled "+reconciled.size+" interrupted run(s); reset "+interrupted.length+" unfinished step(s).",metadata:{reconciledStepIds:[...reconciled],resetStepIds:interrupted.map(step=>step.id)}});
        }
        if(steps.length>0 && steps.every(step=>step.status==="completed")){
          const recoveredResult=steps[steps.length-1]?.result??mission.result;
          const completedMission=await store.update(id,userId,{status:"completed",progress:1,steps,activeRunId:mission.activeRunId,pendingApprovalId:undefined,result:recoveredResult,leaseUntil:undefined,leaseOwner:undefined});
          await store.addEvent({missionId:id,userId,type:"mission.completed",message:"Mission completed during recovery reconciliation."});
          return Response.json({mission:completedMission});
        }
        let lastRunId=mission.activeRunId;
        let lastApproval=mission.pendingApprovalId;
        let lastResult=mission.result;
        const profileMultiplier=mission.budgetProfile==="extended"?1.5:mission.budgetProfile==="intensive"?2:1;
        const maxSteps=Math.min(24,Math.max(1,Math.round((Number(process.env.FROSH_MISSION_MAX_STEPS??12)||12)*profileMultiplier)));
        const maxRetries=Math.max(0,Number(process.env.FROSH_MISSION_MAX_RETRIES??2)||2);
        const retryPollMs=Math.max(5000,Number(process.env.FROSH_MISSION_RETRY_POLL_MS??10000)||10000);
        const maxTools=Math.min(80,Math.max(1,Math.round((Number(process.env.FROSH_MISSION_MAX_TOOL_CALLS??40)||40)*profileMultiplier)));
        const maxDurationMs=Math.min(3600000,Math.max(60000,Math.round((Number(process.env.FROSH_MISSION_MAX_DURATION_MS??1800000)||1800000)*profileMultiplier)));
        const missionStartedAt=Date.now();
        let toolCount=0;
        const emit=async(type:"mission.created"|"mission.claimed"|"mission.step.started"|"mission.step.completed"|"mission.step.failed"|"mission.step.retry"|"mission.approval.required"|"mission.paused"|"mission.cancelled"|"mission.recovered"|"mission.completed"|"mission.failed"|"mission.tool.completed"|"mission.tool.failed"|"mission.budget.exceeded",message:string,stepId?:string,runId?:string,metadata?:Record<string,unknown>)=>{try{await store.addEvent({missionId:id,userId,type,message,stepId,runId,metadata});}catch(error){console.error("FROSH mission telemetry error:",error);}};
        await emit("mission.claimed","Mission execution started.");

        for(let cycle=0;cycle<8;cycle++){
          const renewed=await store.renewLease(id,userId,executionOwner);
          if(!renewed){
            return Response.json({error:"Mission execution lease was lost"},{status:409});
          }
          if(steps.length>maxSteps||Date.now()-missionStartedAt>maxDurationMs||toolCount>=maxTools){
            await emit("mission.budget.exceeded","Mission execution budget reached.");
            mission=await store.update(id,userId,{status:"paused",steps,progress:steps.length?steps.filter(item=>item.status==="completed").length/steps.length:0,activeRunId:lastRunId,pendingApprovalId:lastApproval,result:lastResult,leaseUntil:undefined,leaseOwner:undefined});
            return Response.json({mission,budgetExceeded:true});
          }
          const index=steps.findIndex(step=>step.status==="pending" && (!step.nextRetryAt || Date.parse(step.nextRetryAt)<=Date.now()));
          if(index<0)break;

          const now=new Date().toISOString();
          steps=steps.map((step,i)=>i===index?{...step,status:"running",updatedAt:now}:step);
          const step=steps[index];
          await store.update(id,userId,{status:"running",steps,activeRunId:lastRunId,pendingApprovalId:lastApproval,result:lastResult});
          await emit("mission.step.started","Started: "+step.title,step.id);
          const runStartedAt=Date.now();
          const run=await codingSessions.start({
            goal:step.title+"\nOverall objective: "+mission.goal,
            messages:[{role:"user",content:[step.title,"Overall objective: "+mission.goal,"Step context:",step.context??"No prior context stored for this step.","Previous mission findings:",steps.filter(item=>item.status==="completed").map(item=>"- "+item.title+": "+(item.result??"")).join("\n")||"None yet"].join("\n")}]
          });
          const runDurationMs=Date.now()-runStartedAt;
          toolCount+=run.toolCalls.length;
          for(const toolCall of run.toolCalls){
            await emit(toolCall.status==="failed"?"mission.tool.failed":"mission.tool.completed","Tool "+toolCall.name+" "+toolCall.status,step.id,run.id,{toolName:toolCall.name,status:toolCall.status,durationMs:toolCall.durationMs??runDurationMs});
          }
          if(toolCount>maxTools){
            await emit("mission.budget.exceeded","Mission tool-call budget was exceeded.",step.id,run.id,{toolCount,maxTools});
            mission=await store.update(id,userId,{status:"paused",steps,progress:steps.length?steps.filter(item=>item.status==="completed").length/steps.length:0,activeRunId:run.id,pendingApprovalId:undefined,result:run.result,leaseUntil:undefined,leaseOwner:undefined});
            return Response.json({mission,budgetExceeded:true});
          }
          const stepStatus=run.status==="waiting_approval"?"blocked":run.status==="completed"?"completed":run.status==="failed"?"failed":"running";
          steps=steps.map((item,i)=>i===index?{...item,status:stepStatus,runId:run.id,result:run.result,context:[item.context??"",run.result??""].filter(Boolean).join("\n\n").slice(-12000),updatedAt:new Date().toISOString()}:item);
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
              steps.push(createRecoveryStep(step.title,run.result));
              await emit("mission.recovered","Retry limit reached; added recovery work for: "+step.title,step.id,run.id);
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
              steps.push(createRecoveryStep(step.title,evaluation.reason));
            }else if(evaluation.nextStep?.trim()){
              const timestamp=new Date().toISOString();
              steps.push({id:crypto.randomUUID(),title:evaluation.nextStep.trim(),status:"pending",createdAt:timestamp,updatedAt:timestamp});
            }
          }

          const completed=steps.filter(item=>item.status==="completed").length;
          const progress=steps.length?completed/steps.length:0;

          if(run.status==="waiting_approval"){
            mission=await store.update(id,userId,{status:"waiting_approval",progress,steps,activeRunId:lastRunId,pendingApprovalId:lastApproval,result:lastResult,leaseUntil:undefined,leaseOwner:undefined});
            return Response.json({mission});
          }
          if(run.status==="failed"){
            mission=await store.update(id,userId,{status:"running",progress,steps,activeRunId:lastRunId,pendingApprovalId:undefined,result:lastResult,leaseUntil:undefined,leaseOwner:undefined});
            return Response.json({mission});
          }
          if(progress>=1){
            mission=await store.update(id,userId,{status:"completed",progress:1,steps,activeRunId:lastRunId,pendingApprovalId:undefined,result:lastResult,leaseUntil:undefined,leaseOwner:undefined});
            await emit("mission.completed","Mission completed.");
            return Response.json({mission});
          }
        }

        const completed=steps.filter(item=>item.status==="completed").length;
        mission=await store.update(id,userId,{status:"running",progress:steps.length?completed/steps.length:0,steps,activeRunId:lastRunId,pendingApprovalId:lastApproval,result:lastResult});
        return Response.json({mission});
      }catch(error){
        try{
          const current=await store.get(id,userId);
          if(current && current.status==="running" && current.leaseOwner===executionOwner){
            await store.update(id,userId,{leaseUntil:undefined,leaseOwner:undefined});
          }
        }catch{}
        return Response.json({error:error instanceof Error?error.message:"Mission execution failed"},{status:400});
      }
    }
    const missionRetryMatch=url.pathname.match(/^\/v1\/missions\/users\/([^/]+)\/([^/]+)\/steps\/([^/]+)\/retry$/);
    if(missionRetryMatch && request.method==="POST"){
      try{
        const userId=decodeURIComponent(missionRetryMatch[1]);
        const id=decodeURIComponent(missionRetryMatch[2]);
        const stepId=decodeURIComponent(missionRetryMatch[3]);
        const {getMissionStore}=await import("../../missions/src");
        const store=getMissionStore();
        const mission=await store.get(id,userId);
        if(!mission)return Response.json({error:"Mission not found"},{status:404});
        if(["completed","cancelled"].includes(mission.status))return Response.json({error:"Mission cannot be retried in its current state"},{status:409});
        const step=mission.steps.find(item=>item.id===stepId);
        if(!step)return Response.json({error:"Mission step not found"},{status:404});
        const steps=mission.steps.map(item=>item.id===stepId?{...item,status:"pending",runId:undefined,result:undefined,updatedAt:new Date().toISOString()}:item);
        const updated=await store.update(id,userId,{status:"running",steps,pendingApprovalId:undefined,leaseUntil:undefined,leaseOwner:undefined});
        await store.addEvent({missionId:id,userId,type:"mission.step.retry",message:"Retry requested: "+step.title,stepId});
        return Response.json({mission:updated});
      }catch(error){return Response.json({error:error instanceof Error?error.message:"Mission retry failed"},{status:400});}
    }

    const missionRecoveryMatch=url.pathname.match(/^\/v1\/missions\/users\/([^/]+)\/([^/]+)\/recover$/);
    if(missionRecoveryMatch && request.method==="POST"){
      try{
        const userId=decodeURIComponent(missionRecoveryMatch[1]);
        const id=decodeURIComponent(missionRecoveryMatch[2]);
        const {getMissionStore}=await import("../../missions/src");
        const mission=await getMissionStore().get(id,userId);
        if(!mission)return Response.json({error:"Mission not found"},{status:404});
        if(["completed","waiting_approval","paused","cancelled"].includes(mission.status))return Response.json({mission});
        if(mission.leaseUntil && Date.parse(mission.leaseUntil)>Date.now())return Response.json({mission});
        const next=await fetch(new URL("/v1/missions/users/"+encodeURIComponent(userId)+"/"+encodeURIComponent(id),request.url),{method:"POST",headers:request.headers});
        return next;
      }catch(error){return Response.json({error:error instanceof Error?error.message:"Mission recovery failed"},{status:400});}
    }

    const missionContinueMatch=url.pathname.match(/^\/v1\/missions\/users\/([^/]+)\/([^/]+)\/continue$/);
    if(missionContinueMatch && request.method==="POST"){
      try{
        const userId=decodeURIComponent(missionContinueMatch[1]);
        const id=decodeURIComponent(missionContinueMatch[2]);
        const {getMissionStore}=await import("../../missions/src");
        const mission=await getMissionStore().get(id,userId);
        if(!mission)return Response.json({error:"Mission not found"},{status:404});
        if(mission.status==="waiting_approval" && mission.pendingApprovalId){
          let run;
          try {
            run=await codingSessions.approveAndResume(mission.pendingApprovalId);
          } catch(error) {
            const failed=await getMissionStore().update(id,userId,{
              status:"failed",
              pendingApprovalId:undefined,
              leaseUntil:undefined,
              result:error instanceof Error?error.message:"Mission approval continuation failed"
            });
            await getMissionStore().addEvent({missionId:id,userId,type:"mission.failed",message:"Approval continuation failed: "+(error instanceof Error?error.message:"Unknown error")});
            return Response.json({mission:failed},{status:500});
          }
          const steps=mission.steps.map(step=>step.runId===run.id?{...step,status:run.status==="completed"?"completed":run.status==="failed"?"failed":"blocked",result:run.result,updatedAt:new Date().toISOString()}:step);
          const completed=steps.filter(step=>step.status==="completed").length;
          const progress=steps.length?completed/steps.length:0;
          const continuationStatus=run.status==="failed"
            ?"failed"
            :run.status==="waiting_approval"
              ?"waiting_approval"
              :progress===1
                ?"completed"
                :"running";
          const updated=await getMissionStore().update(id,userId,{
            status:continuationStatus,
            progress,
            steps,
            pendingApprovalId:run.pendingApprovalId,
            activeRunId:run.id,
            result:run.result,
            leaseUntil:undefined,
            leaseOwner:undefined
          });
          if(updated.status==="waiting_approval"){
            await getMissionStore().addEvent({missionId:id,userId,type:"mission.approval.required",message:"Another approval is required to continue the mission.",runId:run.id});
            return Response.json({mission:updated,run});
          }
          if(updated.status==="running"){
            return fetch(new URL("/v1/missions/users/"+encodeURIComponent(userId)+"/"+encodeURIComponent(id),request.url),{method:"POST",headers:request.headers});
          }
          return Response.json({mission:updated,run});
        }
        const response=await fetch(new URL("/v1/missions/users/"+encodeURIComponent(userId)+"/"+encodeURIComponent(id),request.url),{method:"POST",headers:request.headers});
        return response;
      }catch(error){return Response.json({error:error instanceof Error?error.message:"Mission continuation failed"},{status:400});}
    }

    if (request.method === "POST" && url.pathname === "/v1/agent-runs") {
      try {
        const body = await request.json();
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
        const message = error instanceof Error ? error.message : "Agent run failed";
        return Response.json({ error: message }, { status: 500 });
      }
    }

    const runMatch = url.pathname.match(/^\/v1\/agent-runs\/([^/]+)$/);
    if (runMatch && request.method === "GET") {
      const run = await agentRunStore.get(runMatch[1]);
      return run
        ? Response.json(run)
        : Response.json({ error: "Agent run not found" }, { status: 404 });
    }

    const approvalMatch = url.pathname.match(/^\/v1\/approvals\/([^/]+)$/);
    if (approvalMatch && request.method === "GET") {
      const approval = await approvalStore.get(approvalMatch[1]);
      return approval
        ? Response.json(approval)
        : Response.json({ error: "Approval not found" }, { status: 404 });
    }

    if (approvalMatch && request.method === "POST") {
      try {
        const body = await request.json();
        if (body?.status !== "approved" && body?.status !== "rejected") {
          return Response.json(
            { error: "status must be approved or rejected" },
            { status: 400 },
          );
        }

        const approval = await approvalStore.get(approvalMatch[1]);
        if (!approval) {
          return Response.json({ error: "Approval not found" }, { status: 404 });
        }

        const run =
          body.status === "approved"
            ? await codingSessions.approveAndResume(approvalMatch[1])
            : await codingSessions.reject(approvalMatch[1]);

        return Response.json({ approvalId: approvalMatch[1], run });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Approval failed";
        return Response.json({ error: message }, { status: 400 });
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`FROSH API listening on http://localhost:${server.port}`);
