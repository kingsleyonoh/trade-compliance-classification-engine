import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { BatchResult, GateResult } from "./types.js";
import { classifyGateFindings, type GateFindingReport } from "./gate-findings.js";
import { exists } from "./util/fs.js";

export type AdjudicationDecision = "ACCEPT" | "ACCEPT_WITH_WARNINGS" | "REQUIRE_BUGFIX" | "ESCALATE_TO_USER";

export interface AdjudicationResult {
  schemaVersion: number;
  agent: "adjudicate";
  batch: number;
  status: BatchResult["status"];
  decision: AdjudicationDecision;
  acceptedAmbiguities: string[];
  requiresBugfix: boolean;
  requiresHuman: boolean;
  rationale: string;
  flags: string[];
}

export function adjudicationAllowed(gates: GateResult[]): boolean {
  const report = classifyGateFindings(gates);
  return report.hardFailures.length === 0 && report.ambiguities.length > 0;
}

export function adjudicationReport(gates: GateResult[]): GateFindingReport {
  return classifyGateFindings(gates);
}

export function adjudicationAccepted(result: AdjudicationResult): boolean {
  return result.status === "SUCCESS" && (result.decision === "ACCEPT" || result.decision === "ACCEPT_WITH_WARNINGS") && !result.requiresBugfix && !result.requiresHuman;
}

export function adjudicationNeedsBugfix(result: AdjudicationResult): boolean {
  return result.status === "SUCCESS" && (result.decision === "REQUIRE_BUGFIX" || result.requiresBugfix);
}

export function adjudicationNeedsHuman(result: AdjudicationResult): boolean {
  return result.status !== "SUCCESS" || result.decision === "ESCALATE_TO_USER" || result.requiresHuman;
}

export async function readExistingAdjudication(cwd: string, batchNumber: number): Promise<AdjudicationResult | null> {
  const file = path.join(cwd, `.yolo/batch-results/batch-${String(batchNumber).padStart(3, "0")}-adjudicate.json`);
  if (!(await exists(file))) return null;
  return readAdjudicationFile(file);
}

export async function readAdjudicationFile(file: string): Promise<AdjudicationResult | null> {
  try {
    const normalized = normalizeAdjudication(JSON.parse(await readFile(file, "utf8")));
    if (normalized) await writeFile(file, JSON.stringify(normalized, null, 2) + "\n");
    return normalized;
  } catch {
    return null;
  }
}

export function normalizeAdjudication(raw: unknown): AdjudicationResult | null {
  const data = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  if (!data) return null;
  const decision = normalizeDecision(data.decision);
  return {
    schemaVersion: typeof data.schemaVersion === "number" ? data.schemaVersion : 1,
    agent: "adjudicate",
    batch: typeof data.batch === "number" ? data.batch : typeof data.batch === "string" && /^\d+$/.test(data.batch) ? Number(data.batch) : 0,
    status: normalizeStatus(data.status),
    decision,
    acceptedAmbiguities: stringArray(data.acceptedAmbiguities ?? data.accepted_ambiguities ?? data.ambiguitiesAccepted),
    requiresBugfix: boolAlias(data.requiresBugfix ?? data.requires_bugfix ?? data.bugfixRequired, decision === "REQUIRE_BUGFIX"),
    requiresHuman: boolAlias(data.requiresHuman ?? data.requires_human ?? data.humanRequired, decision === "ESCALATE_TO_USER"),
    rationale: typeof data.rationale === "string" ? data.rationale : typeof data.reason === "string" ? data.reason : "No adjudication rationale supplied.",
    flags: stringArray(data.flags)
  };
}

function isDecision(value: string): value is AdjudicationDecision {
  return value === "ACCEPT" || value === "ACCEPT_WITH_WARNINGS" || value === "REQUIRE_BUGFIX" || value === "ESCALATE_TO_USER";
}

function normalizeDecision(value: unknown): AdjudicationDecision {
  if (typeof value !== "string") return "ESCALATE_TO_USER";
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, AdjudicationDecision> = {
    ACCEPTED: "ACCEPT",
    ACCEPT_WARNING: "ACCEPT_WITH_WARNINGS",
    ACCEPT_WARNINGS: "ACCEPT_WITH_WARNINGS",
    BUGFIX: "REQUIRE_BUGFIX",
    REQUIRE_FIX: "REQUIRE_BUGFIX",
    NEEDS_BUGFIX: "REQUIRE_BUGFIX",
    HUMAN: "ESCALATE_TO_USER",
    ESCALATE: "ESCALATE_TO_USER",
    USER: "ESCALATE_TO_USER"
  };
  const decision = aliases[normalized] ?? normalized;
  return isDecision(decision) ? decision : "ESCALATE_TO_USER";
}

function normalizeStatus(value: unknown): BatchResult["status"] {
  if (typeof value !== "string") return "FAILURE";
  const normalized = value.trim().toUpperCase();
  if (normalized === "PASS" || normalized === "PASSED" || normalized === "OK") return "SUCCESS";
  if (normalized === "FAIL" || normalized === "FAILED") return "FAILURE";
  return ["SUCCESS", "PARTIAL_SUCCESS", "FAILURE", "BUG_FOUND", "INVALID_RESULT"].includes(normalized) ? normalized as BatchResult["status"] : "FAILURE";
}

function boolAlias(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return /^(true|yes|required|1)$/i.test(value);
  return fallback;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item : item && typeof item === "object" ? String((item as Record<string, unknown>).message ?? (item as Record<string, unknown>).code ?? "") : "").filter(Boolean);
  if (typeof value === "string") return [value];
  return [];
}
