import path from "node:path";
import { exists, readText, writeText } from "./util/fs.js";
import { isAuditItem } from "./progress-parser.js";
import type { BatchResult, ProgressItem } from "./types.js";

export interface InboxEntry {
  title: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
  body: string;
  affectedFiles: string[];
  type?: string;
  date?: string;
}

export async function readPendingInbox(cwd: string): Promise<InboxEntry[]> {
  const file = path.join(cwd, "docs/yolo-inbox.md");
  if (!(await exists(file))) return [];
  const text = await readText(file);
  const pending = text.split(/## Pending/i)[1]?.split(/## Handled/i)[0] ?? "";
  const chunks = pending.split(/\n(?=###\s+)/).filter((chunk) => chunk.trim().startsWith("###"));
  return chunks.map(parseEntry);
}

export function formatInbox(entries: InboxEntry[]): string {
  if (entries.length === 0) return "No pending inbox entries.";
  return entries.map((entry) => `### ${entry.title}\nPriority: ${entry.priority}\n${entry.body.trim()}`).join("\n\n");
}

export function routeInboxEntries(selected: ProgressItem[], entries: InboxEntry[]): { items: ProgressItem[]; entries: InboxEntry[]; mode: "none" | "intercept" | "fold" | "sweep" } {
  const high = entries.filter((entry) => entry.priority === "HIGH");
  if (high.length) return { items: high.map(inboxItem), entries: high, mode: "intercept" };
  const low = entries.filter((entry) => entry.priority === "LOW");
  if (selected.some(isAuditItem) && low.length) return { items: low.map(inboxItem), entries: low, mode: "sweep" };
  const medium = entries.filter((entry) => entry.priority === "MEDIUM");
  const folded = medium.filter((entry) => overlapsSelected(entry, selected));
  if (folded.length) return { items: [...selected, ...folded.map(inboxItem)], entries: folded, mode: "fold" };
  if (selected.length === 0 && medium.length) return { items: [inboxItem(medium[0])], entries: [medium[0]], mode: "intercept" };
  return { items: selected, entries: [], mode: "none" };
}

function inboxItem(entry: InboxEntry): ProgressItem {
  const tag = inferTag(entry);
  const affected = entry.affectedFiles.length ? entry.affectedFiles.map((file) => `\`${file}\``).join(", ") : "[]";
  const refactor = /extract|rename|consolidate|behind an interface|dedupe|move|inline/i.test(`${entry.title}\n${entry.body}`);
  const raw = [`- [ ] ${tag} ${entry.title} — PRD N/A (inbox)`, `  - **Affected files:** ${affected}`, `  - **Inbox source:** docs/yolo-inbox.md (${entry.date ?? "undated"})`, `  - **Refactor intent:** ${refactor ? "true" : "false"}`].join("\n");
  return { raw, tag, title: `${entry.title} — PRD N/A (inbox)`, phase: "Inbox", checked: false, details: raw.split("\n").slice(1).map((line) => line.trim()), affectedFiles: entry.affectedFiles };
}

function inferTag(entry: InboxEntry): string {
  const type = entry.type?.toUpperCase();
  if (type === "BUG") return "[BUG]";
  if (type === "REFACTOR") return "[REFACTOR]";
  if (type === "FEATURE") return "[FEATURE]";
  if (entry.affectedFiles.some((file) => /templates|static|css|tsx|jsx|html|frontend|ui/i.test(file))) return "[UI]";
  return "[FIX]";
}

function overlapsSelected(entry: InboxEntry, selected: ProgressItem[]): boolean {
  if (selected.length === 0) return false;
  const text = `${entry.title}\n${entry.body}`.toLowerCase();
  if (entry.affectedFiles.some((file) => selected.some((item) => (item.affectedFiles ?? []).some((candidate) => pathOverlap(file, candidate))))) return true;
  if (/ui|frontend|template|css|impeccable|design|polish/.test(text) && selected.some((item) => ["[UI]", "[UX]", "[FRONTEND]"].includes(item.tag))) return true;
  if (/api|endpoint|route/.test(text) && selected.some((item) => item.tag === "[API]")) return true;
  if (/data|database|migration|schema/.test(text) && selected.some((item) => ["[DATA]", "[DB]", "[MODEL]"].includes(item.tag))) return true;
  return false;
}

function pathOverlap(a: string, b: string): boolean {
  const left = a.replace(/[`\s]/g, "").replace(/\\/g, "/").replace(/\/$/, "");
  const right = b.replace(/[`\s]/g, "").replace(/\\/g, "/").replace(/\/$/, "");
  return Boolean(left && right && (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)));
}

export async function reconcileInbox(cwd: string, result: BatchResult): Promise<number> {
  const handled = result.inbox?.handledTitles ?? [];
  if (handled.length === 0) return 0;
  const file = path.join(cwd, "docs/yolo-inbox.md");
  if (!(await exists(file))) return 0;
  let text = await readText(file);
  let moved = 0;
  for (const title of handled) {
    const pattern = new RegExp(`\\n### ${escapeRegExp(title)}[\\s\\S]*?(?=\\n### |\\n## Handled|$)`, "i");
    const match = text.match(pattern);
    if (!match) continue;
    text = text.replace(match[0], "\n");
    const handledBlock = `\n### ${title} — handled ${new Date().toISOString().slice(0, 10)}\n**Handled by:** batch ${result.batch}\n**Approach taken:** runtime result marked this inbox entry handled.\n\n---\n`;
    text = text.replace(/(## Handled\s*)/i, `$1${handledBlock}`);
    moved += 1;
  }
  if (moved > 0) await writeText(file, text);
  return moved;
}

function parseEntry(chunk: string): InboxEntry {
  const title = chunk.match(/^###\s+(.+)$/m)?.[1]?.trim() ?? "Untitled inbox entry";
  const priority = /\[HIGH\]|priority\s*:\s*high|urgent|block|critical|before next batch|stop/i.test(chunk) ? "HIGH" : /\[LOW\]|priority\s*:\s*low|cosmetic|docs|nice-to-have/i.test(chunk) ? "LOW" : "MEDIUM";
  return { title, priority, body: chunk, affectedFiles: parseAffectedFiles(chunk), type: field(chunk, "Type"), date: title.match(/—\s*(\d{4}-\d{2}-\d{2})/)?.[1] };
}

function field(chunk: string, name: string): string | undefined {
  return new RegExp(`^\\*\\*${escapeRegExp(name)}:\\*\\*\\s*(.+)$`, "im").exec(chunk)?.[1]?.trim();
}

function parseAffectedFiles(chunk: string): string[] {
  const raw = field(chunk, "Affected files") ?? "";
  return raw.split(/,/) .map((item) => item.trim().replace(/^`|`$/g, "")).filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
