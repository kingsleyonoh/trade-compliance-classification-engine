import path from "node:path";
import type { BatchResult, TestEvidence } from "./types.js";
import { normalizeTests, readBatchResult } from "./result-contracts.js";
import { isRuntimeOwnedPath } from "./path-policy.js";

export async function mergeRecoveredResultFromDisk(cwd: string, batchNumber: number, implementation: BatchResult, bugfix: BatchResult): Promise<BatchResult> {
  const correctedManifest = correctedSourceManifestPath(batchNumber, implementation, bugfix);
  if (!correctedManifest) return mergeRecoveredResult(implementation, bugfix);
  const corrected = await readBatchResult(path.join(cwd, correctedManifest));
  if (corrected.status === "INVALID_RESULT" || (corrected.status !== "SUCCESS" && corrected.failureType === "INVALID_RESULT")) {
    return mergeRecoveredResult(implementation, { ...bugfix, filesChanged: (bugfix.filesChanged ?? []).filter((changedFile) => normalizeRel(changedFile) !== correctedManifest) });
  }
  const bugfixWithoutManifestRewrite: BatchResult = {
    ...bugfix,
    filesChanged: (bugfix.filesChanged ?? []).filter((changedFile) => normalizeRel(changedFile) !== correctedManifest)
  };
  return mergeRecoveredResult(corrected, bugfixWithoutManifestRewrite);
}

export function mergeRecoveredResult(implementation: BatchResult, bugfix: BatchResult): BatchResult {
  const correctedManifest = Boolean(correctedSourceManifestPath(implementation.batch, implementation, bugfix) ?? touchesAnySourceManifest(implementation, bugfix));
  const removedStalePaths = new Set([...stalePathsFixedByBugfix(implementation), ...stalePathsFixedByBugfix(bugfix)]);
  const filesChanged = mergeFilesChanged(implementation, bugfix, correctedManifest, removedStalePaths);
  const artifacts = mergeArtifacts(implementation, bugfix, removedStalePaths);
  return {
    ...implementation,
    schemaVersion: 1,
    status: "SUCCESS",
    failureType: undefined,
    itemsCompleted: [...new Set([...(implementation.itemsCompleted ?? []), ...(bugfix.itemsCompleted ?? [])])],
    filesChanged,
    tests: mergeRecoveredTests(implementation.tests, bugfix.tests, bugfixCanReplaceRedEvidence(bugfix)),
    wiring: mergeRecoveredWiring(implementation.wiring, bugfix.wiring, bugfixHasSemanticChange(bugfix)),
    projectLocalChecks: mergeProjectLocalChecks(implementation.projectLocalChecks, bugfix.projectLocalChecks),
    businessLogic: mergeBusinessLogic(implementation.businessLogic, bugfix.businessLogic, bugfixHasSemanticChange(bugfix)),
    localOnlyFiles: mergeLocalOnlyFiles(implementation.localOnlyFiles, bugfix.localOnlyFiles, bugfixHasSemanticChange(bugfix)),
    inbox: bugfix.inbox ?? implementation.inbox,
    artifacts,
    flags: recoveredFlags(implementation, bugfix, bugfixHasSemanticChange(bugfix)),
    commit: null
  };
}

function mergeFilesChanged(implementation: BatchResult, bugfix: BatchResult, correctedManifest: boolean, removedStalePaths: Set<string>): string[] {
  const source = correctedManifest ? (bugfix.filesChanged ?? []) : [...(implementation.filesChanged ?? []), ...(bugfix.filesChanged ?? [])];
  const bugfixPaths = new Set((bugfix.filesChanged ?? []).map((file) => normalizeRel(file)));
  return [...new Set(source)]
    .filter((file) => !isRuntimeOwnedPath(normalizeRel(file)))
    .filter((file) => !removedStalePaths.has(normalizeRel(file)) || bugfixPaths.has(normalizeRel(file)));
}

function mergeArtifacts(implementation: BatchResult, bugfix: BatchResult, removedStalePaths: Set<string>): BatchResult["artifacts"] {
  return [...(implementation.artifacts ?? []), ...(bugfix.artifacts ?? [])]
    .filter((artifact) => !removedStalePaths.has((artifact.path ?? "").replace(/\\/g, "/")));
}

export function mergeRecoveredWiring(implementation: BatchResult["wiring"], bugfix: BatchResult["wiring"], allowBugfixWiringEvidence = true): BatchResult["wiring"] {
  if (!bugfix || !allowBugfixWiringEvidence) return implementation;
  if (!implementation?.entrypoints?.length) return normalizeWiring(bugfix);
  const byPath = new Map<string, { type: string; path: string; verifiedBy: string }>();
  for (const entry of implementation.entrypoints ?? []) {
    const normalized = normalizeWiringEntry(entry);
    if (normalized) byPath.set(normalized.path, normalized);
  }
  for (const entry of bugfix.entrypoints ?? []) {
    const normalized = normalizeWiringEntry(entry);
    if (!normalized) continue;
    const prior = byPath.get(normalized.path);
    byPath.set(normalized.path, {
      type: normalized.type || prior?.type || "entrypoint",
      path: normalized.path,
      verifiedBy: normalized.verifiedBy || prior?.verifiedBy || ""
    });
  }
  const entrypoints = [...byPath.values()];
  const required = Boolean(implementation.required || bugfix.required || entrypoints.length);
  return { ...implementation, ...bugfix, required, entrypoints };
}

function normalizeWiring(wiring: BatchResult["wiring"]): BatchResult["wiring"] {
  if (!wiring) return wiring;
  return { ...wiring, entrypoints: (wiring.entrypoints ?? []).map(normalizeWiringEntry).filter((entry): entry is { type: string; path: string; verifiedBy: string } => Boolean(entry)) };
}

function normalizeWiringEntry(entry: unknown): { type: string; path: string; verifiedBy: string } | null {
  if (typeof entry === "string") return { type: "", path: entry, verifiedBy: "" };
  if (!entry || typeof entry !== "object") return null;
  const value = entry as { type?: unknown; path?: unknown; verifiedBy?: unknown };
  if (typeof value.path !== "string") return null;
  return {
    type: typeof value.type === "string" ? value.type : "entrypoint",
    path: value.path,
    verifiedBy: typeof value.verifiedBy === "string" ? value.verifiedBy : ""
  };
}

export function mergeRecoveredTests(implementation: BatchResult["tests"], bugfix: BatchResult["tests"], allowBugfixRedEvidence = true): BatchResult["tests"] {
  const normalizedBugfix = normalizeTests(bugfix);
  if (!normalizedBugfix) return implementation;
  return {
    ...implementation,
    ...normalizedBugfix,
    red: allowBugfixRedEvidence ? normalizedBugfix.red ?? implementation?.red : implementation?.red,
    green: strongerTestEvidence(implementation?.green, normalizedBugfix.green),
    regression: strongerTestEvidence(implementation?.regression, normalizedBugfix.regression),
    e2e: strongerE2eEvidence(implementation?.e2e, normalizedBugfix.e2e)
  };
}

function bugfixCanReplaceRedEvidence(bugfix: BatchResult): boolean {
  return (bugfix.filesChanged ?? []).some((file) => isTestLikePath(normalizeRel(file)) && !isRuntimeOnlyArtifactPath(normalizeRel(file)));
}

function bugfixHasSemanticChange(bugfix: BatchResult): boolean {
  return (bugfix.filesChanged ?? []).some((file) => !isRuntimeOnlyArtifactPath(normalizeRel(file)));
}

function isRuntimeOnlyArtifactPath(file: string): boolean {
  return /^\.yolo\/(?:batch-results|gates|runtime|logs|events)\//i.test(file) || isRuntimeOwnedPath(file);
}

function isTestLikePath(file: string): boolean {
  return /(^|\/)(tests?|spec|__tests__|cypress|playwright)(\/|$)/i.test(file) || /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i.test(file);
}

function strongerTestEvidence(existing: TestEvidence | undefined, candidate: TestEvidence | undefined): TestEvidence | undefined {
  if (!candidate) return existing;
  if (!existing) return candidate;
  const existingRunnablePass = isRunnableTestEvidence(existing) && existing.exitCode === 0;
  const candidateRunnablePass = isRunnableTestEvidence(candidate) && candidate.exitCode === 0;
  if (existingRunnablePass && !candidateRunnablePass) return existing;
  return candidate;
}

function strongerE2eEvidence(existing: (TestEvidence & { required: boolean }) | undefined, candidate: (TestEvidence & { required: boolean }) | undefined): (TestEvidence & { required: boolean }) | undefined {
  if (!candidate) return existing;
  if (!existing) return candidate;
  const existingRunnablePass = isRunnableTestEvidence(existing) && existing.exitCode === 0;
  const candidateRunnablePass = isRunnableTestEvidence(candidate) && candidate.exitCode === 0;
  if (existingRunnablePass && !candidateRunnablePass) return existing;
  return candidate;
}

function isRunnableTestEvidence(evidence: { command?: string }): boolean {
  const command = evidence.command?.trim() ?? "";
  return command.length > 0 && !/^(?:N\/?A|not applicable|not run|skipped|none|manual)$/i.test(command);
}

function mergeProjectLocalChecks(implementation: BatchResult["projectLocalChecks"], bugfix: BatchResult["projectLocalChecks"]): BatchResult["projectLocalChecks"] {
  if (!bugfix) return implementation;
  return {
    evaluated: Math.max(implementation?.evaluated ?? 0, bugfix.evaluated ?? 0),
    triggered: [...new Set([...(implementation?.triggered ?? []), ...(bugfix.triggered ?? [])])],
    notes: [implementation?.notes, bugfix.notes].filter(Boolean).join(" | ") || undefined
  };
}

export function mergeBusinessLogic(implementation: BatchResult["businessLogic"], bugfix: BatchResult["businessLogic"], allowBugfixBusinessEvidence = true): BatchResult["businessLogic"] {
  if (!bugfix || !allowBugfixBusinessEvidence) return implementation;
  if (!implementation) return bugfix;
  return {
    rule: richerText(bugfix.rule, implementation.rule),
    sourceOfTruth: richerText(bugfix.sourceOfTruth, implementation.sourceOfTruth),
    observablePaths: [...new Set([...(implementation.observablePaths ?? []), ...(bugfix.observablePaths ?? [])])],
    test: richerText(bugfix.test, implementation.test)
  };
}

function richerText(candidate: string | undefined, fallback: string | undefined): string {
  if (!candidate) return fallback ?? "";
  if (!fallback) return candidate;
  return candidate.length >= fallback.length || /fixed|verified|regression|e2e|passed/i.test(candidate) ? candidate : fallback;
}

function mergeLocalOnlyFiles(implementation: string[] | undefined, bugfix: string[] | undefined, allowBugfixLocalOnlyEvidence: boolean): string[] {
  if (allowBugfixLocalOnlyEvidence && bugfix !== undefined) return [...new Set(bugfix)];
  return [...new Set(implementation ?? [])];
}

function recoveredFlags(implementation: BatchResult, bugfix: BatchResult, semanticBugfix: boolean): string[] {
  const sourceFailure = implementation.failureType;
  const sourceFlags = (implementation.flags ?? []).map((flag) => demoteRecoveredSourceFlag(flag, sourceFailure));
  const evidenceBackedRuntimeRecovery = !semanticBugfix && bugfixHasPassingCommandEvidence(bugfix);
  const bugfixFlags = (bugfix.flags ?? []).map((flag) => normalizeRecoveredBugfixFlag(flag, semanticBugfix, evidenceBackedRuntimeRecovery)).filter((flag): flag is string => Boolean(flag));
  return [...new Set([
    ...(sourceFailure ? [`RECOVERED_FROM:${sourceFailure}`] : []),
    ...sourceFlags,
    "BUGFIX_RECOVERY_APPLIED",
    ...bugfixFlags
  ].filter(Boolean))];
}

function demoteRecoveredSourceFlag(flag: string, failureType?: string): string {
  if (isActiveFailureFlag(flag, failureType)) return `RECOVERED_SOURCE_FLAG:${flag}`;
  return flag;
}

function normalizeRecoveredBugfixFlag(flag: string, semanticBugfix: boolean, evidenceBackedRuntimeRecovery = false): string | null {
  if (/^RESULT_STATUS_FAILURE:/.test(flag)) return `RECOVERED_BUGFIX_HISTORY:${flag}`;
  if (!semanticBugfix && isSemanticFixFlag(flag) && !(evidenceBackedRuntimeRecovery && isRuntimeRecoveryEvidenceFlag(flag))) return null;
  return flag;
}

function bugfixHasPassingCommandEvidence(bugfix: BatchResult): boolean {
  return Object.values(bugfix.tests ?? {}).some((evidence) => evidence && typeof evidence === "object" && "exitCode" in evidence && Number(evidence.exitCode) === 0 && typeof evidence.command === "string" && evidence.command.trim().length > 0);
}

function isRuntimeRecoveryEvidenceFlag(flag: string): boolean {
  return /^BUSINESS_LOGIC_EVIDENCE_.+_(?:PASS|PASSED|VERIFIED)$/i.test(flag)
    || /^(?:BUSINESS_LOGIC_DRIFT_SWEEP_PASS|TENANT_FAIRNESS_RATE_LIMIT_RETRY_PASS|GENERATED_FILE_DRIFT_REVERTED)$/i.test(flag);
}

function isSemanticFixFlag(flag: string): boolean {
  return /(?:_FIXED|_PASS|_PASSED|_ALLOWLISTED|_SATISFIED|_ENFORCED|_REJECTED|_COVERED)$/i.test(flag);
}

function isActiveFailureFlag(flag: string, failureType?: string): boolean {
  if (!flag) return false;
  if (failureType && flag === failureType) return true;
  if (/^RESULT_STATUS_FAILURE:/.test(flag)) return true;
  if (/^(BUG_FOUND|INVALID_RESULT|FAILURE_WITHOUT_FAILURE_TYPE|COMMIT_CLAIMED_BY_AGENT)$/.test(flag)) return true;
  if (/^(BLOCKED_PATH|PROTECTED_PATH|SECRET_PATTERN|ARTIFACT_MISSING|CHANGED_FILE_MISSING|LOCAL_ONLY_FILE_MISSING|WIRING_VERIFIER_FILE_MISSING):/.test(flag)) return true;
  if (/(^|_)(FAILURE|FAILED|REJECTED|MISSING|GAP|INVALID|BLOCKING|FINDINGS)(_|$|:)/.test(flag) && !/(^|_)(FIXED|PASS|PASSED|NORMALIZED|RECORDED|NOT_APPLICABLE)(_|$|:)/.test(flag)) return true;
  return false;
}

function correctedSourceManifestPath(batchNumber: number, source: BatchResult, bugfix: BatchResult): string | null {
  const padded = String(batchNumber).padStart(3, "0");
  const sourceSuffix = source.agent === "audit" ? "audit" : source.agent === "validate" ? "validate" : "implement";
  const expected = `.yolo/batch-results/batch-${padded}-${sourceSuffix}.json`;
  return bugfix.filesChanged?.map(normalizeRel).includes(expected) ? expected : null;
}

function touchesAnySourceManifest(source: BatchResult, bugfix: BatchResult): boolean {
  const sourceSuffix = source.agent === "audit" ? "audit" : source.agent === "validate" ? "validate" : "implement";
  const padded = String(source.batch).padStart(3, "0");
  const expected = `.yolo/batch-results/batch-${padded}-${sourceSuffix}.json`;
  return Boolean(bugfix.filesChanged?.map(normalizeRel).some((file) => file === expected));
}

function normalizeRel(file: string): string {
  const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized.startsWith(".yolo/") ? normalized : normalized.replace(/^.*(\.yolo\/)/, ".yolo/");
}

function stalePathsFixedByBugfix(bugfix: BatchResult): Set<string> {
  const paths = new Set<string>();
  for (const flag of bugfix.flags ?? []) {
    const match = /(?:CHANGED_FILE_MISSING|ARTIFACT_MISSING):([^\s,]+) fixed\b/.exec(flag);
    if (match) paths.add(match[1].replace(/\\/g, "/"));
  }
  for (const flag of bugfix.flags ?? []) {
    const match = /^CHANGED_FILE_MISSING:([^\s,]+)/.exec(flag);
    const missing = match?.[1]?.replace(/\\/g, "/");
    if (missing) paths.add(missing);
  }
  return paths;
}
