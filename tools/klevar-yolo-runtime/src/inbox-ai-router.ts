import path from "node:path";
import { runAgent } from "./agent-session.js";
import { writeRuntimeGates } from "./gates.js";
import { routeInboxEntries, type InboxEntry } from "./inbox-router.js";
import type { Batch, GateResult, ProgressItem, RuntimeConfig } from "./types.js";
import { ensureDir, exists, readText, writeText } from "./util/fs.js";

export interface InboxRouteDecision {
  items: ProgressItem[];
  entries: InboxEntry[];
  mode: "none" | "intercept" | "fold" | "sweep";
  gate: GateResult;
}

interface AiDecision {
  mode: "none" | "intercept" | "fold" | "sweep";
  selectedTitles: string[];
  rationale?: string;
  staleWarnings?: string[];
}

export async function routeInboxWithAi(cwd: string, batchNumber: number, selected: ProgressItem[], entries: InboxEntry[], config: RuntimeConfig): Promise<InboxRouteDecision> {
  const fallback = routeInboxEntries(selected, entries);
  const baseGate = (mode: string, flags: string[] = []): GateResult => ({ name: "inbox", passed: true, flags: [`INBOX_MODE:${mode}`, ...flags] });
  if (entries.length === 0) return { ...fallback, gate: baseGate("none") };
  if (!config.models.inbox) return { ...fallback, gate: baseGate(fallback.mode, ["INBOX_AI_DISABLED_FALLBACK"]) };
  try {
    const decision = await runInboxRouter(cwd, batchNumber, selected, entries, config);
    const applied = applyDecision(selected, entries, decision, fallback);
    const flags = [`INBOX_MODE:${applied.mode}`, `INBOX_SELECTED:${applied.entries.length}`, ...(decision.staleWarnings ?? []).map((warning) => `INBOX_STALE:${warning}`)];
    return { ...applied, gate: { name: "inbox", passed: true, flags } };
  } catch (error) {
    return { ...fallback, gate: baseGate(fallback.mode, [`INBOX_AI_FAILED:${String(error instanceof Error ? error.message : error).slice(0, 140)}`]) };
  }
}

export async function writeInboxRouteGate(cwd: string, batch: Batch, gate: GateResult): Promise<void> {
  await writeRuntimeGates(cwd, batch, [gate]);
}

async function runInboxRouter(cwd: string, batchNumber: number, selected: ProgressItem[], entries: InboxEntry[], config: RuntimeConfig): Promise<AiDecision> {
  const outBase = `.yolo/inbox-routes/batch-${String(batchNumber).padStart(3, "0")}-inbox-route`;
  const outputFile = path.join(cwd, `${outBase}.json`);
  await ensureDir(path.dirname(outputFile));
  const template = await readIfPresent(cwd, ".agent/agents/yolo/yolo-subagent-inbox-route.md");
  const prompt = `${template}\n\n---\n\n# Inbox route request\n\nBatch ${batchNumber}\n\n## Selected progress batch\n${selected.map((item) => item.raw).join("\n\n") || "No selected progress items."}\n\n## Pending inbox catalog\n${entries.map((entry) => `### ${entry.title}\nPriority: ${entry.priority}\nAffected files: ${(entry.affectedFiles ?? []).join(", ") || "none"}\nType: ${entry.type ?? "unknown"}\n${entry.body}`).join("\n\n")}\n\n## Output\nWrite strict JSON to ${outBase}.json. Select at most 3 exact titles from the catalog.\n`;
  await runAgent({ cwd, sessionFile: path.join(cwd, `.yolo/pi-sessions/batch-${String(batchNumber).padStart(3, "0")}-inbox.jsonl`), prompt, route: config.models.inbox });
  if (!(await exists(outputFile))) return { mode: "none", selectedTitles: [] };
  return normalizeDecision(JSON.parse(await readText(outputFile)));
}

function applyDecision(selected: ProgressItem[], entries: InboxEntry[], decision: AiDecision, fallback: Omit<InboxRouteDecision, "gate">): Omit<InboxRouteDecision, "gate"> {
  const byTitle = new Map(entries.map((entry) => [entry.title, entry]));
  const chosen = decision.selectedTitles.map((title) => byTitle.get(title)).filter((entry): entry is InboxEntry => Boolean(entry)).slice(0, 3);
  if (entries.some((entry) => entry.priority === "HIGH")) return routeInboxEntries(selected, entries);
  if (!chosen.length || decision.mode === "none") return fallback;
  if (decision.mode === "intercept") return routeInboxEntries([], chosen);
  if (decision.mode === "fold") return { items: [...selected, ...chosen.map(inboxItemCompat)], entries: chosen, mode: "fold" };
  if (decision.mode === "sweep") return { items: chosen.map(inboxItemCompat), entries: chosen, mode: "sweep" };
  return fallback;
}

function inboxItemCompat(entry: InboxEntry): ProgressItem {
  const routed = routeInboxEntries([], [entry]);
  return routed.items[0];
}

function normalizeDecision(raw: unknown): AiDecision {
  const data = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const mode = data.mode === "intercept" || data.mode === "fold" || data.mode === "sweep" || data.mode === "none" ? data.mode : "none";
  const selectedTitles = Array.isArray(data.selectedTitles) ? data.selectedTitles.filter((title): title is string => typeof title === "string").slice(0, 3) : [];
  const staleWarnings = Array.isArray(data.staleWarnings) ? data.staleWarnings.filter((warning): warning is string => typeof warning === "string").slice(0, 5) : [];
  return { mode, selectedTitles, rationale: typeof data.rationale === "string" ? data.rationale : undefined, staleWarnings };
}

async function readIfPresent(cwd: string, rel: string): Promise<string> {
  const file = path.join(cwd, rel);
  return (await exists(file)) ? readText(file) : "";
}
