import path from "node:path";
import { stat } from "node:fs/promises";
import type { FroshDeviceCommand } from "../../../packages/types/src/events";
import { describeMachine, resolveShell, runShellCommand, type ShellResult } from "./platform";

/**
 * Command handlers. They are plain functions over a context object so the whole
 * surface can be exercised without a socket, a server, or a Windows machine.
 */

export const AGENT_VERSION = "0.1.0";

/**
 * The server waits 15 seconds for a device to acknowledge a command. Anything
 * slower must not be acked as if it finished, so the ceiling is deliberately
 * under that window. Long-running desktop work needs an asynchronous result
 * channel, which this protocol does not have yet.
 */
export const MAX_COMMAND_TIMEOUT_MS = 14_000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

export interface CommandResult {
  accepted: boolean;
  message: string;
  data?: unknown;
}

export interface AgentContext {
  agentVersion: string;
  startedAt: number;
  workdir: string;
  machine?: ReturnType<typeof describeMachine>;
  run?: (commandLine: string, options: { cwd: string; timeoutMs: number; shell?: { file: string; args: string[] } }) => Promise<ShellResult>;
}

export function createDefaultContext(workdir: string): AgentContext {
  return {
    agentVersion: AGENT_VERSION,
    startedAt: Date.now(),
    workdir: path.resolve(workdir),
  };
}

export function handleDeviceInfo(context: AgentContext): CommandResult {
  const machine = context.machine ?? describeMachine();
  const shell = resolveShell(machine.platform);

  return {
    accepted: true,
    message: `FROSH agent ${context.agentVersion} running on ${machine.hostname}`,
    data: {
      agentVersion: context.agentVersion,
      pid: process.pid,
      uptimeSeconds: Math.floor((Date.now() - context.startedAt) / 1000),
      hostname: machine.hostname,
      platform: machine.platform,
      release: machine.release,
      arch: machine.arch,
      cpuCount: machine.cpuCount,
      totalMemoryBytes: machine.totalMemoryBytes,
      homeDirectory: machine.homeDirectory,
      workdir: context.workdir,
      shell: [shell.file, ...shell.args].join(" "),
    },
  };
}

function clampTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_COMMAND_TIMEOUT_MS;
  return Math.min(MAX_COMMAND_TIMEOUT_MS, Math.max(1_000, Math.floor(value)));
}

export async function handleRunCommand(
  input: { commandLine: unknown; cwd?: unknown; timeoutMs?: unknown },
  context: AgentContext,
): Promise<CommandResult> {
  const commandLine = typeof input.commandLine === "string" ? input.commandLine.trim() : "";
  if (!commandLine) return { accepted: false, message: "commandLine is required." };
  if (commandLine.length > 4000) return { accepted: false, message: "commandLine must be under 4000 characters." };

  const cwd = path.resolve(context.workdir, typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : ".");
  try {
    const info = await stat(cwd);
    if (!info.isDirectory()) return { accepted: false, message: `Working directory is not a directory: ${cwd}` };
  } catch {
    return { accepted: false, message: `Working directory does not exist: ${cwd}` };
  }

  const timeoutMs = clampTimeout(input.timeoutMs);
  const run = context.run ?? runShellCommand;
  const result = await run(commandLine, { cwd, timeoutMs });

  if (result.timedOut) {
    // The process was killed mid-flight, so the real-world effect is unknown.
    // Saying "failed" would be a guess; the caller is told not to retry blindly.
    return {
      accepted: false,
      message: `Command exceeded ${timeoutMs}ms and was terminated. Its outcome is unknown; do not automatically retry it.`,
      data: {
        outcome: "unknown",
        retryable: false,
        reason: "command_timeout",
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
      },
    };
  }

  return {
    accepted: true,
    message: `Command exited with code ${result.exitCode} in ${result.durationMs}ms`,
    data: {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      cwd,
    },
  };
}

export async function executeDeviceCommand(
  message: Extract<FroshDeviceCommand, { type: "device.command" }>,
  context: AgentContext,
): Promise<CommandResult> {
  switch (message.command) {
    case "device_info":
      return handleDeviceInfo(context);
    case "run_command":
      return handleRunCommand(
        { commandLine: message.commandLine, cwd: message.cwd, timeoutMs: message.timeoutMs },
        context,
      );
    default:
      return {
        accepted: false,
        message: `This device does not implement ${String((message as { command?: unknown }).command ?? "that command")}.`,
      };
  }
}
