import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FroshDeviceCommand } from "../../../packages/types/src/events";
import { AGENT_VERSION, createDefaultContext, executeDeviceCommand, type AgentContext } from "./commands";

/**
 * The device half of FROSH's device protocol.
 *
 * The server already knew how to authenticate a device, dispatch a command,
 * and record the result durably in a ledger. What was missing was anything that
 * actually lived on the machine and answered. This is that process: it enrolls
 * once, keeps a websocket open, executes what it is asked to, and reports what
 * really happened.
 *
 * Everything the agent needs from the outside world is injectable — fetch, the
 * websocket constructor, the clock, the logger — so its behaviour can be tested
 * without a server and without waiting for real backoff delays.
 */

const DEFAULT_CAPABILITIES = ["device.info", "shell.execute"];

export type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
};

export interface DeviceAgentOptions {
  apiUrl: string;
  name: string;
  capabilities?: string[];
  enrollmentToken?: string;
  statePath?: string;
  workdir?: string;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: string) => SocketLike;
  context?: AgentContext;
  reconnect?: { minMs?: number; maxMs?: number };
  heartbeatMs?: number;
}

export interface DeviceAgentState {
  deviceId: string;
  token: string;
  expiresAt: string;
  apiUrl: string;
  name: string;
}

export class DeviceAgent {
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketFactory: (url: string) => SocketLike;
  private readonly log: (line: string) => void;
  private readonly context: AgentContext;
  private readonly reconnectOptions: { minMs: number; maxMs: number };
  private readonly heartbeatMs: number;

  private socket: SocketLike | null = null;
  private state: DeviceAgentState | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private authenticated: ((value: DeviceAgentState) => void) | null = null;
  private authFailed: ((error: Error) => void) | null = null;

  constructor(private readonly options: DeviceAgentOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webSocketFactory =
      options.webSocketFactory ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.log = options.log ?? ((line) => console.log(line));
    this.context = options.context ?? createDefaultContext(options.workdir ?? process.cwd());
    this.reconnectOptions = {
      minMs: options.reconnect?.minMs ?? 500,
      maxMs: options.reconnect?.maxMs ?? 30_000,
    };
    this.heartbeatMs = options.heartbeatMs ?? 25_000;
  }

  get device(): DeviceAgentState | null {
    return this.state;
  }

  /** Enroll (or reuse a saved credential) and hold an authenticated socket. */
  async start(): Promise<DeviceAgentState> {
    this.stopping = false;
    this.state = await this.loadOrEnroll();
    const state = await this.connect();
    return state;
  }

  async stop() {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* already closed */
      }
      this.socket = null;
    }
  }

  /** Delay before the next attempt, doubling up to the ceiling. */
  nextReconnectDelay(attempt = this.reconnectAttempts): number {
    const { minMs, maxMs } = this.reconnectOptions;
    return Math.min(maxMs, minMs * 2 ** Math.max(0, attempt - 1));
  }

  private async loadOrEnroll(): Promise<DeviceAgentState> {
    const saved = await this.loadState();
    if (saved && saved.apiUrl === this.options.apiUrl && saved.name === this.options.name) {
      this.log(`[frosh-agent] reusing enrollment ${saved.deviceId}`);
      return saved;
    }
    return this.enroll();
  }

  private async loadState(): Promise<DeviceAgentState | null> {
    if (!this.options.statePath) return null;
    try {
      const raw = await readFile(this.options.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<DeviceAgentState>;
      if (
        typeof parsed.deviceId === "string" &&
        typeof parsed.token === "string" &&
        typeof parsed.expiresAt === "string" &&
        typeof parsed.apiUrl === "string" &&
        typeof parsed.name === "string"
      ) {
        return parsed as DeviceAgentState;
      }
    } catch {
      /* no saved credential, which is the normal first run */
    }
    return null;
  }

  private async saveState(state: DeviceAgentState) {
    if (!this.options.statePath) return;
    await mkdir(path.dirname(this.options.statePath), { recursive: true });
    await writeFile(this.options.statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }

  private async enroll(): Promise<DeviceAgentState> {
    if (!this.options.enrollmentToken) {
      throw new Error("FROSH_DEVICE_ENROLLMENT_TOKEN is required to enroll a new device");
    }

    const response = await this.fetchImpl(new URL("/v1/devices", this.options.apiUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-frosh-device-enrollment-token": this.options.enrollmentToken,
      },
      body: JSON.stringify({
        name: this.options.name,
        platform: "windows",
        capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES,
      }),
    });

    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      device?: { id?: string };
      credential?: { deviceId?: string; token?: string; expiresAt?: string };
    };

    if (!response.ok || !body.credential?.deviceId || !body.credential.token) {
      throw new Error(body.error ?? `Device enrollment failed with status ${response.status}`);
    }

    const state: DeviceAgentState = {
      deviceId: body.credential.deviceId,
      token: body.credential.token,
      expiresAt: body.credential.expiresAt ?? new Date(Date.now() + 30 * 24 * 3600_000).toISOString(),
      apiUrl: this.options.apiUrl,
      name: this.options.name,
    };
    await this.saveState(state);
    this.log(`[frosh-agent] enrolled as ${state.deviceId}`);
    return state;
  }

  private connect(): Promise<DeviceAgentState> {
    const state = this.state;
    if (!state) return Promise.reject(new Error("Device is not enrolled"));

    return new Promise<DeviceAgentState>((resolve, reject) => {
      const socketUrl = new URL("/v1/realtime", this.options.apiUrl);
      socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";

      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        this.authenticated = null;
        this.authFailed = null;
        if (error) reject(error);
        else resolve(state);
      };

      this.authenticated = () => settle();
      this.authFailed = (error) => settle(error);

      let socket: SocketLike;
      try {
        socket = this.webSocketFactory(socketUrl.toString());
      } catch (error) {
        settle(error instanceof Error ? error : new Error("WebSocket could not be opened"));
        return;
      }
      this.socket = socket;

      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "auth", deviceId: state.deviceId, token: state.token }));
      });

      // A socket can close before it ever opens; both paths must end the wait.
      socket.addEventListener("close", () => {
        if (this.socket === socket) this.socket = null;
        this.stopHeartbeat();
        if (!settled) settle(new Error("Realtime socket closed before authentication completed"));
        if (!this.stopping) this.scheduleReconnect();
      });

      socket.addEventListener("message", (event) => {
        void this.handleMessage(event.data);
      });
    });
  }

  private async handleMessage(raw: unknown) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }

    if (parsed.type === "connected") {
      if (parsed.authenticated === true) {
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        this.log(`[frosh-agent] connected as ${this.state?.deviceId}`);
        this.authenticated?.(this.state as DeviceAgentState);
      }
      return;
    }

    if (parsed.type === "error") {
      const message = typeof parsed.message === "string" ? parsed.message : "Realtime error";
      this.log(`[frosh-agent] ${message}`);
      this.authFailed?.(new Error(message));
      return;
    }

    if (parsed.type === "device.command") {
      await this.handleCommand(parsed as Extract<FroshDeviceCommand, { type: "device.command" }>);
    }
  }

  private async handleCommand(message: Extract<FroshDeviceCommand, { type: "device.command" }>) {
    if (message.deviceId !== this.state?.deviceId) return;

    let result;
    try {
      result = await executeDeviceCommand(message, this.context);
    } catch (error) {
      result = {
        accepted: false,
        message: error instanceof Error ? error.message : "Command failed on the device",
      };
    }

    this.log(`[frosh-agent] ${message.command}: ${result.accepted ? "ok" : "refused"} — ${result.message}`);
    try {
      this.socket?.send(
        JSON.stringify({
          type: "device.command.result",
          requestId: message.requestId,
          deviceId: message.deviceId,
          command: message.command,
          accepted: result.accepted,
          message: result.message,
          ...(result.data === undefined ? {} : { data: result.data }),
        }),
      );
    } catch {
      /* the socket is gone; the server will mark the outcome unknown itself */
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    if (this.heartbeatMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      try {
        this.socket?.send(JSON.stringify({ type: "ping" }));
      } catch {
        /* the close handler will take over */
      }
    }, this.heartbeatMs);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.stopping || this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const delay = this.nextReconnectDelay();
    this.log(`[frosh-agent] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopping) return;
      void (async () => {
        try {
          await this.connect();
        } catch (error) {
          this.log(`[frosh-agent] reconnect failed: ${error instanceof Error ? error.message : String(error)}`);
          this.scheduleReconnect();
        }
      })();
    }, delay);
  }
}
