import { postChat } from "./routes";
import { approvalStore } from "../../tools/src";
import { CodingSessionManager, agentRunStore } from "../../ai/src";
import { OpenAIProvider } from "../../ai/src/openai-provider";

const codingSessions = new CodingSessionManager(new OpenAIProvider());
const port = Number(process.env.PORT ?? 3001);

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "frosh-api" });
    }

    if (request.method === "POST" && url.pathname === "/v1/chat") {
      try {
        const body = await request.json();
        return Response.json(await postChat(body));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Request failed";
        return Response.json({ error: message }, { status: message === "message is required" ? 400 : 500 });
      }
    }

    const runMatch = url.pathname.match(/^\/v1\/agent-runs\/([^/]+)$/);
    if (runMatch && request.method === "GET") {
      const run = await agentRunStore.get(runMatch[1]);
      return run ? Response.json(run) : Response.json({ error: "Agent run not found" }, { status: 404 });
    }

    const approvalMatch = url.pathname.match(/^\/v1\/approvals\/([^/]+)$/);
    if (approvalMatch && request.method === "GET") {
      const approval = await approvalStore.get(approvalMatch[1]);
      return approval ? Response.json(approval) : Response.json({ error: "Approval not found" }, { status: 404 });
    }

    if (approvalMatch && request.method === "POST") {
      try {
        const body = await request.json();
        if (body?.status !== "approved" && body?.status !== "rejected") {
          return Response.json({ error: "status must be approved or rejected" }, { status: 400 });
        }

        const approval = await approvalStore.get(approvalMatch[1]);
        if (!approval) return Response.json({ error: "Approval not found" }, { status: 404 });

        const result = body.status === "approved"
          ? await codingSessions.approveAndResume(approvalMatch[1], [])
          : await codingSessions.reject(approvalMatch[1]);

        return Response.json({ approvalId: approvalMatch[1], run: result });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Approval failed";
        return Response.json({ error: message }, { status: 400 });
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`FROSH API listening on http://localhost:${server.port}`);
