import type { Batch, BatchResult, GateResult } from "../types.js";
import { hasDishonestSkipClaim, isPassingRunnableEvidence, isRunnableEvidence } from "./evidence-policy.js";

const ENTRYPOINT_TAGS = new Set(["[API]", "[UI]", "[JOB]", "[INTEGRATION]"]);

export function needsE2e(batch: Batch): boolean {
  return batch.items.some((item) => ENTRYPOINT_TAGS.has(item.tag));
}

export function validateE2e(batch: Batch, result: BatchResult, required: boolean): GateResult {
  if (!required) return { name: "e2e", passed: true, flags: [] };
  const evidence = result.tests?.e2e;
  const flags = [];
  if (!evidence) flags.push("MISSING_E2E_EVIDENCE");
  if (evidence && !isRunnableEvidence(evidence) && !hasPassingModuleBoundaryEvidence(batch, result, evidence)) flags.push("MISSING_RUNNABLE_E2E_COMMAND");
  if (evidence && isRunnableEvidence(evidence) && evidence.exitCode !== 0) flags.push("E2E_DID_NOT_PASS");
  if (evidence && hasDishonestSkipClaim(evidence.evidence) && !isPassingRunnableEvidence(evidence) && !hasPassingModuleBoundaryEvidence(batch, result, evidence)) flags.push("E2E_DISHONEST_SKIP");
  return { name: "e2e", passed: flags.length === 0, flags };
}

function hasPassingModuleBoundaryEvidence(batch: Batch, result: BatchResult, evidence: { required?: boolean; exitCode: number; evidence: string }): boolean {
  if (evidence.required !== false || evidence.exitCode !== 0) return false;
  if (batch.items.some((item) => ["[API]", "[UI]", "[JOB]", "[INTEGRATION]"].includes(item.tag))) return false;
  const hasRunnableRegression = [result.tests?.green, result.tests?.regression].some((item) => item && isPassingRunnableEvidence(item));
  const entrypoints = result.wiring?.entrypoints ?? [];
  const verifiedModulesOnly = entrypoints.length > 0 && entrypoints.every((entry) => {
    const type = String(entry.type ?? "").toLowerCase();
    const path = String(entry.path ?? "");
    return type === "module" || /^[A-Za-z0-9_.]+\.[A-Za-z0-9_.]+/.test(path);
  });
  return hasRunnableRegression && verifiedModulesOnly;
}
