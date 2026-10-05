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
