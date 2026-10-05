import { postChat } from "./routes";
import { approvalStore, resolveApproval } from "../../tools/src";

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
        const result = await postChat(body);
        return Response.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Request failed";
        const status = message === "message is required" ? 400 : 500;
        return Response.json({ error: message }, { status });
      }
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
        const status = body?.status;
        if (status !== "approved" && status !== "rejected") {
          return Response.json({ error: "status must be approved or rejected" }, { status: 400 });
        }
        const result = await resolveApproval(approvalMatch[1], status);
        return Response.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Approval failed";
        return Response.json({ error: message }, { status: 400 });
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`FROSH API listening on http://localhost:${server.port}`);
