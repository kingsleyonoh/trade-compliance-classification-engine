const BLOCKING_CODE = /(?:FAILURE|FAILED|REJECTED|MISSING|GAP|INVALID|BLOCKING|DRIFT|LEAKAGE|FINDINGS|UNWIRED|UNVERIFIED|NOT_WIRED|MISMATCH|UNVALIDATED)/i;
const POSITIVE_CODE_SUFFIX = /_(?:PASS|PASSED|FIXED|RECOVERED|RESOLVED|WIRED|PROPAGATED|SATISFIED|COVERED|ENFORCED|VERIFIED|ALLOWLISTED|NORMALIZED|RECORDED|EVIDENCE_RECORDED|REVERTED|PRESERVED|NOT_APPLICABLE|NO_LEAKS|UNTOUCHED|NO_FINDINGS|NO_BLOCKING_FINDINGS|RECORDED_AS_MANUAL_NOT_FINDINGS)$/i;
const FIX_EVIDENCE_SUFFIX = /_(?:FIXED|RECOVERED|RESOLVED|PASS|PASSED|ALLOWLISTED|SATISFIED|ENFORCED|COVERED|WIRED|VERIFIED|PROPAGATED|REVERTED|PRESERVED)$/i;
const NEGATIVE_REJECTION_CODE = /^(?:VALIDATOR|JOURNAL|RUNTIME_GATES|BUGFIX|AUDIT|ADVERSARIAL_VALIDATION|RESULT_STATUS|CONTRACT|GATE|SECURITY|SECRET|AUTH|TENANT|EXTERNAL_OPS)_REJECTED(?:_|$)/i;
const BUSINESS_RULE_REJECTED_CODE = /^(?:CROSS_ORDER|BUSINESS_RULE|DOMAIN_RULE|INPUT_RULE|PAYMENT_RULE|MATCHING_RULE|VALIDATION_CASE)_.*_REJECTED$/i;
const DANGEROUS_NON_BLOCKING_CODE = /^(?:VALIDATOR|JOURNAL|RUNTIME_GATES|BUGFIX|AUDIT|ADVERSARIAL_VALIDATION|RESULT_STATUS|CONTRACT|GATE|SECURITY|SECRET|AUTH|TENANT|EXTERNAL_OPS|COMMAND|ARTIFACT)(?:_.*)?_NON_BLOCKING$/i;

export function flagCode(flag: string): string {
  return flag.replace(/^(?:RECOVERED_SOURCE_FLAG:)+/i, "").split(":")[0]?.trim() ?? flag.trim();
}

export function isRuntimeRecoveryMetaFlag(flag: string): boolean {
  const code = flagCode(flag);
  return /^(?:BUGFIX_RECOVERY_APPLIED|RUNTIME_GATES_REJECTED_RECOVERED|RECOVERED_FROM|RECOVERED_BUGFIX_HISTORY)$/i.test(code);
}

export function isWarningFlag(flag: string, gate?: string): boolean {
  const code = flagCode(flag);
  if (code === "QUALITY_WARNING") return true;
  if (code === "NO_ACTIVE_PROJECT_LOCAL_CHECKS") return true;
  if (code === "IMPECCABLE_DETECTOR_UNAVAILABLE") return true;
  if (code === "WORKFLOW_INFERRED_VALIDATE_PRD_RUNTIME_PLACEHOLDER_UNAVAILABLE") return true;
  if (code === "PHASE_SCOPE_LIMITED_TO_PHASE_1_CLOSEOUT") return true;
  if (code === "FUTURE_PHASE_SUCCESS_CRITERIA_RECORDED_AS_MANUAL_NOT_FINDINGS") return true;
  if (code === "MODULARITY_RULE_FILE_LIMIT_VIOLATION" && isTemplateManagedMetadataDetail(flag)) return true;
  if (code === "TENANT_NEUTRALITY_SWEEP_NO_LEAKS") return true;
  if (/(?:^|_)NON_BLOCKING(?:_|$)/i.test(code) && !DANGEROUS_NON_BLOCKING_CODE.test(code)) return true;
  if (gate === "business-logic" && code === "BUSINESS_LOGIC_UNTOUCHED_DOCS") return true;
  return flag.startsWith("QUALITY_WARNING:") || code.endsWith("_LOW_FINDING") || code.endsWith("_MEDIUM_FINDING");
}

export function isPositiveFlag(flag: string): boolean {
  const code = flagCode(flag);
  if (/^(?:NO_FINDINGS|NO_BLOCKING_FINDINGS)$/i.test(code)) return true;
  if (code === "CHANGED_FILE_MISSING_METADATA_REMOVED" && isTemplateManagedMetadataDetail(flag)) return true;
  if (code === "PROTECTED_PATH_METADATA_REMOVED") return true;
  if (code === "MODULARITY_RULE_FILE_WARNING_ROUTED_NON_BLOCKING") return true;
  if (code === "NO_PRODUCTION_SOURCE_REFACTOR") return true;
  if (NEGATIVE_REJECTION_CODE.test(code)) return false;
  if (/_NOT_WIRED$/i.test(code)) return false;
  if (code.endsWith("_REJECTED")) return BUSINESS_RULE_REJECTED_CODE.test(code);
  if (/^ENTRYPOINT_(?:VERIFIED|WIRED)_/i.test(code)) return true;
  return POSITIVE_CODE_SUFFIX.test(code);
}

export function isBlockingFlag(flag: string): boolean {
  const code = flagCode(flag);
  if (!code || flag.startsWith("RECOVERED_")) return false;
  if (isRuntimeRecoveryMetaFlag(flag) || isWarningFlag(flag) || isPositiveFlag(flag)) return false;
  return BLOCKING_CODE.test(code);
}

function isTemplateManagedMetadataDetail(flag: string): boolean {
  const normalized = flag.replace(/\\/g, "/");
  const detail = normalized.includes(":") ? normalized.slice(normalized.indexOf(":") + 1).trim() : "";
  if (!detail) return false;
  return detail.startsWith(".agent/rules/")
    || detail.startsWith(".agent/guides/")
    || detail.startsWith(".agent/workflows/")
    || detail.startsWith(".agent/agents/")
    || detail === "AGENTS.md"
    || detail === "CLAUDE.md"
    || detail === "docs/progress.md";
}

export function fixedFindingPrefix(flag: string): string | null {
  const clean = flag.replace(/^(?:RECOVERED_SOURCE_FLAG:)+/i, "").trim();
  const code = flagCode(flag);
  const detail = clean.includes(":") ? clean.slice(clean.indexOf(":")) : "";
  if (/_VERIFIED$/i.test(code)) return `${code.replace(/_VERIFIED$/i, "_UNVERIFIED")}${detail}`;
  if (/_WIRED$/i.test(code)) return `${code.replace(/_WIRED$/i, "_UNWIRED")}${detail}`;
  return FIX_EVIDENCE_SUFFIX.test(code) ? code.replace(FIX_EVIDENCE_SUFFIX, "") : null;
}
