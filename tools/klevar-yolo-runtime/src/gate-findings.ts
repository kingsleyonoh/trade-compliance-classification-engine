import type { GateResult } from "./types.js";

export type FindingSeverity = "hard_fail" | "ambiguous" | "warning" | "pass";

export interface GateFinding {
  gate: string;
  code: string;
  severity: FindingSeverity;
  message: string;
  evidence?: string;
  path?: string;
  command?: string;
  recommendedAction?: "bugfix" | "adjudicate" | "record";
}

export interface GateFindingReport {
  hardFailures: GateFinding[];
  ambiguities: GateFinding[];
  warnings: GateFinding[];
}

export function classifyGateFindings(gates: GateResult[]): GateFindingReport {
  const report: GateFindingReport = { hardFailures: [], ambiguities: [], warnings: [] };
  for (const gate of gates) {
    for (const flag of gate.flags) {
      const finding = classifyFlag(gate.name, flag);
      if (finding.severity === "hard_fail") report.hardFailures.push(finding);
      else if (finding.severity === "ambiguous") report.ambiguities.push(finding);
      else report.warnings.push(finding);
    }
  }
  return report;
}

function classifyFlag(gate: string, flag: string): GateFinding {
  const code = flag.split(":")[0] ?? flag;
  const severity = severityFor(gate, flag, code);
  return { gate, code, severity, message: flag, ...detailsFor(flag), recommendedAction: actionFor(gate, code, severity) };
}

function detailsFor(flag: string): Pick<GateFinding, "path" | "command" | "evidence"> {
  const parts = flag.split(":");
  if (parts[0] === "COMMAND_RERUN_FAILED") return { command: parts.slice(2, -1).join(":"), evidence: parts.at(-1) };
  if (parts[0]?.startsWith("IMPECCABLE_")) return { evidence: flag, path: parts[0] === "artifact" ? parts.slice(1).join(":") : undefined };
  if (/_(?:MISSING|PATTERN)$/.test(parts[0] ?? "") || parts[0]?.includes("FILE") || parts[0]?.includes("ARTIFACT")) return { path: parts.slice(1).join(":") };
  return { evidence: flag };
}

function severityFor(gate: string, flag: string, code: string): FindingSeverity {
  if (code === "NO_ACTIVE_PROJECT_LOCAL_CHECKS") return "warning";
  if (code === "IMPECCABLE_DETECTOR_UNAVAILABLE") return "warning";
  if (isFrontendRecoveryCode(code)) return "hard_fail";
  if (code === "INVALID_FLAGS_SHAPE" || code === "INVALID_LOCAL_ONLY_FILES_SHAPE" || code === "INVALID_ARTIFACTS_SHAPE") return "ambiguous";
  if (code === "COMMAND_RERUN_FAILED" && /:e2e:(?:not run|not applicable|skipped|N\/A)\b/i.test(flag)) return "ambiguous";
  if (code === "INVALID_FILES_CHANGED_SHAPE" || code === "INVALID_ITEMS_COMPLETED_SHAPE") return "ambiguous";
  if (code === "WORKFLOW_INFERRED_VALIDATE_PRD_RUNTIME_PLACEHOLDER_UNAVAILABLE") return "warning";
  if (code === "PHASE_SCOPE_LIMITED_TO_PHASE_1_CLOSEOUT" || code === "FUTURE_PHASE_SUCCESS_CRITERIA_RECORDED_AS_MANUAL_NOT_FINDINGS") return "warning";
  if (code === "TENANT_NEUTRALITY_SWEEP_NO_LEAKS") return "warning";
  if (gate === "business-logic" && code === "BUSINESS_LOGIC_UNTOUCHED_DOCS") return "warning";
  return "hard_fail";
}

function actionFor(gate: string, code: string, severity: FindingSeverity): GateFinding["recommendedAction"] {
  if (code === "IMPECCABLE_DETECTOR_UNAVAILABLE") return "record";
  if (isFrontendRecoveryCode(code)) return "bugfix";
  if (severity === "hard_fail") return "bugfix";
  if (severity === "ambiguous") return "adjudicate";
  return "record";
}

function isFrontendRecoveryCode(code: string): boolean {
  return code === "IMPECCABLE_DETECTOR_FINDINGS"
    || code === "IMPECCABLE_DETECTOR_FAILED"
    || code === "IMPECCABLE_DETECTOR_NOT_CONFIGURED"
    || code === "MISSING_PRODUCT_CONTEXT"
    || code === "MISSING_DESIGN_CONTEXT"
    || code === "MISSING_FRONTEND_IMPECCABLE_AUDIT_PASS"
    || code === "MISSING_FRONTEND_IMPECCABLE_POLISH_PASS"
    || code === "FRONTEND_IMPECCABLE_BLOCKING_FINDINGS";
}
