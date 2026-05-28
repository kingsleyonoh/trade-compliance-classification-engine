import path from "node:path";
import { exists, readText, writeText } from "./util/fs.js";
import type { Batch, ProgressItem } from "./types.js";

export type SupportKind = "modularity" | "validate-prd" | "security-audit";

export interface SupportPlan {
  kind: SupportKind;
  scope: string;
  phase?: string;
  item: ProgressItem;
}

const SUPPORT_SEQUENCE: SupportKind[] = ["modularity", "validate-prd", "security-audit"];

export async function nextSupportPlan(cwd: string, items: ProgressItem[]): Promise<SupportPlan | null> {
  const due = await nextDuePhaseSupport(cwd);
  if (due) return makeSupportPlan(due.kind, due.phase, due.phase);
  if (items.some((item) => !item.checked)) return null;
  for (const kind of SUPPORT_SEQUENCE) {
    if (!(await supportGateExists(cwd, kind, "final"))) return makeSupportPlan(kind, "final");
  }
  return null;
}

export async function markPhaseSupportDue(cwd: string, batch: Batch, items: ProgressItem[]): Promise<void> {
  if (batch.supportKind) return;
  const phases = [...new Set(batch.items.map((item) => item.phase).filter(Boolean))];
  const completed = phases.filter((phase) => items.some((item) => item.phase === phase) && items.filter((item) => item.phase === phase).every((item) => item.checked));
  if (!completed.length) return;
  const current = await readDue(cwd);
  const next = [...new Set([...current, ...completed])];
  await writeDue(cwd, next);
}

export function applySupportPlan(batch: Batch, plan: SupportPlan | null): Batch {
  return plan ? { ...batch, items: [plan.item], type: "implement", supportKind: plan.kind, supportScope: plan.scope } : batch;
}

export async function supportGateExists(cwd: string, kind: SupportKind, scope: string): Promise<boolean> {
  return exists(path.join(cwd, ".yolo/gates", supportGateName(kind, scope)));
}

export function supportGateName(kind: SupportKind, scope: string): string {
  return `support-${kind}-${supportGateStem(scope)}.md`;
}

export function supportGateStem(scope: string): string {
  return safeScope(scope);
}

function safeScope(scope: string): string {
  return scope.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

async function nextDuePhaseSupport(cwd: string): Promise<{ phase: string; kind: SupportKind } | null> {
  for (const phase of await readDue(cwd)) {
    for (const kind of SUPPORT_SEQUENCE) {
      if (!(await supportGateExists(cwd, kind, phase))) return { phase, kind };
    }
  }
  return null;
}

async function readDue(cwd: string): Promise<string[]> {
  const file = path.join(cwd, ".yolo/support-due.json");
  if (!(await exists(file))) return [];
  try {
    const data = JSON.parse(await readText(file)) as { phases?: unknown };
    return Array.isArray(data.phases) ? data.phases.filter((phase): phase is string => typeof phase === "string" && phase.trim().length > 0) : [];
  } catch {
    return [];
  }
}

async function writeDue(cwd: string, phases: string[]): Promise<void> {
  await writeText(path.join(cwd, ".yolo/support-due.json"), JSON.stringify({ schemaVersion: 1, phases }, null, 2) + "\n");
}

export function makeSupportPlan(kind: SupportKind, scope: string, phase?: string): SupportPlan {
  const label = phase ?? "Final project";
  const title = kind === "modularity"
    ? `${label} support — run modularity check and safe refactor sweep`
    : kind === "validate-prd"
      ? `${label} support — run PRD validation sweep`
      : `${label} support — run security audit sweep`;
  const guidance = kind === "modularity"
    ? "Run structural/modularity checks. Only refactor when an objective violation is found. Preserve behavior and public contracts; run targeted and full regression evidence."
    : kind === "validate-prd"
      ? "Compare implementation against docs/progress.md and the PRD. Fix only objective gaps or record human/manual criteria clearly."
      : "Run a security/privacy/secrets/access-control audit. Fix only objective findings with tests or document manual follow-up when runtime evidence is impossible.";
  const raw = [`- [ ] [FIX] ${title} — PRD N/A (runtime support)`, `  - **Support workflow:** ${kind}`, `  - **Support scope:** ${scope}`, `  - **Runtime guardrails:** ${guidance}`].join("\n");
  return { kind, scope, phase, item: { raw, tag: "[FIX]", title: `${title} — PRD N/A (runtime support)`, phase: phase ?? "Runtime Support", checked: false, details: raw.split("\n").slice(1).map((line) => line.trim()), affectedFiles: [] } };
}
