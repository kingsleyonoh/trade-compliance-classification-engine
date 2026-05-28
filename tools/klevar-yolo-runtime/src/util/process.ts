import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

export interface ExecResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CommandInvocation {
  file: string;
  args: string[];
  shell: boolean;
  display: string;
}

interface ExecOptions {
  timeoutMs?: number;
  heartbeatMs?: number;
  onHeartbeat?: () => void;
}

export function execCommand(command: string, cwd: string, timeoutMsOrOptions: number | ExecOptions = 600000): Promise<ExecResult> {
  const options = typeof timeoutMsOrOptions === "number" ? { timeoutMs: timeoutMsOrOptions } : timeoutMsOrOptions;
  const timeoutMs = options.timeoutMs ?? 600000;
  const invocation = buildCommandInvocation(command, cwd);
  return new Promise((resolve) => {
    const child = spawn(invocation.file, invocation.args, { cwd, shell: invocation.shell, stdio: ["ignore", "pipe", "pipe"], detached: platform() !== "win32" });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (exitCode: number, extraStderr = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      resolve({ command: invocation.display, exitCode, stdout, stderr: `${stderr}${extraStderr}` });
    };
    const heartbeat = options.onHeartbeat ? setInterval(() => options.onHeartbeat?.(), options.heartbeatMs ?? 60_000) : null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      killProcessTree(child.pid);
      finish(124, `\nCOMMAND_TIMEOUT_AFTER_MS:${timeoutMs}`);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (error) => finish(1, `\n${error.message}`));
    child.on("close", (code) => finish(timedOut ? 124 : code ?? 1, timedOut ? `\nCOMMAND_TIMEOUT_AFTER_MS:${timeoutMs}` : ""));
  });
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (platform() === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

export function buildCommandInvocation(command: string, cwd: string, os: NodeJS.Platform = platform()): CommandInvocation {
  if (os === "win32") {
    const bash = findBash();
    if (bash) return { file: bash, args: ["-lc", command], shell: false, display: `bash -lc ${JSON.stringify(command)}` };
    const normalized = normalizeCommand(command, cwd, os);
    return { file: normalized.command, args: [], shell: true, display: normalized.display };
  }
  return { file: command, args: [], shell: true, display: command };
}

export function normalizeCommand(command: string, cwd: string, os: NodeJS.Platform = platform()): { command: string; display: string } {
  if (os !== "win32") return { command, display: command };
  const normalized = command.replace(/(^|&&|\|\||;|&)(\s*)(?:\.\/)?([^\s\/\\&|;]+)(?=\s|$)/g, (match, operator: string, spacing: string, executable: string) => {
    if (/\.(bat|cmd|ps1|exe)$/i.test(executable)) return match;
    const companion = findWindowsCompanion(cwd, executable);
    return companion ? `${operator}${spacing}${companion}` : match;
  });
  return { command: normalized, display: normalized };
}

export function findBash(): string | null {
  const envPath = process.env.KLEVAR_BASH_PATH;
  if (envPath === "none") return null;
  if (envPath && existsSync(envPath)) return envPath;

  const candidates = [
    "C:/Program Files/Git/usr/bin/bash.exe",
    "C:/Program Files/Git/bin/bash.exe",
    "C:/Windows/System32/bash.exe"
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  const where = spawnSync("where.exe", ["bash"], { encoding: "utf8", shell: false });
  const first = where.stdout?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return first && existsSync(first) ? first : null;
}

function findWindowsCompanion(cwd: string, executable: string): string | null {
  for (const extension of [".bat", ".cmd", ".exe"]) {
    const candidate = `${executable}${extension}`;
    if (existsSync(join(cwd, candidate))) return candidate;
  }
  return null;
}
