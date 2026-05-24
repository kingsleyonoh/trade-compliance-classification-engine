import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, exists, readText, writeText } from "../util/fs.js";
import { git } from "../util/git.js";
import type { Batch, GateResult, RuntimeConfig } from "../types.js";

export interface Claim {
  schemaVersion: number;
  task: string;
  operator: string;
  tool?: string;
  branch: string;
  status: "active" | "blocked" | "done" | "released";
  startedAt: string;
  expectedFiles?: string[];
}

export interface ClaimSet {
  claims: Claim[];
  errors: string[];
}

export async function loadClaims(cwd: string, config: RuntimeConfig): Promise<ClaimSet> {
  const dir = join(cwd, config.collaboration?.claimsDir ?? "docs/claims");
  if (!(await exists(dir))) return { claims: [], errors: [] };
  const claims: Claim[] = [];
  const errors: string[] = [];
  const completed = await completedYoloBatches(cwd);
  for (const name of (await readdir(dir)).filter((file) => file.endsWith(".json")).sort()) {
    try {
      const file = join(dir, name);
      const claim = reconcileCommittedRuntimeClaim(normalizeClaim(JSON.parse(await readText(file)), name), name, completed);
      const validation = validateClaimShape(claim, name);
      if (validation.length) errors.push(...validation);
      else {
        await writeText(file, JSON.stringify(claim, null, 2) + "\n");
        claims.push(claim);
      }
    } catch (error) {
      errors.push(`CLAIM_JSON_INVALID:${name}:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { claims, errors };
}

export function activeClaims(claims: Claim[]): Claim[] {
  return claims.filter((claim) => claim.status === "active" || claim.status === "blocked");
}

export async function prepareRuntimeClaim(cwd: string, config: RuntimeConfig, batch: Batch): Promise<GateResult> {
  if (!config.collaboration?.enabled) return { name: "claims-contract", passed: true, flags: [] };
  const claims = await loadClaims(cwd, config);
  const gate = validateClaims(claims);
  const conflicts = runtimeClaimConflicts(batch, claims.claims);
  const flags = [...gate.flags, ...conflicts];
  if (flags.length) return { name: "claims-contract", passed: false, flags };
  await writeRuntimeClaim(cwd, config, batch, "active");
  return { name: "claims-contract", passed: true, flags: [] };
}

export async function markRuntimeClaim(cwd: string, config: RuntimeConfig, batch: Batch, status: Claim["status"]): Promise<void> {
  if (!config.collaboration?.enabled) return;
  await writeRuntimeClaim(cwd, config, batch, status);
}

export function validateClaims(claims: ClaimSet): GateResult {
  const flags = [...claims.errors];
  const active = activeClaims(claims.claims);
  const byTask = new Map<string, Claim[]>();
  const byFile = new Map<string, Claim[]>();
  for (const claim of active) {
    byTask.set(claim.task, [...(byTask.get(claim.task) ?? []), claim]);
    for (const file of claim.expectedFiles ?? []) byFile.set(file, [...(byFile.get(file) ?? []), claim]);
  }
  for (const [task, owners] of byTask) if (owners.length > 1) flags.push(`DUPLICATE_ACTIVE_CLAIM:${task}`);
  for (const [file, owners] of byFile) if (owners.length > 1) flags.push(`CLAIM_FILE_CONFLICT:${file}`);
  return { name: "claims-contract", passed: flags.length === 0, flags };
}

export function isClaimedByExternalOperator(itemTitle: string, claims: Claim[]): boolean {
  return activeClaims(claims).some((claim) => sameTask(itemTitle, claim.task) && !claim.operator.startsWith("operator:pi-yolo"));
}

export function conflictsWithClaimedFiles(files: string[], claims: Claim[]): string[] {
  const activeFiles = new Set(activeClaims(claims).filter((claim) => !claim.operator.startsWith("operator:pi-yolo")).flatMap((claim) => claim.expectedFiles ?? []));
  return files.filter((file) => activeFiles.has(file));
}

function runtimeClaimConflicts(batch: Batch, claims: Claim[]): string[] {
  const external = activeClaims(claims).filter((claim) => !claim.operator.startsWith("operator:pi-yolo"));
  const flags: string[] = [];
  for (const item of batch.items) {
    if (external.some((claim) => sameTask(item.title, claim.task))) flags.push(`EXTERNALLY_CLAIMED:${item.title}`);
  }
  const files = [...new Set(batch.items.flatMap((item) => item.affectedFiles ?? []))];
  const fileConflicts = conflictsWithClaimedFiles(files, claims);
  for (const file of fileConflicts) flags.push(`CLAIM_FILE_CONFLICT:${file}`);
  return flags;
}

async function writeRuntimeClaim(cwd: string, config: RuntimeConfig, batch: Batch, status: Claim["status"]): Promise<void> {
  const dir = join(cwd, config.collaboration?.claimsDir ?? "docs/claims");
  await ensureDir(dir);
  const file = join(dir, `yolo-batch-${String(batch.number).padStart(3, "0")}.json`);
  const claim: Claim = {
    schemaVersion: 1,
    task: batch.items.map((item) => item.title).join(" | "),
    operator: "operator:pi-yolo",
    tool: "klevar-yolo-runtime",
    branch: `klevar/yolo-batch-${String(batch.number).padStart(3, "0")}`,
    status,
    startedAt: new Date().toISOString(),
    expectedFiles: [...new Set(batch.items.flatMap((item) => item.affectedFiles ?? []))]
  };
  await writeText(file, JSON.stringify(claim, null, 2) + "\n");
}

function normalizeClaim(raw: unknown, name: string): Claim {
  const data = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const task = stringField(data.task ?? data.title ?? data.item ?? data.description) || name.replace(/\.json$/i, "");
  const operator = stringField(data.operator ?? data.owner ?? data.claimant ?? data.user) || "unknown";
  const status = normalizeClaimStatus(data.status ?? data.state);
  return {
    schemaVersion: typeof data.schemaVersion === "number" ? data.schemaVersion : 1,
    task,
    operator,
    tool: stringField(data.tool),
    branch: stringField(data.branch) || `claims/${slug(task)}`,
    status,
    startedAt: stringField(data.startedAt ?? data.started_at ?? data.createdAt ?? data.created_at) || new Date().toISOString(),
    expectedFiles: stringList(data.expectedFiles ?? data.files ?? data.paths ?? data.expected_files).map((file) => file.replace(/\\/g, "/"))
  };
}

function reconcileCommittedRuntimeClaim(claim: Claim, name: string, completed: Set<number>): Claim {
  const match = /^yolo-batch-(\d+)\.json$/i.exec(name);
  const batch = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(batch) || !completed.has(batch)) return claim;
  if (claim.tool !== "klevar-yolo-runtime" || !claim.operator.startsWith("operator:pi-yolo")) return claim;
  if (claim.status !== "active" && claim.status !== "blocked") return claim;
  return { ...claim, status: "done" };
}

async function completedYoloBatches(cwd: string): Promise<Set<number>> {
  try {
    const subjects = await git(cwd, "log -n 200 --format=%s");
    const out = new Set<number>();
    for (const subject of subjects.split(/\r?\n/)) {
      const match = /^feat\(yolo\): complete batch 0*(\d+)$/i.exec(subject.trim());
      if (match) out.add(Number(match[1]));
    }
    return out;
  } catch {
    return new Set();
  }
}

function validateClaimShape(claim: Claim, name: string): string[] {
  const flags: string[] = [];
  if (claim.schemaVersion !== 1) flags.push(`CLAIM_SCHEMA_UNSUPPORTED:${name}`);
  for (const key of ["task", "operator", "branch", "status", "startedAt"] as const) if (!claim[key]) flags.push(`CLAIM_MISSING_${key.toUpperCase()}:${name}`);
  if (claim.status && !["active", "blocked", "done", "released"].includes(claim.status)) flags.push(`CLAIM_STATUS_INVALID:${name}:${claim.status}`);
  return flags;
}

function normalizeClaimStatus(value: unknown): Claim["status"] {
  if (typeof value !== "string") return "active";
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["done", "complete", "completed", "closed"].includes(normalized)) return "done";
  if (["release", "released", "cancelled", "canceled"].includes(normalized)) return "released";
  if (["block", "blocked", "stalled"].includes(normalized)) return "blocked";
  return "active";
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item : item && typeof item === "object" ? String((item as Record<string, unknown>).path ?? (item as Record<string, unknown>).file ?? "") : "").filter(Boolean);
  if (typeof value === "string") return [value];
  return [];
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "claim";
}

function sameTask(a: string, b: string): boolean {
  return normalizeTask(a).includes(normalizeTask(b)) || normalizeTask(b).includes(normalizeTask(a));
}

function normalizeTask(value: string): string {
  return value.replace(/^\[[A-Z-]+\]\s+/, "").replace(/—\s*PRD\s+.+$/i, "").trim().toLowerCase();
}
