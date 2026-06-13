import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mergeRecoveredResult } from "./recovery-merge.js";
import { syncWorktreeChangesToRoot } from "./worktree-sync.js";
import { exists } from "./util/fs.js";
import { execCommand } from "./util/process.js";
import { blockingOpenFindings, findingSummary, importAgentResultToState } from "./runtime-batch-state.js";
import { blockingRecoveryFlags, failureSignature, isRuntimeOwnedRecoverySignature } from "./runtime.js";
import type { Batch, BatchResult } from "./types.js";

interface WorktreeSyncIncident {
  kind: "worktree-sync";
  candidatePaths?: string[];
  expectedSynced?: string[];
  expectedErrorIncludes?: string;
}

interface RecoveryMergeIncident {
  kind: "recovery-merge";
  implementation: BatchResult;
  bugfix: BatchResult;
  expectedFilesChanged?: string[];
  forbiddenFilesChanged?: string[];
}

interface RuntimeClassificationIncident {
  kind: "runtime-classification";
  batch?: number;
  implementation: BatchResult;
  recovery?: BatchResult;
  expectedClassification: "runtime-owned" | "product-owned" | "mixed";
  expectedActiveBlockers?: string[];
  expectedQuarantinedStaleFindings?: string[];
  expectedRecommendationIncludes?: string;
  expectBugfixDispatch: boolean;
}

type IncidentScenario = WorktreeSyncIncident | RecoveryMergeIncident | RuntimeClassificationIncident;

export interface IncidentReplayResult {
  fixture: string;
  kind: string;
  passed: boolean;
  details: string[];
}

export async function replayIncidentFixture(fixtureDir: string): Promise<IncidentReplayResult> {
  const absolute = resolve(fixtureDir);
  const scenario = JSON.parse(await readFile(join(absolute, "scenario.json"), "utf8")) as IncidentScenario;
  if (scenario.kind === "worktree-sync") return replayWorktreeSyncIncident(absolute, scenario);
  if (scenario.kind === "recovery-merge") return replayRecoveryMergeIncident(absolute, scenario);
  if (scenario.kind === "runtime-classification") return replayRuntimeClassificationIncident(absolute, scenario);
  throw new Error(`UNKNOWN_INCIDENT_KIND:${(scenario as { kind?: string }).kind ?? "missing"}`);
}

async function replayWorktreeSyncIncident(fixtureDir: string, scenario: WorktreeSyncIncident): Promise<IncidentReplayResult> {
  const scratch = await mkdtemp(join(tmpdir(), "klevar-incident-"));
  const root = join(scratch, "root");
  const worktree = join(scratch, "worktree");
  await cp(join(fixtureDir, "root"), root, { recursive: true });
  const baseWorktree = join(fixtureDir, "base-worktree");
  if (await exists(baseWorktree)) {
    await cp(baseWorktree, worktree, { recursive: true });
    await ensureGitBaseline(worktree);
    await cp(join(fixtureDir, "worktree"), worktree, { recursive: true });
  } else {
    await cp(join(fixtureDir, "worktree"), worktree, { recursive: true });
    await ensureGitBaseline(worktree);
  }
  await ensureGitBaseline(root);
  try {
    const synced = await syncWorktreeChangesToRoot(worktree, root, scenario.candidatePaths ?? []);
    if (scenario.expectedErrorIncludes) {
      return { fixture: fixtureDir, kind: scenario.kind, passed: false, details: [`expected error containing ${scenario.expectedErrorIncludes}, got success`] };
    }
    const missing = (scenario.expectedSynced ?? []).filter((item) => !synced.includes(item));
    return { fixture: fixtureDir, kind: scenario.kind, passed: missing.length === 0, details: missing.length ? [`missing synced paths: ${missing.join(",")}`] : [`synced: ${synced.join(",") || "none"}`] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const passed = Boolean(scenario.expectedErrorIncludes && message.includes(scenario.expectedErrorIncludes));
    return { fixture: fixtureDir, kind: scenario.kind, passed, details: [message] };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function ensureGitBaseline(dir: string): Promise<void> {
  if (await exists(join(dir, ".git"))) return;
  const result = await execCommand("git init && git config user.email test@example.com && git config user.name Test && git add . && git commit --allow-empty -m init", dir, 30_000);
  if (result.exitCode !== 0) throw new Error(`INCIDENT_FIXTURE_GIT_BASELINE_FAILED:${dir}:${result.stderr || result.stdout}`);
}

function replayRecoveryMergeIncident(fixtureDir: string, scenario: RecoveryMergeIncident): IncidentReplayResult {
  const recovered = mergeRecoveredResult(scenario.implementation, scenario.bugfix);
  const files = recovered.filesChanged ?? [];
  const missing = (scenario.expectedFilesChanged ?? []).filter((item) => !files.includes(item));
  const forbidden = (scenario.forbiddenFilesChanged ?? []).filter((item) => files.includes(item));
  const details = [
    ...(missing.length ? [`missing changed paths: ${missing.join(",")}`] : []),
    ...(forbidden.length ? [`forbidden changed paths present: ${forbidden.join(",")}`] : []),
    ...(!missing.length && !forbidden.length ? [`filesChanged: ${files.join(",") || "none"}`] : [])
  ];
  return { fixture: fixtureDir, kind: scenario.kind, passed: missing.length === 0 && forbidden.length === 0, details };
}

async function replayRuntimeClassificationIncident(fixtureDir: string, scenario: RuntimeClassificationIncident): Promise<IncidentReplayResult> {
  const scratch = await mkdtemp(join(tmpdir(), "klevar-runtime-classification-"));
  try {
    const batch = incidentBatch(scenario);
    let state = await importAgentResultToState(scratch, batch, "implement", scenario.implementation);
    if (scenario.recovery) state = await importAgentResultToState(scratch, batch, "bugfix", scenario.recovery, state);
    const activeBlockers = blockingOpenFindings(state).map((finding) => finding.id).sort();
    const staleFindings = state.findings.filter((finding) => finding.status === "stale").map((finding) => finding.id).sort();
    const signature = failureSignature(scenario.implementation.flags ?? [], scenario.implementation.failureType);
    const blockingFlags = blockingRecoveryFlags(scenario.implementation.flags ?? [], scenario.implementation.failureType);
    const hasRuntimeOwnedFlag = blockingFlags.some((flag) => isRuntimeOwnedRecoverySignature(flag));
    const hasProductBlocker = activeBlockers.some((blocker) => /^(?:BUSINESS_LOGIC|ENTRYPOINT|AUTH|AUTHORIZATION|SECURITY|TENANT|PAYMENT|PRICING|API|DB|DATABASE|SCHEMA|E2E_SETUP_MISSING)/i.test(blocker));
    const classification = hasRuntimeOwnedFlag && hasProductBlocker ? "mixed" : hasRuntimeOwnedFlag ? "runtime-owned" : "product-owned";
    const bugfixDispatch = !hasRuntimeOwnedFlag && activeBlockers.length > 0;
    const recommendation = hasRuntimeOwnedFlag
      ? `runtime-owned incident (${signature}); do not dispatch bugfix; clean/restart runtime after preserving fixture; product blockers remain active: ${activeBlockers.join(",") || "none"}`
      : `product-owned blockers require implementation/bugfix: ${activeBlockers.join(",") || "none"}`;
    const details = compareExpected("classification", [classification], [scenario.expectedClassification]);
    details.push(...compareExpected("active blockers", activeBlockers, scenario.expectedActiveBlockers ?? []));
    details.push(...compareExpected("quarantined stale findings", staleFindings, scenario.expectedQuarantinedStaleFindings ?? []));
    if (bugfixDispatch !== scenario.expectBugfixDispatch) details.push(`bugfix dispatch expected ${scenario.expectBugfixDispatch}, got ${bugfixDispatch}`);
    if (scenario.expectedRecommendationIncludes && !recommendation.includes(scenario.expectedRecommendationIncludes)) details.push(`recommendation missing ${scenario.expectedRecommendationIncludes}: ${recommendation}`);
    if (!details.length) details.push(`classification=${classification}; active=${activeBlockers.join(",") || "none"}; stale=${staleFindings.join(",") || "none"}; summary=${JSON.stringify(findingSummary(state))}; recommendation=${recommendation}`);
    return { fixture: fixtureDir, kind: scenario.kind, passed: details.length === 1 && details[0].startsWith("classification="), details };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function incidentBatch(scenario: RuntimeClassificationIncident): Batch {
  return { number: scenario.batch ?? scenario.implementation.batch ?? 1, type: "implement", items: [{ raw: "- [ ] Incident replay fixture", tag: "[INFRA]", title: "Incident replay fixture", phase: "Incident", checked: false }] };
}

function compareExpected(label: string, actual: string[], expected: string[]): string[] {
  const missing = expected.filter((item) => !actual.includes(item));
  const unexpected = actual.filter((item) => !expected.includes(item));
  return [
    ...(missing.length ? [`${label} missing: ${missing.join(",")}`] : []),
    ...(unexpected.length ? [`${label} unexpected: ${unexpected.join(",")}`] : [])
  ];
}

export function formatIncidentReplayResult(result: IncidentReplayResult): string {
  return [result.passed ? "PASS" : "FAIL", `fixture=${result.fixture}`, `kind=${result.kind}`, ...result.details.map((detail) => `- ${detail}`)].join("\n");
}
