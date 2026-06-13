import path from "node:path";
import { exists, readText, writeText } from "./util/fs.js";
import type { Batch, BatchResult, GateResult, TestEvidence } from "./types.js";
import { fixedFindingPrefix, flagCode, isBlockingFlag, isPositiveFlag, isWarningFlag } from "./flag-classification.js";

export type FindingStatus = "open" | "fixed" | "stale" | "accepted" | "human";
export type RiskClass = "low" | "medium" | "high" | "critical";

export interface RuntimeFinding {
  id: string;
  source: string;
  status: FindingStatus;
  evidence: string[];
  lastCheckedAt: string;
}

export interface RuntimeCommandEvidence {
  phase: string;
  command: string;
  exitCode: number;
  source: string;
  completedAt: string;
}

export interface RuntimeClosureTrace {
  findingId: string;
  from: FindingStatus;
  to: FindingStatus;
  cause: string;
  evidence: string[];
  at: string;
}

export interface RuntimeOpenExplanation {
  findingId: string;
  reason: string;
  evidence: string[];
  at: string;
}

export interface RuntimeBatchState {
  schemaVersion: 1;
  batch: number;
  selectedItems: string[];
  changedFiles: string[];
  risk: { class: RiskClass; reasons: string[] };
  currentResult: BatchResult;
  findings: RuntimeFinding[];
  commands: RuntimeCommandEvidence[];
  gates: Record<string, { passed: boolean; flags: string[] }>;
  closureTraces?: RuntimeClosureTrace[];
  openExplanations?: RuntimeOpenExplanation[];
  updatedAt: string;
}

const INVALID_PLACEHOLDER = /^(?:unknown|n\/?a|not applicable|none|manual|tbd|todo|-)$/i;

export async function loadRuntimeBatchState(cwd: string, batch: Batch, fallback: BatchResult): Promise<RuntimeBatchState> {
  const file = statePath(cwd, batch.number);
  if (await exists(file)) {
    try {
      return JSON.parse(await readText(file)) as RuntimeBatchState;
    } catch {
      // Rebuild from fallback below.
    }
  }
  return emptyRuntimeBatchState(batch, fallback);
}

export async function writeRuntimeBatchState(cwd: string, state: RuntimeBatchState): Promise<void> {
  const now = new Date().toISOString();
  const findings = normalizeCanonicalFindings(state.findings, now);
  await writeText(statePath(cwd, state.batch), JSON.stringify({ ...state, findings, openExplanations: explainOpenFindings({ ...state, findings }, now), updatedAt: now }, null, 2) + "\n");
}

export async function importAgentResultToState(cwd: string, batch: Batch, source: string, raw: BatchResult, previous?: RuntimeBatchState): Promise<RuntimeBatchState> {
  const base = previous ?? await loadRuntimeBatchState(cwd, batch, raw);
  const result = canonicalizeBatchResultForRuntime(batch, raw, base.findings);
  const beforeFindings = base.findings;
  const reconciled = reconcileFindings([...base.findings, ...findingsFromResult(source, result)], result, source);
  const closedBySuccessfulValidation = closeFindingsOnSuccessfulValidation(reconciled, result, source);
  const findings = normalizeCanonicalFindings(rebuildActiveFindingsFromTrustedLatestEvidence(closeAggregateFindings(closedBySuccessfulValidation), result, source));
  const commands = [...base.commands, ...commandsFromResult(source, result)];
  const now = new Date().toISOString();
  const state: RuntimeBatchState = {
    ...base,
    changedFiles: [...new Set([...(base.changedFiles ?? []), ...(result.filesChanged ?? [])])],
    currentResult: result,
    findings,
    commands,
    closureTraces: [...(base.closureTraces ?? []), ...closureTracesFromDiff(beforeFindings, findings, resultClosureCause(result, source), result.flags ?? [], now)],
    openExplanations: explainOpenFindings({ ...base, findings, currentResult: result }, now),
    updatedAt: now
  };
  await writeRuntimeBatchState(cwd, state);
  return state;
}

export function canonicalizeBatchResultForRuntime(batch: Batch, result: BatchResult, findings: RuntimeFinding[] = []): BatchResult {
  const fixedFindingIds = new Set(findings.filter((finding) => finding.status === "fixed" || finding.status === "stale" || finding.status === "accepted").map((finding) => finding.id));
  const bugfixFlags = new Set((result.flags ?? []).map(fixedFindingPrefix).filter((flag): flag is string => Boolean(flag)));
  const flags = (result.flags ?? [])
    .filter((flag) => !invalidPlaceholder(flag))
    .map((flag) => fixedFindingIds.has(flag) || bugfixFlags.has(flag) ? `RECOVERED_SOURCE_FLAG:${flag}` : flag)
    .filter((flag) => !isStaleBlockingFlag(flag, bugfixFlags));
  return {
    ...result,
    schemaVersion: 1,
    batch: result.batch || batch.number,
    filesChanged: [...new Set((result.filesChanged ?? []).filter((file) => !invalidPlaceholder(file)))],
    artifacts: normalizeArtifacts(result.artifacts),
    flags
  };
}

export function recordGateState(state: RuntimeBatchState, gates: GateResult[]): RuntimeBatchState {
  const now = new Date().toISOString();
  const next = { ...state.gates };
  for (const gate of gates) next[gate.name] = { passed: gate.passed, flags: gate.flags };
  const transitioned = transitionFindingsForGates(state, gates, now);
  const findings = normalizeCanonicalFindings(transitioned.findings, now);
  return { ...transitioned, findings, gates: next, openExplanations: explainOpenFindings({ ...transitioned, findings }, now), updatedAt: now };
}

export function transitionFindingsForGates(state: RuntimeBatchState, gates: GateResult[], now = new Date().toISOString()): RuntimeBatchState {
  const beforeFindings = state.findings;
  const byId = new Map(state.findings.map((finding) => [finding.id, finding]));
  const passedFlags = new Set<string>();
  for (const gate of gates) {
    const hardFlags = gate.flags.filter((flag) => !isWarningFlag(flag, gate.name) && !isPositiveFlag(flag) && !flag.startsWith("RECOVERED_"));
    const hasFixFlags = gate.flags.some((flag) => fixedFindingPrefix(flag) || isPositiveFlag(flag));
    const warningOnly = gate.flags.length > 0 && gate.flags.every((flag) => isWarningFlag(flag, gate.name));
    if (gate.passed && hardFlags.length === 0 && !warningOnly) {
      for (const prior of state.gates[gate.name]?.flags ?? []) passedFlags.add(prior);
      for (const finding of state.findings) if (finding.source === `gate:${gate.name}`) passedFlags.add(finding.id);
    }
    if (!gate.passed && gate.flags.every((flag) => isWarningFlag(flag, gate.name))) continue;
    for (const flag of hardFlags) {
      const existing = byId.get(flag);
      byId.set(flag, { id: flag, source: `gate:${gate.name}`, status: existing?.status ?? "open", evidence: [...new Set([...(existing?.evidence ?? []), ...gate.flags])], lastCheckedAt: now });
    }
    if (hasFixFlags) {
      for (const [id, finding] of byId.entries()) if (hasFixEvidenceFromFlags(gate.flags, id)) byId.set(id, { ...finding, status: "fixed", lastCheckedAt: now });
    }
  }
  const transitioned = [...byId.values()].map((finding) => {
    if (finding.status !== "open") return finding;
    if (passedFlags.has(finding.id) || hasFixEvidence(state.currentResult, finding.id)) return { ...finding, status: "fixed" as const, lastCheckedAt: now };
    return finding;
  });
  const next = rebuildActiveFindingsFromTrustedLatestEvidence(closeAggregateFindings(transitioned), state.currentResult, "gate");
  const gateEvidence = gates.flatMap((gate) => gate.flags.map((flag) => `${gate.name}:${flag}`));
  return { ...state, findings: next, closureTraces: [...(state.closureTraces ?? []), ...closureTracesFromDiff(beforeFindings, next, "gate-reconciliation", gateEvidence, now)], updatedAt: now };
}

export function blockingOpenFindings(state: RuntimeBatchState): RuntimeFinding[] {
  return state.findings.filter((finding) => finding.status === "open" && !isWarningFlag(finding.id) && !isPositiveFlag(finding.id));
}

export function findingSummary(state: RuntimeBatchState): Record<FindingStatus, number> {
  return state.findings.reduce((summary, finding) => ({ ...summary, [finding.status]: (summary[finding.status] ?? 0) + 1 }), { open: 0, fixed: 0, stale: 0, accepted: 0, human: 0 } as Record<FindingStatus, number>);
}

export function explainOpenFindings(state: RuntimeBatchState, at = new Date().toISOString()): RuntimeOpenExplanation[] {
  return blockingOpenFindings(state).map((finding) => ({
    findingId: finding.id,
    reason: openFindingReason(state, finding),
    evidence: finding.evidence,
    at
  }));
}

function closureTracesFromDiff(before: RuntimeFinding[], after: RuntimeFinding[], defaultCause: string, evidence: string[], at: string): RuntimeClosureTrace[] {
  const prior = new Map(before.map((finding) => [finding.id, finding]));
  const traces: RuntimeClosureTrace[] = [];
  for (const finding of after) {
    const previous = prior.get(finding.id);
    if (!previous || previous.status === finding.status || finding.status === "open") continue;
    traces.push({ findingId: finding.id, from: previous.status, to: finding.status, cause: closureCauseForFinding(finding.id, defaultCause), evidence: [...new Set([...evidence, ...finding.evidence])], at });
  }
  return traces;
}

function closureCauseForFinding(findingId: string, defaultCause: string): string {
  if (findingId === "UNWIRED_WORKER_ENTRYPOINTS") return "aggregate-wiring-closed";
  return defaultCause;
}

function resultClosureCause(result: BatchResult, source: string): string {
  if (source === "bugfix" && !(result.filesChanged ?? []).some((file) => !isRuntimeOnlyArtifactPath(file)) && hasPassingCommandEvidence(result)) return "artifact-command-evidence";
  if (source === "bugfix") return "bugfix-semantic-evidence";
  if (source === "validate") return "validate-evidence";
  return `${source}-evidence`;
}

function openFindingReason(state: RuntimeBatchState, finding: RuntimeFinding): string {
  if (state.currentResult.flags?.some((flag) => positiveFlagClosesFinding(flag, finding.id))) return "positive evidence is present but closure guard rejected it; check runtime-only command evidence and recovery merge filtering";
  if (finding.source.startsWith("gate:")) return `latest gate evidence still marks ${finding.source.slice(5)} as blocking`;
  if (isRuntimeOnlyResult(state.currentResult) && !hasPassingCommandEvidence(state.currentResult)) return "runtime-only result lacks passing command evidence required to close canonical findings";
  return "no matching accepted positive evidence has closed this finding";
}

function isRuntimeOnlyResult(result: BatchResult): boolean {
  return (result.filesChanged ?? []).length > 0 && !(result.filesChanged ?? []).some((file) => !isRuntimeOnlyArtifactPath(file));
}

export function classifyBatchRisk(batch: Batch, result?: BatchResult): RuntimeBatchState["risk"] {
  const text = [batch.type, ...batch.items.map((item) => `${item.tag} ${item.title} ${(item.affectedFiles ?? []).join(" ")}`), ...(result?.filesChanged ?? [])].join("\n").toLowerCase();
  const reasons: string[] = [];
  const critical = [/auth/, /tenant/, /security/, /secret/, /migration/, /schema/, /payment/, /permission/, /role/, /rate-limit/, /external mutation/];
  const high = [/api/, /route/, /openapi/, /database/, /db\//, /worker/, /job/, /integration/, /public contract/];
  const medium = [/ui/, /frontend/, /component/, /solver/, /planner/, /business/, /service/];
  for (const pattern of critical) if (pattern.test(text)) reasons.push(`critical:${pattern.source}`);
  if (reasons.length) return { class: "critical", reasons };
  for (const pattern of high) if (pattern.test(text)) reasons.push(`high:${pattern.source}`);
  if (reasons.length) return { class: "high", reasons };
  for (const pattern of medium) if (pattern.test(text)) reasons.push(`medium:${pattern.source}`);
  if (reasons.length) return { class: "medium", reasons };
  return { class: "low", reasons: ["no high-risk surfaces detected"] };
}

function emptyRuntimeBatchState(batch: Batch, result: BatchResult): RuntimeBatchState {
  return {
    schemaVersion: 1,
    batch: batch.number,
    selectedItems: batch.items.map((item) => item.raw || item.title),
    changedFiles: result.filesChanged ?? [],
    risk: classifyBatchRisk(batch, result),
    currentResult: canonicalizeBatchResultForRuntime(batch, result),
    findings: findingsFromResult(result.agent ?? "implement", result),
    commands: commandsFromResult(result.agent ?? "implement", result),
    gates: {},
    updatedAt: new Date().toISOString()
  };
}

function statePath(cwd: string, batch: number): string {
  return path.join(cwd, ".yolo/runtime/batches", `batch-${String(batch).padStart(3, "0")}`, "state.json");
}

function findingsFromResult(source: string, result: BatchResult): RuntimeFinding[] {
  const now = new Date().toISOString();
  const ids = new Set<string>();
  if (result.failureType) ids.add(result.failureType);
  for (const flag of result.flags ?? []) if (isBlockingFlag(flag)) ids.add(flag);
  return [...ids].map((id) => ({ id, source, status: "open" as const, evidence: evidenceForFinding(result, id), lastCheckedAt: now }));
}

function normalizeCanonicalFindings(findings: RuntimeFinding[], now = new Date().toISOString()): RuntimeFinding[] {
  return findings.map((finding) => {
    if (finding.status !== "open") return finding;
    if (!isPositiveFlag(finding.id) && !finding.id.startsWith("RECOVERED_")) return finding;
    return {
      ...finding,
      status: "fixed" as const,
      evidence: [...new Set([...finding.evidence, "positive-or-recovered-flag-not-open-canonical-finding"])],
      lastCheckedAt: now
    };
  });
}

function reconcileFindings(findings: RuntimeFinding[], result: BatchResult, source: string): RuntimeFinding[] {
  const byId = new Map<string, RuntimeFinding>();
  for (const finding of findings) byId.set(finding.id, { ...(byId.get(finding.id) ?? finding), ...finding, evidence: [...new Set([...(byId.get(finding.id)?.evidence ?? []), ...finding.evidence])] });
  const now = new Date().toISOString();
  if (source === "bugfix" && isRuntimeOnlyResult(result) && hasPassingCommandEvidence(result)) {
    for (const [id, finding] of byId.entries()) {
      if (finding.status === "open" && isRuntimeOwnedFinding(id)) {
        byId.set(id, { ...finding, status: "stale", evidence: [...new Set([...finding.evidence, "stale-runtime-owned-finding-quarantined-by-passing-recovery-command"])], lastCheckedAt: now });
      }
    }
  }
  if (!canResultCloseFindingsByFlag(result, source)) return [...byId.values()];
  for (const [id, finding] of byId.entries()) {
    if (hasFixEvidenceFromFlags(result.flags ?? [], id)) byId.set(id, { ...finding, status: "fixed", lastCheckedAt: now });
  }
  return [...byId.values()];
}

function canResultCloseFindingsByFlag(result: BatchResult, source: string): boolean {
  if (source === "validate") return true;
  if (source !== "bugfix") return true;
  if ((result.filesChanged ?? []).some((file) => !isRuntimeOnlyArtifactPath(file))) return true;
  return hasPassingCommandEvidence(result) && (result.flags ?? []).some(isPositiveFlag);
}

function closeFindingsOnSuccessfulValidation(findings: RuntimeFinding[], result: BatchResult, source: string): RuntimeFinding[] {
  if (source !== "validate" || result.status !== "SUCCESS" || !hasPassingCommandEvidence(result)) return findings;
  const active = new Set([result.failureType, ...(result.flags ?? [])].filter((value): value is string => Boolean(value && isBlockingFlag(value))));
  const now = new Date().toISOString();
  return findings.map((finding) => {
    if (finding.status !== "open" || active.has(finding.id) || isProductOwnedFinding(finding.id)) return finding;
    return { ...finding, status: "fixed" as const, lastCheckedAt: now };
  });
}

function hasPassingCommandEvidence(result: BatchResult): boolean {
  return Object.values(result.tests ?? {}).some((evidence) => evidence && typeof evidence === "object" && "exitCode" in evidence && Number(evidence.exitCode) === 0 && typeof evidence.command === "string" && evidence.command.trim().length > 0);
}

function closeAggregateFindings(findings: RuntimeFinding[]): RuntimeFinding[] {
  const now = new Date().toISOString();
  const open = new Set(findings.filter((finding) => finding.status === "open").map((finding) => finding.id));
  return findings.map((finding) => {
    if (finding.status !== "open") return finding;
    if (finding.id === "UNWIRED_WORKER_ENTRYPOINTS" && ![...open].some(isOpenWiringFindingExceptAggregate)) return { ...finding, status: "fixed" as const, lastCheckedAt: now };
    return finding;
  });
}

function rebuildActiveFindingsFromTrustedLatestEvidence(findings: RuntimeFinding[], result: BatchResult, source: string): RuntimeFinding[] {
  if (!isTrustedSuccessfulRecoveryEvidence(result, source)) return findings;
  const activeBlocking = new Set((result.flags ?? []).filter(isBlockingFlag));
  const now = new Date().toISOString();
  return findings.map((finding) => {
    if (finding.status !== "open") return finding;
    if (activeBlocking.has(finding.id)) return finding;
    if (!isRuntimeSupportOrToolingFinding(finding)) return finding;
    return {
      ...finding,
      status: "stale" as const,
      evidence: [...new Set([...finding.evidence, "quarantined-by-latest-trusted-recovery-evidence"])],
      lastCheckedAt: now
    };
  });
}

function isTrustedSuccessfulRecoveryEvidence(result: BatchResult, source: string): boolean {
  if (result.status !== "SUCCESS") return false;
  if (source !== "bugfix" && source !== "gate") return false;
  if ((result.flags ?? []).some((flag) => isBlockingFlag(flag))) return false;
  if ((result.filesChanged ?? []).some((file) => !isRuntimeOnlyArtifactPath(file))) return true;
  return hasPassingCommandEvidence(result);
}

function isRuntimeSupportOrToolingFinding(finding: RuntimeFinding): boolean {
  const text = `${finding.id}\n${finding.source}\n${finding.evidence.join("\n")}`.toUpperCase();
  if (isProductOwnedFinding(finding.id)) return false;
  return /(?:RUNTIME|TOOLING|SUPPORT|PROTECTED_PATH|TEMPLATE_MANAGED|WORKTREE_|CHANGED_FILE_MISSING_METADATA|MODULARITY_RULE_FILE|PLAN_REJECTED|VALIDATOR_REJECTED|RUNTIME_GATES_REJECTED|ARTIFACT_MISSING:\.YOLO|RUNTIME_ONLY_PATH|LOCAL_ONLY_PATH|GENERATED_FILE_DRIFT|COMMAND_EVIDENCE|JOURNAL|GATE_FILE)/.test(text);
}

function isProductOwnedFinding(id: string): boolean {
  return /^(?:BUSINESS_LOGIC|ENTRYPOINT|AUTH|AUTHORIZATION|SECURITY|TENANT|PAYMENT|PRICING|API|DB|DATABASE|SCHEMA|E2E_SETUP_MISSING)/.test(flagCode(id).toUpperCase());
}

function isOpenWiringFindingExceptAggregate(id: string): boolean {
  const code = flagCode(id).toUpperCase();
  if (code === "UNWIRED_WORKER_ENTRYPOINTS") return false;
  return /^ENTRYPOINT_(?:UNWIRED|UNVERIFIED)_/.test(code) || /_NOT_WIRED$/.test(code) || code.includes("UNWIRED");
}

function isRuntimeOnlyArtifactPath(file: string): boolean {
  const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
  return /^\.yolo\/(?:batch-results|gates|runtime|logs|events)\//i.test(normalized);
}

function isRuntimeOwnedFinding(id: string): boolean {
  const normalized = id.replace(/\\/g, "/");
  const code = flagCode(id).toUpperCase();
  if (/^(?:RUNTIME_GATES_REJECTED|RUNTIME_GATES_REJECTED_AFTER_VALIDATION_BUGFIX|RUNTIME_ONLY_PATH|RUNTIME_ONLY_PATH_LEAKAGE|BUGFIX_RESULT_INVALID|CONTRACT_SCHEMA_MISMATCH|CONTRACT_FAILURE)$/.test(code)) return true;
  if (/^(?:WORKTREE_CHANGED_FILES_UNDECLARED|ARTIFACT_MISSING|CHANGED_FILE_MISSING|CHANGED_FILE_MISSING_METADATA|LOCAL_ONLY_FILE_MISSING|WIRING_VERIFIER_FILE_MISSING)$/.test(code)) {
    const payload = normalized.includes(":") ? normalized.slice(normalized.indexOf(":") + 1).trim() : "";
    return isRuntimeOnlyArtifactPath(payload);
  }
  if (/^(?:TEMPLATE_MANAGED_PROTECTED_PATH|PROTECTED_PATH|SUPPORT_LOOP_STALE)$/.test(code)) return true;
  if (code === "PLAN_REJECTED" && /\.yolo\/(?:batch-results|gates|runtime|logs|events)\//i.test(normalized)) return true;
  return false;
}

function commandsFromResult(source: string, result: BatchResult): RuntimeCommandEvidence[] {
  const out: RuntimeCommandEvidence[] = [];
  for (const [phase, evidence] of Object.entries(result.tests ?? {})) {
    const item = evidence as TestEvidence | undefined;
    if (!item?.command || invalidPlaceholder(item.command)) continue;
    out.push({ phase, command: item.command, exitCode: item.exitCode, source, completedAt: new Date().toISOString() });
  }
  return out;
}

function evidenceForFinding(result: BatchResult, id: string): string[] {
  return [result.failureType, ...(result.flags ?? []), result.businessLogic?.test].filter((value): value is string => Boolean(value && value.includes(id) || value === id));
}

function normalizeArtifacts(artifacts: BatchResult["artifacts"]): BatchResult["artifacts"] {
  return (artifacts ?? []).filter((artifact) => {
    const value = typeof artifact === "string" ? artifact : artifact?.path;
    return typeof value === "string" && !invalidPlaceholder(value);
  });
}

function invalidPlaceholder(value: string): boolean {
  return INVALID_PLACEHOLDER.test(value.trim());
}

function isStaleBlockingFlag(flag: string, fixedPrefixes: Set<string>): boolean {
  if (!isBlockingFlag(flag) || flag.startsWith("RECOVERED_")) return false;
  return [...fixedPrefixes].some((fixed) => findingMatchesFixedPrefix(flag, fixed));
}

function hasFixEvidence(result: BatchResult, id: string): boolean {
  return hasFixEvidenceFromFlags(result.flags ?? [], id);
}

function hasFixEvidenceFromFlags(flags: string[], id: string): boolean {
  const fixedPrefixes = new Set(flags.map(fixedFindingPrefix).filter((flag): flag is string => Boolean(flag)));
  return fixedPrefixes.has(id) || [...fixedPrefixes].some((fixed) => findingMatchesFixedPrefix(id, fixed)) || flags.some((flag) => positiveFlagClosesFinding(flag, id));
}

function findingMatchesFixedPrefix(id: string, fixed: string): boolean {
  if (!fixed || fixed.length < 8) return false;
  if (id === fixed || id.startsWith(`${fixed}:`) || fixed.startsWith(`${id}:`)) return true;
  const remainder = id.startsWith(`${fixed}_`) ? id.slice(fixed.length + 1) : "";
  return /^(?:GAP|MISSING|DRIFT|UNVERIFIED|UNVALIDATED|UNWIRED|NOT_WIRED|FINDINGS?|FAIL(?:ED|URE)?|INVALID|MISMATCH)(?:_|$)/i.test(remainder);
}

function positiveFlagClosesFinding(flag: string, id: string): boolean {
  if (!isPositiveFlag(flag)) return false;
  const code = flagCode(flag).toUpperCase();
  const finding = flagCode(id).toUpperCase();
  const entrypoint = code.match(/^ENTRYPOINT_(?:VERIFIED|WIRED)(?:_(.+))?$/);
  if (entrypoint) {
    const target = normalizeFindingToken(entrypoint[1] ?? flagDetail(flag));
    if (!target) return false;
    if (/^ENTRYPOINT_(?:UNVERIFIED|UNWIRED)$/.test(finding)) return entrypointSubjectMatches(target, normalizeFindingToken(flagDetail(id)));
    if (/^ENTRYPOINT_(?:UNVERIFIED|UNWIRED)_/.test(finding)) return entrypointSubjectMatches(target, normalizeFindingToken(finding.replace(/^ENTRYPOINT_(?:UNVERIFIED|UNWIRED)_/, "")));
    if (/_NOT_WIRED$/.test(finding)) {
      const subject = normalizeFindingToken(finding.replace(/_NOT_WIRED$/, ""));
      return entrypointSubjectMatches(target, subject);
    }
  }
  if (/^BUSINESS_LOGIC_DRIFT_SWEEP_PASS$/i.test(code) && /^BUSINESS_LOGIC_DRIFT_/.test(finding)) return true;
  if (/^TENANT_FAIRNESS_RATE_LIMIT_RETRY_PASS$/i.test(code) && /^BUSINESS_LOGIC_DRIFT_TENANT_FAIRNESS_/.test(finding)) return true;
  if (/^GENERATED_FILE_DRIFT_REVERTED$/i.test(code) && /^GENERATED_FILE_DRIFT_/.test(finding)) return true;
  if (/^PROTECTED_PATH_METADATA_REMOVED$/i.test(code) && /^CHANGED_FILE_MISSING_METADATA_REMOVED$/i.test(finding)) return true;
  if (/^MODULARITY_RULE_FILE_WARNING_ROUTED_NON_BLOCKING$/i.test(code) && /^MODULARITY_RULE_FILE_LIMIT_VIOLATION$/i.test(finding)) return true;
  const business = code.match(/^BUSINESS_LOGIC(?:_EVIDENCE)?_(.+)_(?:PASS|PASSED|VERIFIED|FIXED)$/);
  if (business && /^BUSINESS_LOGIC_(?:DRIFT|GAP|MISSING|UNVERIFIED|UNVALIDATED)_/.test(finding)) {
    const target = normalizeFindingToken(business[1]);
    const subject = normalizeFindingToken(finding.replace(/^BUSINESS_LOGIC_(?:DRIFT|GAP|MISSING|UNVERIFIED|UNVALIDATED)_/, ""));
    if (target === subject || target.endsWith(`_${subject}`) || subject.startsWith(`${target}_`)) return true;
    if (target.startsWith("TENANT_FAIRNESS_") && subject.startsWith("TENANT_FAIRNESS_")) return true;
    return false;
  }
  return false;
}

function flagDetail(flag: string): string {
  const clean = flag.replace(/^RECOVERED_SOURCE_FLAG:/i, "").trim();
  return clean.includes(":") ? clean.slice(clean.indexOf(":") + 1) : "";
}

function entrypointSubjectMatches(target: string, subject: string): boolean {
  if (!target || !subject) return false;
  if (target === subject || target.endsWith(`_${subject}`)) return true;
  const targetWithoutEvidenceNoun = target.replace(/_(?:WIRING|ENTRYPOINT|WORKER)$/i, "");
  return singularizeFindingToken(targetWithoutEvidenceNoun) === singularizeFindingToken(subject);
}

function singularizeFindingToken(value: string): string {
  return value.split("_").map((part) => part.length > 3 && part.endsWith("S") ? part.slice(0, -1) : part).join("_");
}

function normalizeFindingToken(value: string): string {
  return value.replace(/[^A-Z0-9]+/gi, "_").replace(/^(?:THE|A|AN)_/i, "").replace(/_+/g, "_").replace(/^_|_$/g, "").toUpperCase();
}
