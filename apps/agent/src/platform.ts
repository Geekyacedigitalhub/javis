import { spawn } from "node:child_process";
import os from "node:os";

/**
 * The only file in the agent that knows which operating system it is running
 * on. Everything above it talks in plain data, so the command handlers can be
 * tested without a Windows machine and the Windows behaviour is decided in one
 * place.
 */

export interface MachineInfo {
  hostname: string;
  platform: NodeJS.Platform;
  release: string;
  arch: string;
  cpuCount: number;
  totalMemoryBytes: number;
  homeDirectory: string;
}

export function describeMachine(): MachineInfo {
  return {
    hostname: os.hostname(),
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    homeDirectory: os.homedir(),
  };
}

/** How to hand a command line to a shell on this platform. */
export function resolveShell(platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform === "win32") return { file: "cmd.exe", args: ["/d", "/s", "/c"] };
  return { file: "/bin/sh", args: ["-c"] };
}

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

const MAX_CAPTURED_OUTPUT = 100_000;

export function runShellCommand(
  commandLine: string,
  options: { cwd: string; timeoutMs: number; shell?: { file: string; args: string[] } },
): Promise<ShellResult> {
  const shell = options.shell ?? resolveShell();
  const startedAt = Date.now();

  return new Promise<ShellResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(shell.file, [...shell.args, commandLine], {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: stdout.slice(0, MAX_CAPTURED_OUTPUT),
        stderr: stderr.slice(0, MAX_CAPTURED_OUTPUT),
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      // The command was interrupted, so whatever it was doing may or may not
      // have happened. The caller is told that, rather than being told it failed.
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish(-1);
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk) => {
      if (stdout.length < MAX_CAPTURED_OUTPUT) stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < MAX_CAPTURED_OUTPUT) stderr += String(chunk);
    });
    child.on("error", (error) => {
      stderr += error instanceof Error ? error.message : String(error);
      finish(-1);
    });
    child.on("close", (code) => finish(code ?? -1));
  });
}
