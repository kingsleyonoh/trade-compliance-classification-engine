import type { BatchResult, GateResult, TestEvidence } from "../types.js";
import { markCommand } from "../telemetry.js";
import { execCommand } from "../util/process.js";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export async function validateCommandEvidence(cwd: string, result: BatchResult, telemetryCwd = cwd): Promise<GateResult> {
  const flags: string[] = [];
  const rerunTargets: Array<[string, TestEvidence | undefined]> = [
    ["green", result.tests?.green],
    ["regression", result.tests?.regression],
    ["e2e", result.tests?.e2e]
  ];
  for (const [phase, evidence] of rerunTargets) {
    if (!evidence?.command || !isRunnableCommand(evidence.command)) continue;
    if (isNaturalLanguageRecipe(evidence.command)) {
      flags.push(`COMMAND_RERUN_NON_RUNNABLE_RECIPE:${phase}:${evidence.command}`);
      continue;
    }
    if (isUnsafeForegroundServerCommand(evidence.command)) {
      flags.push(`COMMAND_RERUN_UNSAFE_FOREGROUND_SERVER:${phase}:${evidence.command}`);
      continue;
    }
    const snapshot = commandSnapshot(cwd);
    if (snapshot && cachedCommandPassed(cwd, phase, evidence.command, snapshot)) {
      await markCommand(telemetryCwd, phase, evidence.command, "passed", 0);
      continue;
    }
    const started = Date.now();
    await markCommand(telemetryCwd, phase, evidence.command, "started");
    const run = await execCommand(evidence.command, cwd, 1000 * 60 * 20);
    const durationMs = Date.now() - started;
    await markCommand(telemetryCwd, phase, evidence.command, run.exitCode === 0 ? "passed" : "failed", durationMs);
    if (run.exitCode !== 0) flags.push(`COMMAND_RERUN_FAILED:${phase}:${evidence.command}:${summarizeFailure(run.stderr || run.stdout)}`);
    else if (snapshot) recordCommandPass(cwd, phase, evidence.command, snapshot, durationMs);
  }
  return { name: "command-rerun", passed: flags.length === 0, flags };
}

type CommandCache = { entries: Array<{ phase: string; command: string; snapshot: string; exitCode: number; durationMs: number; completedAt: string }> };

function cachedCommandPassed(cwd: string, phase: string, command: string, snapshot: string): boolean {
  const cache = readCommandCache(cwd);
  return cache.entries.some((entry) => entry.phase === phase && entry.command === command && entry.snapshot === snapshot && entry.exitCode === 0);
}

function recordCommandPass(cwd: string, phase: string, command: string, snapshot: string, durationMs: number): void {
  const cache = readCommandCache(cwd);
  const entries = cache.entries.filter((entry) => !(entry.phase === phase && entry.command === command && entry.snapshot === snapshot));
  entries.push({ phase, command, snapshot, exitCode: 0, durationMs, completedAt: new Date().toISOString() });
  writeCommandCache(cwd, { entries: entries.slice(-200) });
}

function readCommandCache(cwd: string): CommandCache {
  try {
    const value = JSON.parse(readFileSync(commandCachePath(cwd), "utf8")) as CommandCache;
    return { entries: Array.isArray(value.entries) ? value.entries : [] };
  } catch {
    return { entries: [] };
  }
}

function writeCommandCache(cwd: string, cache: CommandCache): void {
  const file = commandCachePath(cwd);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`);
}

function commandCachePath(cwd: string): string {
  return join(cwd, ".yolo/command-cache.json");
}

function commandSnapshot(cwd: string): string {
  const files = collectSnapshotFiles(cwd);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    try {
      hash.update(readFileSync(join(cwd, file)));
    } catch {
      hash.update("missing");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function collectSnapshotFiles(cwd: string): string[] {
  const files: string[] = [];
  collectSnapshotFilesRec(cwd, cwd, files);
  return files.sort();
}

function collectSnapshotFilesRec(root: string, dir: string, files: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === ".git" || name === ".yolo" || name === "node_modules" || name === "dist" || name === "build" || name === "coverage") continue;
    const full = join(dir, name);
    const rel = relative(root, full).replace(/\\/g, "/");
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) collectSnapshotFilesRec(root, full, files);
    else if (stat.isFile() && stat.size <= 1_000_000) files.push(rel);
    if (files.length >= 5000) return;
  }
}

function summarizeFailure(output: string): string {
  return output.replace(/\s+/g, " ").trim().slice(0, 220) || "no output";
}

function isRunnableCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || /^N\/A\b|^not applicable\b|^not run\b|^skipped\b/i.test(trimmed)) return false;
  if (/^bootRun\b/i.test(trimmed)) return false;
  if (/\bon\s+[A-Z_][A-Z0-9_]*=/.test(trimmed) && /,\s*(curl|rg|grep|test)\b/.test(trimmed)) return false;
  return true;
}

function isNaturalLanguageRecipe(command: string): boolean {
  const trimmed = command.trim();
  if (/^(?:seed|start|run|open|click|login|create|verify|then)\b/i.test(trimmed) && /\b(?:with|then|and|before|after)\b/i.test(trimmed) && /\b(?:npx|npm|pnpm|yarn|bun|curl|http|GET|POST|PORT=)\b/i.test(trimmed)) return true;
  if (/\bthen\s+(?:curl|GET|POST|run|start)\b/i.test(trimmed) && !/[;&|]|&&/.test(trimmed)) return true;
  return false;
}

function isUnsafeForegroundServerCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!/(?:^|[;&|]\s*|\b)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start:dev|dev:api|serve|preview)\b/i.test(normalized) && !/\b(?:vite|next|nuxt|tsx\s+watch|nodemon)\b/i.test(normalized)) return false;
  if (/\b(?:curl|wget|httpie|http|pwsh|powershell)\b/i.test(normalized) || /\bGET\s+\/|\bPOST\s+\//i.test(normalized)) {
    return !/(?:&\s*(?:curl|wget|httpie|http)\b|\bstart-server-and-test\b|\bwait-on\b|\bconcurrently\b|\btimeout\s+\d+)/i.test(normalized);
  }
  return false;
}
