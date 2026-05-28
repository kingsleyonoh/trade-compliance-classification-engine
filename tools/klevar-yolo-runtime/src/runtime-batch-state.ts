import path from "node:path";
import { exists, readText, writeText } from "./util/fs.js";
import type { Batch, BatchResult, GateResult, TestEvidence } from "./types.js";

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
  updatedAt: string;
}

const INVALID_PLACEHOLDER = /^(?:unknown|n\/?a|not applicable|none|manual|tbd|todo|-)$/i;
const FIXED_SUFFIX = /(?:_FIXED|_PASS|_PASSED|_ALLOWLISTED|_SATISFIED|_ENFORCED|_REJECTED|_COVERED)$/i;
const BLOCKING_FINDING = /(?:FAILURE|FAILED|REJECTED|MISSING|GAP|INVALID|BLOCKING|DRIFT|LEAKAGE|FINDINGS|UNWIRED|MISMATCH|UNVALIDATED)/i;

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
  await writeText(statePath(cwd, state.batch), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + "\n");
}

export async function importAgentResultToState(cwd: string, batch: Batch, source: string, raw: BatchResult, previous?: RuntimeBatchState): Promise<RuntimeBatchState> {
  const base = previous ?? await loadRuntimeBatchState(cwd, batch, raw);
  const result = canonicalizeBatchResultForRuntime(batch, raw, base.findings);
  const findings = closeFindingsOnSuccessfulResult(reconcileFindings([...base.findings, ...findingsFromResult(source, raw)], result), result, source);
  const commands = [...base.commands, ...commandsFromResult(source, result)];
  const state: RuntimeBatchState = {
    ...base,
    changedFiles: [...new Set([...(base.changedFiles ?? []), ...(result.filesChanged ?? [])])],
    currentResult: result,
    findings,
    commands,
    updatedAt: new Date().toISOString()
  };
  await writeRuntimeBatchState(cwd, state);
  return state;
}

export function canonicalizeBatchResultForRuntime(batch: Batch, result: BatchResult, findings: RuntimeFinding[] = []): BatchResult {
  const fixedFindingIds = new Set(findings.filter((finding) => finding.status === "fixed" || finding.status === "stale" || finding.status === "accepted").map((finding) => finding.id));
  const bugfixFlags = new Set((result.flags ?? []).filter((flag) => FIXED_SUFFIX.test(flag)).map((flag) => flag.replace(/_(?:FIXED|PASS|PASSED|ALLOWLISTED|SATISFIED|ENFORCED|REJECTED|COVERED)$/i, "")));
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
  const next = { ...state.gates };
  for (const gate of gates) next[gate.name] = { passed: gate.passed, flags: gate.flags };
  return { ...transitionFindingsForGates(state, gates), gates: next, updatedAt: new Date().toISOString() };
}

export function transitionFindingsForGates(state: RuntimeBatchState, gates: GateResult[]): RuntimeBatchState {
  const now = new Date().toISOString();
  const byId = new Map(state.findings.map((finding) => [finding.id, finding]));
  const passedFlags = new Set<string>();
  for (const gate of gates) {
    if (gate.passed) {
      for (const prior of state.gates[gate.name]?.flags ?? []) passedFlags.add(prior);
      continue;
    }
    for (const flag of gate.flags) {
      if (isWarningFinding(flag) || flag.startsWith("RECOVERED_")) continue;
      const existing = byId.get(flag);
      byId.set(flag, { id: flag, source: `gate:${gate.name}`, status: existing?.status ?? "open", evidence: [...new Set([...(existing?.evidence ?? []), ...gate.flags])], lastCheckedAt: now });
    }
  }
  const next = [...byId.values()].map((finding) => {
    if (finding.status !== "open") return finding;
    if (passedFlags.has(finding.id) || hasFixEvidence(state.currentResult, finding.id)) return { ...finding, status: "fixed" as const, lastCheckedAt: now };
    return finding;
  });
  return { ...state, findings: next, updatedAt: now };
}

export function blockingOpenFindings(state: RuntimeBatchState): RuntimeFinding[] {
  return state.findings.filter((finding) => finding.status === "open" && !isWarningFinding(finding.id));
}

export function findingSummary(state: RuntimeBatchState): Record<FindingStatus, number> {
  return state.findings.reduce((summary, finding) => ({ ...summary, [finding.status]: (summary[finding.status] ?? 0) + 1 }), { open: 0, fixed: 0, stale: 0, accepted: 0, human: 0 } as Record<FindingStatus, number>);
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
  for (const flag of result.flags ?? []) if (BLOCKING_FINDING.test(flag) && !FIXED_SUFFIX.test(flag) && !flag.startsWith("RECOVERED_")) ids.add(flag);
  return [...ids].map((id) => ({ id, source, status: "open" as const, evidence: evidenceForFinding(result, id), lastCheckedAt: now }));
}

function reconcileFindings(findings: RuntimeFinding[], result: BatchResult): RuntimeFinding[] {
  const byId = new Map<string, RuntimeFinding>();
  for (const finding of findings) byId.set(finding.id, { ...(byId.get(finding.id) ?? finding), ...finding, evidence: [...new Set([...(byId.get(finding.id)?.evidence ?? []), ...finding.evidence])] });
  const fixedPrefixes = new Set((result.flags ?? []).filter((flag) => FIXED_SUFFIX.test(flag)).map((flag) => flag.replace(/_(?:FIXED|PASS|PASSED|ALLOWLISTED|SATISFIED|ENFORCED|REJECTED|COVERED)$/i, "")));
  for (const [id, finding] of byId.entries()) {
    if (fixedPrefixes.has(id) || [...fixedPrefixes].some((fixed) => id.includes(fixed) || fixed.includes(id))) byId.set(id, { ...finding, status: "fixed", lastCheckedAt: new Date().toISOString() });
  }
  return [...byId.values()];
}

function closeFindingsOnSuccessfulResult(findings: RuntimeFinding[], result: BatchResult, source: string): RuntimeFinding[] {
  if (result.status !== "SUCCESS" || !["validate", "bugfix", "implement"].includes(source)) return findings;
  const active = new Set([result.failureType, ...(result.flags ?? [])].filter((value): value is string => Boolean(value)));
  const hasPassingEvidence = Object.values(result.tests ?? {}).some((evidence) => evidence && typeof evidence === "object" && "exitCode" in evidence && Number(evidence.exitCode) === 0);
  if (!hasPassingEvidence) return findings;
  const now = new Date().toISOString();
  return findings.map((finding) => finding.status === "open" && !active.has(finding.id) ? { ...finding, status: "fixed" as const, evidence: [...new Set([...finding.evidence, `closed-by-${source}-success`])], lastCheckedAt: now } : finding);
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
  if (!BLOCKING_FINDING.test(flag) || flag.startsWith("RECOVERED_")) return false;
  return [...fixedPrefixes].some((fixed) => flag.includes(fixed) || fixed.includes(flag));
}

function hasFixEvidence(result: BatchResult, id: string): boolean {
  const fixedPrefixes = new Set((result.flags ?? []).filter((flag) => FIXED_SUFFIX.test(flag)).map((flag) => flag.replace(/_(?:FIXED|PASS|PASSED|ALLOWLISTED|SATISFIED|ENFORCED|REJECTED|COVERED)$/i, "")));
  return fixedPrefixes.has(id) || [...fixedPrefixes].some((fixed) => id.includes(fixed) || fixed.includes(id));
}

function isWarningFinding(flag: string): boolean {
  return flag.startsWith("QUALITY_WARNING:") || flag.startsWith("IMPECCABLE_DETECTOR_UNAVAILABLE:");
}
