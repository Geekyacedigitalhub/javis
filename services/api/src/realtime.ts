type Client = {
  id: string;
  socket: WebSocket;
};

const clients = new Map<string, Client>();

export function addRealtimeClient(socket: WebSocket) {
  const id = crypto.randomUUID();
  clients.set(id, { id, socket });

  socket.addEventListener("close", () => clients.delete(id));

  return id;
}

export function removeRealtimeClient(id: string) {
  clients.delete(id);
}

export function broadcast(event: unknown) {
  const payload = JSON.stringify(event);
  for (const client of clients.values()) {
    if (client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(payload);
    }
  }
}

export function realtimeClientCount() {
  return clients.size;
}
