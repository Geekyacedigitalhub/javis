import type { FroshAgentRun } from "./agent-run";
import type { FroshApprovalRequest } from "./approval";
import type { FroshDevice } from "./device";

export type FroshEvent =
  | { type: "connected"; timestamp: string }
  | { type: "run.updated"; run: FroshAgentRun }
  | { type: "approval.created"; approval: FroshApprovalRequest }
  | { type: "device.updated"; device: FroshDevice }
  | { type: "error"; message: string };

export type FroshDeviceCommand =
  | { type: "device.command"; requestId: string; deviceId: string; command: "open_app"; appName: string }
  | { type: "device.command.result"; requestId: string; deviceId: string; accepted: boolean; message: string };
