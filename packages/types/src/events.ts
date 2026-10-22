import type { FroshAgentRun } from "./agent-run";
import type { FroshApprovalRequest } from "./approval";
import type { FroshDevice } from "./device";

export type FroshEvent =
  | { type: "connected"; timestamp: string }
  | { type: "run.updated"; run: FroshAgentRun }
  | { type: "approval.created"; approval: FroshApprovalRequest }
  | { type: "device.updated"; device: FroshDevice }
  | { type: "error"; message: string };

export type FroshDeviceCommandName =
  | "open_app"
  | "media_control"
  | "media_state"
  | "contacts_search"
  | "open_dialer"
  | "call_number"
  | "message_inbox"
  | "message_reply"
  | "send_message"
  | "device_info"
  | "run_command";

export type FroshDeviceCommand =
  | { type: "device.command"; requestId: string; deviceId: string; command: "open_app"; appName: string }
  | { type: "device.command"; requestId: string; deviceId: string; command: "media_control"; action: string }
  | { type: "device.command"; requestId: string; deviceId: string; command: "media_state" }
  | { type: "device.command"; requestId: string; deviceId: string; command: "contacts_search"; query: string }
  | { type: "device.command"; requestId: string; deviceId: string; command: "open_dialer" | "call_number"; phoneNumber?: string }
  | { type: "device.command"; requestId: string; deviceId: string; command: "message_inbox" }
  | { type: "device.command"; requestId: string; deviceId: string; command: "message_reply"; notificationId: string; message: string }
  | { type: "device.command"; requestId: string; deviceId: string; command: "send_message"; provider: string; recipient: string; message: string }
  | { type: "device.command"; requestId: string; deviceId: string; command: "device_info" }
  | { type: "device.command"; requestId: string; deviceId: string; command: "run_command"; commandLine: string; cwd?: string; timeoutMs?: number }
  | { type: "device.command.result"; requestId: string; deviceId: string; command: FroshDeviceCommandName; accepted: boolean; message: string; data?: unknown };
