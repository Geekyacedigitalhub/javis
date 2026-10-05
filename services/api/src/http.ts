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
startAutomationRunner();

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
        const mission=await getMissionStore().create({userId,goal,status:"planning",progress:0,steps:[]});
        return Response.json({mission},{status:201});
      } catch(error){return Response.json({error:error instanceof Error?error.message:"Mission creation failed"},{status:400});}
    }

    const missionMatch=url.pathname.match(/^\/v1\/missions\/users\/([^/]+)\/([^/]+)$/);
    if(missionMatch && request.method==="GET"){
      const {getMissionStore}=await import("../../missions/src");
      const mission=await getMissionStore().get(decodeURIComponent(missionMatch[2]),decodeURIComponent(missionMatch[1]));
      return mission?Response.json({mission}):Response.json({error:"Mission not found"},{status:404});
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
        const {getMissionStore, planMission}=await import("../../missions/src");
        const mission=await getMissionStore().get(id,userId);
        if(!mission)return Response.json({error:"Mission not found"},{status:404});
        if(mission.status==="completed")return Response.json({mission});

        let steps=mission.steps.length?mission.steps:planMission(mission.goal);
        const index=steps.findIndex(step=>step.status==="pending");
        if(index<0){
          const done=await getMissionStore().update(id,userId,{status:"completed",progress:1,steps,result:"All planned mission steps completed."});
          return Response.json({mission:done});
        }

        const now=new Date().toISOString();
        steps=steps.map((step,i)=>i===index?{...step,status:"running",updatedAt:now}:step);
        const step=steps[index];
        const run=await codingSessions.start({
          goal:step.title+"\nOverall objective: "+mission.goal,
          messages:[{role:"user",content:step.title+"\nOverall objective: "+mission.goal}]
        });
        const stepStatus=run.status==="waiting_approval"?"blocked":run.status==="completed"?"completed":run.status==="failed"?"failed":"running";
        steps=steps.map((item,i)=>i===index?{...item,status:stepStatus,runId:run.id,result:run.result,updatedAt:new Date().toISOString()}:item);
        const completed=steps.filter(item=>item.status==="completed").length;
        const progress=steps.length?completed/steps.length:0;
        const status=run.status==="waiting_approval"?"waiting_approval":run.status==="failed"?"failed":progress===1?"completed":"running";
        const updated=await getMissionStore().update(id,userId,{status,progress,steps,activeRunId:run.id,pendingApprovalId:run.pendingApprovalId,result:run.result});
        return Response.json({mission:updated});
      }catch(error){return Response.json({error:error instanceof Error?error.message:"Mission execution failed"},{status:400});}
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
          const run=await codingSessions.approveAndResume(mission.pendingApprovalId);
          const steps=mission.steps.map(step=>step.runId===run.id?{...step,status:run.status==="completed"?"completed":run.status==="failed"?"failed":"blocked",result:run.result,updatedAt:new Date().toISOString()}:step);
          const completed=steps.filter(step=>step.status==="completed").length;
          const progress=steps.length?completed/steps.length:0;
          const updated=await getMissionStore().update(id,userId,{
            status:run.status==="failed"?"failed":progress===1?"completed":"running",
            progress,
            steps,
            pendingApprovalId:run.pendingApprovalId,
            activeRunId:run.id,
            result:run.result
          });
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
