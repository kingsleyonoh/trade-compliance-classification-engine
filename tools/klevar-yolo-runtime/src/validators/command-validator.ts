import type { BatchResult, GateResult, TestEvidence } from "../types.js";
import { markCommand, markCommandDecision, markHeartbeat } from "../telemetry.js";
import { execCommand } from "../util/process.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { delimiter } from "node:path";
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
    if (hasProseParenthetical(evidence.command)) {
      flags.push(`COMMAND_RERUN_PROSE_PARENTHETICAL:${phase}:${evidence.command}`);
      continue;
    }
    const devEnv = officialDevCommandEnv(cwd, evidence.command);
    const preparedCommand = prepareCommandWithOfficialDevEnv(evidence.command, devEnv);
    const missingRequiredEnv = missingRequiredEnvAssignment(cwd, preparedCommand, devEnv);
    if (missingRequiredEnv) {
      flags.push(`COMMAND_RERUN_MISSING_REQUIRED_ENV:${phase}:${missingRequiredEnv.name}:${missingRequiredEnv.reason}:${evidence.command}`);
      continue;
    }
    const missingBinary = missingHostBinary(cwd, preparedCommand);
    if (missingBinary) {
      flags.push(`COMMAND_RERUN_MISSING_HOST_BINARY:${phase}:${missingBinary}:${evidence.command}`);
      continue;
    }
    if (isUnsafeForegroundServerCommand(preparedCommand)) {
      flags.push(`COMMAND_RERUN_UNSAFE_FOREGROUND_SERVER:${phase}:${evidence.command}`);
      continue;
    }
    const snapshot = commandSnapshot(cwd);
    if (snapshot && cachedCommandPassed(cwd, phase, evidence.command, snapshot)) {
      await markCommandDecision(telemetryCwd, phase, evidence.command, "cache", "hit", "exact phase+command+snapshot pass reused", 0);
      await markCommand(telemetryCwd, phase, evidence.command, "passed", 0);
      continue;
    }
    await markCommandDecision(telemetryCwd, phase, evidence.command, "cache", "miss", snapshot ? "no matching pass for phase+command+snapshot" : "snapshot unavailable");
    if (snapshot && adoptedSessionCommandPassed(cwd, evidence.command)) {
      await markCommandDecision(telemetryCwd, phase, evidence.command, "session", "adopted", "exact passed session command with no later source mutation", 0);
      await markCommand(telemetryCwd, `${phase}:adopted`, evidence.command, "passed", 0);
      await markCommand(telemetryCwd, phase, evidence.command, "passed", 0);
      recordCommandPass(cwd, phase, evidence.command, snapshot, 0);
      await markCommandDecision(telemetryCwd, phase, evidence.command, "cache", "recorded", "session-adopted pass recorded for future snapshot reuse", 0);
      continue;
    }
    const first = await runCommandEvidence(cwd, telemetryCwd, phase, preparedCommand, devEnv);
    const retry = first.run.exitCode !== 0 && isCommandTimeout(first.run) ? await runCommandEvidence(cwd, telemetryCwd, `${phase}:timeout-retry`, preparedCommand, devEnv) : null;
    const final = retry?.run.exitCode === 0 ? retry : first;
    if (final.run.exitCode !== 0) flags.push(`COMMAND_RERUN_FAILED:${phase}:${evidence.command}:${summarizeFailure(final.run.stdout, final.run.stderr)}`);
    else if (snapshot) {
      recordCommandPass(cwd, phase, evidence.command, snapshot, final.durationMs);
      await markCommandDecision(telemetryCwd, phase, evidence.command, "cache", "recorded", "fresh rerun pass recorded for snapshot reuse", final.durationMs);
    }
  }
  return { name: "command-rerun", passed: flags.length === 0, flags };
}

type CommandCache = { entries: Array<{ phase: string; command: string; snapshot: string; exitCode: number; durationMs: number; completedAt: string }> };

type CommandRun = { run: Awaited<ReturnType<typeof execCommand>>; durationMs: number };

async function runCommandEvidence(cwd: string, telemetryCwd: string, phase: string, command: string, env?: NodeJS.ProcessEnv): Promise<CommandRun> {
  const started = Date.now();
  await markCommand(telemetryCwd, phase, command, "started");
  const run = await execCommand(command, cwd, {
    timeoutMs: 1000 * 60 * 20,
    heartbeatMs: 60_000,
    env,
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
      if (command) events.push({ sessionFile: file, resultIndex: index, command, passed: message.isError === false && !toolResultShowsNonZeroExit(message) });
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

function toolResultShowsNonZeroExit(message: Record<string, any>): boolean {
  const text = JSON.stringify(message.content ?? "");
  return /Command exited with code (?!0\b)\d+|exitCode["' ]*[:=]["' ]*(?!0\b)\d+/i.test(text);
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
  if (/(?:>|>>|2>|&>|\|)|\b(?:rm|mv|cp|touch|mkdir|rmdir|chmod|chown|tee|npm\s+install|pnpm\s+install|yarn\s+install|bun\s+install)\b|\bfind\b[\s\S]*(?:-delete|-exec)\b/i.test(trimmed)) return false;
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

function hasProseParenthetical(command: string): boolean {
  const trimmed = command.trim();
  const matches = [...trimmed.matchAll(/\s\(([^)]{3,160})\)(?=\s*(?:$|[;&|]))/g)];
  return matches.some((match) => {
    const text = match[1].trim();
    if (isShellCommandParenthetical(text)) return false;
    return /\b(?:pass(?:es|ed)?|fail(?:s|ed)?|green|red|expected|after|before|manual|artifact|server|locally|verified|works|needed|optional|required|not run|timeout)\b/i.test(text)
      || /\b[a-z]{3,}\s+[a-z]{3,}\b/i.test(text);
  });
}

function isShellCommandParenthetical(text: string): boolean {
  const segments = text.split(/&&|\|\||;|\|/).map((segment) => segment.trim()).filter(Boolean);
  if (!segments.length) return false;
  const first = firstCommandToken(segments[0]);
  if (!first || !isLikelyCommandStarter(first)) return false;
  if (segments.length > 1) {
    return segments.every((segment) => {
      const token = firstCommandToken(segment);
      return Boolean(token && isLikelyCommandStarter(token));
    });
  }
  return /^[\w.-]+(?:\s+[\w./:=@%-]+)*$/.test(text);
}

function isLikelyCommandStarter(token: string): boolean {
  if (isKnownShellWord(token)) return true;
  if (/^(?:npm|pnpm|yarn|bun|node|npx|python|python3|pytest|cargo|go|gradle|mvn|make|bash|sh|cmd|powershell|pwsh|docker|docker-compose|git|rg|grep|curl|wget|deno|tsx|tsc)$/i.test(token)) return true;
  return /^(?:\.\/|\.\.\/|\/|[A-Za-z]:[\\/])/.test(token);
}

function missingHostBinary(cwd: string, command: string): string | null {
  for (const binary of commandBinaries(command)) {
    if (isKnownShellWord(binary)) continue;
    if (!binaryExists(cwd, binary)) return binary;
  }
  return null;
}

function commandBinaries(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((segment) => firstCommandToken(segment.trim()))
    .filter((token): token is string => Boolean(token));
}

function firstCommandToken(segment: string): string | null {
  let value = segment.replace(/^\(+\s*/, "").trim();
  while (true) {
    const withoutAssignment = stripLeadingEnvAssignment(value);
    if (withoutAssignment === value) break;
    value = withoutAssignment;
  }
  if (/^(?:sudo|env|command|time)\s+/.test(value)) return firstCommandToken(value.replace(/^(?:sudo|env|command|time)\s+/, ""));
  const match = value.match(/^['"]?([^\s'"()]+)['"]?/);
  return match ? match[1] : null;
}

type RequiredEnvProblem = { name: string; reason: "empty-assignment" | `unset-placeholder:${string}` };

function missingRequiredEnvAssignment(cwd: string, command: string, devEnv: NodeJS.ProcessEnv = officialDevCommandEnv(cwd, command)): RequiredEnvProblem | null {
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    let value = segment.replace(/^\(+\s*/, "").trim();
    while (value) {
      const wrapper = value.match(/^(?:sudo|env|command|time)\s+/);
      if (wrapper) {
        value = value.slice(wrapper[0].length).trimStart();
        continue;
      }
      const parsed = parseLeadingEnvAssignment(value);
      if (!parsed) break;
      if (requiredCommandEnvName(parsed.name)) {
        if (parsed.value === "" && !resolvedDevEnvValue(parsed.name, devEnv)) return { name: parsed.name, reason: "empty-assignment" };
        const placeholder = envPlaceholderName(parsed.value);
        if (placeholder && !(resolvedDevEnvValue(placeholder, devEnv))) return { name: parsed.name, reason: `unset-placeholder:${placeholder}` };
      }
      value = parsed.rest;
    }
  }
  return null;
}

function stripLeadingEnvAssignment(value: string): string {
  return parseLeadingEnvAssignment(value)?.rest ?? value;
}

function parseLeadingEnvAssignment(value: string): { name: string; value: string; rest: string } | null {
  const match = value.match(/^([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s]*))(?:\s+|$)/);
  if (!match) return null;
  return {
    name: match[1],
    value: match[2] ?? match[3] ?? match[4] ?? "",
    rest: value.slice(match[0].length).trimStart()
  };
}

function envPlaceholderName(value: string): string | null {
  const braced = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (braced) return braced[1];
  const bare = value.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  return bare ? bare[1] : null;
}

function requiredCommandEnvName(name: string): boolean {
  return /(?:^|_)(?:DATABASE_URL|DB_URL|CONNECTION_STRING|JWT_SECRET|API_KEY|API_KEY_PEPPER|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)$/i.test(name);
}

function prepareCommandWithOfficialDevEnv(command: string, devEnv: NodeJS.ProcessEnv): string {
  return command.split(/(&&|\|\||;|\|)/).map((part) => {
    if (/^(?:&&|\|\||;|\|)$/.test(part)) return part;
    let value = part;
    let prefix = "";
    while (true) {
      const leading = value.match(/^(\s*\(*\s*)/)?.[0] ?? "";
      const parsed = parseLeadingEnvAssignment(value.slice(leading.length));
      if (!parsed) break;
      const replacement = parsed.value === "" && requiredCommandEnvName(parsed.name) && resolvedDevEnvValue(parsed.name, devEnv)
        ? `${parsed.name}=\"$${parsed.name}\" `
        : `${parsed.name}=${quoteEnvAssignmentValue(parsed.value)} `;
      prefix += `${leading}${replacement}`;
      value = parsed.rest;
    }
    return `${prefix}${value}`;
  }).join("");
}

function quoteEnvAssignmentValue(value: string): string {
  if (value === "") return "";
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value)) return value;
  if (/^[A-Za-z0-9_./:@%+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function officialDevCommandEnv(cwd: string, command: string): NodeJS.ProcessEnv {
  const names = requiredEnvAssignmentNames(command);
  if (!names.length) return {};
  const fileEnv = loadDevEnvFiles(cwd);
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const direct = process.env[name]?.trim() || fileEnv[name]?.trim();
    if (direct) env[name] = direct;
    else if (name === "TEST_DATABASE_URL") {
      const fallback = process.env.DATABASE_URL?.trim() || fileEnv.DATABASE_URL?.trim();
      if (fallback) env[name] = fallback;
    }
  }
  return env;
}

function requiredEnvAssignmentNames(command: string): string[] {
  const names = new Set<string>();
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    let value = segment.replace(/^\(+\s*/, "").trim();
    while (value) {
      const wrapper = value.match(/^(?:sudo|env|command|time)\s+/);
      if (wrapper) {
        value = value.slice(wrapper[0].length).trimStart();
        continue;
      }
      const parsed = parseLeadingEnvAssignment(value);
      if (!parsed) break;
      if (requiredCommandEnvName(parsed.name)) names.add(parsed.name);
      const placeholder = envPlaceholderName(parsed.value);
      if (placeholder && requiredCommandEnvName(placeholder)) names.add(placeholder);
      value = parsed.rest;
    }
  }
  return [...names];
}

function resolvedDevEnvValue(name: string, devEnv: NodeJS.ProcessEnv): string {
  return process.env[name]?.trim() || devEnv[name]?.trim() || "";
}

function loadDevEnvFiles(cwd: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const file of [".env.example", ".env", ".env.local"]) {
    const full = join(cwd, file);
    if (!existsSync(full)) continue;
    for (const line of readFileSync(full, "utf8").split(/\r?\n/)) {
      const parsed = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!parsed || line.trim().startsWith("#")) continue;
      env[parsed[1]] = expandEnvValue(unquoteEnvValue(parsed[2]), env);
    }
  }
  return env;
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

function expandEnvValue(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? env[name] ?? "");
}

function isKnownShellWord(binary: string): boolean {
  return /^(?:cd|echo|printf|test|true|false|exit|export|set|unset|alias|source|\.|if|then|else|fi|for|do|done|while|case|esac|ulimit|type|hash|pwd|read|trap|wait|sleep)$/i.test(binary);
}

function binaryExists(cwd: string, binary: string): boolean {
  if (binary.includes("/") || binary.includes("\\")) return existsSync(join(cwd, binary)) || existsSync(binary);
  const pathValue = process.env.PATH ?? "";
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      if (existsSync(join(dir, `${binary}${ext}`))) return true;
      if (process.platform === "win32" && existsSync(join(dir, binary))) return true;
    }
  }
  return false;
}

function isUnsafeForegroundServerCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  const serverLike = /(?:^|[;&|]\s*|\b)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start:dev|dev:api|serve|preview)\b/i.test(normalized)
    || /\b(?:vite|next|nuxt|tsx\s+watch|nodemon|uvicorn|flask\s+run|rails\s+s|dotnet\s+watch)\b/i.test(normalized);
  if (!serverLike) return false;
  return !/(?:&[\s\S]{0,80}\b(?:curl|wget|httpie|http)\b|\bstart-server-and-test\b|\bwait-on\b|\bconcurrently\b|\btimeout\s+\d+)/i.test(normalized);
}
