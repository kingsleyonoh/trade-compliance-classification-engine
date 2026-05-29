import path from "node:path";
import { rm } from "node:fs/promises";
import { runAgent } from "./agent-session.js";
import { readPromptTemplate } from "./prompt-source.js";
import { readCanonicalBatchResult } from "./result-contracts.js";
import { markHeartbeat, markTiming } from "./telemetry.js";
import { appendSubagentEvent, budgetFromInvocation, summarizeSubagentSession, writeSubagentTelemetry, type AgentBudget, type SubagentTelemetry } from "./subagent-telemetry.js";
import { ensureDir, writeText } from "./util/fs.js";
import type { BatchResult, SubagentInvocation } from "./types.js";

export async function runSubagent(invocation: SubagentInvocation): Promise<BatchResult> {
  await ensureRuntimeDirs(invocation.cwd);
  const prompt = await materializePrompt(invocation);
  const resultFile = path.join(invocation.cwd, `${invocation.outputBase}.json`);
  const budget = budgetFromInvocation(invocation);
  let lastError: unknown;
  const maxRetries = budget.maxRetries ?? 0;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    const sessionFile = path.join(invocation.cwd, `.yolo/pi-sessions/${invocation.id}${attempt > 1 ? `-retry-${attempt}` : ""}.jsonl`);
    await rm(sessionFile, { force: true });
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    await emitTelemetry(invocation, sessionFile, startedMs, startedAt, attempt, budget, "running");
    const stopHeartbeat = startHeartbeat(invocation, sessionFile, startedMs, startedAt, attempt, budget);
    try {
      await appendSubagentEvent(invocation.cwd, invocation.id, { type: "agent_attempt_started", role: invocation.role, attempt, sessionFile: rel(invocation.cwd, sessionFile) });
      await clearSubagentOutput(invocation.cwd, invocation.outputBase);
      await runAgent({ cwd: invocation.cwd, sessionFile, prompt, route: invocation.route, staleToolTimeoutMs: budget.staleMs });
      stopHeartbeat();
      if (invocation.telemetryRoot) await markTiming(invocation.telemetryRoot, `${invocation.role}AgentMs`, Date.now() - startedMs);
      const result = await readCanonicalBatchResult(resultFile);
      await emitTelemetry(invocation, sessionFile, startedMs, startedAt, attempt, budget, "complete", result.status);
      await appendSubagentEvent(invocation.cwd, invocation.id, { type: "agent_attempt_complete", role: invocation.role, attempt, status: result.status });
      return result;
    } catch (error) {
      stopHeartbeat();
      lastError = error;
      await emitTelemetry(invocation, sessionFile, startedMs, startedAt, attempt, budget, attempt <= maxRetries ? "retrying" : "failed", undefined, error);
      await appendSubagentEvent(invocation.cwd, invocation.id, { type: attempt <= maxRetries ? "agent_attempt_retry" : "agent_attempt_failed", role: invocation.role, attempt, error: String(error instanceof Error ? error.message : error) });
      if (attempt > maxRetries) {
        if (isRecoverableAgentTimeout(error)) return await writeSyntheticFailureResult(invocation, error);
        throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Subagent failed"));
}

export async function clearSubagentOutput(cwd: string, outputBase: string): Promise<void> {
  await Promise.all([
    rm(path.join(cwd, `${outputBase}.json`), { force: true }),
    rm(path.join(cwd, `${outputBase}.md`), { force: true })
  ]);
}

function startHeartbeat(invocation: SubagentInvocation, sessionFile: string, startedMs: number, startedAt: string, attempt: number, budget: AgentBudget): () => void {
  const tick = async () => {
    const telemetry = await emitTelemetry(invocation, sessionFile, startedMs, startedAt, attempt, budget, "running");
    if (invocation.telemetryRoot) {
      const detail = telemetry.lastCommand || telemetry.lastFile || telemetry.lastResult || "waiting for tool activity";
      await markHeartbeat(invocation.telemetryRoot, `${invocation.role} agent running ${formatDuration(Date.now() - startedMs)} | ${detail}`).catch(() => undefined);
    }
  };
  const timer = setInterval(() => tick().catch(() => undefined), 30_000);
  tick().catch(() => undefined);
  return () => clearInterval(timer);
}

async function emitTelemetry(invocation: SubagentInvocation, sessionFile: string, startedMs: number, startedAt: string, attempt: number, budget: AgentBudget, status: SubagentTelemetry["status"], resultStatus?: string, error?: unknown): Promise<SubagentTelemetry> {
  const telemetry = await summarizeSubagentSession(invocation, sessionFile, startedMs, startedAt, attempt, budget);
  telemetry.status = status;
  if (status === "complete" || status === "failed" || status === "timeout") telemetry.endedAt = new Date().toISOString();
  if (resultStatus) telemetry.warnings.push(`RESULT_STATUS:${resultStatus}`);
  if (error) telemetry.warnings.push(`AGENT_ERROR:${String(error instanceof Error ? error.message : error).slice(0, 200)}`);
  await writeSubagentTelemetry(invocation.cwd, telemetry);
  return telemetry;
}

function isRecoverableAgentTimeout(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error);
  return /^AGENT_(?:STALE_TOOL_TIMEOUT|TIMEOUT):/.test(message);
}

async function writeSyntheticFailureResult(invocation: SubagentInvocation, error: unknown): Promise<BatchResult> {
  const message = String(error instanceof Error ? error.message : error);
  const failureType = message.startsWith("AGENT_STALE_TOOL_TIMEOUT:") ? "AGENT_STALE_TOOL_TIMEOUT" : "AGENT_TIMEOUT";
  const batch = extractBatch(invocation.id);
  const result: BatchResult = {
    schemaVersion: 1,
    agent: invocation.role,
    batch,
    status: "FAILURE",
    itemsCompleted: [],
    filesChanged: [`${invocation.outputBase}.md`, `${invocation.outputBase}.json`],
    tests: {
      regression: { command: "not applicable", exitCode: 1, evidence: message }
    },
    wiring: { required: false, entrypoints: [] },
    projectLocalChecks: { evaluated: 0, triggered: [], notes: "agent did not complete" },
    artifacts: [{ path: `${invocation.outputBase}.md`, description: "synthetic failure report" }],
    localOnlyFiles: [],
    inbox: { handledTitles: [] },
    failureType,
    flags: [failureType],
    commit: null
  };
  await writeText(path.join(invocation.cwd, `${invocation.outputBase}.md`), `# ${failureType}\n\n${message}\n`);
  await writeText(path.join(invocation.cwd, `${invocation.outputBase}.json`), JSON.stringify(result, null, 2) + "\n");
  return result;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m${seconds % 60}s` : `${seconds}s`;
}

async function ensureRuntimeDirs(cwd: string): Promise<void> {
  for (const rel of [".yolo/pi-sessions", ".yolo/subagent-prompts", ".yolo/subagent-runs", ".yolo/batch-results"]) {
    await ensureDir(path.join(cwd, rel));
  }
}

async function materializePrompt(invocation: SubagentInvocation): Promise<string> {
  const rawBase = await readPromptTemplate(invocation.cwd, invocation.promptFile);
  const base = fillLegacyPlaceholders(rawBase, invocation);
  const sections = [header(invocation), base, resultContract(invocation)];
  if (!rawBase.includes("{{CONTEXT_BLOCK}}")) sections.push(invocation.context);
  const prompt = sections.join("\n\n---\n\n");
  await writeText(path.join(invocation.cwd, `.yolo/subagent-prompts/${invocation.id}.prompt.md`), prompt);
  return prompt;
}

export function fillLegacyPlaceholders(template: string, invocation: SubagentInvocation): string {
  const batch = extractBatch(invocation.id);
  const values: Record<string, string> = {
    BATCH_NUMBER: String(batch).padStart(3, "0"),
    BATCH_ITEMS: extractContextSection(invocation.context, "Items") || "No batch items found in runtime context.",
    WORKSPACE_FILE: `${invocation.outputBase}.md`,
    CONTEXT_BLOCK: invocation.context,
    SHARED_FOUNDATION_FILES: "Included in the runtime context under ## Shared Foundation.",
    PRD_SECTION: "Included in the runtime context under ## PRD.",
    CODING_STANDARDS_DIGEST: "Included in the runtime context under ## Core Rules.",
    INBOX_BATCH: invocation.context.includes("## Pending YOLO Inbox") && !invocation.context.includes("No pending inbox") ? "true" : "false",
    AUDIT_ITEM_TEXT: extractContextSection(invocation.context, "Items") || "Audit item is listed in runtime context.",
    AUDIT_TYPE: "phase-exhaustive",
    PHASE_NUMBER: extractPhase(invocation.context),
    MATRIX_REF: "n/a",
    BUG_DESCRIPTION: extractContextSection(invocation.context, "Validation Failure Recovery") || "See runtime validation failure context.",
    ERROR_MESSAGE: extractContextSection(invocation.context, "Validator Result JSON") || "See runtime validation failure context.",
    AFFECTED_FILES: "See validator result and filesChanged in runtime context.",
    DEV_COMMAND: extractCommand(invocation.context, "Dev server") || "N/A",
    TEST_COMMAND: extractCommand(invocation.context, "Run tests") || "N/A",
    UNIT_TEST_COMMAND: extractCommand(invocation.context, "Run tests (unit only)") || extractCommand(invocation.context, "Run tests") || "N/A",
    INTEGRATION_TEST_COMMAND: extractCommand(invocation.context, "Run tests (integration only)") || extractCommand(invocation.context, "Run tests") || "N/A",
    E2E_COMMAND: extractCommand(invocation.context, "E2E tests") || "N/A",
    LINT_COMMAND: extractCommand(invocation.context, "Lint/check") || "N/A"
  };
  return template.replace(/{{([A-Z0-9_]+)}}/g, (match, key: string) => invocation.promptVars?.[key] ?? values[key] ?? `[runtime value unavailable for ${key}]`);
}

function extractBatch(id: string): number {
  const match = /batch-(\d+)/.exec(id);
  return match ? Number(match[1]) : 0;
}

function extractContextSection(context: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(^|\\n)## ${escaped}\\n([\\s\\S]*?)(\\n---\\n|\\n## |$)`).exec(context);
  return match?.[2]?.trim().replace(/^---\s*/m, "").trim() ?? "";
}

function extractCommand(context: string, action: string): string {
  for (const line of context.split(/\r?\n/)) {
    const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
    if (cells[0] !== action || !cells[1]) continue;
    const match = /`([^`]+)`/.exec(cells[1]);
    return (match?.[1] ?? cells[1]).trim();
  }
  return "";
}

function extractPhase(context: string): string {
  const match = /Phase\s+(\d+)/i.exec(context);
  return match?.[1] ?? "0";
}

function header(invocation: SubagentInvocation): string {
  return `# Klevar YOLO Sub-Agent Invocation\n\nAgent: ${invocation.role}\nRun: ${invocation.id}\nOutput markdown: ${invocation.outputBase}.md\nOutput JSON: ${invocation.outputBase}.json`;
}

function resultContract(invocation: SubagentInvocation): string {
  const batch = extractBatch(invocation.id);
  return `# Required Machine Contract

You MUST write both output files before finishing:

- ${invocation.outputBase}.md — human audit report
- ${invocation.outputBase}.json — machine control contract

## Canonical JSON shape — copy this shape exactly

\`\`\`json
{
  "schemaVersion": 1,
  "agent": "${invocation.role}",
  "batch": ${batch},
  "status": "SUCCESS",
  "itemsCompleted": ["exact progress item or fix completed"],
  "filesChanged": ["src/file.ts", "tests/file.test.ts"],
  "tests": {
    "red": { "command": "npm test -- failing-test", "exitCode": 1, "evidence": "test failed before implementation/fix" },
    "green": { "command": "npm test -- targeted-test", "exitCode": 0, "evidence": "targeted tests passed" },
    "regression": { "command": "npm test", "exitCode": 0, "evidence": "full suite passed" },
    "e2e": { "required": false, "command": "not applicable", "exitCode": 0, "evidence": "no entrypoint touched" }
  },
  "wiring": { "required": false, "entrypoints": [] },
  "projectLocalChecks": { "evaluated": 0, "triggered": [], "notes": "none present" },
  "businessLogic": { "rule": "N/A for non-business work", "sourceOfTruth": "docs/progress.md", "observablePaths": [], "test": "N/A" },
  "artifacts": [{ "path": "${invocation.outputBase}.md", "description": "human report" }],
  "localOnlyFiles": [],
  "inbox": { "handledTitles": [] },
  "flags": [],
  "commit": null
}
\`\`\`

## Failure shape

\`\`\`json
{
  "schemaVersion": 1,
  "agent": "${invocation.role}",
  "batch": ${batch},
  "status": "FAILURE",
  "itemsCompleted": [],
  "filesChanged": ["${invocation.outputBase}.md", "${invocation.outputBase}.json"],
  "tests": { "regression": { "command": "npm test", "exitCode": 0, "evidence": "tests that were actually run" } },
  "wiring": { "required": false, "entrypoints": [] },
  "projectLocalChecks": { "evaluated": 0, "triggered": [] },
  "artifacts": [{ "path": "${invocation.outputBase}.md", "description": "failure report" }],
  "localOnlyFiles": [],
  "inbox": { "handledTitles": [] },
  "failureType": "PRECISE_MACHINE_REASON",
  "flags": ["PRECISE_FLAG"],
  "commit": null
}
\`\`\`

## Contract rules

- Prefer the exact canonical shape above. The runtime can repair common aliases, but canonical JSON prevents false stops.
- Do NOT use \`tests.commands[]\`, \`status: PASS\`, \`cmd\`, or \`summary\` if you can avoid it.
- Do NOT put plain strings in test evidence, e.g. \`"red": "passed"\`. Every test evidence object needs \`command\`, \`exitCode\`, and \`evidence\`.
- Do NOT write descriptive labels as runnable commands. If live E2E required several shell steps, put an exact executable script/command in \`command\` or use \`command: "not applicable"\` and put artifact details in \`evidence\` and \`artifacts\`.
- Do NOT claim a commit hash. Always write \`commit: null\`; the runtime owns commits.
- If Active Project-Local Checks are present, report how many were evaluated and any triggered checks.
- If the PRD calls for mobile, offline/PWA, privacy/consent, or bundle discipline, include objective evidence and flags such as MOBILE_VIEWPORT_PASS, OFFLINE_PWA_PASS, PRIVACY_MATRIX_PASS, and BUNDLE_DYNAMIC_IMPORT_AUDIT_PASS when those concerns are touched.`;
}

function rel(cwd: string, file: string): string {
  return path.relative(cwd, file).replace(/\\/g, "/");
}
