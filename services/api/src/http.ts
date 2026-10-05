import { postChat } from "./routes";

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

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`FROSH API listening on http://localhost:${server.port}`);
