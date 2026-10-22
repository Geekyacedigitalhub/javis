import os from "node:os";
import path from "node:path";
import { DeviceAgent } from "./agent";

/**
 * Entry point. Configuration comes from the environment so the same binary runs
 * as a Windows service, a scheduled task, or a foreground process while you are
 * watching it.
 *
 *   FROSH_API_URL                  default http://127.0.0.1:3001
 *   FROSH_DEVICE_ENROLLMENT_TOKEN  required the first time only
 *   FROSH_DEVICE_NAME              default the hostname
 *   FROSH_AGENT_STATE              default ~/.frosh/agent.json
 *   FROSH_AGENT_WORKDIR            default the user's home directory
 *   FROSH_AGENT_CAPABILITIES       default "device.info,shell.execute"
 */

async function main() {
  const apiUrl = (process.env.FROSH_API_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
  const name = process.env.FROSH_DEVICE_NAME?.trim() || os.hostname();
  const workdir = process.env.FROSH_AGENT_WORKDIR?.trim() || os.homedir();
  const statePath = process.env.FROSH_AGENT_STATE?.trim() || path.join(os.homedir(), ".frosh", "agent.json");
  const capabilities = (process.env.FROSH_AGENT_CAPABILITIES?.split(",") ?? [])
    .map((item) => item.trim())
    .filter(Boolean);

  const agent = new DeviceAgent({
    apiUrl,
    name,
    workdir,
    statePath,
    enrollmentToken: process.env.FROSH_DEVICE_ENROLLMENT_TOKEN?.trim() || undefined,
    ...(capabilities.length > 0 ? { capabilities } : {}),
  });

  const shutdown = async (signal: string) => {
    console.log(`[frosh-agent] ${signal} received, disconnecting`);
    await agent.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    const state = await agent.start();
    console.log(`[frosh-agent] ready as ${state.deviceId} (${name}) at ${apiUrl}`);
  } catch (error) {
    console.error(`[frosh-agent] could not start: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

void main();
