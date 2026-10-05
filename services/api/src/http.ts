import { postChat } from "./routes";
import { approvalStore } from "../../tools/src";
import { CodingSessionManager, agentRunStore } from "../../ai/src";
import { OpenAIProvider } from "../../ai/src/openai-provider";
import { authenticateDevice, issueDeviceCredential, listDevices, registerDevice, getDevice } from "./devices";
import { addRealtimeClient, realtimeClientCount } from "./realtime";

const codingSessions = new CodingSessionManager(new OpenAIProvider());
const port = Number(process.env.PORT ?? 3001);

const server = Bun.serve({
  port,
  websocket: {
    open(ws) {
      addRealtimeClient(ws);
      ws.send(JSON.stringify({ type: "connected", timestamp: new Date().toISOString() }));
    },
    message(ws, message) {
      try {
        const parsed = JSON.parse(String(message));
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
    const publicPath =
      url.pathname === "/health" ||
      (request.method === "POST" && url.pathname === "/v1/devices");
    if (!publicPath && (!deviceId || !deviceToken || !authenticateDevice(deviceId, deviceToken))) {
      return Response.json({ error: "FROSH device authentication required" }, { status: 401 });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "frosh-api", realtimeClients: realtimeClientCount() });
    }

    if (request.method === "GET" && url.pathname === "/v1/realtime") {
      if (server.upgrade(request, { data: {} })) return undefined;
      return new Response("WebSocket upgrade required", { status: 426 });
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
