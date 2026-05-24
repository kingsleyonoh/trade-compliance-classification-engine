import type { Batch, BatchResult, GateResult } from "../types.js";

const BUSINESS_TAGS = new Set(["[API]", "[UI]", "[JOB]", "[INTEGRATION]", "[DATA]", "[MODEL]", "[DB]"]);

export function validateBusinessLogic(batch: Batch, result: BatchResult): GateResult {
  const evidence = result.businessLogic;
  const required = batch.items.some((item) => BUSINESS_TAGS.has(item.tag)) || hasBusinessArtifacts(result);
  if (!required) return { name: "business-logic", passed: true, flags: [] };
  if (evidence && isExplicitlyUntouched(evidence)) return { name: "business-logic", passed: true, flags: [] };

  const flags = [];
  if (!evidence) flags.push("MISSING_BUSINESS_LOGIC_EVIDENCE");
  if (evidence && !evidence.rule) flags.push("BUSINESS_LOGIC_RULE_MISSING");
  if (evidence && !evidence.sourceOfTruth) flags.push("BUSINESS_LOGIC_SOURCE_OF_TRUTH_MISSING");
  if (evidence && !evidence.test) flags.push("BUSINESS_LOGIC_TEST_MISSING");
  if (evidence && (!Array.isArray(evidence.observablePaths) || evidence.observablePaths.length === 0)) flags.push("BUSINESS_LOGIC_OBSERVABLE_PATHS_MISSING");
  return { name: "business-logic", passed: flags.length === 0, flags };
}

function isExplicitlyUntouched(evidence: unknown): boolean {
  return Boolean(evidence && typeof evidence === "object" && "touched" in evidence && (evidence as { touched?: unknown }).touched === false);
}

function hasBusinessArtifacts(result: BatchResult): boolean {
  return (result.artifacts ?? []).some((artifact) => {
    if (!artifact || typeof artifact !== "object") return false;
    const kind = String((artifact as Record<string, unknown>).kind ?? (artifact as Record<string, unknown>).type ?? "");
    return /report|export|invoice|email|pdf|domain|business/i.test(kind);
  });
}
