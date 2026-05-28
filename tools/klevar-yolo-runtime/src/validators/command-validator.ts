import type { BatchResult, GateResult, TestEvidence } from "../types.js";
import { markCommand, markHeartbeat } from "../telemetry.js";
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
    if (snapshot && adoptedSessionCommandPassed(cwd, evidence.command)) {
      await markCommand(telemetryCwd, `${phase}:adopted`, evidence.command, "passed", 0);
      await markCommand(telemetryCwd, phase, evidence.command, "passed", 0);
      recordCommandPass(cwd, phase, evidence.command, snapshot, 0);
      continue;
    }
    const first = await runCommandEvidence(cwd, telemetryCwd, phase, evidence.command);
    const retry = first.run.exitCode !== 0 && isCommandTimeout(first.run) ? await runCommandEvidence(cwd, telemetryCwd, `${phase}:timeout-retry`, evidence.command) : null;
    const final = retry?.run.exitCode === 0 ? retry : first;
    if (final.run.exitCode !== 0) flags.push(`COMMAND_RERUN_FAILED:${phase}:${evidence.command}:${summarizeFailure(final.run.stdout, final.run.stderr)}`);
    else if (snapshot) recordCommandPass(cwd, phase, evidence.command, snapshot, final.durationMs);
  }
  return { name: "command-rerun", passed: flags.length === 0, flags };
}

type CommandCache = { entries: Array<{ phase: string; command: string; snapshot: string; exitCode: number; durationMs: number; completedAt: string }> };

type CommandRun = { run: Awaited<ReturnType<typeof execCommand>>; durationMs: number };

async function runCommandEvidence(cwd: string, telemetryCwd: string, phase: string, command: string): Promise<CommandRun> {
  const started = Date.now();
  await markCommand(telemetryCwd, phase, command, "started");
  const run = await execCommand(command, cwd, {
    timeoutMs: 1000 * 60 * 20,
    heartbeatMs: 60_000,
    onHeartbeat: () => void markHeartbeat(telemetryCwd, `RUNNING ${phase}: ${command}`)
  });
  const durationMs = Date.now() - started;
  await markCommand(telemetryCwd, phase, command, run.exitCode === 0 ? "passed" : "failed", durationMs);
  return { run, durationMs };
}

function isCommandTimeout(run: Awaited<ReturnType<typeof execCommand>>): boolean {
  return run.exitCode === 124 || /COMMAND_TIMEOUT_AFTER_MS:/i.test(`${run.stderr}\n${run.stdout}`);
}

export function adoptedSessionCommandPassed(cwd: string, command: string): boolean {
  for (const event of sessionCommandEvents(cwd).filter((item) => item.command.trim() === command.trim()).reverse()) {
    if (!event.passed) continue;
    if (!hasLaterSourceMutation(cwd, event.sessionFile, event.resultIndex)) return true;
  }
  return false;
}

type SessionCommandEvent = { sessionFile: string; resultIndex: number; command: string; passed: boolean };

function sessionCommandEvents(cwd: string): SessionCommandEvent[] {
  const dir = join(cwd, ".yolo/pi-sessions");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".jsonl")).map((file) => join(dir, file));
  } catch {
    return [];
  }
  return files.flatMap((file) => parseSessionCommandEvents(file));
}

function parseSessionCommandEvents(file: string): SessionCommandEvent[] {
  const lines = readJsonl(file);
  const calls = new Map<string, string>();
  const events: SessionCommandEvent[] = [];
  lines.forEach((entry, index) => {
    const message = entry.message;
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === "toolCall" && block.name === "bash" && block.id) calls.set(String(block.id), String(block.arguments?.command ?? ""));
      }
    }
    if (message?.role === "toolResult" && message.toolName === "bash") {
      const command = calls.get(String(message.toolCallId));
      if (command) events.push({ sessionFile: file, resultIndex: index, command, passed: message.isError === false });
    }
  });
  return events;
}

function hasLaterSourceMutation(cwd: string, sessionFile: string, resultIndex: number): boolean {
  const lines = readJsonl(sessionFile);
  for (const entry of lines.slice(resultIndex + 1)) {
    const message = entry.message;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type !== "toolCall") continue;
      if ((block.name === "write" || block.name === "edit") && !isYoloLocalPath(String(block.arguments?.path ?? ""))) return true;
      if (block.name === "bash" && !isReadOnlyCommand(String(block.arguments?.command ?? ""))) return true;
    }
  }
  return false;
}

function readJsonl(file: string): Array<Record<string, any>> {
  try {
    return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
  } catch {
    return [];
  }
}

function isYoloLocalPath(value: string): boolean {
  return value.replace(/\\/g, "/").startsWith(".yolo/");
}

function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return true;
  if (/^(?:git\s+(?:status|diff|show|log|rev-parse)|node\s+-e\s+["'][^"']*(?:JSON\.parse|readFileSync)|test\s+-[sef]\s+|wc\s+|date\b|pwd\b|ls\b|find\b|rg\b|grep\b|cat\b|head\b|tail\b)/i.test(trimmed)) return true;
  return false;
}

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

export function summarizeFailure(stdout: string, stderr = ""): string {
  const combined = stripAnsi(`${stdout}\n${stderr}`);
  const lines = combined.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const signalIndexes = lines.map((line, index) => /(?:fail|failed|error|exception|stacktrace|stack trace|test failed|errored|timeout|undefvar|methoderror|keyerror|argumenterror|loaderror|test summary|broken|mismatch)/i.test(line) ? index : -1).filter((index) => index >= 0);
  const signal = signalIndexes.length ? [...new Set(signalIndexes.flatMap((index) => [index - 1, index, index + 1]).filter((index) => index >= 0 && index < lines.length))].sort((a, b) => a - b).map((index) => lines[index]) : [];
  const selected = (signal.length ? signal : lines).slice(-12).join(" | ");
  return selected.replace(/\s+/g, " ").trim().slice(0, 900) || "no output";
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
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
