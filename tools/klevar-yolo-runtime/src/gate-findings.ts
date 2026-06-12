import type { GateResult } from "./types.js";
import { flagCode, isPositiveFlag, isWarningFlag } from "./flag-classification.js";
import { classifyRuntimePath, matchesAnyPolicyPattern } from "./path-policy.js";
import { defaultConfig } from "./config.js";

export type FindingSeverity = "hard_fail" | "ambiguous" | "warning" | "pass";

export interface GateFinding {
  gate: string;
  code: string;
  severity: FindingSeverity;
  message: string;
  evidence?: string;
  path?: string;
  command?: string;
  recommendedAction?: "bugfix" | "adjudicate" | "record" | "human";
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
      else if (finding.severity === "warning") report.warnings.push(finding);
    }
  }
  return report;
}

function classifyFlag(gate: string, flag: string): GateFinding {
  const code = flagCode(flag);
  const severity = severityFor(gate, flag, code);
  return { gate, code, severity, message: flag, ...detailsFor(flag), recommendedAction: actionFor(gate, flag, code, severity) };
}

function detailsFor(flag: string): Pick<GateFinding, "path" | "command" | "evidence"> {
  const parts = flag.split(":");
  if (parts[0] === "COMMAND_RERUN_FAILED") return { command: parts.slice(2, -1).join(":"), evidence: parts.at(-1) };
  if (parts[0]?.startsWith("IMPECCABLE_")) return { evidence: flag, path: parts[0] === "artifact" ? parts.slice(1).join(":") : undefined };
  if (/_(?:MISSING|PATTERN)$/.test(parts[0] ?? "") || parts[0]?.includes("FILE") || parts[0]?.includes("ARTIFACT")) return { path: parts.slice(1).join(":") };
  return { evidence: flag };
}

function severityFor(gate: string, flag: string, code: string): FindingSeverity {
  if (isWarningFlag(flag, gate)) return "warning";
  if (isPositiveFlag(flag)) return "pass";
  if (isFrontendRecoveryCode(code)) return "hard_fail";
  if (code === "INVALID_FLAGS_SHAPE" || code === "INVALID_LOCAL_ONLY_FILES_SHAPE" || code === "INVALID_ARTIFACTS_SHAPE") return "ambiguous";
  if (code === "COMMAND_RERUN_FAILED" && /:e2e:(?:not run|not applicable|skipped|N\/A)\b/i.test(flag)) return "ambiguous";
  if (code === "INVALID_FILES_CHANGED_SHAPE" || code === "INVALID_ITEMS_COMPLETED_SHAPE") return "ambiguous";
  return "hard_fail";
}

function actionFor(gate: string, flag: string, code: string, severity: FindingSeverity): GateFinding["recommendedAction"] {
  if (code === "IMPECCABLE_DETECTOR_UNAVAILABLE") return "record";
  if (isNonRecoverableRuntimeFlag(flag)) return "human";
  if (isFrontendRecoveryCode(code)) return "bugfix";
  if (severity === "hard_fail") return "bugfix";
  if (severity === "ambiguous") return "adjudicate";
  return "record";
}

export function isNonRecoverableRuntimeFlag(flag: string): boolean {
  const code = flagCode(flag);
  if (isNonRecoverableRuntimeCode(code)) return true;
  if (!isMissingPathEvidenceCode(code)) return false;
  const path = flagPathPayload(flag);
  if (!path) return false;
  const classification = classifyRuntimePath(path);
  if (!classification.safe || classification.sync === "reject" || classification.sync === "ignore") return true;
  if (classification.owner === "runtime" || classification.owner === "environment" || classification.owner === "generated") return true;
  return matchesAnyPolicyPattern(classification.path, [...defaultConfig.policy.protectedPaths, ...defaultConfig.policy.blockedPaths]);
}

function isMissingPathEvidenceCode(code: string): boolean {
  return code === "CHANGED_FILE_MISSING" || code === "ARTIFACT_MISSING" || code === "LOCAL_ONLY_FILE_MISSING" || code === "WIRING_VERIFIER_FILE_MISSING";
}

function flagPathPayload(flag: string): string | null {
  const index = flag.indexOf(":");
  if (index < 0) return null;
  return flag.slice(index + 1).trim().replace(/\\/g, "/");
}

function isNonRecoverableRuntimeCode(code: string): boolean {
  return code === "PROTECTED_PATH"
    || code === "TEMPLATE_MANAGED_PROTECTED_PATH"
    || code === "BLOCKED_PATH"
    || code === "UNSAFE_PATH"
    || code === "PROTECTED_COORDINATION_FILE_MODULARITY_FINDING"
    || code === "TOOLING_HUMAN_REQUIRED_SYNC_CONTEXT";
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
