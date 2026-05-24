import { readText } from "./util/fs.js";
import type { ProgressItem } from "./types.js";

export async function parseProgress(cwd: string): Promise<ProgressItem[]> {
  const text = await readText(`${cwd}/docs/progress.md`);
  const lines = text.split(/\r?\n/);
  const items: ProgressItem[] = [];
  let phase = "Unphased";
  let inFence = false;
  let current: ProgressItem | undefined;
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const phaseMatch = /^##\s+(Phase[^\n]+)/.exec(line);
    if (phaseMatch) phase = phaseMatch[1].trim();
    const item = /^- \[( |x|\/)\]\s+(\[[A-Z-]+\])\s+(.+)$/.exec(line);
    if (item) {
      current = { raw: line, tag: item[2], title: item[3].trim(), phase, checked: item[1] === "x", details: [], affectedFiles: [] };
      items.push(current);
      continue;
    }
    if (current && /^\s+-\s+\*\*/.test(line)) {
      current.details?.push(line.trim());
      const affected = /^\s+-\s+\*\*Affected files:\*\*\s*(.+)$/i.exec(line);
      if (affected) current.affectedFiles = parseList(affected[1]);
      const claim = /^\s+-\s+\*\*Claim:\*\*\s*(.+)$/i.exec(line);
      if (claim) current.claim = claim[1].trim();
    }
  }
  return items;
}

function parseList(value: string): string[] {
  return value
    .replace(/^\[|\]$/g, "")
    .split(/,/) 
    .map((item) => item.trim().replace(/^`|`$/g, ""))
    .filter(Boolean);
}

export function selectBatch(items: ProgressItem[], maxBatchSize: number, scope: string): ProgressItem[] {
  const remaining = items.filter((item) => !item.checked);
  const scoped = scope.startsWith("phase ")
    ? remaining.filter((item) => phaseMatchesScope(item.phase, scope))
    : remaining;
  const limit = scope.startsWith("next ") ? Number(scope.split(/\s+/)[1]) || 1 : maxBatchSize;
  return auditIsolated(scoped, limit);
}

export function isAuditItem(item: ProgressItem): boolean {
  return item.tag === "[AUDIT]" || isPhaseCloseout(item) || isMatrixCoverageAudit(item);
}

export function isPhaseCloseout(item: ProgressItem): boolean {
  return /phase\s+\d+\s+close-out/i.test(`${item.title}\n${item.raw}`);
}

export function isMatrixCoverageAudit(item: ProgressItem): boolean {
  return /audit\s+type:\*\*\s*matrix-coverage/i.test(item.details?.join("\n") ?? "") || /matrix-coverage/i.test(item.raw);
}

function phaseMatchesScope(phase: string, scope: string): boolean {
  const target = scope.replace(/^phase\s+/i, "").trim().toLowerCase();
  const phaseNumber = Number(/phase\s+(\d+)/i.exec(phase)?.[1]);
  if (!Number.isFinite(phaseNumber)) return phase.toLowerCase().includes(`phase ${target}`);
  const range = /^(\d+)\s*(?:-|\.\.|to|through|until)\s*(\d+)$/i.exec(target);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    const min = Math.min(start, end);
    const max = Math.max(start, end);
    return phaseNumber >= min && phaseNumber <= max;
  }
  const single = /^(\d+)$/.exec(target);
  return single ? phaseNumber === Number(single[1]) : phase.toLowerCase().includes(`phase ${target}`);
}

function auditIsolated(items: ProgressItem[], limit: number): ProgressItem[] {
  const first = items[0];
  if (!first) return [];
  if (isAuditItem(first)) return [first];
  const auditIndex = items.findIndex(isAuditItem);
  const candidates = auditIndex === -1 ? items : items.slice(0, auditIndex);
  return candidates.slice(0, limit);
}
