import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";

export interface RuntimeLock {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  scope: string;
  batch?: number;
}

export function acquireRuntimeLock(cwd: string, scope: string, staleMs = 10 * 60_000): { ok: true; lock: RuntimeLock } | { ok: false; reason: string } {
  const existing = readRuntimeLock(cwd);
  if (existing?.pid === process.pid) {
    const lock = { ...existing, heartbeatAt: new Date().toISOString(), scope };
    writeRuntimeLock(cwd, lock);
    return { ok: true, lock };
  }
  if (existing && processAlive(existing.pid) && Date.now() - Date.parse(existing.heartbeatAt) < staleMs) return { ok: false, reason: `active runtime pid ${existing.pid} (${existing.scope})` };
  if (existing && processAlive(existing.pid)) stopProcessTree(existing.pid);
  if (existing) clearRuntimeLock(cwd);
  const lock = { pid: process.pid, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), scope };
  writeRuntimeLock(cwd, lock);
  return { ok: true, lock };
}

export function heartbeatRuntimeLock(cwd: string): void {
  const lock = readRuntimeLock(cwd);
  if (!lock || lock.pid !== process.pid) return;
  writeRuntimeLock(cwd, { ...lock, heartbeatAt: new Date().toISOString() });
}

export function releaseRuntimeLock(cwd: string): void {
  const lock = readRuntimeLock(cwd);
  if (!lock || lock.pid === process.pid) clearRuntimeLock(cwd);
}

function readRuntimeLock(cwd: string): RuntimeLock | null {
  try { return JSON.parse(readFileSync(lockPath(cwd), "utf8")) as RuntimeLock; } catch { return null; }
}

function writeRuntimeLock(cwd: string, lock: RuntimeLock): void {
  mkdirSync(join(cwd, ".yolo"), { recursive: true });
  writeFileSync(lockPath(cwd), JSON.stringify(lock, null, 2) + "\n");
}

function clearRuntimeLock(cwd: string): void {
  rmSync(lockPath(cwd), { force: true });
}

function lockPath(cwd: string): string {
  return join(cwd, ".yolo/runtime-lock.json");
}

function stopProcessTree(pid: number): void {
  try {
    if (platform() === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "pipe" });
    else process.kill(pid, "SIGTERM");
  } catch {
    // Stale process cleanup is best effort; the lock will be rewritten only after this returns.
  }
}

function processAlive(pid: number): boolean {
  if (platform() === "win32") return spawnSync("tasklist.exe", ["/FI", `PID eq ${pid}`], { encoding: "utf8" }).stdout.includes(String(pid));
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function runtimeLockSourceMarker(): string {
  return "runtime-lock";
}
