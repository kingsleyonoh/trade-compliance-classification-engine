import path from "node:path";
import { readFile } from "node:fs/promises";
import { ensureDir, exists, writeText } from "./util/fs.js";
import type { SubagentInvocation } from "./types.js";

export interface SubagentTelemetry {
  id: string;
  role: string;
  model?: string;
  thinking?: string;
  requestedModel?: string;
  requestedThinking?: string;
  sessionModel?: string;
  sessionThinking?: string;
  status: "running" | "stale" | "timeout" | "retrying" | "failed" | "complete";
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  attempt: number;
  durationMs: number;
  lastTool?: string;
  lastCommand?: string;
  lastFile?: string;
  lastResult?: string;
  toolCalls: number;
  toolResults: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  estimatedCost?: number;
  warnings: string[];
}

export interface AgentBudget {
  staleMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  maxToolCalls?: number;
  maxEstimatedCost?: number;
}

export const defaultAgentBudget: AgentBudget = {
  staleMs: 5 * 60_000
};

export async function writeSubagentTelemetry(cwd: string, telemetry: SubagentTelemetry): Promise<void> {
  await ensureDir(path.join(cwd, ".yolo/subagent-runs"));
  await writeText(path.join(cwd, `.yolo/subagent-runs/${telemetry.id}.json`), JSON.stringify(telemetry, null, 2) + "\n");
}

export async function appendSubagentEvent(cwd: string, id: string, event: Record<string, unknown>): Promise<void> {
  const dir = path.join(cwd, ".yolo/subagent-events");
  await ensureDir(dir);
  const file = path.join(dir, `${id}.jsonl`);
  const previous = (await exists(file)) ? await readFile(file, "utf8") : "";
  await writeText(file, previous + JSON.stringify({ timestamp: new Date().toISOString(), id, ...event }) + "\n");
}

export async function summarizeSubagentSession(invocation: SubagentInvocation, sessionFile: string, startedMs: number, startedAt: string, attempt: number, budget: AgentBudget): Promise<SubagentTelemetry> {
  const parsed = await parseSession(sessionFile);
  const now = Date.now();
  const warnings: string[] = [];
  const durationMs = now - startedMs;
  const lastActivityAge = parsed.lastActivityMs ? now - parsed.lastActivityMs : durationMs;
  if (budget.staleMs !== undefined && lastActivityAge > budget.staleMs) warnings.push(`AGENT_STALE:${formatDuration(lastActivityAge)}`);
  if (budget.timeoutMs !== undefined && durationMs > budget.timeoutMs) warnings.push(`AGENT_TIMEOUT_BUDGET:${formatDuration(durationMs)}`);
  if (budget.maxToolCalls !== undefined && parsed.toolCalls > budget.maxToolCalls) warnings.push(`TOOL_CALL_BUDGET:${parsed.toolCalls}`);
  if (budget.maxEstimatedCost !== undefined && (parsed.estimatedCost ?? 0) > budget.maxEstimatedCost) warnings.push(`COST_BUDGET:${parsed.estimatedCost}`);
  return {
    id: invocation.id,
    role: invocation.role,
    model: invocation.route.model,
    thinking: invocation.route.thinking ?? "medium",
    requestedModel: invocation.route.model,
    requestedThinking: invocation.route.thinking ?? "medium",
    sessionModel: parsed.sessionModel,
    sessionThinking: parsed.sessionThinking,
    status: warnings.some((warning) => warning.startsWith("AGENT_STALE")) ? "stale" : "running",
    startedAt,
    updatedAt: new Date().toISOString(),
    attempt,
    durationMs,
    lastTool: parsed.lastTool,
    lastCommand: parsed.lastCommand,
    lastFile: parsed.lastFile,
    lastResult: parsed.lastResult,
    toolCalls: parsed.toolCalls,
    toolResults: parsed.toolResults,
    promptTokens: parsed.promptTokens,
    completionTokens: parsed.completionTokens,
    totalTokens: parsed.totalTokens,
    estimatedCost: parsed.estimatedCost,
    warnings
  };
}

export function budgetFromInvocation(invocation: SubagentInvocation): AgentBudget {
  return {
    ...defaultAgentBudget,
    ...(invocation.route.timeoutSeconds ? { timeoutMs: invocation.route.timeoutSeconds * 1000 } : {}),
    ...(invocation.route.budget ?? {})
  };
}

async function parseSession(file: string): Promise<{
  lastTool?: string;
  lastCommand?: string;
  lastFile?: string;
  lastResult?: string;
  lastActivityMs?: number;
  toolCalls: number;
  toolResults: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  estimatedCost?: number;
  sessionModel?: string;
  sessionThinking?: string;
}> {
  if (!(await exists(file))) return { toolCalls: 0, toolResults: 0 };
  const lines = (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).slice(-300);
  let toolCalls = 0;
  let toolResults = 0;
  let lastTool: string | undefined;
  let lastCommand: string | undefined;
  let lastFile: string | undefined;
  let lastResult: string | undefined;
  let lastActivityMs: number | undefined;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let estimatedCost = 0;
  let sessionModel: string | undefined;
  let sessionThinking: string | undefined;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as Record<string, any>;
      const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
      if (Number.isFinite(timestamp)) lastActivityMs = timestamp;
      if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") sessionThinking = entry.thinkingLevel;
      if (entry.type === "model_change" && typeof entry.modelId === "string") sessionModel = typeof entry.provider === "string" ? `${entry.provider}/${entry.modelId}` : entry.modelId;
      const message = entry.message;
      if (message?.provider && message?.model) sessionModel = `${message.provider}/${message.model}`;
      const usage = message?.usage ?? entry.usage;
      if (usage) {
        promptTokens += Number(usage.input ?? usage.promptTokens ?? 0);
        completionTokens += Number(usage.output ?? usage.completionTokens ?? 0);
        totalTokens += Number(usage.totalTokens ?? usage.total ?? 0);
        estimatedCost += Number(usage.cost?.total ?? usage.totalCost ?? 0);
      }
      if (message?.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type !== "toolCall") continue;
          toolCalls += 1;
          lastTool = String(block.name ?? "tool");
          const args = block.arguments ?? {};
          if (lastTool === "bash") lastCommand = String(args.command ?? "").slice(0, 300);
          if (lastTool === "read" || lastTool === "write" || lastTool === "edit") lastFile = String(args.path ?? "");
        }
      }
      if (message?.role === "toolResult") {
        toolResults += 1;
        lastTool = String(message.toolName ?? lastTool ?? "tool");
        lastResult = summarizeResult(message.content);
      }
    } catch {
      // Ignore partial JSONL writes.
    }
  }
  return { lastTool, lastCommand, lastFile, lastResult, lastActivityMs, toolCalls, toolResults, promptTokens, completionTokens, totalTokens, estimatedCost, sessionModel, sessionThinking };
}

function summarizeResult(content: unknown): string {
  const text = Array.isArray(content)
    ? content.map((item) => typeof item === "object" && item ? String((item as Record<string, unknown>).text ?? "") : String(item ?? "")).join(" ")
    : String(content ?? "");
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m${seconds % 60}s` : `${seconds}s`;
}
