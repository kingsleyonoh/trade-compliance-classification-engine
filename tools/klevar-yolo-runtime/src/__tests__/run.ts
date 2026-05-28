import { existsSync, readFileSync } from "node:fs";
import { access, mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { staleUnansweredToolReason } from "../agent-session.js";
import { validatePaths } from "../validators/path-validator.js";
import { validateArtifacts } from "../validators/artifact-validator.js";
import { blockingOpenFindings, canonicalizeBatchResultForRuntime, classifyBatchRisk, findingSummary, importAgentResultToState, recordGateState } from "../runtime-batch-state.js";
import { validationPolicyFor } from "../validation-policy.js";
import { validateLocalOnlyFiles } from "../validators/local-only-validator.js";
import { validateSecrets } from "../validators/secret-validator.js";
import { validateExternalOps } from "../validators/external-ops-validator.js";
import { isAuditItem, selectBatch } from "../progress-parser.js";
import { extractVerifierFiles, validateWiring } from "../validators/wiring-validator.js";
import { validateProgressContract } from "../validators/progress-contract-validator.js";
import { validateBusinessLogic } from "../validators/business-logic-validator.js";
import { adoptedSessionCommandPassed, summarizeFailure, validateCommandEvidence } from "../validators/command-validator.js";
import { validateFrontendImpeccable } from "../validators/frontend-validator.js";
import { validateProductQuality } from "../validators/product-quality-validator.js";
import { validateTdd } from "../validators/tdd-validator.js";
import { validateE2e } from "../validators/e2e-validator.js";
import { normalizeBatchResult, readBatchResult, readCanonicalBatchResult, validateContract } from "../result-contracts.js";
import { buildCommandInvocation, normalizeCommand, execCommand, findBash } from "../util/process.js";
import { nextBatchNumber, removeWindowsReservedDeviceFiles } from "../util/git.js";
import { failRuntimeFromError, markHeartbeat, resetRuntimeState, setCheckpoint, setPhase } from "../telemetry.js";
import { validateJournalContract } from "../journal-contract.js";
import { validateAll, gatesPassed } from "../validators/index.js";
import { canonicalizeBatchResultManifests, classifyBatchType, completedBatchCommitExists, findLatestResumableBatch, journalSource, mergeRecoveredResult, mergeRecoveredResultFromDisk, validationFailureContradictedByRecoveredEvidence } from "../runtime.js";
import { buildBatchContext } from "../context-builder.js";
import { adjudicationAccepted, adjudicationAllowed, adjudicationNeedsBugfix, normalizeAdjudication, readAdjudicationFile } from "../adjudication.js";
import { classifyGateFindings } from "../gate-findings.js";
import { clearSubagentOutput, fillLegacyPlaceholders } from "../subagent-runner.js";
import { appendSubagentEvent, budgetFromInvocation, summarizeSubagentSession } from "../subagent-telemetry.js";
import { defaultConfig, loadConfig } from "../config.js";
import { syncLocalOnlyFilesToRoot, syncWorktreeChangesToRoot } from "../worktree-sync.js";
import { isTransientRemoveError, pruneSuccessfulWorktrees } from "../worktree-retention.js";
import { runPolicyConsistencyTests } from "./policy-consistency.js";
import { repairCommittedCloseoutGate, verifyPreviousBatchGates } from "../gates.js";
import { readPromptTemplate } from "../prompt-source.js";
import { cleanBatch, normalizeBatch, rollbackLast, undoLast } from "../recovery.js";
import { loadClaims, markRuntimeClaim, prepareRuntimeClaim, validateClaims } from "../collaboration/claims.js";
import { planParallelBatches } from "../collaboration/scheduler.js";
import { formatRuntimeNotification, shouldNotifyRuntimeFinish, telegramEnabled } from "../notifications.js";
import { readPendingInbox, reconcileInbox, routeInboxEntries } from "../inbox-router.js";
import { routeInboxWithAi } from "../inbox-ai-router.js";
import { buildRelevantKnowledgePack, expandCandidateRequests } from "../knowledge-retriever.js";
import { markPhaseSupportDue, nextSupportPlan, supportGateName } from "../support-scheduler.js";
import type { BatchResult, RuntimeConfig } from "../types.js";

const tests: Array<[string, () => Promise<void> | void]> = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push([name, fn]);
}

test("prompt instructions and runtime path policy are consistent", () => {
  runPolicyConsistencyTests();
});

test("path policy globs are escaped safely", () => {
  const config = configWithPatterns(["*.pem", ".env.*", "node_modules/"], [], []);
  assert.deepEqual(validatePaths(["secret.pem", ".env.local", "node_modules/pkg/index.js"], config), {
    name: "paths",
    passed: false,
    flags: ["BLOCKED_PATH:secret.pem", "BLOCKED_PATH:.env.local", "BLOCKED_PATH:node_modules/pkg/index.js"]
  });
  assert.equal(validatePaths(["src/main.ts"], config).passed, true);
});

test("Windows local wrapper commands resolve native companions", async () => {
  const dir = await tempDir();
  await writeFile(join(dir, "gradlew.bat"), "@echo off\r\n");
  await writeFile(join(dir, "tool.cmd"), "@echo off\r\n");
  assert.deepEqual(normalizeCommand("./gradlew test --no-daemon", dir, "win32"), {
    command: "gradlew.bat test --no-daemon",
    display: "gradlew.bat test --no-daemon"
  });
  assert.deepEqual(normalizeCommand("./tool check", dir, "win32"), {
    command: "tool.cmd check",
    display: "tool.cmd check"
  });
  assert.deepEqual(normalizeCommand("./gradlew test && ./gradlew build", dir, "win32"), {
    command: "gradlew.bat test && gradlew.bat build",
    display: "gradlew.bat test && gradlew.bat build"
  });
  assert.deepEqual(normalizeCommand("npm test", dir, "win32"), { command: "npm test", display: "npm test" });
  assert.deepEqual(normalizeCommand("./missing test", dir, "win32"), { command: "./missing test", display: "./missing test" });
  await rm(dir, { recursive: true, force: true });
});

test("Windows command runner prefers Bash when available", async () => {
  const dir = await tempDir();
  const bash = findBash();
  if (bash) {
    const invocation = buildCommandInvocation("./gradlew test && ./gradlew build", dir, "win32");
    assert.equal(invocation.file, bash);
    assert.deepEqual(invocation.args, ["-lc", "./gradlew test && ./gradlew build"]);
    assert.equal(invocation.shell, false);
  }
  await rm(dir, { recursive: true, force: true });
});

test("Windows command runner falls back to normalized cmd when Bash disabled", async () => {
  const dir = await tempDir();
  await writeFile(join(dir, "gradlew.bat"), "@echo off\r\n");
  const previous = process.env.KLEVAR_BASH_PATH;
  process.env.KLEVAR_BASH_PATH = "none";
  const invocation = buildCommandInvocation("./gradlew test && ./gradlew build", dir, "win32");
  assert.equal(invocation.file, "gradlew.bat test && gradlew.bat build");
  assert.equal(invocation.shell, true);
  if (previous === undefined) delete process.env.KLEVAR_BASH_PATH;
  else process.env.KLEVAR_BASH_PATH = previous;
  await rm(dir, { recursive: true, force: true });
});

test("protected paths allow configured generated paths", () => {
  const config = configWithPatterns([], [".agent/", ".yolo/runtime.config.json"], [".yolo/", "docs/progress.md"]);
  assert.deepEqual(validatePaths([".agent/rules/CODEBASE_CONTEXT.md", ".yolo/runtime.config.json", "docs/progress.md"], config), {
    name: "paths",
    passed: false,
    flags: ["PROTECTED_PATH:.agent/rules/CODEBASE_CONTEXT.md"]
  });
});

test("default path policy allows runtime-owned knowledge and env example updates", () => {
  const result = validatePaths([
    ".env.example",
    ".agent/knowledge/foundation/startup.md",
    ".agent/knowledge/gotchas/package-info.md",
    ".agent/knowledge/patterns/module-layout.md",
    ".agent/knowledge/modules/claims.md",
    ".agent/knowledge/checks/repeated-failure.md",
    ".agent/rules/CODEBASE_CONTEXT.md",
    ".env.local"
  ], defaultConfig);
  assert.deepEqual(result, { name: "paths", passed: false, flags: ["PROTECTED_PATH:.agent/rules/CODEBASE_CONTEXT.md", "BLOCKED_PATH:.env.local"] });
});

test("path policy allows evidence-backed documented command fixes in CODEBASE_CONTEXT", () => {
  const result = implementResult({
    filesChanged: [".agent/rules/CODEBASE_CONTEXT.md"],
    flags: ["BROKEN_DOCUMENTED_AQUA_COMMAND", "DOCUMENTED_AQUA_COMMAND_PASS"],
    tests: { green: { command: "bash tests/static_documented_commands_contract.sh", exitCode: 0, evidence: "documented command passed" } }
  });
  assert.deepEqual(validatePaths(result.filesChanged, defaultConfig, result), { name: "paths", passed: true, flags: [] });
});

test("config merge preserves new default allowed generated paths for older project configs", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo"), { recursive: true });
  await writeFile(join(dir, ".yolo/runtime.config.json"), JSON.stringify({ policy: { allowedGeneratedPaths: [".yolo/", "docs/progress.md"] } }));
  const loaded = await loadConfig(dir);
  assert.ok(loaded.policy.allowedGeneratedPaths.includes(".agent/knowledge/foundation/"));
  assert.ok(loaded.policy.allowedGeneratedPaths.includes(".agent/knowledge/checks/"));
  assert.ok(loaded.policy.allowedGeneratedPaths.includes(".env.example"));
  assert.ok(loaded.policy.allowedGeneratedPaths.includes(".yolo/"));
  await rm(dir, { recursive: true, force: true });
});

test("local-only env files are allowed when gitignored and not changed deliverables", async () => {
  const dir = await tempDir();
  await execCommand("git init && git config user.email test@example.com && git config user.name Test", dir, 30_000);
  await writeFile(join(dir, ".gitignore"), ".env\n.env.*\n!.env.example\n");
  await writeFile(join(dir, ".env"), "POSTGRES_PASSWORD=local\n");
  await writeFile(join(dir, ".env.local"), "POSTGRES_PASSWORD=local\n");
  await execCommand("git add .gitignore && git commit -m init", dir, 30_000);
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.localOnlyFiles = [".env", ".env.local"];
  result.filesChanged = ["docker-compose.yml"];
  assert.deepEqual(await validateLocalOnlyFiles(dir, result, defaultConfig), { name: "local-only", passed: true, flags: [] });
  await rm(dir, { recursive: true, force: true });
});

test("local-only generated test reports are allowed when gitignored", async () => {
  const dir = await tempDir();
  await execCommand("git init && git config user.email test@example.com && git config user.name Test", dir, 30_000);
  await mkdir(join(dir, "build/test-results/test"), { recursive: true });
  await writeFile(join(dir, ".gitignore"), "build/\n");
  await writeFile(join(dir, "build/test-results/test/TEST-example.xml"), "<testsuite/>\n");
  await execCommand("git add .gitignore && git commit -m init", dir, 30_000);
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.localOnlyFiles = ["build/test-results/test/TEST-example.xml"];
  result.filesChanged = [];
  assert.deepEqual(await validateLocalOnlyFiles(dir, result, defaultConfig), { name: "local-only", passed: true, flags: [] });
  await rm(dir, { recursive: true, force: true });
});

test("local-only nested node_modules directories are allowed when gitignored", async () => {
  const dir = await tempDir();
  await execCommand("git init && git config user.email test@example.com && git config user.name Test", dir, 30_000);
  await mkdir(join(dir, "web/node_modules/pkg"), { recursive: true });
  await writeFile(join(dir, ".gitignore"), "node_modules/\nweb/node_modules/\n");
  await writeFile(join(dir, "web/node_modules/pkg/index.js"), "module.exports = {};\n");
  await execCommand("git add .gitignore && git commit -m init", dir, 30_000);
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.localOnlyFiles = ["web/node_modules"];
  result.filesChanged = [];
  assert.deepEqual(await validateLocalOnlyFiles(dir, result, defaultConfig), { name: "local-only", passed: true, flags: [] });
  await rm(dir, { recursive: true, force: true });
});

test("local-only env files fail if listed as changed deliverables", async () => {
  const dir = await tempDir();
  await execCommand("git init && git config user.email test@example.com && git config user.name Test", dir, 30_000);
  await writeFile(join(dir, ".gitignore"), ".env\n.env.*\n!.env.example\n");
  await writeFile(join(dir, ".env.local"), "POSTGRES_PASSWORD=local\n");
  await execCommand("git add .gitignore && git commit -m init", dir, 30_000);
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.localOnlyFiles = [".env.local"];
  result.filesChanged = [".env.local"];
  const gate = await validateLocalOnlyFiles(dir, result, defaultConfig);
  assert.equal(gate.passed, false);
  assert.ok(gate.flags.includes("LOCAL_ONLY_LISTED_AS_CHANGED:.env.local"));
  await rm(dir, { recursive: true, force: true });
});

test("external ops validator rejects remote mutations by default", () => {
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.filesChanged = ["remote:root@example:/apps/app/.env.backup (deleted)"];
  result.tests = {
    green: { command: "ssh root@example 'test ! -e /apps/app/.env.backup'", exitCode: 0, evidence: "After `rm -f -- /apps/app/.env.backup`, the verification returned BACKUP_ABSENT." },
    regression: { command: "npm test", exitCode: 0, evidence: "passed" }
  };
  const gate = validateExternalOps(result, defaultConfig);
  assert.equal(gate.passed, false);
  assert.ok(gate.flags.some((flag) => flag.startsWith("EXTERNAL_MUTATION_NOT_ALLOWED:remote:root@example")));
  assert.ok(gate.flags.some((flag) => flag.startsWith("EXTERNAL_MUTATION_EVIDENCE_NOT_ALLOWED:green:")));
});

test("external ops validator allows remote mutations only with explicit policy opt-in", () => {
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.filesChanged = ["remote:root@example:/apps/app/.env.backup (deleted)"];
  const config = { ...defaultConfig, policy: { ...defaultConfig.policy, allowExternalMutations: true } };
  assert.deepEqual(validateExternalOps(result, config), { name: "external-ops", passed: true, flags: [] });
});

test("secret validator ignores external operation markers", async () => {
  const dir = await tempDir();
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.filesChanged = ["remote:root@example:/apps/app/.env.backup (deleted)"];
  assert.deepEqual(await validateSecrets(dir, result), { name: "secrets", passed: true, flags: [] });
  await rm(dir, { recursive: true, force: true });
});

test("bugfix recovery reloads corrected implement manifest artifacts", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo/batch-results"), { recursive: true });
  const original = journalResult({ journal_entry_written: true, gate_file_written: true });
  original.batch = 27;
  original.filesChanged = ["src/missing/File.java", "node_modules/"];
  original.localOnlyFiles = ["node_modules/"];
  original.artifacts = [{ path: "var/storage/tenants/*/exports/*.{csv,json}", description: "bad wildcard" }];
  original.tests = { regression: { command: "false", exitCode: 1, evidence: "stale failed evidence" } };
  const corrected = {
    ...original,
    filesChanged: ["src/main/App.java", ".yolo/batch-results/batch-027-implement.md"],
    localOnlyFiles: [],
    artifacts: [{ path: ".yolo/batch-results/batch-027-implement.md", description: "report" }],
    tests: { regression: { command: "true", exitCode: 0, evidence: "corrected passing evidence" } }
  };
  await writeFile(join(dir, ".yolo/batch-results/batch-027-implement.md"), "report\n");
  await writeFile(join(dir, ".yolo/batch-results/batch-027-implement.json"), JSON.stringify(corrected));
  const bugfix = journalResult({ journal_entry_written: true, gate_file_written: true });
  bugfix.agent = "bugfix";
  bugfix.filesChanged = [".yolo/batch-results/batch-027-implement.json", ".yolo/batch-results/batch-027-bugfix.json"];
  bugfix.artifacts = [{ path: ".yolo/batch-results/batch-027-bugfix.json", description: "bugfix" }];
  await writeFile(join(dir, ".yolo/batch-results/batch-027-bugfix.json"), JSON.stringify(bugfix));
  const recovered = await mergeRecoveredResultFromDisk(dir, 27, original, bugfix);
  assert.deepEqual(recovered.filesChanged, ["src/main/App.java", ".yolo/batch-results/batch-027-implement.md", ".yolo/batch-results/batch-027-bugfix.json"]);
  assert.deepEqual(recovered.localOnlyFiles, []);
  assert.equal(recovered.tests?.regression?.command, "true");
  assert.deepEqual(recovered.artifacts?.map((artifact) => artifact.path), [".yolo/batch-results/batch-027-implement.md", ".yolo/batch-results/batch-027-bugfix.json"]);
  await rm(dir, { recursive: true, force: true });
});

test("contract gate fails terminal failure results so coverage gaps route to recovery", () => {
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.agent = "audit";
  result.status = "FAILURE";
  result.failureType = "COVERAGE_GAP";
  const gate = validateContract(result);
  assert.equal(gate.passed, false);
  assert.ok(gate.flags.includes("RESULT_STATUS_FAILURE:COVERAGE_GAP"));
});

test("bugfix recovery reloads corrected audit manifest artifacts", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo/batch-results"), { recursive: true });
  const original = journalResult({ journal_entry_written: true, gate_file_written: true });
  original.agent = "audit";
  original.batch = 35;
  original.flags = ["INVALID_TESTS_SHAPE"];
  original.tests = undefined;
  const corrected = { ...original, tests: { regression: { command: "./gradlew test", exitCode: 0, evidence: "corrected audit evidence" } }, flags: ["COVERAGE_GAP"] };
  await writeFile(join(dir, ".yolo/batch-results/batch-035-audit.json"), JSON.stringify(corrected));
  const bugfix = journalResult({ journal_entry_written: true, gate_file_written: true });
  bugfix.agent = "bugfix";
  bugfix.batch = 35;
  bugfix.filesChanged = [".yolo/batch-results/batch-035-audit.json", ".yolo/batch-results/batch-035-bugfix.json"];
  const recovered = await mergeRecoveredResultFromDisk(dir, 35, original, bugfix);
  assert.equal(recovered.agent, "audit");
  assert.equal(recovered.tests?.regression?.evidence, "corrected audit evidence");
  assert.ok(!recovered.flags.includes("INVALID_TESTS_SHAPE"));
  await rm(dir, { recursive: true, force: true });
});

test("bugfix recovery canonicalizes batch result manifests before revalidation", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo/batch-results"), { recursive: true });
  await writeFile(join(dir, ".yolo/batch-results/batch-006-validate.json"), JSON.stringify({
    schemaVersion: 1,
    agent: "validate",
    batch: 6,
    status: "FAILURE",
    itemsCompleted: [],
    filesChanged: [".yolo/batch-results/batch-006-validate.json"],
    tests: { commands: [{ command: "npm test", exitCode: 0, evidence: "passed" }], testsAdded: 1 },
    failureType: "PRD_PROOF_GAP",
    flags: []
  }));
  const changed = await canonicalizeBatchResultManifests(dir, 6);
  const normalized = JSON.parse(await readFileText(join(dir, ".yolo/batch-results/batch-006-validate.json")));
  assert.deepEqual(changed, [".yolo/batch-results/batch-006-validate.json"]);
  assert.equal(normalized.flags.includes("INVALID_TESTS_SHAPE"), false);
  assert.equal(normalized.tests.regression.command, "npm test");
  await rm(dir, { recursive: true, force: true });
});

test("claims loader canonicalizes common human claim aliases", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "docs/claims"), { recursive: true });
  await writeFile(join(dir, "docs/claims/survey.json"), JSON.stringify({ title: "[API] Add survey export — PRD §8b", owner: "alice", state: "in progress", files: [{ path: "src\\api\\survey.ts" }] }));
  const claims = await loadClaims(dir, defaultConfig);
  assert.equal(claims.errors.length, 0);
  assert.equal(claims.claims[0].operator, "alice");
  assert.equal(claims.claims[0].status, "active");
  assert.deepEqual(claims.claims[0].expectedFiles, ["src/api/survey.ts"]);
  const onDisk = JSON.parse(await readFileText(join(dir, "docs/claims/survey.json")));
  assert.equal(onDisk.schemaVersion, 1);
  assert.equal(onDisk.task, "[API] Add survey export — PRD §8b");
  await rm(dir, { recursive: true, force: true });
});

test("claims contract validates active contributor claims", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "docs/claims"), { recursive: true });
  await writeFile(join(dir, "docs/claims/survey.json"), JSON.stringify({ schemaVersion: 1, task: "[API] Add survey export — PRD §8b", operator: "contributor:alice", tool: "claude-code", branch: "feature/survey-export", status: "active", startedAt: "2026-05-18T00:00:00Z", expectedFiles: ["src/api/survey.ts"] }));
  const claims = await loadClaims(dir, defaultConfig);
  assert.deepEqual(validateClaims(claims), { name: "claims-contract", passed: true, flags: [] });
  await rm(dir, { recursive: true, force: true });
});

test("runtime claims create and release yolo-owned single batch claims", async () => {
  const dir = await tempDir();
  const config = { ...defaultConfig, collaboration: { enabled: true, claimsDir: "docs/claims", staleClaimHours: 24, maxParallelAgents: 2 } };
  const batch = { number: 3, type: "implement" as const, items: [{ raw: "", tag: "[UI]", title: "Build app shell — PRD §5b", phase: "Phase 0", checked: false, affectedFiles: ["src/App.tsx"] }] };
  const gate = await prepareRuntimeClaim(dir, config, batch);
  assert.deepEqual(gate, { name: "claims-contract", passed: true, flags: [] });
  const file = join(dir, "docs/claims/yolo-batch-003.json");
  const active = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(active.operator, "operator:pi-yolo");
  assert.equal(active.status, "active");
  assert.deepEqual(active.expectedFiles, ["src/App.tsx"]);
  await markRuntimeClaim(dir, config, batch, "done");
  const done = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(done.status, "done");
  await rm(dir, { recursive: true, force: true });
});

test("claims loader reconciles stale yolo-owned claims for committed batches", async () => {
  const dir = await tempDir();
  await execCommand("git init && git config user.email test@example.com && git config user.name Test", dir, 30_000);
  await writeFile(join(dir, "README.md"), "x");
  await execCommand("git add . && git commit -m init", dir, 30_000);
  await writeFile(join(dir, "README.md"), "x\ny");
  await execCommand("git add . && git commit -m 'feat(yolo): complete batch 013'", dir, 30_000);
  await mkdir(join(dir, "docs/claims"), { recursive: true });
  await writeFile(join(dir, "docs/claims/yolo-batch-013.json"), JSON.stringify({ schemaVersion: 1, task: "done task", operator: "operator:pi-yolo", tool: "klevar-yolo-runtime", branch: "klevar/yolo-batch-013", status: "blocked", startedAt: "2026-05-18T00:00:00Z", expectedFiles: ["tests/components/"] }));
  await writeFile(join(dir, "docs/claims/external.json"), JSON.stringify({ schemaVersion: 1, task: "external task", operator: "contributor:alice", tool: "human", branch: "feature/external", status: "blocked", startedAt: "2026-05-18T00:00:00Z", expectedFiles: ["tests/components/"] }));
  const claims = await loadClaims(dir, defaultConfig);
  assert.equal(claims.claims.find((claim) => claim.branch === "klevar/yolo-batch-013")?.status, "done");
  assert.equal(claims.claims.find((claim) => claim.branch === "feature/external")?.status, "blocked");
  const onDisk = JSON.parse(await readFileText(join(dir, "docs/claims/yolo-batch-013.json")));
  assert.equal(onDisk.status, "done");
  await rm(dir, { recursive: true, force: true });
});

test("runtime claims reject external task and file conflicts", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "docs/claims"), { recursive: true });
  await writeFile(join(dir, "docs/claims/external.json"), JSON.stringify({ schemaVersion: 1, task: "Build app shell", operator: "contributor:alice", branch: "feature/app-shell", status: "active", startedAt: "2026-05-18T00:00:00Z", expectedFiles: ["src/App.tsx"] }));
  const config = { ...defaultConfig, collaboration: { enabled: true, claimsDir: "docs/claims", staleClaimHours: 24, maxParallelAgents: 2 } };
  const batch = { number: 4, type: "implement" as const, items: [{ raw: "", tag: "[UI]", title: "Build app shell — PRD §5b", phase: "Phase 0", checked: false, affectedFiles: ["src/App.tsx"] }] };
  const gate = await prepareRuntimeClaim(dir, config, batch);
  assert.equal(gate.passed, false);
  assert.ok(gate.flags.includes("EXTERNALLY_CLAIMED:Build app shell — PRD §5b"));
  assert.ok(gate.flags.includes("CLAIM_FILE_CONFLICT:src/App.tsx"));
  assert.equal(existsSync(join(dir, "docs/claims/yolo-batch-004.json")), false);
  await rm(dir, { recursive: true, force: true });
});

test("claims contract rejects duplicate file ownership", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "docs/claims"), { recursive: true });
  const base = { schemaVersion: 1, task: "task", operator: "contributor:alice", branch: "feature/a", status: "active", startedAt: "2026-05-18T00:00:00Z", expectedFiles: ["src/shared.ts"] };
  await writeFile(join(dir, "docs/claims/a.json"), JSON.stringify(base));
  await writeFile(join(dir, "docs/claims/b.json"), JSON.stringify({ ...base, task: "other", operator: "contributor:bob", branch: "feature/b" }));
  const gate = validateClaims(await loadClaims(dir, defaultConfig));
  assert.equal(gate.passed, false);
  assert.ok(gate.flags.includes("CLAIM_FILE_CONFLICT:src/shared.ts"));
  await rm(dir, { recursive: true, force: true });
});

test("parallel scheduler selects independent local frontend and backend shards", () => {
  const items = [
    { raw: "", tag: "[UI]", title: "Build survey page — PRD §5b", phase: "Phase 1", checked: false, affectedFiles: ["src/ui/survey.tsx"] },
    { raw: "", tag: "[API]", title: "Build survey API — PRD §8b", phase: "Phase 1", checked: false, affectedFiles: ["src/api/survey.ts"] }
  ];
  const plan = planParallelBatches(items, 2, 2, defaultConfig, []);
  assert.equal(plan.shards.length, 2);
  assert.deepEqual(plan.flags, []);
});

test("parallel scheduler skips externally claimed work", () => {
  const items = [
    { raw: "", tag: "[API]", title: "Add survey export — PRD §8b", phase: "Phase 1", checked: false, affectedFiles: ["src/api/export.ts"] },
    { raw: "", tag: "[UI]", title: "Add survey dashboard — PRD §5b", phase: "Phase 1", checked: false, affectedFiles: ["src/ui/dashboard.tsx"] }
  ];
  const plan = planParallelBatches(items, 2, 2, defaultConfig, [{ schemaVersion: 1, task: "Add survey export", operator: "contributor:alice", branch: "feature/export", status: "active", startedAt: "2026-05-18T00:00:00Z", expectedFiles: ["src/api/export.ts"] }]);
  assert.equal(plan.shards.length, 1);
  assert.ok(plan.skipped.some((item) => item.startsWith("EXTERNALLY_CLAIMED")));
});

test("parallel scheduler treats cross-language build manifests as shared files", () => {
  const items = [
    { raw: "", tag: "[API]", title: "Update Rust deps — PRD §3", phase: "Phase 1", checked: false, affectedFiles: ["Cargo.toml"] },
    { raw: "", tag: "[API]", title: "Update .NET project — PRD §3", phase: "Phase 1", checked: false, affectedFiles: ["src/App/App.csproj"] },
    { raw: "", tag: "[API]", title: "Update Python deps — PRD §3", phase: "Phase 1", checked: false, affectedFiles: ["pyproject.toml"] }
  ];
  const plan = planParallelBatches(items, 2, 3, defaultConfig, []);
  assert.equal(plan.shards.length, 0);
  assert.equal(plan.skipped.filter((item) => item.startsWith("SHARED_FILE_NOT_PARALLEL")).length, 3);
});

test("progress contract accepts tagged PRD-referenced items", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs/progress.md"), [
    "# Progress",
    "## Phase 0: Setup",
    "- [ ] [SETUP] Configure local tooling — PRD §3",
    "- [ ] [API] Add claim endpoint — PRD §8b",
    "- [ ] [SETUP] Phase 0 close-out — PRD §2b"
  ].join("\n"));
  assert.deepEqual(await validateProgressContract(dir), { name: "progress-contract", passed: true, flags: [] });
  await rm(dir, { recursive: true, force: true });
});

test("progress contract rejects malformed items, missing PRD refs, unknown tags, and misplaced audits", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs/progress.md"), [
    "# Progress",
    "## Phase 0: Setup",
    "- [ ] Missing tag — PRD §3",
    "- [ ] [NOPE] Unknown task — PRD §3",
    "- [ ] [API] Add claim endpoint",
    "- [ ] [AUDIT] Verify throughput target — PRD §13",
    "- [ ] [SETUP] Phase 0 close-out — PRD §2b",
    "- [ ] [SETUP] Another task after phase close-out — PRD §3"
  ].join("\n"));
  const gate = await validateProgressContract(dir);
  assert.equal(gate.passed, false);
  assert.ok(gate.flags.includes("PROGRESS_ITEM_MALFORMED:L3"));
  assert.ok(gate.flags.includes("UNKNOWN_PROGRESS_TAG:L4:[NOPE]"));
  assert.ok(gate.flags.includes("MISSING_PRD_REFERENCE:L5:[API]"));
  assert.ok(gate.flags.includes("AUDIT_CLOSEOUT_NOT_LAST:Phase 0: Setup"));
  await rm(dir, { recursive: true, force: true });
});

test("batch selection isolates audit items from implementation work", () => {
  const items = [
    progressItem("[SETUP]", "Foundation — PRD §2"),
    progressItem("[API]", "Validation — PRD §2"),
    progressItem("[SETUP]", "Phase 0 close-out — walk Coverage Matrices — PRD §2b", ["- **Audit type:** matrix-coverage"]),
    progressItem("[DATA]", "Tenants migration — PRD §4")
  ];
  assert.deepEqual(selectBatch(items, 5, "full").map((item) => item.tag), ["[SETUP]", "[API]"]);
  assert.deepEqual(selectBatch(items.slice(2), 5, "full").map((item) => item.tag), ["[SETUP]"]);
  assert.equal(isAuditItem(items[2]), true);
});

test("phase range selection includes bounded phases and excludes later phases", () => {
  const phase18 = { ...progressItem("[API]", "Earlier — PRD §8b"), phase: "Phase 18: Earlier" };
  const phase19 = { ...progressItem("[API]", "Start range — PRD §8b"), phase: "Phase 19: Start" };
  const phase20 = { ...progressItem("[UI]", "End range — PRD §5b"), phase: "Phase 20: End" };
  const phase21 = { ...progressItem("[API]", "Later — PRD §8b"), phase: "Phase 21: Later" };
  assert.deepEqual(selectBatch([phase18, phase19, phase20, phase21], 5, "phase 19 to 20").map((item) => item.phase), ["Phase 19: Start", "Phase 20: End"]);
  assert.deepEqual(selectBatch([phase18, phase19, phase20, phase21], 5, "phase 19-20").map((item) => item.phase), ["Phase 19: Start", "Phase 20: End"]);
});

test("acceptance audit items route to implement while closeout audits route to audit", () => {
  const acceptance = progressItem("[AUDIT]", "Verify ingest throughput reaches 50 tracking events/sec locally — PRD §10b");
  const closeout = progressItem("[AUDIT]", "Phase 5 close-out — verify full PRD success criteria — PRD §15");
  const matrix = progressItem("[SETUP]", "Phase 1 close-out — walk Coverage Matrices — PRD §2b", ["- **Audit type:** matrix-coverage"]);
  assert.equal(isAuditItem(acceptance), true);
  assert.equal(classifyBatchType([acceptance]), "implement");
  assert.equal(classifyBatchType([closeout]), "audit");
  assert.equal(classifyBatchType([matrix]), "audit");
});

test("progress contract allows non-closeout audit verification items before phase closeout", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs/progress.md"), [
    "# Progress",
    "## Phase 5: Operations",
    "- [ ] [AUDIT] Verify ingest throughput reaches 50 tracking events/sec locally — PRD §10b",
    "- [ ] [UI] Implement Dashboard — PRD §5b",
    "- [ ] [AUDIT] Phase 5 close-out — verify full PRD success criteria — PRD §15"
  ].join("\n"));
  assert.deepEqual(await validateProgressContract(dir), { name: "progress-contract", passed: true, flags: [] });
  await rm(dir, { recursive: true, force: true });
});

test("git commit cleanup removes Windows reserved device files before staging", async () => {
  const dir = await tempDir();
  await writeFile(join(dir, "NUL"), "accidental device file\n");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "COM1.txt"), "reserved with extension\n");
  const removed = await removeWindowsReservedDeviceFiles(dir);
  assert.deepEqual(removed.sort(), ["NUL", "src/COM1.txt"].sort());
  assert.equal(existsSync(join(dir, "NUL")), false);
  assert.equal(existsSync(join(dir, "src", "COM1.txt")), false);
  await rm(dir, { recursive: true, force: true });
});

test("batch numbering uses filesystem instead of shell utilities", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo/batch-results"), { recursive: true });
  await writeFile(join(dir, ".yolo/batch-results/batch-001-implement.json"), "{}\n");
  await writeFile(join(dir, ".yolo/batch-results/batch-009-journal.json"), "{}\n");
  assert.equal(await nextBatchNumber(dir), 10);
  await rm(dir, { recursive: true, force: true });
});

test("journal contract accepts journal-specific success shape", () => {
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  assert.deepEqual(validateJournalContract(result), { passed: true, flags: [] });
});

test("journal contract derives confirmations from changed files", () => {
  const result = journalResult({ journal_entry_written: false, gate_file_written: false });
  result.filesChanged = ["docs/build-journal/001-batch.md", ".yolo/gates/journal-batch-001.md"];
  assert.deepEqual(validateJournalContract(result), { passed: true, flags: [] });
});

test("journal contract accepts artifact and flag confirmations", () => {
  const result = journalResult({ journal_entry_written: false, gate_file_written: false });
  result.filesChanged = [];
  result.artifacts = [{ path: "docs/build-journal/001-batch.md" }, { path: ".yolo/gates/journal-batch-001.md" }];
  assert.deepEqual(validateJournalContract(result), { passed: true, flags: [] });
  const flagResult = journalResult({ journal_entry_written: false, gate_file_written: false });
  flagResult.flags = ["JOURNAL_ENTRY_WRITTEN", "GATE_FILE_WRITTEN"];
  assert.deepEqual(validateJournalContract(flagResult), { passed: true, flags: [] });
});

test("journal contract rejects missing journal confirmations", () => {
  const result = journalResult({ journal_entry_written: false, gate_file_written: true });
  result.filesChanged = [];
  assert.deepEqual(validateJournalContract(result), { passed: false, flags: ["JOURNAL_ENTRY_NOT_CONFIRMED"] });
});

test("journal source falls back to validate result for audit close-out batches", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo/batch-results"), { recursive: true });
  await writeFile(join(dir, ".yolo/batch-results/batch-029-validate.md"), "# Validate\n");
  assert.deepEqual(await journalSource(dir, { number: 29, type: "audit", items: [] }), { file: ".yolo/batch-results/batch-029-validate.md", type: "validate" });
  await writeFile(join(dir, ".yolo/batch-results/batch-029-bugfix-2.md"), "# Bugfix\n");
  assert.deepEqual(await journalSource(dir, { number: 29, type: "audit", items: [] }), { file: ".yolo/batch-results/batch-029-bugfix-2.md", type: "bugfix" });
  await rm(dir, { recursive: true, force: true });
});

test("journal prompt placeholders include runtime-selected source file and type", () => {
  const filled = fillLegacyPlaceholders("{{BATCH_RESULT_FILE}} {{BATCH_TYPE}} {{WORKSPACE_FILE}}", { id: "batch-029-journal", role: "journal", promptFile: "p.md", context: "", outputBase: ".yolo/batch-results/batch-029-journal", cwd: process.cwd(), route: {}, promptVars: { BATCH_RESULT_FILE: ".yolo/batch-results/batch-029-validate.md", BATCH_TYPE: "validate" } });
  assert.equal(filled, ".yolo/batch-results/batch-029-validate.md validate .yolo/batch-results/batch-029-journal.md");
});

test("journal contract rejects non-array flags instead of crashing runtime", () => {
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.flags = { journalEntryWritten: true } as unknown as string[];
  assert.deepEqual(validateJournalContract(result), { passed: false, flags: ["MISSING_FLAGS_ARRAY"] });
  const source = readFileSync(join(process.cwd(), "src/runtime.ts"), "utf8");
  assert.match(source, /function resultFlags/);
  assert.match(source, /INVALID_FLAGS_SHAPE/);
});

test("wiring verifier extracts file paths from descriptive evidence", () => {
  assert.deepEqual(extractVerifierFiles("TenantApiAndContextIntegrationTest.postRegister and tests/playwright/tenant-api.spec.ts"), ["tests/playwright/tenant-api.spec.ts"]);
  assert.deepEqual(extractVerifierFiles("src/test/java/com/acme/TenantApiAndContextIntegrationTest.java proves route"), ["src/test/java/com/acme/TenantApiAndContextIntegrationTest.java"]);
  assert.deepEqual(extractVerifierFiles("TenantWebMvcConfiguration registers interceptor; integration test proves it"), []);
  assert.deepEqual(extractVerifierFiles("src/features/support/SupportRoute.tsx and .yolo/gates/wiring-batch-010.md"), ["src/features/support/SupportRoute.tsx", ".yolo/gates/wiring-batch-010.md"]);
});

test("wiring verifier accepts cross-language test extension variants", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "tests/components"), { recursive: true });
  await mkdir(join(dir, "src/test/java/com/acme"), { recursive: true });
  await mkdir(join(dir, "tests/api"), { recursive: true });
  await mkdir(join(dir, "tests/go"), { recursive: true });
  await writeFile(join(dir, "tests/components/component-foundation.test.tsx"), "test('ok', () => {})\n");
  await writeFile(join(dir, "src/test/java/com/acme/OrderServiceTest.kt"), "class OrderServiceTest\n");
  await writeFile(join(dir, "tests/api/test_resource.py"), "def test_resource(): pass\n");
  await writeFile(join(dir, "tests/go/order_test.go"), "package tests\n");
  const result = implementResult({ filesChanged: ["src/App.tsx"] });
  result.wiring = {
    required: true,
    entrypoints: [
      { type: "ui-route", path: "/app", verifiedBy: "tests/components/component-foundation.test.ts" },
      { type: "module", path: "OrderService", verifiedBy: "src/test/java/com/acme/OrderServiceTest.java" },
      { type: "api", path: "resource", verifiedBy: "tests/api/test_resource.js" },
      { type: "job", path: "consumer", verifiedBy: "tests/go/order_test.rs" }
    ]
  };
  const gate = await validateWiring(dir, { number: 10, type: "implement", items: [progressItem("[UI]", "Workspace — PRD §13")] } as any, result, true);
  assert.equal(gate.passed, true);
  await rm(dir, { recursive: true, force: true });
});

test("wiring verifier infers objective test coverage for string-only recovered entrypoints", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "tests/integration/api"), { recursive: true });
  await mkdir(join(dir, "src/api"), { recursive: true });
  await writeFile(join(dir, "tests/integration/api/share-telemetry-support.test.ts"), "router.handle(new Request('https://app.test/api/projects/project-1/export-artifacts'))\n");
  await writeFile(join(dir, "tests/integration/api/supabase-cloud-store.test.ts"), "import { createStore } from '@/api/supabaseCloudStore';\n");
  await writeFile(join(dir, "src/api/supabaseCloudStore.ts"), "export const createStore = () => null;\n");
  const result = implementResult({ filesChanged: ["src/api/supabaseCloudStore.ts"] });
  result.wiring = {
    required: true,
    entrypoints: [
      { type: "", path: "GET /api/projects/:id/export-artifacts", verifiedBy: "" },
      { type: "", path: "src/api/supabaseCloudStore.ts", verifiedBy: "" }
    ]
  };
  const gate = await validateWiring(dir, { number: 27, type: "implement", items: [progressItem("[API]", "Cloud export artifacts — PRD §8b")] } as any, result, true);
  assert.equal(gate.passed, true);
  assert.deepEqual(gate.flags, []);
  await rm(dir, { recursive: true, force: true });
});

test("wiring verifier infers annotated API entrypoint chains from route evidence", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "scripts"), { recursive: true });
  await writeFile(join(dir, "scripts/run-e2e.ts"), "console.log('PASS POST /api/admin/operator-inbox/read/:itemId 200');\nconsole.log('PASS GET /api/admin/audit-events 200');\n");
  const result = implementResult({ filesChanged: ["src/routes/admin/operator-inbox.ts"] });
  result.wiring = {
    required: true,
    entrypoints: [
      { type: "api", path: "POST /api/admin/operator-inbox/read/:itemId -> markOperatorItemRead -> recordAuditEvent", verifiedBy: "" },
      { type: "api", path: "GET /api/admin/audit-events -> listAuditEvents", verifiedBy: "" }
    ]
  };
  const gate = await validateWiring(dir, { number: 7, type: "implement", items: [progressItem("[API]", "Audit inbox reads — PRD §13b.7")] } as any, result, true);
  assert.deepEqual(gate, { name: "wiring", passed: true, flags: [] });
  await rm(dir, { recursive: true, force: true });
});

test("wiring verifier infers API and CLI coverage from e2e scripts", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "scripts"), { recursive: true });
  await writeFile(join(dir, "scripts/run-e2e.ts"), [
    "await expectApi('POST', `/api/admin/operator-inbox/read-project/${seed.projectId}`, seed.apiKey);",
    "await expectApi('POST', `/api/admin/operator-inbox/read-client/${seed.clientId}`, seed.apiKey);",
    "await expectCli(['queue'], seed.apiKey, 'Work queue');",
    "await expectCli(['inbox', 'read-state', `task:${seed.taskId}`], seed.apiKey, 'Unread: no');",
    "await expectCli(['reports', 'draft', seed.clientId], seed.apiKey, 'Draft created');",
    "await expectCli(['reports', 'archive', seed.draftId], seed.apiKey, 'Archived');"
  ].join("\n"));
  const result = implementResult({ filesChanged: ["scripts/run-e2e.ts"] });
  result.wiring = {
    required: true,
    entrypoints: [
      { type: "api", path: "POST /api/admin/operator-inbox/read-project/:projectId", verifiedBy: "" },
      { type: "api", path: "POST /api/admin/operator-inbox/read-client/:clientId", verifiedBy: "" },
      { type: "cli", path: "CLI klevar-portal queue", verifiedBy: "" },
      { type: "cli", path: "CLI klevar-portal inbox read-state <itemId>", verifiedBy: "" },
      { type: "cli", path: "CLI klevar-portal reports draft <clientId>", verifiedBy: "" },
      { type: "cli", path: "CLI klevar-portal reports archive <draftId>", verifiedBy: "" }
    ]
  };
  const gate = await validateWiring(dir, { number: 4, type: "implement", items: [progressItem("[API]", "Operator inbox — PRD §8b")] } as any, result, true);
  assert.deepEqual(gate, { name: "wiring", passed: true, flags: [] });
  await rm(dir, { recursive: true, force: true });
});

test("wiring verifier infers CLI entries without CLI prefix and query route coverage", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "tests/cli"), { recursive: true });
  await mkdir(join(dir, "scripts"), { recursive: true });
  await writeFile(join(dir, "tests/cli/tooling.test.ts"), [
    "await cli(['inbox', '--read']);",
    "await cli(['inbox', '--all']);",
    "await cli(['inbox', 'read-state', itemId]);",
    "await cli(['reports', 'draft', clientId]);",
    "await cli(['reports', 'send', draftId]);"
  ].join("\n"));
  await writeFile(join(dir, "scripts/e2e.ts"), "await expectApi('GET', '/api/admin/operator-inbox?all=true', apiKey);\n");
  const result = implementResult({ filesChanged: ["tools/commands/operator.ts"] });
  result.wiring = {
    required: true,
    entrypoints: [
      { type: "cli", path: "klevar-portal inbox --read", verifiedBy: "" },
      { type: "cli", path: "klevar-portal inbox --all", verifiedBy: "" },
      { type: "cli", path: "klevar-portal inbox read-state <itemId>", verifiedBy: "" },
      { type: "cli", path: "klevar-portal reports draft|send", verifiedBy: "" },
      { type: "api", path: "GET /api/admin/operator-inbox?all=true", verifiedBy: "" }
    ]
  };
  const gate = await validateWiring(dir, { number: 5, type: "implement", items: [progressItem("[API]", "Operator inbox — PRD §8b")] } as any, result, true);
  assert.deepEqual(gate, { name: "wiring", passed: true, flags: [] });
  await rm(dir, { recursive: true, force: true });
});

test("wiring verifier infers dynamic API query placeholders from e2e evidence", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "scripts"), { recursive: true });
  await writeFile(join(dir, "scripts/run-e2e.ts"), [
    "await expectApi('GET', `/api/admin/notifications/preview/${seed.eventType}?client=${clientA.id}&project=${projectB.id}&explain=true`, apiKey, 400);",
    "await expectCli(['notifications', 'preview', seed.eventType, '--client', clientA.id, '--project', projectB.id, '--explain'], apiKey, 'client/project mismatch');"
  ].join("\n"));
  const result = implementResult({ filesChanged: ["scripts/run-e2e.ts"] });
  result.wiring = {
    required: true,
    entrypoints: [
      { type: "api", path: "GET /api/admin/notifications/preview/:eventType?client=<clientA>&project=<projectB>&explain=true", verifiedBy: "" },
      { type: "cli", path: "klevar-portal notifications preview --client <clientA> --project <projectB> --explain", verifiedBy: "" }
    ]
  };
  const gate = await validateWiring(dir, { number: 8, type: "implement", items: [progressItem("[API]", "Notification preview explain — PRD §13b.6")] } as any, result, true);
  assert.deepEqual(gate, { name: "wiring", passed: true, flags: [] });
  await rm(dir, { recursive: true, force: true });
});

test("wiring verifier infers descriptive API and npm script evidence", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "scripts"), { recursive: true });
  await mkdir(join(dir, "src/routes/public"), { recursive: true });
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "scripts/run-e2e.ts"), "console.log('PASS POST /api/onboard invalid payload 400 without server-error log');\n");
  await writeFile(join(dir, "src/routes/public/onboard.ts"), "router.post('/api/onboard', async () => {});\n");
  await writeFile(join(dir, "src/server.ts"), "app.addHook('onClose', async () => closeRateLimitRedis());\n");
  const result = implementResult({ filesChanged: ["src/routes/public/onboard.ts", "src/server.ts", "scripts/run-e2e.ts"] });
  result.wiring = {
    required: true,
    entrypoints: [
      { type: "api", path: "POST /api/onboard invalid payload returns 400 without server-error log", verifiedBy: "" },
      { type: "server", path: "Fastify onClose closes rate-limit Redis singleton", verifiedBy: "" },
      { type: "e2e", path: "npm run test:e2e public onboarding validation probe", verifiedBy: "" }
    ]
  };
  const gate = await validateWiring(dir, { number: 11, type: "implement", items: [progressItem("[API]", "Public onboarding — PRD §8")] } as any, result, true);
  assert.deepEqual(gate, { name: "wiring", passed: true, flags: [] });
  await rm(dir, { recursive: true, force: true });
});

test("wiring verifier discovers project-local verifier extensions", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "tests/policy"), { recursive: true });
  await writeFile(join(dir, "tests/policy/allocation_policy_test.weirdlang"), "assert creates_policy_via_adapter()\n");
  const result = implementResult({ filesChanged: ["src/policy.adapter"] });
  result.wiring = {
    required: true,
    entrypoints: [{ type: "module", path: "creates_policy_via_adapter", verifiedBy: "" }]
  };
  const gate = await validateWiring(dir, { number: 14, type: "implement", items: [progressItem("[API]", "Policy adapter — PRD §7")] } as any, result, true);
  assert.deepEqual(gate, { name: "wiring", passed: true, flags: [] });
  await rm(dir, { recursive: true, force: true });
});

test("wiring verifier accepts discovered extension alternatives for declared test files", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "tests/policy"), { recursive: true });
  await writeFile(join(dir, "tests/policy/allocation_policy.test.weirdlang"), "assert true\n");
  const result = implementResult({ filesChanged: ["src/policy.adapter"] });
  result.wiring = {
    required: true,
    entrypoints: [{ type: "module", path: "create policy", verifiedBy: "tests/policy/allocation_policy.test.ts" }]
  };
  const gate = await validateWiring(dir, { number: 14, type: "implement", items: [progressItem("[API]", "Policy adapter — PRD §7")] } as any, result, true);
  assert.deepEqual(gate, { name: "wiring", passed: true, flags: [] });
  await rm(dir, { recursive: true, force: true });
});

test("wiring verifier infers module function symbols from compact entrypoints", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "tests/unit/data"), { recursive: true });
  await mkdir(join(dir, "src/planning"), { recursive: true });
  await writeFile(join(dir, "tests/unit/data/repository_test.jl"), [
    "listed = list_allocation_policies(store, ctx)",
    "created = create_allocation_policy!(store, ctx, payload)"
  ].join("\n"));
  await writeFile(join(dir, "src/planning/catalog.jl"), "function list_allocation_policies() end\nfunction create_allocation_policy!() end\n");
  const result = implementResult({ filesChanged: ["src/planning/catalog.jl"] });
  result.wiring = {
    required: true,
    entrypoints: [{ type: "module", path: "list_allocation_policies/create_allocation_policy!", verifiedBy: "" }]
  };
  const gate = await validateWiring(dir, { number: 13, type: "implement", items: [progressItem("[API]", "Repository functions — PRD §7")] } as any, result, true);
  assert.deepEqual(gate, { name: "wiring", passed: true, flags: [] });
  await rm(dir, { recursive: true, force: true });
});

test("batch result normalization treats malformed agent JSON as hostile input", async () => {
  const raw = {
    schemaVersion: 1,
    agent: "journal",
    batch: "012",
    status: "SUCCESS",
    itemsCompleted: [{ title: "done" }],
    filesChanged: [{ path: "src/App.java" }],
    flags: { journalEntryWritten: true },
    localOnlyFiles: { path: "node_modules/" },
    artifacts: "docs/build-journal/012-batch.md"
  };
  const normalized = normalizeBatchResult(raw, 12);
  assert.equal(normalized.batch, 12);
  assert.deepEqual(normalized.itemsCompleted, ["done"]);
  assert.deepEqual(normalized.filesChanged, ["src/App.java"]);
  assert.deepEqual(normalized.localOnlyFiles, []);
  assert.ok(normalized.flags.includes("FLAGS_OBJECT_NORMALIZED"));
  assert.ok(normalized.flags.includes("ITEMS_COMPLETED_OBJECTS_NORMALIZED"));
  assert.ok(normalized.flags.includes("FILES_CHANGED_OBJECTS_NORMALIZED"));
  assert.ok(normalized.flags.includes("journalEntryWritten"));
  assert.deepEqual(normalized.artifacts, [{ path: "docs/build-journal/012-batch.md" }]);
  assert.equal(validateContract(normalized).passed, true);
  const dir = await tempDir();
  const file = join(dir, ".yolo/batch-results/batch-012-journal.json");
  await mkdir(join(dir, ".yolo/batch-results"), { recursive: true });
  await writeFile(file, JSON.stringify(raw));
  assert.deepEqual(await readBatchResult(file), normalized);
  await rm(dir, { recursive: true, force: true });
});

test("batch result normalization canonicalizes test evidence aliases", () => {
  const normalized = normalizeBatchResult({
    schemaVersion: 1,
    agent: "bugfix",
    batch: 16,
    status: "SUCCESS",
    itemsCompleted: ["fixed race"],
    filesChanged: ["src/App.java"],
    tests: {
      redReproducer: { cmd: "./gradlew race", exit_code: 1, summary: "race failed red" },
      greenReproducer: { command: "./gradlew race", exitCode: 0, evidence: "race green" },
      cargoTest: { commandLine: "cargo test", code: 0, output: "full suite green" },
      cypressRegression: { command: "npx cypress run", exitCode: 0, evidence: "browser green", required: true }
    },
    flags: []
  }, 16);
  assert.equal(normalized.tests?.red?.command, "./gradlew race");
  assert.equal(normalized.tests?.red?.exitCode, 1);
  assert.equal(normalized.tests?.green?.evidence, "race green");
  assert.equal(normalized.tests?.regression?.command, "cargo test");
  assert.equal(normalized.tests?.e2e?.required, true);
  assert.ok(normalized.flags.includes("TEST_EVIDENCE_ALIASES_NORMALIZED"));
  assert.equal(validateTdd(normalized, true).passed, true);
  assert.equal(validateContract(normalized).passed, true);
});

test("canonical batch result preserves project-local contract metadata", async () => {
  const dir = await tempDir();
  const file = join(dir, "batch-015-audit.json");
  await writeFile(file, JSON.stringify({
    schemaVersion: 1,
    agent: "audit",
    batch: 15,
    status: "SUCCESS",
    itemsCompleted: [],
    filesChanged: [],
    flags: [],
    auditType: "matrix-coverage",
    matrixRef: "Roles × Resource Actions",
    cellsChecked: 18,
    cellsPassed: 18,
    cellsFailed: 0
  }));
  const result = await readCanonicalBatchResult(file) as any;
  assert.equal(result.auditType, "matrix-coverage");
  const persisted = JSON.parse(await readFileText(file));
  assert.equal(persisted.auditType, "matrix-coverage");
  assert.equal(persisted.cellsChecked, 18);
  await rm(dir, { recursive: true, force: true });
});

test("canonical batch result read repairs result files on disk", async () => {
  const dir = await tempDir();
  const file = join(dir, ".yolo/batch-results/batch-006-validate.json");
  await mkdir(join(dir, ".yolo/batch-results"), { recursive: true });
  await writeFile(file, JSON.stringify({ schemaVersion: 1, agent: "validate", batch: 6, status: "SUCCESS", itemsCompleted: [], filesChanged: [], tests: { commands: [{ command: "npm test", exitCode: 0, evidence: "passed" }], testsAdded: 1 }, flags: [] }));
  const result = await readCanonicalBatchResult(file);
  const onDisk = JSON.parse(await readFileText(file));
  assert.equal(result.tests?.regression?.command, "npm test");
  assert.equal(onDisk.tests.regression.command, "npm test");
  assert.equal(onDisk.tests.commands, undefined);
  await rm(dir, { recursive: true, force: true });
});

test("batch result normalization accepts tests.commands arrays with metadata", () => {
  const normalized = normalizeBatchResult({
    schemaVersion: 1,
    agent: "validate",
    batch: 6,
    status: "FAILURE",
    itemsCompleted: [],
    filesChanged: [".yolo/batch-results/batch-006-validate.json"],
    tests: {
      commands: [
        { command: "npm run test:exports:parity", exitCode: 0, evidence: "passed" },
        { command: "npm test", exitCode: 0, evidence: "71 tests passed" }
      ],
      testsAdded: 7,
      additional: [{ command: "npm run lint", status: "PASS" }]
    },
    failureType: "PRD_PROOF_GAP",
    flags: []
  }, 6);
  assert.equal(normalized.flags.includes("INVALID_TESTS_SHAPE"), false);
  assert.equal(normalized.tests?.regression?.command, "npm run test:exports:parity");
  assert.equal(validateContract(normalized).flags.includes("RESULT_STATUS_FAILURE:PRD_PROOF_GAP"), true);
});

test("batch result normalization accepts validate-agent test arrays", () => {
  const normalized = normalizeBatchResult({
    schemaVersion: 1,
    agent: "validate",
    batch: 18,
    status: "SUCCESS",
    itemsCompleted: [],
    filesChanged: [".yolo/batch-results/batch-018-validate.json"],
    tests: [
      { command: "./gradlew test --rerun-tasks", status: "PASS", summary: "99 JVM tests passed" },
      { command: "npx playwright test", status: "PASS", summary: "7 browser tests passed" },
      { command: "bash scripts/scan-secrets.sh --mode paths", status: "PASS", summary: "clean" }
    ],
    flags: []
  }, 18);
  assert.equal(normalized.tests?.regression?.command, "./gradlew test --rerun-tasks");
  assert.equal(normalized.tests?.regression?.exitCode, 0);
  assert.equal(normalized.tests?.e2e?.command, "npx playwright test");
  assert.equal(normalized.tests?.e2e?.required, true);
  assert.ok(normalized.flags.includes("TEST_EVIDENCE_ARRAY_NORMALIZED"));
  assert.equal(normalized.flags.includes("INVALID_TESTS_SHAPE"), false);
  assert.equal(validateContract(normalized).passed, true);
});

test("batch result normalization rejects malformed test evidence shape", () => {
  const normalized = normalizeBatchResult({ schemaVersion: 1, agent: "implement", batch: 1, status: "SUCCESS", itemsCompleted: [], filesChanged: [], tests: { red: "passed" }, flags: [] }, 1);
  assert.ok(normalized.flags.includes("INVALID_TESTS_SHAPE"));
  assert.equal(validateContract(normalized).passed, false);
});

test("batch result normalization rejects unsafe non-normalizable shapes", () => {
  const normalized = normalizeBatchResult({
    schemaVersion: 1,
    agent: "validate",
    batch: 19,
    status: "SUCCESS",
    itemsCompleted: [{ nope: true }],
    filesChanged: [{ nope: true }],
    flags: { nested: { unsafe: true } },
    artifacts: [null],
    localOnlyFiles: [{ reason: "missing path" }],
    tests: ["passed"]
  }, 19);
  for (const flag of ["INVALID_ITEMS_COMPLETED_SHAPE", "INVALID_FILES_CHANGED_SHAPE", "INVALID_FLAGS_SHAPE", "INVALID_ARTIFACTS_SHAPE", "INVALID_LOCAL_ONLY_FILES_SHAPE", "INVALID_TESTS_SHAPE"]) {
    assert.ok(normalized.flags.includes(flag), flag);
  }
  assert.equal(validateContract(normalized).passed, false);
});

test("batch result normalization drops common generated local-only directories", () => {
  const normalized = normalizeBatchResult({ schemaVersion: 1, agent: "implement", batch: 1, status: "SUCCESS", itemsCompleted: [], filesChanged: [], localOnlyFiles: ["node_modules/", "var/storage/", ".env.local"], flags: [] }, 1);
  assert.deepEqual(normalized.localOnlyFiles, [".env.local"]);
});

test("batch result normalization accepts local-only path objects", () => {
  const normalized = normalizeBatchResult({
    schemaVersion: 1,
    agent: "validate",
    batch: 14,
    status: "SUCCESS",
    itemsCompleted: ["audit"],
    filesChanged: [".yolo/batch-results/batch-014-validate.json"],
    localOnlyFiles: [{ path: "node_modules/", reason: "Created by npm ci" }],
    flags: []
  }, 14);
  assert.deepEqual(normalized.localOnlyFiles, []);
  assert.equal(validateContract(normalized).passed, true);
});

test("implement contract tolerates journal-style non-business shapes", () => {
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.businessLogic = { touched: false, notes: "documentation only" } as unknown as BatchResult["businessLogic"];
  assert.deepEqual(validateContract(result), { name: "contract", passed: true, flags: [] });
});

test("e2e validator allows legitimate manual-intake feature names", () => {
  const result = implementResult({
    tests: {
      e2e: {
        required: true,
        command: "npx playwright test",
        exitCode: 0,
        evidence: "8 Playwright tests passed over real HTTP, including browser manual claim intake."
      }
    }
  });
  assert.deepEqual(validateE2e({ number: 1, type: "implement", items: [progressItem("[UI]", "Manual intake — PRD §8")] }, result, true), { name: "e2e", passed: true, flags: [] });
});

test("e2e validator still rejects manual-only skip claims", () => {
  const result = implementResult({ tests: { e2e: { required: true, command: "n/a", exitCode: 0, evidence: "Manual testing only; covered by integration tests." } } });
  assert.deepEqual(validateE2e({ number: 1, type: "implement", items: [progressItem("[UI]", "Manual intake — PRD §8")] }, result, true), { name: "e2e", passed: false, flags: ["MISSING_RUNNABLE_E2E_COMMAND", "E2E_DISHONEST_SKIP"] });
});

test("e2e validator trusts passing runnable evidence over fuzzy language", () => {
  const result = implementResult({ tests: { e2e: { required: true, command: "npx playwright test", exitCode: 0, evidence: "Playwright passed; not manual testing only." } } });
  assert.deepEqual(validateE2e({ number: 1, type: "implement", items: [progressItem("[UI]", "Manual intake — PRD §8")] }, result, true), { name: "e2e", passed: true, flags: [] });
});

test("e2e validator accepts module-boundary batches with passing regression and no endpoint changes", () => {
  const result = implementResult({ tests: {
    green: { command: "sbt testOnly solver.SolverAdapterSpec", exitCode: 0, evidence: "module tests passed" },
    regression: { command: "sbt test", exitCode: 0, evidence: "full tests passed" },
    e2e: { required: false, command: "not applicable", exitCode: 0, evidence: "No API endpoint or UI entrypoint changed; solver boundary only." }
  } });
  result.wiring = { required: true, entrypoints: [{ type: "module", path: "solver.OrToolsSolverAdapter.solve", verifiedBy: "SolverAdapterSpec" }] };
  assert.deepEqual(validateE2e({ number: 15, type: "implement", items: [progressItem("[DATA]", "Solver adapter — PRD §5.4")] }, result, true), { name: "e2e", passed: true, flags: [] });
});

test("tdd validator uses objective evidence before fuzzy skip language", () => {
  const result = implementResult({ tests: {
    red: { command: "npm test -- failing", exitCode: 1, evidence: "RED failed" },
    green: { command: "npm test -- targeted", exitCode: 0, evidence: "GREEN passed; not manual testing only" },
    regression: { command: "npm test", exitCode: 0, evidence: "REGRESSION passed" }
  } });
  assert.deepEqual(validateTdd(result, true), { name: "tdd", passed: true, flags: [] });
});

test("tdd validator accepts failing state probes that exit zero for operational cleanup", () => {
  const result = implementResult({ tests: {
    red: { command: "ssh host 'test -f /remote/backup && echo BACKUP_PRESENT || echo BACKUP_ABSENT'", exitCode: 0, evidence: "Read-only reproducing check returned BACKUP_PRESENT, matching validator failure. The failing acceptance condition was BACKUP_PRESENT instead of BACKUP_ABSENT." },
    green: { command: "ssh host 'test ! -e /remote/backup && echo BACKUP_ABSENT || echo BACKUP_PRESENT'", exitCode: 0, evidence: "After cleanup the verification check returned BACKUP_ABSENT." },
    regression: { command: "npm test", exitCode: 0, evidence: "full passed" }
  } });
  assert.deepEqual(validateTdd(result, true), { name: "tdd", passed: true, flags: [] });
});

test("frontend validator requires Impeccable context and evidence for UI work", async () => {
  const dir = await tempDir();
  const batch = { number: 1, type: "implement" as const, items: [{ raw: "", tag: "[UI]", title: "dashboard", phase: "p", checked: false }] };
  await mkdir(join(dir, ".yolo/tests"), { recursive: true });
  await writeFile(join(dir, ".yolo/tests/impeccable-ok.js"), "console.log('[]')\n");
  const config = configWithPatterns([], [], []);
  config.frontend = { impeccableCommand: "node .yolo/tests/impeccable-ok.js", failOnDetectorFindings: true, detectorTimeoutMs: 30000 };
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.filesChanged = ["src/components/Dashboard.tsx"];
  assert.deepEqual(await validateFrontendImpeccable(dir, batch, result, config), {
    name: "frontend",
    passed: false,
    flags: ["MISSING_PRODUCT_CONTEXT", "MISSING_DESIGN_CONTEXT", "MISSING_FRONTEND_IMPECCABLE_POLISH_PASS"]
  });
  await writeFile(join(dir, "PRODUCT.md"), "# Product\n");
  await writeFile(join(dir, "DESIGN.md"), "# Design\n");
  result.flags = ["FRONTEND_IMPECCABLE_AUDIT_PASS", "FRONTEND_IMPECCABLE_POLISH_PASS"];
  assert.deepEqual(await validateFrontendImpeccable(dir, batch, result, config), { name: "frontend", passed: true, flags: [] });
  await rm(dir, { recursive: true, force: true });
});

test("frontend validator accepts clean detector plus runnable UI evidence without magic flags", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo/tests"), { recursive: true });
  await writeFile(join(dir, ".yolo/tests/impeccable-ok.js"), "console.log('[]')\n");
  await writeFile(join(dir, "PRODUCT.md"), "# Product\n");
  await writeFile(join(dir, "DESIGN.md"), "# Design\n");
  const config = configWithPatterns([], [], []);
  config.frontend = { impeccableCommand: "node .yolo/tests/impeccable-ok.js", failOnDetectorFindings: true, detectorTimeoutMs: 30000 };
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.filesChanged = ["src/main/resources/templates/resource/detail.html"];
  result.tests = { e2e: { command: "npx browser-test", exitCode: 0, evidence: "browser route passed", required: true } };
  const gate = await validateFrontendImpeccable(dir, { number: 41, type: "implement", items: [progressItem("[UI]", "Detail page — PRD §5b")] } as any, result, config);
  assert.deepEqual(gate, { name: "frontend", passed: true, flags: [] });
  await rm(dir, { recursive: true, force: true });
});

test("frontend validator skips non-frontend work", async () => {
  const dir = await tempDir();
  const batch = { number: 1, type: "implement" as const, items: [{ raw: "", tag: "[API]", title: "endpoint", phase: "p", checked: false }] };
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.filesChanged = ["src/api/orders.ts"];
  assert.deepEqual(await validateFrontendImpeccable(dir, batch, result, configWithPatterns([], [], [])), { name: "frontend", passed: true, flags: [] });
  await rm(dir, { recursive: true, force: true });
});

test("frontend validator does not treat backend public route handlers as Impeccable targets", async () => {
  const dir = await tempDir();
  const batch = { number: 11, type: "implement" as const, items: [{ raw: "", tag: "[API]", title: "Public route — PRD §8", phase: "p", checked: false }] };
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.filesChanged = ["src/routes/public/onboard.ts", "src/server.ts"];
  assert.deepEqual(await validateFrontendImpeccable(dir, batch, result, configWithPatterns([], [], [])), { name: "frontend", passed: true, flags: [] });
  await rm(dir, { recursive: true, force: true });
});

test("frontend validator does not treat backend ui package controllers as Impeccable targets", async () => {
  const dir = await tempDir();
  const batch = { number: 38, type: "implement" as const, items: [{ raw: "", tag: "[SETUP]", title: "Add indexed query pattern — PRD §10b", phase: "p", checked: false }] };
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.filesChanged = ["src/main/java/com/example/app/ui/BackendUiController.java"];
  assert.deepEqual(await validateFrontendImpeccable(dir, batch, result, configWithPatterns([], [], [])), { name: "frontend", passed: true, flags: [] });
  await rm(dir, { recursive: true, force: true });
});

test("frontend validator warns when detector unavailable but explicit audit evidence exists", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo/tests"), { recursive: true });
  await writeFile(join(dir, ".yolo/tests/impeccable-fail.js"), "process.exit(2)\n");
  await writeFile(join(dir, "PRODUCT.md"), "# Product\n");
  await writeFile(join(dir, "DESIGN.md"), "# Design\n## Visual System\n## Accessibility\n## Responsive\n## States\n");
  const config = configWithPatterns([], [], []);
  config.frontend = { impeccableCommand: "node .yolo/tests/impeccable-fail.js", failOnDetectorFindings: true, detectorTimeoutMs: 30000 };
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.filesChanged = ["src/components/Card.tsx"];
  result.flags = ["FRONTEND_IMPECCABLE_AUDIT_PASS", "FRONTEND_IMPECCABLE_POLISH_PASS"];
  const gate = await validateFrontendImpeccable(dir, { number: 1, type: "implement", items: [progressItem("[UI]", "UI — PRD §5b")] } as any, result, config);
  assert.equal(gate.passed, false);
  assert.deepEqual(gate.flags, ["IMPECCABLE_DETECTOR_UNAVAILABLE:2"]);
  assert.equal(gatesPassed([gate]), true);
  await rm(dir, { recursive: true, force: true });
});

test("frontend validator includes runtime-observed changed frontend files in Impeccable targets", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo/tests"), { recursive: true });
  await mkdir(join(dir, "src/components"), { recursive: true });
  await writeFile(join(dir, "PRODUCT.md"), "# Product\n");
  await writeFile(join(dir, "DESIGN.md"), "# Design\n");
  await writeFile(join(dir, "src/components/Omitted.tsx"), "export function Omitted(){return null}\n");
  await writeFile(join(dir, ".yolo/tests/impeccable-capture.js"), "const fs=require('fs'); fs.writeFileSync('.yolo/tests/targets.json', JSON.stringify(process.argv.slice(2))); console.log('[]')\n");
  await execCommand("git init && git config user.email test@example.com && git config user.name Test && git add PRODUCT.md DESIGN.md && git commit -m init", dir, 30_000);
  const config = configWithPatterns([], [], []);
  config.frontend = { impeccableCommand: "node .yolo/tests/impeccable-capture.js", failOnDetectorFindings: true, detectorTimeoutMs: 30000 };
  const batch = { number: 44, type: "implement" as const, items: [progressItem("[UI]", "Omitted UI — PRD §5b")] } as any;
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.filesChanged = [];
  result.flags = ["FRONTEND_IMPECCABLE_AUDIT_PASS", "FRONTEND_IMPECCABLE_POLISH_PASS"];
  result.tests = { regression: { command: "npm test", exitCode: 0, evidence: "tests pass" } };
  const gate = await validateFrontendImpeccable(dir, batch, result, config);
  assert.deepEqual(gate, { name: "frontend", passed: true, flags: [] });
  const targets = JSON.parse(await readFileText(join(dir, ".yolo/tests/targets.json"))) as string[];
  assert.ok(targets.includes("src/components/Omitted.tsx"));
  await rm(dir, { recursive: true, force: true });
});

test("frontend validator fails on Impeccable detector findings", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo/tests"), { recursive: true });
  await writeFile(join(dir, ".yolo/tests/impeccable-findings.js"), "console.log(JSON.stringify([{rule:'purple-gradient', severity:'warn'}]))\n");
  await writeFile(join(dir, "PRODUCT.md"), "# Product\n");
  await writeFile(join(dir, "DESIGN.md"), "# Design\n");
  await mkdir(join(dir, "src/components"), { recursive: true });
  await writeFile(join(dir, "src/components/Card.tsx"), "export function Card(){return null}\n");
  const config = configWithPatterns([], [], []);
  config.frontend = { impeccableCommand: "node .yolo/tests/impeccable-findings.js", failOnDetectorFindings: true, detectorTimeoutMs: 30000 };
  const batch = { number: 2, type: "implement" as const, items: [{ raw: "", tag: "[UI]", title: "card", phase: "p", checked: false }] };
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.filesChanged = ["src/components/Card.tsx"];
  result.flags = ["FRONTEND_IMPECCABLE_AUDIT_PASS", "FRONTEND_IMPECCABLE_POLISH_PASS"];
  const gate = await validateFrontendImpeccable(dir, batch, result, config);
  assert.equal(gate.passed, false);
  assert.ok(gate.flags.includes("IMPECCABLE_DETECTOR_FINDINGS:1"));
  assert.equal(existsSync(join(dir, ".yolo/gates/impeccable-detect-batch-002.json")), true);
  await rm(dir, { recursive: true, force: true });
});

test("product quality validator enforces prd-triggered mobile offline privacy and bundle evidence", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs/example_prd.md"), [
    "# PRD",
    "## 5b. User Journeys & Screens",
    "### Frontend Product Quality Contract",
    "- Evidence required: MOBILE_VIEWPORT_PASS",
    "- Evidence required: OFFLINE_PWA_PASS",
    "- Evidence required: PRIVACY_MATRIX_PASS",
    "- Evidence required: BUNDLE_DYNAMIC_IMPORT_AUDIT_PASS"
  ].join("\n"));
  await writeFile(join(dir, "DESIGN.md"), "# Design\nMobile responsive touch targets. Accessibility keyboard focus contrast. Loading empty error offline warning states. Spacing typography density hierarchy color components.");
  const batch = { number: 1, type: "implement" as const, items: [{ raw: "", tag: "[UI]", title: "app", phase: "p", checked: false }] };
  const result = implementResult({
    filesChanged: ["src/App.tsx"],
    flags: ["MOBILE_VIEWPORT_PASS", "OFFLINE_PWA_PASS", "PRIVACY_MATRIX_PASS", "BUNDLE_DYNAMIC_IMPORT_AUDIT_PASS"],
    businessLogic: { rule: "privacy consent enforced", sourceOfTruth: "PRD", observablePaths: ["src/App.tsx"], test: "privacy matrix consent test passed" },
    tests: { e2e: { required: true, command: "npx playwright test", exitCode: 0, evidence: "mobile viewport offline PWA passed" } }
  });
  assert.deepEqual(await validateProductQuality(dir, batch, result, true), { name: "quality", passed: true, flags: [] });
  result.flags = [];
  const gate = await validateProductQuality(dir, batch, result, true);
  assert.equal(gate.passed, false);
  assert.ok(gate.flags.includes("BUNDLE_DYNAMIC_IMPORT_EVIDENCE_MISSING"));
  await rm(dir, { recursive: true, force: true });
});

test("product quality validator does not burden backend-only batches", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs/example_prd.md"), "mobile-first offline privacy bundle dynamic import");
  const batch = { number: 1, type: "implement" as const, items: [{ raw: "", tag: "[API]", title: "api", phase: "p", checked: false }] };
  const result = implementResult({ filesChanged: ["src/api/projects.ts"] });
  assert.deepEqual(await validateProductQuality(dir, batch, result, true), { name: "quality", passed: true, flags: [] });
  await rm(dir, { recursive: true, force: true });
});

test("product quality validator does not require frontend evidence for docs and test-only setup batches", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs/example_prd.md"), "## Frontend Product Quality Contract\n- Evidence required: BUNDLE_DYNAMIC_IMPORT_AUDIT_PASS\n");
  await writeFile(join(dir, "DESIGN.md"), "# Design\n## Visual System\n## Accessibility\nKeyboard focus contrast.\n## Responsive\nMobile touch.\n## States\nLoading empty error offline warning success.\n");
  const batch = { number: 28, type: "implement" as const, items: [progressItem("[SETUP]", "Evaluate Stage 2 evidence gates — PRD §15b")] };
  const result = implementResult({ filesChanged: ["docs/build-journal/028-batch.md", "tests/components/export-route.test.tsx"] });
  assert.deepEqual(await validateProductQuality(dir, batch, result, true), { name: "quality", passed: true, flags: [] });
  await rm(dir, { recursive: true, force: true });
});

test("product quality validator skips backend ui package controllers", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs/example_prd.md"), "mobile-first offline privacy bundle dynamic import");
  const batch = { number: 38, type: "implement" as const, items: [{ raw: "", tag: "[SETUP]", title: "Indexed query pattern — PRD §10b", phase: "p", checked: false }] };
  const result = implementResult({ filesChanged: ["src/main/java/com/example/app/ui/BackendUiController.java"] });
  assert.deepEqual(await validateProductQuality(dir, batch, result, true), { name: "quality", passed: true, flags: [] });
  await rm(dir, { recursive: true, force: true });
});

test("product quality validator accepts canonical visual system heading", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs/demo_prd.md"), "# PRD\nMobile responsive UI.\n");
  await writeFile(join(dir, "DESIGN.md"), [
    "# Design",
    "## Visual System",
    "Dark operations-console surfaces and clear cards.",
    "## Interaction",
    "Responsive mobile touch controls.",
    "## Accessibility",
    "Keyboard focus and contrast.",
    "## States",
    "Loading, empty, error, offline, warning, success."
  ].join("\n"));
  const result = implementResult({ filesChanged: ["src/App.tsx"] });
  result.flags = ["MOBILE_VIEWPORT_PASS"];
  const gate = await validateProductQuality(dir, { number: 1, type: "implement", items: [progressItem("[UI]", "UI — PRD §5b")] } as any, result, true);
  assert.equal(gate.passed, true, JSON.stringify(gate));
  await rm(dir, { recursive: true, force: true });
});

test("product quality validator accepts explicit not-applicable evidence variants", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs/demo_prd.md"), "# PRD\nFrontend dashboard displays tenant data with consent-aware privacy copy and route-level bundle discipline.\n");
  await writeFile(join(dir, "DESIGN.md"), "# Design\n## Visual System\n## Accessibility\nKeyboard focus contrast.\n## Responsive\nMobile touch.\n## States\nLoading empty error offline warning success.\n");
  const result = implementResult({ filesChanged: ["src/App.tsx"] });
  result.flags = ["PRIVACY_MATRIX_NOT_APPLICABLE", "BUNDLE_DYNAMIC_IMPORT_AUDIT_EVIDENCE_RECORDED"];
  const gate = await validateProductQuality(dir, { number: 1, type: "implement", items: [progressItem("[UI]", "UI — PRD §5b")] } as any, result, true);
  assert.equal(gate.passed, true, JSON.stringify(gate));
  await rm(dir, { recursive: true, force: true });
});

test("product quality validator does not treat unrelated backend language as frontend quality requirements", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs/demo_prd.md"), "# PRD\nNotifications are local-first and hub-assisted. Tenant resources are scoped in middleware. Worker dynamic import jobs run in background processing. UI is server rendered.\n");
  await writeFile(join(dir, "DESIGN.md"), "# Design\n## Visual System\n## Accessibility\nKeyboard focus contrast.\n## Responsive\nMobile touch.\n## States\nLoading empty error offline warning success.\n");
  const gate = await validateProductQuality(dir, { number: 1, type: "implement", items: [progressItem("[UI]", "UI — PRD §5b")] } as any, implementResult({ filesChanged: ["src/main/resources/templates/page.html"] }), true);
  assert.equal(gate.passed, true, JSON.stringify(gate));
  await rm(dir, { recursive: true, force: true });
});

test("product quality validator rejects generic design briefs for ui work", async () => {
  const dir = await tempDir();
  await writeFile(join(dir, "DESIGN.md"), "# Design\nLooks clean.");
  const batch = { number: 1, type: "implement" as const, items: [{ raw: "", tag: "[UI]", title: "app", phase: "p", checked: false }] };
  const gate = await validateProductQuality(dir, batch, implementResult({ filesChanged: ["src/App.tsx"] }), true);
  assert.equal(gate.passed, false);
  assert.ok(gate.flags.includes("GENERIC_DESIGN_BRIEF"));
  await rm(dir, { recursive: true, force: true });
});

test("canonical runtime state drops placeholder artifacts and stale fixed flags", () => {
  const batch = { number: 12, type: "implement", items: [progressItem("[API]", "Endpoint — PRD §8")] } as any;
  const result = implementResult({ artifacts: [{ path: "unknown" }], flags: ["FRONTEND_IMPECCABLE_P1_UNWIRED_FORMS", "FRONTEND_IMPECCABLE_P1_UNWIRED_FORMS_FIXED"] });
  const canonical = canonicalizeBatchResultForRuntime(batch, result);
  assert.deepEqual(canonical.artifacts, []);
  assert.ok(!canonical.flags.includes("FRONTEND_IMPECCABLE_P1_UNWIRED_FORMS"));
});

test("canonical finding lifecycle closes previously open gate findings", async () => {
  const batch = { number: 12, type: "implement", items: [progressItem("[UI]", "Form — PRD §8")] } as any;
  const base = canonicalizeBatchResultForRuntime(batch, implementResult({ flags: ["FRONTEND_IMPECCABLE_P1_UNWIRED_FORMS"] }));
  const opened = recordGateState({ schemaVersion: 1, batch: 12, selectedItems: [], changedFiles: [], risk: { class: "medium", reasons: [] }, currentResult: base, findings: [], commands: [], gates: {}, updatedAt: new Date().toISOString() }, [{ name: "frontend", passed: false, flags: ["FRONTEND_IMPECCABLE_P1_UNWIRED_FORMS"] }]);
  assert.equal(blockingOpenFindings(opened).length, 1);
  const fixedResult = canonicalizeBatchResultForRuntime(batch, implementResult({ flags: ["FRONTEND_IMPECCABLE_P1_UNWIRED_FORMS_FIXED"] }), opened.findings);
  const closed = recordGateState({ ...opened, currentResult: fixedResult }, [{ name: "frontend", passed: true, flags: [] }]);
  assert.equal(blockingOpenFindings(closed).length, 0);
  assert.equal(findingSummary(closed).fixed, 1);
  const dir = await tempDir();
  await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "FAILURE", failureType: "UNIMPLEMENTED_ASSIGNED_ITEM", flags: ["UNIMPLEMENTED_ASSIGNED_ITEM"] }), agent: "validate" });
  const success = await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "SUCCESS", flags: [], tests: { green: { command: "npm test", exitCode: 0, evidence: "fixed" } } }), agent: "validate" });
  assert.equal(blockingOpenFindings(success).length, 0);
  await rm(dir, { recursive: true, force: true });
});

test("validation policy classifies critical and low risk batches", () => {
  const critical = { number: 1, type: "implement", items: [progressItem("[API]", "Auth migration — PRD §8")] } as any;
  const low = { number: 2, type: "implement", items: [progressItem("[DOCS]", "Docs wording — PRD §1")] } as any;
  assert.equal(classifyBatchRisk(critical).class, "critical");
  assert.equal(classifyBatchRisk(low).class, "low");
  assert.equal(validationPolicyFor(low, implementResult(), defaultConfig).allowRegressionCache, true);
  assert.equal(validationPolicyFor(low, implementResult(), { ...defaultConfig, validationMode: "fast" }).requireAdversarialValidation, false);
  assert.equal(validationPolicyFor(critical, implementResult(), { ...defaultConfig, validationMode: "fast" }).requireAdversarialValidation, true);
});

test("runtime source uses canonical batch state and runtime lock", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /importAgentResultToState/);
  assert.match(source, /recordGateState/);
  assert.match(source, /acquireRuntimeLock/);
  assert.match(source, /heartbeatRuntimeLock/);
  assert.match(source, /releaseRuntimeLock/);
});

test("artifact validator ignores placeholder artifact paths", async () => {
  const dir = await tempDir();
  const result = implementResult({ artifacts: [{ path: "unknown" }] });
  assert.deepEqual(await validateArtifacts(dir, result), { name: "artifacts", passed: true, flags: [] });
  await rm(dir, { recursive: true, force: true });
});

test("artifact validator accepts string/path/file artifact shapes", async () => {
  const dir = await tempDir();
  await writeFile(join(dir, "a.txt"), "a");
  await writeFile(join(dir, "b.txt"), "b");
  await writeFile(join(dir, "c.txt"), "c");
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.artifacts = ["a.txt", { path: "b.txt" }, { file: "c.txt" }] as unknown as BatchResult["artifacts"];
  assert.deepEqual(await validateArtifacts(dir, result), { name: "artifacts", passed: true, flags: [] });
  await rm(dir, { recursive: true, force: true });
});

test("business logic validator accepts explicit untouched documentation work", () => {
  const batch = { number: 1, type: "implement" as const, items: [{ raw: "", tag: "[API]", title: "doc", phase: "p", checked: false }] };
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.businessLogic = { touched: false, notes: "journal only" } as unknown as BatchResult["businessLogic"];
  assert.deepEqual(validateBusinessLogic(batch, result), { name: "business-logic", passed: true, flags: [] });
});

test("full validator matrix accepts valid setup batch variants", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs/progress.md"), "## Phase 0: Setup\n- [ ] [SETUP] setup — PRD §3\n");
  await writeFile(join(dir, "src/app.txt"), "ok");
  await writeFile(join(dir, "artifact.txt"), "artifact");
  const batch = { number: 1, type: "implement" as const, items: [{ raw: "", tag: "[SETUP]", title: "setup", phase: "p", checked: false }] };
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.agent = "implement";
  result.filesChanged = ["src/app.txt"];
  result.tests = {
    red: { command: "node -e \"process.exit(1)\"", exitCode: 1, evidence: "expected red" },
    green: { command: "node -e \"process.exit(0)\"", exitCode: 0, evidence: "green" },
    regression: { command: "node -e \"process.exit(0)\"", exitCode: 0, evidence: "regression" },
    e2e: { required: false, command: "N/A", exitCode: 0, evidence: "SKIPPED_NO_ENDPOINTS" }
  };
  result.artifacts = ["artifact.txt"] as unknown as BatchResult["artifacts"];
  const gates = await validateAll(dir, batch, result, configWithPatterns([], [], [".yolo/"]));
  assert.equal(gatesPassed(gates), true, JSON.stringify(gates));
  await rm(dir, { recursive: true, force: true });
});

test("config merge caps stale project high thinking overrides", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo"), { recursive: true });
  await writeFile(join(dir, ".yolo/runtime.config.json"), JSON.stringify({ schemaVersion: 1, models: { master: { thinking: "xhigh" }, validate: { thinking: "xhigh" }, bugfix: { thinking: "high" }, audit: { thinking: "high" }, adjudicate: { thinking: "high" } } }));
  const config = await loadConfig(dir);
  assert.equal(config.models.master.thinking, "medium");
  assert.equal(config.models.validate.thinking, "medium");
  assert.equal(config.models.bugfix.thinking, "medium");
  assert.equal(config.models.audit.thinking, "medium");
  assert.equal(config.models.adjudicate.thinking, "medium");
  await rm(dir, { recursive: true, force: true });
});

test("config merge preserves recovery defaults for older project configs", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo"), { recursive: true });
  await writeFile(join(dir, ".yolo/runtime.config.json"), JSON.stringify({ schemaVersion: 1, policy: { allowedGeneratedPaths: [] } }));
  const config = await loadConfig(dir);
  assert.equal(config.recovery?.maxBugfixAttempts, 2);
  assert.equal(config.recovery?.retryJournalOnce, true);
  await rm(dir, { recursive: true, force: true });
});

test("batch context keeps section content under headings", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs/progress.md"), "- [ ] [API] Demo — PRD §1\n");
  const context = await buildBatchContext(dir, { number: 7, type: "implement", items: [{ raw: "- [ ] [API] Demo — PRD §1", title: "Demo", tag: "API", phase: "Phase 1", checked: false }] });
  assert.match(context, /## Items\n- \[ \] \[API\] Demo/);
  assert.doesNotMatch(context, /## Items\n\n---\n\n- \[ \]/);
  await rm(dir, { recursive: true, force: true });
});

test("knowledge pack selects relevant files and avoids unrelated foundation bloat", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".agent/knowledge/foundation"), { recursive: true });
  await mkdir(join(dir, ".agent/knowledge/gotchas"), { recursive: true });
  await mkdir(join(dir, ".agent/knowledge/modules"), { recursive: true });
  await mkdir(join(dir, "docs/build-journal"), { recursive: true });
  await writeFile(join(dir, ".agent/knowledge/foundation/_index.md"), "# Foundation Index\n- storage-local-indexeddb.md — IndexedDB storage queue\n");
  await writeFile(join(dir, ".agent/knowledge/foundation/storage-local-indexeddb.md"), "# IndexedDB Local Storage\nUse durable local queues.\n");
  await writeFile(join(dir, ".agent/knowledge/foundation/payment-webhook.md"), "# Payment Webhook\nUnrelated billing primitive.\n");
  await writeFile(join(dir, ".agent/knowledge/gotchas/dexie-transaction-lifetime.md"), "# Dexie Transaction Lifetime\nTransactions close after async gaps.\n");
  await writeFile(join(dir, ".agent/knowledge/modules/src-storage-projectRepository.md"), "# projectRepository\nPersists local project queue records.\n");
  await writeFile(join(dir, "docs/build-journal/009-batch.md"), "# Batch 009\nAdded offline sync and IndexedDB queue foundation.\n");
  const pack = await buildRelevantKnowledgePack(dir, { number: 12, type: "implement", items: [{ raw: "- [ ] [DATA] Implement Dexie IndexedDB local queue — PRD §7\n  - Affected files: src/storage/projectRepository.ts", title: "Implement Dexie IndexedDB local queue", tag: "[DATA]", phase: "Phase 2", checked: false, affectedFiles: ["src/storage/projectRepository.ts"] }] });
  assert.equal(pack.mode, "fallback");
  assert.ok(pack.selectedFiles.includes(".agent/knowledge/foundation/storage-local-indexeddb.md"));
  assert.ok(pack.selectedFiles.includes(".agent/knowledge/gotchas/dexie-transaction-lifetime.md"));
  assert.ok(pack.selectedFiles.includes(".agent/knowledge/modules/src-storage-projectRepository.md"));
  assert.ok(pack.selectedFiles.includes("docs/build-journal/009-batch.md"));
  assert.equal(pack.selectedFiles.includes(".agent/knowledge/foundation/payment-webhook.md"), false);
  assert.ok(existsSync(join(dir, ".yolo/knowledge-packs/batch-012.json")));
  await rm(dir, { recursive: true, force: true });
});

test("knowledge request expansion stays inside allowed knowledge directories", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".agent/knowledge/gotchas"), { recursive: true });
  await mkdir(join(dir, "docs/build-journal"), { recursive: true });
  await mkdir(join(dir, "src/secrets"), { recursive: true });
  await writeFile(join(dir, ".agent/knowledge/gotchas/excel-import-column-mapping.md"), "# Excel Import Column Mapping\nKnown parser issue.\n");
  await writeFile(join(dir, "docs/build-journal/014-batch.md"), "# Batch 014\nExcel import parser fixtures.\n");
  await writeFile(join(dir, "src/secrets/import.md"), "# Should never be selected\n");
  const expanded = await expandCandidateRequests(dir, [
    { type: "keyword", query: "excel import parser" },
    { type: "glob", pattern: ".agent/knowledge/**/*import*.md" },
    { type: "glob", pattern: "src/**/*.md" }
  ]);
  assert.ok(expanded.some((candidate) => candidate.path === ".agent/knowledge/gotchas/excel-import-column-mapping.md"));
  assert.ok(expanded.some((candidate) => candidate.path === "docs/build-journal/014-batch.md"));
  assert.equal(expanded.some((candidate) => candidate.path.startsWith("src/")), false);
  await rm(dir, { recursive: true, force: true });
});

test("support scheduler runs full phase support sequence after runtime marks a completed phase due", async () => {
  const dir = await tempDir();
  const batch = { number: 7, type: "implement" as const, items: [{ ...progressItem("[UI]", "Finish phase item — PRD §5b"), phase: "Phase 2", checked: false }] };
  const items = [
    { ...progressItem("[UI]", "Finish phase item — PRD §5b"), phase: "Phase 2", checked: true },
    { ...progressItem("[API]", "Next phase item — PRD §8b"), phase: "Phase 3", checked: false }
  ];
  assert.equal(await nextSupportPlan(dir, items), null);
  await mkdir(join(dir, ".yolo/gates"), { recursive: true });
  await markPhaseSupportDue(dir, batch, items);
  let plan = await nextSupportPlan(dir, items);
  assert.equal(plan?.kind, "modularity");
  assert.equal(plan?.scope, "Phase 2");
  await writeFile(join(dir, ".yolo/gates", supportGateName("modularity", "Phase 2")), "pass");
  plan = await nextSupportPlan(dir, items);
  assert.equal(plan?.kind, "validate-prd");
  assert.equal(plan?.scope, "Phase 2");
  await writeFile(join(dir, ".yolo/gates", supportGateName("validate-prd", "Phase 2")), "pass");
  plan = await nextSupportPlan(dir, items);
  assert.equal(plan?.kind, "security-audit");
  assert.equal(plan?.scope, "Phase 2");
  await writeFile(join(dir, ".yolo/gates", supportGateName("security-audit", "Phase 2")), "pass");
  assert.equal(await nextSupportPlan(dir, items), null);
  await rm(dir, { recursive: true, force: true });
});

test("support scheduler does not interrupt unfinished project work to backfill old phase checks", async () => {
  const dir = await tempDir();
  const items = [
    progressItem("[SETUP]", "Configure project — PRD §3"),
    { ...progressItem("[UI]", "Build next phase page — PRD §5b"), phase: "Phase 1" }
  ];
  items[0].checked = true;
  items[0].phase = "Phase 0";
  assert.equal(await nextSupportPlan(dir, items), null);
  await rm(dir, { recursive: true, force: true });
});

test("support scheduler runs final maintenance sequence after all progress items", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo/gates"), { recursive: true });
  const done = progressItem("[SETUP]", "Complete project — PRD §15");
  done.checked = true;
  done.phase = "Phase 9";
  await writeFile(join(dir, ".yolo/gates", supportGateName("modularity", "Phase 9")), "pass");
  let plan = await nextSupportPlan(dir, [done]);
  assert.equal(plan?.kind, "modularity");
  assert.equal(plan?.scope, "final");
  await writeFile(join(dir, ".yolo/gates", supportGateName("modularity", "final")), "pass");
  plan = await nextSupportPlan(dir, [done]);
  assert.equal(plan?.kind, "validate-prd");
  await writeFile(join(dir, ".yolo/gates", supportGateName("validate-prd", "final")), "pass");
  plan = await nextSupportPlan(dir, [done]);
  assert.equal(plan?.kind, "security-audit");
  await writeFile(join(dir, ".yolo/gates", supportGateName("security-audit", "final")), "pass");
  assert.equal(await nextSupportPlan(dir, [done]), null);
  await rm(dir, { recursive: true, force: true });
});

test("inbox parser ignores inline heading references before real sections", async () => {
  const dir = await mkdtemp(join(tmpdir(), "klevar-inbox-heading-"));
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs/yolo-inbox.md"), [
    "# YOLO Inbox",
    "Intro says write entries under `## Pending` and move them to `## Handled` later.",
    "",
    "## Pending",
    "",
    "<!--",
    "### [HIGH|MEDIUM|LOW (optional)] Title — YYYY-MM-DD",
    "**Type:** FEATURE",
    "**Urgency hint:** HIGH",
    "**Affected files:** docs/example.md",
    "Status: PENDING",
    "-->",
    "",
    "### Manual CI/CD trigger — 2026-05-23",
    "**Type:** FEATURE",
    "**Urgency hint:** HIGH",
    "**Affected files:** .github/workflows/ci.yml, tests/unit/setup/test_lifecycle_migrations_ci.jl",
    "Status: PENDING",
    "",
    "## Handled",
    "",
    "None yet."
  ].join("\n"));
  const entries = await readPendingInbox(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, "Manual CI/CD trigger — 2026-05-23");
  assert.equal(entries[0].priority, "HIGH");
  assert.deepEqual(entries[0].affectedFiles, [".github/workflows/ci.yml", "tests/unit/setup/test_lifecycle_migrations_ci.jl"]);
  const moved = await reconcileInbox(dir, implementResult({ inbox: { handledTitles: ["Manual CI/CD trigger — 2026-05-23"] } }));
  assert.equal(moved, 1);
  const text = await readFile(join(dir, "docs/yolo-inbox.md"), "utf8");
  assert.match(text, /^## Handled\n\n### Manual CI\/CD trigger — 2026-05-23 — handled/m);
  await rm(dir, { recursive: true, force: true });
});

test("inbox router prioritizes high, folds related medium, and defers low", () => {
  const selected = [{ raw: "- [ ] [UI] Build queue — PRD §5b", title: "Build queue", tag: "[UI]", phase: "Phase 1", checked: false, affectedFiles: ["src/main/resources/templates/claims/list.html"] }];
  const high = [{ title: "[HIGH] Stop unsafe flow — 2026-05-19", priority: "HIGH" as const, body: "critical", affectedFiles: [], type: "BUG", date: "2026-05-19" }];
  assert.equal(routeInboxEntries(selected, high).mode, "intercept");
  assert.equal(routeInboxEntries(selected, high).items[0].tag, "[BUG]");
  const medium = [{ title: "[MEDIUM] Run Impeccable audit — 2026-05-19", priority: "MEDIUM" as const, body: "templates and CSS need polish", affectedFiles: ["src/main/resources/templates/"], type: "FIX", date: "2026-05-19" }];
  const folded = routeInboxEntries(selected, medium);
  assert.equal(folded.mode, "fold");
  assert.equal(folded.items.length, 2);
  assert.match(folded.items[1].raw, /PRD N\/A \(inbox\)/);
  const low = [{ title: "[LOW] Rename doc heading — 2026-05-19", priority: "LOW" as const, body: "docs nice-to-have", affectedFiles: ["README.md"], type: "FIX", date: "2026-05-19" }];
  assert.equal(routeInboxEntries(selected, low).mode, "none");
  assert.equal(routeInboxEntries([{ ...selected[0], tag: "[AUDIT]" }], low).mode, "sweep");
});



test("ai inbox router falls back to deterministic routing without model route", async () => {
  const selected = [{ raw: "- [ ] [AUDIT] Verify core suite � PRD �15", title: "Verify core suite", tag: "[AUDIT]", phase: "Phase 1", checked: false, affectedFiles: [] }];
  const medium = [{ title: "[MEDIUM] Run Impeccable audit � 2026-05-19", priority: "MEDIUM" as const, body: "templates and CSS need polish", affectedFiles: ["src/main/resources/templates/"], type: "FIX", date: "2026-05-19" }];
  const config = { ...defaultConfig, models: { ...defaultConfig.models } };
  delete (config.models as Record<string, unknown>).inbox;
  const routed = await routeInboxWithAi(process.cwd(), 99, selected as never, medium, config);
  assert.equal(routed.mode, "none");
  assert.ok(routed.gate.flags.includes("INBOX_AI_DISABLED_FALLBACK"));
});

test("batch context reads pending inbox from root when worktree copy is stale", async () => {
  const root = await tempDir();
  const worktree = await tempDir();
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(worktree, "docs"), { recursive: true });
  await writeFile(join(worktree, "docs/progress.md"), "- [ ] [UI] Demo — PRD §5b\n");
  await writeFile(join(root, "docs/yolo-inbox.md"), [
    "# YOLO Inbox",
    "## Pending",
    "### [MEDIUM] Run Impeccable audit/polish — 2026-05-19",
    "**Concern:** Existing UI needs audit.",
    "Status: PENDING",
    "## Handled",
    "(none yet)"
  ].join("\n"));
  await writeFile(join(worktree, "docs/yolo-inbox.md"), "# YOLO Inbox\n## Pending\n## Handled\n");
  const context = await buildBatchContext(worktree, { number: 20, type: "implement", items: [{ raw: "- [ ] [UI] Demo — PRD §5b", title: "Demo", tag: "[UI]", phase: "Phase 1", checked: false }] }, root);
  assert.match(context, /## Pending YOLO Inbox[\s\S]*Run Impeccable audit\/polish/);
  await rm(root, { recursive: true, force: true });
  await rm(worktree, { recursive: true, force: true });
});

test("subagent output is cleared before reruns to avoid stale validation artifacts", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo/batch-results"), { recursive: true });
  await writeFile(join(dir, ".yolo/batch-results/batch-019-validate.json"), JSON.stringify({ status: "FAILURE" }));
  await writeFile(join(dir, ".yolo/batch-results/batch-019-validate.md"), "old failure");
  await clearSubagentOutput(dir, ".yolo/batch-results/batch-019-validate");
  assert.equal(existsSync(join(dir, ".yolo/batch-results/batch-019-validate.json")), false);
  assert.equal(existsSync(join(dir, ".yolo/batch-results/batch-019-validate.md")), false);
  await rm(dir, { recursive: true, force: true });
});

test("subagent prompt materialization fills legacy placeholders", () => {
  const template = "Batch {{BATCH_NUMBER}}\nItems:\n{{BATCH_ITEMS}}\nFile {{WORKSPACE_FILE}}\nTest {{TEST_COMMAND}}\nE2E {{E2E_COMMAND}}\n{{CONTEXT_BLOCK}}";
  const context = "# Batch 10 Context\n\n---\n\n## Items\n- [ ] [API] Demo endpoint — PRD §8\n\n---\n\n## Core Rules\n## Commands\n\n| Action | Command |\n|--------|---------|\n| Run tests | `./gradlew test` |\n| E2E tests | `npx playwright test` |\n";
  const filled = fillLegacyPlaceholders(template, { id: "batch-010-implement", role: "implement", promptFile: "p.md", context, outputBase: ".yolo/batch-results/batch-010-implement", cwd: process.cwd(), route: {} });
  assert.match(filled, /Batch 010/);
  assert.match(filled, /\[API\] Demo endpoint/);
  assert.match(filled, /.yolo\/batch-results\/batch-010-implement.md/);
  assert.match(filled, /Test \.\/gradlew test/);
  assert.match(filled, /E2E npx playwright test/);
  assert.doesNotMatch(filled, /{{BATCH_NUMBER}}|{{BATCH_ITEMS}}|{{WORKSPACE_FILE}}|\[runtime value unavailable for TEST_COMMAND\]/);
});

test("subagent prompt contract includes canonical JSON examples", async () => {
  const source = await readFileText(join(process.cwd(), "src/subagent-runner.ts"));
  assert.match(source, /Canonical JSON shape/);
  assert.match(source, /Do NOT use \\`tests\.commands\[\]\\`/);
  assert.match(source, /"commit": null/);
});

test("agent session detects stale unanswered tool calls", () => {
  const now = Date.parse("2026-05-28T14:00:00Z");
  const staleToolCall = [
    JSON.stringify({ timestamp: "2026-05-28T13:20:00Z", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "npx playwright test slow.spec.ts" } }] } })
  ].join("\n");
  const staleReason = staleUnansweredToolReason(staleToolCall, now, 30 * 60_000);
  assert.ok(staleReason);
  assert.match(staleReason, /AGENT_STALE_TOOL_TIMEOUT:1800000ms:npx playwright test slow\.spec\.ts/);
  const completedToolCall = `${staleToolCall}\n${JSON.stringify({ timestamp: "2026-05-28T13:21:00Z", message: { role: "toolResult", toolName: "bash", content: [] } })}`;
  assert.equal(staleUnansweredToolReason(completedToolCall, now, 30 * 60_000), undefined);
});

test("subagent runner starts from a fresh session file on rerun", async () => {
  const source = await readFileText(join(process.cwd(), "src/subagent-runner.ts"));
  assert.match(source, /rm\(sessionFile, \{ force: true \}\)/);
  assert.match(source, /clearSubagentOutput\(invocation\.cwd, invocation\.outputBase\)/);
  assert.match(source, /staleToolTimeoutMs: budget\.staleMs/);
});

test("default model routes cap guarded roles at medium thinking", () => {
  assert.equal(defaultConfig.models.master.thinking, "medium");
  assert.equal(defaultConfig.models.implement.thinking, "medium");
  assert.equal(defaultConfig.models.validate.thinking, "medium");
  assert.equal(defaultConfig.models.bugfix.thinking, "medium");
  assert.equal(defaultConfig.models.audit.thinking, "medium");
  assert.equal(defaultConfig.models.adjudicate.thinking, "medium");
  assert.equal(defaultConfig.models.journal.thinking, "low");
  assert.equal(defaultConfig.models.knowledge.thinking, "medium");
  assert.equal(defaultConfig.models.inbox.thinking, "low");
});

test("default agent budgets allow long validation and bugfix sessions", () => {
  assert.equal(defaultConfig.models.validate.budget?.staleMs, 30 * 60_000);
  assert.equal(defaultConfig.models.validate.budget?.maxToolCalls, 300);
  assert.equal(defaultConfig.models.bugfix.budget?.staleMs, 30 * 60_000);
  assert.equal(defaultConfig.models.bugfix.budget?.maxToolCalls, 300);
});

test("subagent telemetry summarizes tool calls budgets and events", async () => {
  const dir = await tempDir();
  const sessionFile = join(dir, ".yolo/pi-sessions/batch-001-implement.jsonl");
  await mkdir(join(dir, ".yolo/pi-sessions"), { recursive: true });
  await writeFile(sessionFile, [
    JSON.stringify({ timestamp: new Date(Date.now() - 10_000).toISOString(), type: "model_change", provider: "openai", modelId: "gpt-test" }),
    JSON.stringify({ timestamp: new Date(Date.now() - 9_000).toISOString(), type: "thinking_level_change", thinkingLevel: "medium" }),
    JSON.stringify({ timestamp: new Date(Date.now() - 8_000).toISOString(), message: { role: "assistant", provider: "openai", model: "gpt-test", content: [{ type: "toolCall", name: "bash", arguments: { command: "./gradlew test" } }], usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.01 } } } }),
    JSON.stringify({ timestamp: new Date().toISOString(), message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "BUILD SUCCESSFUL" }] } })
  ].join("\n") + "\n");
  const invocation = { id: "batch-001-implement", role: "implement" as const, promptFile: "p.md", context: "", outputBase: ".yolo/batch-results/batch-001-implement", cwd: dir, route: { model: "openai/gpt-test", thinking: "medium" as const, budget: { maxToolCalls: 0 } } };
  const budget = budgetFromInvocation(invocation);
  const summary = await summarizeSubagentSession(invocation, sessionFile, Date.now() - 1000, new Date().toISOString(), 1, budget);
  assert.equal(summary.lastCommand, "./gradlew test");
  assert.equal(summary.lastResult, "BUILD SUCCESSFUL");
  assert.equal(summary.thinking, "medium");
  assert.equal(summary.requestedThinking, "medium");
  assert.equal(summary.sessionThinking, "medium");
  assert.equal(summary.requestedModel, "openai/gpt-test");
  assert.equal(summary.sessionModel, "openai/gpt-test");
  assert.ok(summary.warnings.includes("TOOL_CALL_BUDGET:1"));
  await appendSubagentEvent(dir, invocation.id, { type: "test_event" });
  assert.match(await readFileText(join(dir, ".yolo/subagent-events/batch-001-implement.jsonl")), /test_event/);
  await rm(dir, { recursive: true, force: true });
});

test("subagent invocation type supports root telemetry heartbeat", () => {
  const invocation = { id: "batch-001-implement", role: "implement", promptFile: "p.md", context: "", outputBase: ".yolo/batch-results/batch-001-implement", cwd: process.cwd(), route: {}, telemetryRoot: process.cwd() };
  assert.equal(invocation.telemetryRoot, process.cwd());
});

test("bugfix recovery result merges fixed files and overrides local-only contract", () => {
  const implementation = journalResult({ journal_entry_written: true, gate_file_written: true });
  implementation.filesChanged = ["docker-compose.yml"];
  implementation.localOnlyFiles = ["node_modules/", ".env.local"];
  implementation.flags = ["initial"];
  const bugfix = journalResult({ journal_entry_written: true, gate_file_written: true });
  bugfix.agent = "bugfix";
  bugfix.filesChanged = ["Dockerfile", "docker-compose.yml"];
  bugfix.localOnlyFiles = [".env.local"];
  bugfix.flags = ["fixed compose build"];
  const recovered = mergeRecoveredResult(implementation, bugfix);
  assert.deepEqual(recovered.filesChanged, ["docker-compose.yml", "Dockerfile"]);
  assert.deepEqual(recovered.localOnlyFiles, [".env.local"]);
  assert.ok(recovered.flags.includes("BUGFIX_RECOVERY_APPLIED"));
});

test("bugfix recovery preserves richer evidence while applying compact bugfix manifests", () => {
  const implementation = implementResult();
  implementation.failureType = "BUSINESS_LOGIC_DRIFT";
  implementation.flags = ["BUSINESS_LOGIC_DRIFT", "REGRESSION_PASS"];
  implementation.businessLogic = {
    rule: "Project settings and coordinate validation obey explicit unit and CRS assumptions.",
    sourceOfTruth: "docs/product_prd.md §5.2 and §5.3 with project settings schema.",
    observablePaths: ["src/features/settings/SettingsRoute.tsx", "src/features/validation/ValidationRoute.tsx"],
    test: "tests/components/settings-validation-flow.test.tsx and tests/unit/validation/settings-validation.test.ts"
  };
  const bugfix = implementResult({ agent: "bugfix" });
  bugfix.businessLogic = {
    rule: "Fixed unit validation drift.",
    sourceOfTruth: "PRD §5.3",
    observablePaths: ["src/features/import/importParser.ts"],
    test: "npm test passed after fix"
  };
  bugfix.tests = { regression: { command: "npm test", exitCode: 0, evidence: "all tests passed" } };
  bugfix.flags = ["BUSINESS_LOGIC_DRIFT_FIXED"];
  const recovered = mergeRecoveredResult(implementation, bugfix);
  assert.equal(recovered.status, "SUCCESS");
  assert.equal(recovered.failureType, undefined);
  assert.equal(recovered.businessLogic?.sourceOfTruth, "docs/product_prd.md §5.2 and §5.3 with project settings schema.");
  assert.deepEqual(recovered.businessLogic?.observablePaths, ["src/features/settings/SettingsRoute.tsx", "src/features/validation/ValidationRoute.tsx", "src/features/import/importParser.ts"]);
  assert.equal(recovered.tests?.red?.command, implementation.tests?.red?.command);
  assert.equal(recovered.tests?.green?.command, implementation.tests?.green?.command);
  assert.equal(recovered.tests?.regression?.command, "npm test");
  assert.ok(recovered.flags.includes("RECOVERED_SOURCE_FLAG:BUSINESS_LOGIC_DRIFT"));
  assert.ok(recovered.flags.includes("BUSINESS_LOGIC_DRIFT_FIXED"));
});

test("bugfix recovery preserves wiring verifier details when bugfix narrows entrypoints", () => {
  const implementation = implementResult();
  implementation.wiring = {
    required: true,
    entrypoints: [
      { type: "ui-route", path: "/app/items/new", verifiedBy: "tests/components/item-flow.test.tsx and tests/e2e/item.spec.ts" },
      { type: "ui-route", path: "/app/items/:id/review", verifiedBy: "tests/components/item-flow.test.tsx and tests/e2e/item.spec.ts" }
    ]
  };
  const bugfix = implementResult({ agent: "bugfix" });
  bugfix.wiring = { required: false, entrypoints: ["/app/items/:id/review"] as never };
  const recovered = mergeRecoveredResult(implementation, bugfix);
  assert.equal(recovered.wiring?.required, true);
  assert.deepEqual(recovered.wiring?.entrypoints, [
    { type: "ui-route", path: "/app/items/new", verifiedBy: "tests/components/item-flow.test.tsx and tests/e2e/item.spec.ts" },
    { type: "ui-route", path: "/app/items/:id/review", verifiedBy: "tests/components/item-flow.test.tsx and tests/e2e/item.spec.ts" }
  ]);
});

test("gate finding classifier separates ambiguity from hard failures", () => {
  const ambiguous = [{ name: "command-rerun", passed: false, flags: ["COMMAND_RERUN_FAILED:e2e:not run:/usr/bin/bash: not found"] }];
  assert.equal(adjudicationAllowed(ambiguous), true);
  const hard = [{ name: "artifacts", passed: false, flags: ["ARTIFACT_MISSING:.yolo/tests/missing.mjs"] }];
  assert.equal(adjudicationAllowed(hard), false);
  assert.equal(classifyGateFindings(hard).hardFailures[0]?.code, "ARTIFACT_MISSING");
});

test("gate finding classifier routes frontend quality failures to bugfix", () => {
  const report = classifyGateFindings([
    { name: "frontend", passed: false, flags: ["IMPECCABLE_DETECTOR_FINDINGS:2", "MISSING_PRODUCT_CONTEXT"] }
  ]);
  assert.equal(report.hardFailures.length, 2);
  assert.deepEqual(report.hardFailures.map((finding) => finding.recommendedAction), ["bugfix", "bugfix"]);
});

test("adjudication decisions canonicalize common aliases", async () => {
  const dir = await tempDir();
  const file = join(dir, "adjudicate.json");
  await writeFile(file, JSON.stringify({ batch: "9", status: "pass", decision: "require fix", reason: "needs deterministic proof", accepted_ambiguities: [{ message: "minor" }], flags: "X" }));
  const result = await readAdjudicationFile(file);
  assert.ok(result);
  assert.equal(result.batch, 9);
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.decision, "REQUIRE_BUGFIX");
  assert.equal(result.requiresBugfix, true);
  const onDisk = JSON.parse(await readFileText(file));
  assert.equal(onDisk.decision, "REQUIRE_BUGFIX");
  await rm(dir, { recursive: true, force: true });
});

test("adjudication decisions normalize accept and bugfix outcomes", () => {
  const accept = normalizeAdjudication({ schemaVersion: 1, agent: "adjudicate", batch: 1, status: "SUCCESS", decision: "ACCEPT_WITH_WARNINGS", rationale: "optional skip is justified", acceptedAmbiguities: ["x"], flags: [] });
  assert.ok(accept);
  assert.equal(adjudicationAccepted(accept), true);
  const bugfix = normalizeAdjudication({ schemaVersion: 1, agent: "adjudicate", batch: 1, status: "SUCCESS", decision: "REQUIRE_BUGFIX", rationale: "manifest must be corrected", flags: [] });
  assert.ok(bugfix);
  assert.equal(adjudicationNeedsBugfix(bugfix), true);
});

test("command validator adopts exact passed subagent commands with no later source mutation", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo/pi-sessions"), { recursive: true });
  const session = join(dir, ".yolo/pi-sessions/batch-001-implement.jsonl");
  await writeFile(session, [
    JSON.stringify({ message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } }] } }),
    JSON.stringify({ message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", isError: false, content: [{ type: "text", text: "passed" }] } }),
    JSON.stringify({ message: { role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "write", arguments: { path: ".yolo/batch-results/batch-001-implement.json", content: "{}" } }] } }),
    JSON.stringify({ message: { role: "assistant", content: [{ type: "toolCall", id: "call-3", name: "bash", arguments: { command: "git status --short" } }] } })
  ].join("\n") + "\n");
  assert.equal(adoptedSessionCommandPassed(dir, "npm test"), true);
  await writeFile(session, (await readFileText(session)) + JSON.stringify({ message: { role: "assistant", content: [{ type: "toolCall", id: "call-4", name: "edit", arguments: { path: "src/app.ts" } }] } }) + "\n");
  assert.equal(adoptedSessionCommandPassed(dir, "npm test"), false);
  await rm(dir, { recursive: true, force: true });
});

test("command validator summarizes failure tails instead of dependency banners", () => {
  const stdout = [
    "Testing InventoryAllocationSimulator",
    "Status `C:/Temp/jl_x/Project.toml`",
    "[4c88cf16] Aqua v0.8.14",
    "Test Summary: | Pass  Fail  Total",
    "tenant uuid validation | 12 1 13",
    "ERROR: LoadError: MethodError: no method matching parse_uuid(::String)",
    "Stacktrace:",
    " [1] top-level scope"
  ].join("\n");
  const summary = summarizeFailure(stdout, "");
  assert.match(summary, /MethodError/);
  assert.match(summary, /tenant uuid validation/);
  assert.doesNotMatch(summary, /^Testing InventoryAllocationSimulator Status/);
});

test("command validator skips non-runnable not-run placeholders", async () => {
  const dir = await tempDir();
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.tests = {
    green: { command: "not run", exitCode: 0, evidence: "placeholder" },
    regression: { command: "not applicable", exitCode: 0, evidence: "placeholder" },
    e2e: { required: false, command: "skipped", exitCode: 0, evidence: "SKIPPED_NO_ENDPOINTS" }
  };
  const gate = await validateCommandEvidence(dir, result, dir);
  assert.equal(gate.passed, true);
  assert.deepEqual(gate.flags, []);
  await rm(dir, { recursive: true, force: true });
});

test("command validator skips descriptive live e2e labels", async () => {
  const dir = await tempDir();
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.tests = {
    e2e: {
      required: true,
      command: "bootRun on PORT=18080, curl /api/ready, curl /api/metrics, rg required/forbidden metric families",
      exitCode: 0,
      evidence: "live readiness and metrics artifacts captured"
    }
  };
  const gate = await validateCommandEvidence(dir, result, dir);
  assert.equal(gate.passed, true);
  assert.deepEqual(gate.flags, []);
  await rm(dir, { recursive: true, force: true });
});

test("command validator rejects natural-language e2e recipes instead of executing prose", async () => {
  const dir = await tempDir();
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.tests = {
    e2e: {
      required: true,
      command: "seed test DB with npx tsx, start real server with PORT=3998 NODE_ENV=test npx tsx src/server.ts, then curl -X POST http://127.0.0.1:3998/api/tasks",
      exitCode: 0,
      evidence: "live endpoint passed"
    }
  };
  const gate = await validateCommandEvidence(dir, result, dir);
  assert.equal(gate.passed, false);
  assert.match(gate.flags[0] ?? "", /^COMMAND_RERUN_NON_RUNNABLE_RECIPE:e2e:/);
  await rm(dir, { recursive: true, force: true });
});

test("command validator rejects foreground dev server e2e commands instead of hanging", async () => {
  const dir = await tempDir();
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.tests = {
    e2e: {
      required: true,
      command: "PORT=3199 npm run dev:api; curl POST /api/tenants/register; curl GET /api/admin/today-summary",
      exitCode: 0,
      evidence: "live endpoints passed"
    }
  };
  const gate = await validateCommandEvidence(dir, result, dir);
  assert.equal(gate.passed, false);
  assert.match(gate.flags[0] ?? "", /^COMMAND_RERUN_UNSAFE_FOREGROUND_SERVER:e2e:/);
  await rm(dir, { recursive: true, force: true });
});

test("command validator retries timed out reruns before failing", async () => {
  const source = await readFileText(join(process.cwd(), "src/validators/command-validator.ts"));
  assert.match(source, /isCommandTimeout\(first\.run\)/);
  assert.match(source, /`\$\{phase\}:timeout-retry`/);
  assert.match(source, /retry\?\.run\.exitCode === 0 \? retry : first/);
});

test("command reruns heartbeat while long commands are active", async () => {
  const commandSource = await readFileText(join(process.cwd(), "src/validators/command-validator.ts"));
  const processSource = await readFileText(join(process.cwd(), "src/util/process.ts"));
  assert.match(commandSource, /markHeartbeat/);
  assert.match(commandSource, /RUNNING \$\{phase\}: \$\{command\}/);
  assert.match(processSource, /onHeartbeat/);
  assert.match(processSource, /setInterval\(\(\) => options\.onHeartbeat/);
  assert.match(processSource, /clearInterval\(heartbeat\)/);
});

test("command validator reuses runtime-owned successful command evidence for unchanged trees", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo"), { recursive: true });
  await writeFile(join(dir, "src.txt"), "stable\n");
  await writeFile(join(dir, ".yolo/cache-probe.js"), "const fs=require('fs'); const p='.yolo/cache-count'; const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0; fs.writeFileSync(p,String(n+1)); if(n>0) process.exit(17);\n");
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.tests = { green: { command: "node .yolo/cache-probe.js", exitCode: 0, evidence: "probe" } };
  const first = await validateCommandEvidence(dir, result, dir);
  const second = await validateCommandEvidence(dir, result, dir);
  assert.equal(first.passed, true);
  assert.equal(second.passed, true);
  assert.equal(await readFileText(join(dir, ".yolo/cache-count")), "1");
  assert.match(await readFileText(join(dir, ".yolo/command-cache.json")), /node \.yolo\/cache-probe\.js/);
  await writeFile(join(dir, "src.txt"), "changed\n");
  const third = await validateCommandEvidence(dir, result, dir);
  assert.equal(third.passed, false);
  assert.match(third.flags[0] ?? "", /^COMMAND_RERUN_FAILED:green:/);
  await rm(dir, { recursive: true, force: true });
});

test("execCommand reports timeout instead of waiting on orphaned child pipes", async () => {
  const result = await execCommand("node -e \"setTimeout(() => {}, 5000)\"", process.cwd(), 100);
  assert.equal(result.exitCode, 124);
  assert.match(result.stderr, /COMMAND_TIMEOUT_AFTER_MS:100/);
});

test("bugfix recovery clears terminal failure status after successful fix", () => {
  const audit = journalResult({ journal_entry_written: true, gate_file_written: true });
  audit.agent = "audit";
  audit.status = "FAILURE";
  audit.failureType = "COVERAGE_GAP";
  audit.itemsCompleted = [];
  audit.filesChanged = [".yolo/batch-results/batch-008-audit.json"];
  audit.flags = ["COVERAGE_GAP", "EXPORT_LIBRARY_PROOF_GAP", "TEST_EVIDENCE_ALIASES_NORMALIZED"];
  audit.businessLogic = { rule: "N/A for audit", sourceOfTruth: "audit", observablePaths: [], test: "N/A" };
  const bugfix = journalResult({ journal_entry_written: true, gate_file_written: true });
  bugfix.agent = "bugfix";
  bugfix.itemsCompleted = ["Fixed coverage gap"];
  bugfix.filesChanged = ["src/exports/vectorExport.ts", ".yolo/batch-results/batch-008-bugfix.json"];
  bugfix.flags = ["COVERAGE_GAP_FIXED"];
  bugfix.businessLogic = { rule: "Fixed export coverage", sourceOfTruth: "PRD §2b", observablePaths: ["src/exports/vectorExport.ts"], test: "npm test" };
  const recovered = mergeRecoveredResult(audit, bugfix);
  assert.equal(recovered.agent, "audit");
  assert.equal(recovered.status, "SUCCESS");
  assert.equal(recovered.failureType, undefined);
  assert.deepEqual(validateContract(recovered), { name: "contract", passed: true, flags: [] });
  assert.ok(recovered.itemsCompleted.includes("Fixed coverage gap"));
  assert.ok(recovered.flags.includes("RECOVERED_FROM:COVERAGE_GAP"));
  assert.ok(recovered.flags.includes("RECOVERED_SOURCE_FLAG:COVERAGE_GAP"));
  assert.ok(recovered.flags.includes("RECOVERED_SOURCE_FLAG:EXPORT_LIBRARY_PROOF_GAP"));
  assert.ok(!recovered.flags.includes("COVERAGE_GAP"));
  assert.ok(recovered.flags.includes("TEST_EVIDENCE_ALIASES_NORMALIZED"));
  assert.equal(recovered.businessLogic?.rule, "Fixed export coverage");
});

test("bugfix recovery demotes stale terminal flags for all source result roles", () => {
  for (const agent of ["implement", "validate", "audit"] as const) {
    const source = journalResult({ journal_entry_written: true, gate_file_written: true });
    source.agent = agent;
    source.status = "FAILURE";
    source.failureType = agent === "implement" ? "RUNTIME_GATES_REJECTED" : agent === "validate" ? "CONTRACT_FAILURE" : "COVERAGE_GAP";
    source.flags = [source.failureType, `RESULT_STATUS_FAILURE:${source.failureType}`, "ARTIFACT_MISSING:.yolo/tests/stale.mjs", "FULL_TEST_SUITE_PASS"];
    const bugfix = journalResult({ journal_entry_written: true, gate_file_written: true });
    bugfix.agent = "bugfix";
    bugfix.itemsCompleted = [`Fixed ${agent}`];
    bugfix.filesChanged = [`src/fixed-${agent}.ts`, `.yolo/batch-results/batch-008-bugfix.json`];
    bugfix.flags = [`${source.failureType}_FIXED`, "FULL_TEST_SUITE_PASS"];
    const recovered = mergeRecoveredResult(source, bugfix);
    assert.equal(recovered.status, "SUCCESS", agent);
    assert.equal(recovered.failureType, undefined, agent);
    assert.deepEqual(validateContract(recovered), { name: "contract", passed: true, flags: [] }, agent);
    assert.ok(!recovered.flags.includes(source.failureType), agent);
    assert.ok(!recovered.flags.includes(`RESULT_STATUS_FAILURE:${source.failureType}`), agent);
    assert.ok(!recovered.flags.includes("ARTIFACT_MISSING:.yolo/tests/stale.mjs"), agent);
    assert.ok(recovered.flags.includes(`RECOVERED_FROM:${source.failureType}`), agent);
    assert.ok(recovered.flags.includes(`RECOVERED_SOURCE_FLAG:${source.failureType}`), agent);
    assert.ok(recovered.flags.includes(`RECOVERED_SOURCE_FLAG:RESULT_STATUS_FAILURE:${source.failureType}`), agent);
    assert.ok(recovered.flags.includes("RECOVERED_SOURCE_FLAG:ARTIFACT_MISSING:.yolo/tests/stale.mjs"), agent);
    assert.ok(recovered.flags.includes(`${source.failureType}_FIXED`), agent);
    assert.ok(recovered.flags.includes("FULL_TEST_SUITE_PASS"), agent);
  }
});

test("bugfix recovery prunes stale missing artifact references fixed by bugfix", () => {
  const implementation = journalResult({ journal_entry_written: true, gate_file_written: true });
  implementation.filesChanged = ["src/App.java", ".yolo/tests/stale.mjs"];
  implementation.artifacts = [{ path: ".yolo/tests/stale.mjs" }, { path: "docs/real.md" }];
  const bugfix = journalResult({ journal_entry_written: true, gate_file_written: true });
  bugfix.agent = "bugfix";
  bugfix.filesChanged = [".yolo/batch-results/batch-015-bugfix.json", ".yolo/tests/repro.mjs"];
  bugfix.artifacts = [{ path: ".yolo/tests/repro.mjs" }];
  bugfix.flags = ["CHANGED_FILE_MISSING:.yolo/tests/stale.mjs fixed by removing stale metadata references.", "ARTIFACT_MISSING:.yolo/tests/stale.mjs fixed by removing stale artifact declaration."];
  const recovered = mergeRecoveredResult(implementation, bugfix);
  assert.deepEqual(recovered.filesChanged, ["src/App.java", ".yolo/batch-results/batch-015-bugfix.json", ".yolo/tests/repro.mjs"]);
  assert.deepEqual(recovered.artifacts?.map((artifact) => artifact.path), ["docs/real.md", ".yolo/tests/repro.mjs"]);
});

test("bugfix recovery prunes stale missing changed files omitted by later bugfix", () => {
  const implementation = journalResult({ journal_entry_written: true, gate_file_written: true });
  implementation.filesChanged = ["src/legacy/oldVerifier.ts", "src/features/workspace/AppHomeRoute.tsx"];
  implementation.flags = ["CHANGED_FILE_MISSING:src/legacy/oldVerifier.ts"];
  const bugfix = journalResult({ journal_entry_written: true, gate_file_written: true });
  bugfix.agent = "bugfix";
  bugfix.filesChanged = ["src/platform/newVerifier.ts", "src/features/workspace/AppHomeRoute.tsx", ".yolo/batch-results/batch-007-bugfix.json"];
  const recovered = mergeRecoveredResult(implementation, bugfix);
  assert.ok(!recovered.filesChanged.includes("src/legacy/oldVerifier.ts"));
  assert.ok(recovered.filesChanged.includes("src/platform/newVerifier.ts"));
});

test("chained bugfix recovery prunes stale refs from earlier recovery attempts", () => {
  const implementation = journalResult({ journal_entry_written: true, gate_file_written: true });
  implementation.filesChanged = ["src/App.java"];
  implementation.artifacts = [{ path: "docs/real.md" }];
  const firstBugfix = journalResult({ journal_entry_written: true, gate_file_written: true });
  firstBugfix.agent = "bugfix";
  firstBugfix.filesChanged = [".yolo/tests/stale.mjs", ".yolo/batch-results/batch-015-bugfix.json"];
  firstBugfix.artifacts = [{ path: ".yolo/tests/stale.mjs" }];
  const secondBugfix = journalResult({ journal_entry_written: true, gate_file_written: true });
  secondBugfix.agent = "bugfix";
  secondBugfix.filesChanged = [".yolo/tests/repro.mjs", ".yolo/batch-results/batch-015-bugfix-2.json"];
  secondBugfix.artifacts = [{ path: ".yolo/tests/repro.mjs" }];
  secondBugfix.flags = ["CHANGED_FILE_MISSING:.yolo\\tests\\stale.mjs fixed by removing stale metadata references.", "ARTIFACT_MISSING:.yolo/tests/stale.mjs fixed by removing stale artifact declaration."];
  const afterFirst = mergeRecoveredResult(implementation, firstBugfix);
  const afterSecond = mergeRecoveredResult(afterFirst, secondBugfix);
  assert.ok(!afterSecond.filesChanged.includes(".yolo/tests/stale.mjs"));
  assert.ok(!afterSecond.artifacts?.some((artifact) => artifact.path === ".yolo/tests/stale.mjs"));
  assert.ok(afterSecond.filesChanged.includes(".yolo/tests/repro.mjs"));
});

test("bugfix recovery preserves canonical TDD evidence when bugfix uses named reproducer tests", () => {
  const implementation = journalResult({ journal_entry_written: true, gate_file_written: true });
  implementation.tests = {
    red: { command: "./gradlew failing-test", exitCode: 1, evidence: "RED failed before implementation" },
    green: { command: "./gradlew targeted", exitCode: 0, evidence: "targeted green" },
    regression: { command: "./gradlew test", exitCode: 0, evidence: "full suite green" },
    e2e: { required: true, command: "npx playwright test", exitCode: 0, evidence: "e2e green" }
  };
  const bugfix = journalResult({ journal_entry_written: true, gate_file_written: true });
  bugfix.agent = "bugfix";
  bugfix.tests = {
    redReproducer: { command: "./gradlew race-repro", exitCode: 1, evidence: "race reproduced red" },
    greenReproducer: { command: "./gradlew race-repro", exitCode: 0, evidence: "race fixed green" },
    jvmRegression: { command: "./gradlew test", exitCode: 0, evidence: "92 tests green" },
    e2e: { required: true, command: "npx playwright test", exitCode: 0, evidence: "e2e still green" }
  } as NonNullable<typeof bugfix.tests>;
  const recovered = mergeRecoveredResult(implementation, bugfix);
  assert.equal(recovered.tests?.red?.command, "./gradlew race-repro");
  assert.equal(recovered.tests?.red?.exitCode, 1);
  assert.equal(recovered.tests?.green?.command, "./gradlew race-repro");
  assert.equal(recovered.tests?.regression?.evidence, "92 tests green");
  assert.equal(recovered.tests?.e2e?.evidence, "e2e still green");
});

test("bugfix recovery detects stale adversarial validation contradicted by recovered evidence", () => {
  const implementation = journalResult({ journal_entry_written: true, gate_file_written: true });
  implementation.tests = { e2e: { required: true, command: "npx playwright test", exitCode: 0, evidence: "8/8 browser tests passed" } };
  implementation.wiring = { required: true, entrypoints: [{ type: "ui-route", path: "GET /integrations", verifiedBy: "e2e" }] };
  const bugfix = journalResult({ journal_entry_written: true, gate_file_written: true });
  bugfix.agent = "bugfix";
  bugfix.status = "SUCCESS";
  bugfix.tests = {
    regression: { command: "python scripts/static_probe.py", exitCode: 0, evidence: "all wiring probes true" },
    e2e: { required: true, command: "npx playwright test", exitCode: 0, evidence: "8/8 browser tests passed after fix" }
  };
  bugfix.wiring = {
    required: true,
    entrypoints: [
      { type: "job", path: "integration_status_probe job via _simulation_worker", verifiedBy: "static probe" },
      { type: "api", path: "API controller error responses with X-Request-ID", verifiedBy: "static probe" },
      { type: "job", path: "outbox_dispatcher structured request-id logging", verifiedBy: "static probe" }
    ]
  };
  bugfix.flags = ["INTEGRATION_STATUS_PROBE_WIRED", "REQUEST_ID_LOGGING_PROPAGATED", "E2E_REAL_HTTP_PASS"];
  const recovered = mergeRecoveredResult(implementation, bugfix);
  const staleValidation = journalResult({ journal_entry_written: true, gate_file_written: true });
  staleValidation.agent = "validate";
  staleValidation.status = "FAILURE";
  staleValidation.failureType = "UNWIRED_CODE_AND_AUTHZ_DRIFT";
  staleValidation.flags = [
    "MISSING_RUNNABLE_E2E_COMMAND",
    "ENTRYPOINT_UNVERIFIED:integration_status_probe job via _simulation_worker",
    "ENTRYPOINT_UNVERIFIED:API controller error responses with X-Request-ID",
    "ENTRYPOINT_UNVERIFIED:outbox_dispatcher structured request-id logging"
  ];
  assert.equal(validationFailureContradictedByRecoveredEvidence(staleValidation, recovered, bugfix), true);
  staleValidation.flags = [...staleValidation.flags!, "BUSINESS_LOGIC_UNVERIFIED:manual reviewer found untested invariant"];
  assert.equal(validationFailureContradictedByRecoveredEvidence(staleValidation, recovered, bugfix), false);
});

test("bugfix recovery can replace corrected implementation manifest fields", () => {
  const implementation = journalResult({ journal_entry_written: true, gate_file_written: true });
  implementation.filesChanged = ["src/missing/File.java", "node_modules/"];
  implementation.localOnlyFiles = ["node_modules/"];
  const bugfix = journalResult({ journal_entry_written: true, gate_file_written: true });
  bugfix.agent = "bugfix";
  bugfix.filesChanged = ["src/main/App.java", ".yolo/batch-results/batch-012-implement.json", ".yolo/batch-results/batch-012-bugfix-2.json"];
  bugfix.localOnlyFiles = [];
  bugfix.tests = { regression: { command: "true", exitCode: 0, evidence: "rerun after fix" } };
  const recovered = mergeRecoveredResult(implementation, bugfix);
  assert.deepEqual(recovered.filesChanged, ["src/main/App.java", ".yolo/batch-results/batch-012-implement.json", ".yolo/batch-results/batch-012-bugfix-2.json"]);
  assert.deepEqual(recovered.localOnlyFiles, []);
  assert.equal(recovered.tests?.regression?.command, "true");
});

test("worktree sync copies source, journal, and gate changes to root", async () => {
  const root = await tempDir();
  const worktree = await tempDir();
  await mkdir(join(worktree, "src"), { recursive: true });
  await mkdir(join(worktree, "docs/build-journal"), { recursive: true });
  await mkdir(join(worktree, ".github/workflows"), { recursive: true });
  await mkdir(join(worktree, ".git/hooks"), { recursive: true });
  await mkdir(join(worktree, ".yolo/gates"), { recursive: true });
  await writeFile(join(worktree, "src/app.txt"), "app");
  await writeFile(join(worktree, "docs/build-journal/001-batch.md"), "journal");
  await writeFile(join(worktree, ".github/workflows/ci.yml"), "ci");
  await writeFile(join(worktree, ".git/hooks/pre-commit"), "ignored");
  await writeFile(join(worktree, ".yolo/gates/journal-batch-001.md"), "gate");
  await execCommand("git init && git config user.email test@example.com && git config user.name Test && git add . && git commit -m init", worktree, 30_000);
  await writeFile(join(worktree, "src/app.txt"), "changed");
  await writeFile(join(worktree, "src/new.txt"), "new");
  await writeFile(join(worktree, "docs/build-journal/001-batch.md"), "journal changed");
  await writeFile(join(worktree, ".yolo/gates/journal-batch-001.md"), "gate changed");
  await writeFile(join(worktree, ".env.local"), "local=true");
  const synced = await syncWorktreeChangesToRoot(worktree, root, ["src/app.txt", "src/new.txt", "docs/build-journal/001-batch.md", ".github/workflows/ci.yml", ".git/hooks/pre-commit", ".yolo/gates/journal-batch-001.md"]);
  const localSynced = await syncLocalOnlyFilesToRoot(worktree, root, [".env.local"]);
  assert.ok(synced.includes("src/app.txt"));
  assert.ok(synced.includes("src/new.txt"));
  assert.ok(synced.includes("docs/build-journal/001-batch.md"));
  assert.ok(synced.includes(".github/workflows/ci.yml"));
  assert.ok(!synced.includes(".git/hooks/pre-commit"));
  assert.ok(synced.includes(".yolo/gates/journal-batch-001.md"));
  assert.equal(await readFileText(join(root, "src/app.txt")), "changed");
  assert.deepEqual(localSynced, [".env.local"]);
  assert.equal(await readFileText(join(root, "docs/build-journal/001-batch.md")), "journal changed");
  assert.equal(await readFileText(join(root, ".github/workflows/ci.yml")), "ci");
  assert.equal(existsSync(join(root, ".git/hooks/pre-commit")), false);
  assert.equal(await readFileText(join(root, ".env.local")), "local=true");
  await rm(root, { recursive: true, force: true });
  await rm(worktree, { recursive: true, force: true });
});

test("runtime cleans batch-scoped docker compose resources", async () => {
  const dockerSource = await readFileText(join(process.cwd(), "src/docker-cleanup.ts"));
  assert.match(dockerSource, /com\.docker\.compose\.project=\$\{project\}/);
  assert.match(dockerSource, /volume rm -f/);
  assert.match(dockerSource, /batch-\$\{String\(batchNumber\)\.padStart\(3, "0"\)\}/);
  const runtimeSource = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(runtimeSource, /cleanupDockerForBatch\(cwd, batch\.number, "success", config\)/);
  assert.match(runtimeSource, /cleanupDockerForBatch\(cwd, batch\.number, "failure", config\)/);
  const recoverySource = await readFileText(join(process.cwd(), "src/recovery.ts"));
  assert.match(recoverySource, /cleanupBatchDockerResources\(cwd, Number\(batch\), "failure"\)/);
});

test("retention classifies locked worktree removal errors as non-fatal cleanup skips", () => {
  assert.equal(isTransientRemoveError({ code: "EBUSY" }), true);
  assert.equal(isTransientRemoveError({ code: "ENOTEMPTY" }), true);
  assert.equal(isTransientRemoveError({ code: "EPERM" }), true);
  assert.equal(isTransientRemoveError({ code: "EACCES" }), true);
  assert.equal(isTransientRemoveError({ code: "ENOENT" }), false);
});

test("retention prunes older successful worktrees and keeps failed worktrees", async () => {
  const dir = await tempDir();
  await execCommand("git init && git config user.email test@example.com && git config user.name Test", dir, 30_000);
  await writeFile(join(dir, "README.md"), "x");
  await execCommand("git add . && git commit -m init", dir, 30_000);
  for (const batch of ["001", "002", "003", "004"]) {
    await mkdir(join(dir, `.yolo/worktrees/batch-${batch}`), { recursive: true });
  }
  await mkdir(join(dir, ".yolo/gates"), { recursive: true });
  for (const batch of ["001", "002", "003"]) await writeFile(join(dir, `.yolo/gates/closeout-batch-${batch}.md`), "pass");
  const result = await pruneSuccessfulWorktrees(dir, { keepSuccessfulWorktrees: 2, keepFailedWorktrees: true });
  assert.deepEqual(result.pruned, ["batch-001"]);
  assert.deepEqual(result.kept, ["batch-003", "batch-002"]);
  assert.deepEqual(result.skipped, ["batch-004"]);
  assert.equal(await pathExists(join(dir, ".yolo/worktrees/batch-001")), false);
  assert.equal(await pathExists(join(dir, ".yolo/worktrees/batch-004")), true);
  await rm(dir, { recursive: true, force: true });
});

test("recovery clean removes failed batch artifacts and restores runtime journal", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo/batch-results"), { recursive: true });
  await mkdir(join(dir, ".yolo/gates"), { recursive: true });
  await mkdir(join(dir, ".yolo/events"), { recursive: true });
  await mkdir(join(dir, ".yolo/worktrees/batch-002"), { recursive: true });
  await execCommand("git init && git config user.email test@example.com && git config user.name Test", dir, 30_000);
  await writeFile(join(dir, ".yolo/batch-results/batch-002-implement.json"), "{}\n");
  await writeFile(join(dir, ".yolo/gates/tdd-batch-002.md"), "gate\n");
  await writeFile(join(dir, ".yolo/events/batch-002.jsonl"), "{}\n");
  await writeFile(join(dir, ".yolo/journal.md"), "committed journal\n");
  await execCommand("git add .yolo/journal.md && git commit -m init", dir, 30_000);
  await writeFile(join(dir, ".yolo/journal.md"), "committed journal\nfailed batch append\n");
  await writeFile(join(dir, ".yolo/failure-patterns.json"), JSON.stringify([
    { key: "A::x", failureType: "A", signature: "x", count: 2, batches: [1, 2], reinforced: false, lastSeen: "now" },
    { key: "B::y", failureType: "B", signature: "y", count: 1, batches: [2], reinforced: false, lastSeen: "now" }
  ], null, 2));
  await writeFile(join(dir, ".yolo/runtime-state.json"), "{}\n");
  const result = await cleanBatch(dir, "batch-002");
  assert.equal(result.ok, true);
  assert.equal(await pathExists(join(dir, ".yolo/batch-results/batch-002-implement.json")), false);
  assert.equal(await pathExists(join(dir, ".yolo/gates/tdd-batch-002.md")), false);
  assert.equal(await pathExists(join(dir, ".yolo/events/batch-002.jsonl")), false);
  assert.equal((await readFileText(join(dir, ".yolo/journal.md"))).replace(/\r\n/g, "\n"), "committed journal\n");
  const patterns = JSON.parse(await readFileText(join(dir, ".yolo/failure-patterns.json")));
  assert.deepEqual(patterns, [{ key: "A::x", failureType: "A", signature: "x", count: 1, batches: [1], reinforced: false, lastSeen: "now" }]);
  assert.equal(await pathExists(join(dir, ".yolo/runtime-state.json")), false);
  await rm(dir, { recursive: true, force: true });
});

test("recovery clean removes registered git worktree before deleting branch", async () => {
  const dir = await tempDir();
  await execCommand("git init && git config user.email test@example.com && git config user.name Test", dir, 30_000);
  await writeFile(join(dir, "README.md"), "x");
  await execCommand("git add . && git commit -m init", dir, 30_000);
  await mkdir(join(dir, ".yolo/worktrees"), { recursive: true });
  await execCommand("git worktree add -b yolo/batch-002 .yolo/worktrees/batch-002", dir, 30_000);
  const result = await cleanBatch(dir, "batch-002");
  assert.equal(result.ok, true);
  assert.equal(await pathExists(join(dir, ".yolo/worktrees/batch-002")), false);
  assert.equal((await execCommand("git branch --list yolo/batch-002", dir, 30_000)).stdout.trim(), "");
  await rm(dir, { recursive: true, force: true });
});

test("rollback refuses non-YOLO HEAD and dry-runs YOLO HEAD", async () => {
  const dir = await tempDir();
  await execCommand("git init && git config user.email test@example.com && git config user.name Test", dir, 30_000);
  await writeFile(join(dir, "a.txt"), "a");
  await execCommand("git add . && git commit -m init", dir, 30_000);
  assert.equal((await rollbackLast(dir)).ok, false);
  await writeFile(join(dir, "b.txt"), "b");
  await execCommand("git add . && git commit -m 'feat(yolo): complete batch 007'", dir, 30_000);
  const dry = await rollbackLast(dir);
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  assert.match(dry.message, /Dry-run rollback YOLO batch 007/);
  await rm(dir, { recursive: true, force: true });
});

test("rollback can force-push reset to configured remote", async () => {
  const remote = await tempDir();
  const dir = await tempDir();
  await execCommand("git init --bare", remote, 30_000);
  await execCommand("git init && git config user.email test@example.com && git config user.name Test", dir, 30_000);
  await execCommand(`git remote add origin ${JSON.stringify(remote)}`, dir, 30_000);
  await writeFile(join(dir, "a.txt"), "a");
  await execCommand("git add . && git commit -m init && git push -u origin HEAD:master", dir, 30_000);
  await writeFile(join(dir, "b.txt"), "b");
  await execCommand("git add . && git commit -m 'feat(yolo): complete batch 009' && git push", dir, 30_000);
  const before = (await execCommand("git rev-parse HEAD", dir)).stdout.trim();
  assert.equal((await execCommand("git rev-parse origin/master", dir)).stdout.trim(), before);
  const applied = await rollbackLast(dir, { yes: true, push: true });
  assert.equal(applied.ok, true);
  const after = (await execCommand("git rev-parse HEAD", dir)).stdout.trim();
  assert.equal((await execCommand("git rev-parse origin/master", dir)).stdout.trim(), after);
  assert.notEqual(after, before);
  await rm(dir, { recursive: true, force: true });
  await rm(remote, { recursive: true, force: true });
});

test("undo-last can create collaboration-safe revert commit", async () => {
  const dir = await tempDir();
  await execCommand("git init && git config user.email test@example.com && git config user.name Test", dir, 30_000);
  await writeFile(join(dir, "a.txt"), "a");
  await execCommand("git add . && git commit -m init", dir, 30_000);
  await writeFile(join(dir, "b.txt"), "b");
  await execCommand("git add . && git commit -m 'fix(app): patch bug'", dir, 30_000);
  const applied = await undoLast(dir, { revert: true });
  assert.equal(applied.ok, true);
  assert.match((await execCommand("git log -1 --pretty=%s", dir)).stdout.trim(), /^Revert/);
  await rm(dir, { recursive: true, force: true });
});

test("undo-last dry-runs arbitrary HEAD commits", async () => {
  const dir = await tempDir();
  await execCommand("git init && git config user.email test@example.com && git config user.name Test", dir, 30_000);
  await writeFile(join(dir, "a.txt"), "a");
  await execCommand("git add . && git commit -m init", dir, 30_000);
  await writeFile(join(dir, "b.txt"), "b");
  await execCommand("git add . && git commit -m 'fix(app): patch bug'", dir, 30_000);
  const dry = await undoLast(dir);
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  assert.match(dry.message, /Dry-run undo last commit/);
  assert.match(dry.message, /fix\(app\): patch bug/);
  const applied = await undoLast(dir, { yes: true });
  assert.equal(applied.ok, true);
  assert.equal((await execCommand("git log -1 --pretty=%s", dir)).stdout.trim(), "init");
  await rm(dir, { recursive: true, force: true });
});

test("cli unknown scope exits without mutating runtime state", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo"), { recursive: true });
  const cli = join(process.cwd(), "dist/cli.js");
  const result = await execCommand(`node ${JSON.stringify(cli)} nope`, dir, 30_000);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /Unknown scope: nope/);
  assert.equal(await pathExists(join(dir, ".yolo/runtime-state.json")), false);
  await rm(dir, { recursive: true, force: true });
});

test("continue path recognizes already committed batches before replaying stale worktrees", async () => {
  const dir = await tempDir();
  await execCommand("git init && git config user.email test@example.com && git config user.name Test", dir, 30_000);
  await writeFile(join(dir, "README.md"), "x");
  await execCommand("git add . && git commit -m init", dir, 30_000);
  await writeFile(join(dir, "README.md"), "x\ny");
  await execCommand("git add . && git commit -m 'feat(yolo): complete batch 011'", dir, 30_000);
  assert.equal(await completedBatchCommitExists(dir, 11), true);
  assert.equal(await completedBatchCommitExists(dir, 12), false);
  await rm(dir, { recursive: true, force: true });
});

test("continue path can infer latest resumable worktree after state loss", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo/worktrees/batch-018/.yolo/batch-results"), { recursive: true });
  await mkdir(join(dir, ".yolo/worktrees/batch-019/.yolo/batch-results"), { recursive: true });
  await writeFile(join(dir, ".yolo/worktrees/batch-018/.yolo/batch-results/batch-018-implement.json"), JSON.stringify({ schemaVersion: 1, agent: "implement", batch: 18, status: "SUCCESS", itemsCompleted: [], filesChanged: [], flags: [] }));
  await writeFile(join(dir, ".yolo/worktrees/batch-019/.yolo/batch-results/batch-019-implement.json"), JSON.stringify({ schemaVersion: 1, agent: "implement", batch: 19, status: "SUCCESS", itemsCompleted: [], filesChanged: [], flags: [] }));
  await mkdir(join(dir, ".yolo/logs"), { recursive: true });
  await writeFile(join(dir, ".yolo/logs/runtime-test.log"), [
    "Continued batch 18 passed and committed: abc123",
    "Continuing original full YOLO scope after resumed batch.",
    "Selected batch 19: Continue remaining work"
  ].join("\n"));
  const resumable = await findLatestResumableBatch(dir);
  assert.equal(resumable?.batch, 19);
  assert.ok(resumable?.worktree.endsWith("batch-019"));
  assert.equal(resumable?.requestedScope, "full");
  await rm(dir, { recursive: true, force: true });
});

test("continue path preserves support workflow batch identity", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /supportPlanFromRuntimeState/);
  assert.match(source, /state\?\.inspect\?\.supportKind/);
  assert.match(source, /makeSupportPlan\(kind, scope/);
  assert.match(source, /support \? \[support\.item\] : selectBatch/);
});

test("continue path uses inferred batch when failed state has no valid worktree", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /const stateWorktree = state\?\.worktree/);
  assert.match(source, /stateWorktree \? Number\(state\?\.batch/);
  assert.match(source, /Number\(inferred\?\.batch \?\? state\?\.batch/);
});

test("continue path does not fail a fresh active batch before result exists", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /state\?\.status === "running"/);
  assert.match(source, /no \$\{suffix\} result exists yet/);
  assert.match(source, /Use \/yolo-dashboard instead of \/klevar-yolo continue/);
});

test("continue path restarts stale active batches without result artifacts", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /runningNoResultIsStale/);
  assert.match(source, /Recovering stale running batch/);
  assert.match(source, /runImplementationAgent\(cwd, worktree, batch, config, context\)/);
  assert.doesNotMatch(source, /state\?\.status === "running" && !\(await exists\(resultFile\)\)[\s\S]{0,220}return;/);
});

test("continue path can reuse existing valid journal artifacts", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /reuseOrRunJournalAgent/);
  assert.match(source, /Reusing existing valid journal artifacts/);
});

test("runtime does not write orphan inbox gate for empty completion probe batches", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /if \(batch\.items\.length > 0\) await writeInboxRouteGate/);
});

test("runtime source dispatches bugfix recovery for runtime gate failures", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /recoverGateFailure/);
  assert.match(source, /RUNTIME_GATES_REJECTED/);
  assert.match(source, /Re-running runtime gates after gate-failure bugfix recovery/);
});

test("runtime attempts bugfix recovery for audit and validation failures before user escalation", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.doesNotMatch(source, /batch\.type !== "implement"[\s\S]{0,80}return null/);
  assert.doesNotMatch(source, /Adversarial validation rejected batch \$\{batch\.number\}[\s\S]{0,160}return null/);
  assert.match(source, /Validation rejected batch \$\{batch\.number\}; dispatching bugfix recovery attempt/);
  assert.match(source, /Runtime gates rejected batch \$\{batch\.number\}; dispatching bugfix recovery attempt/);
  assert.match(source, /importAgentResultToState\(cwd, batch, "validate", await runValidator/);
});

test("bugfix recovery budget resets for distinct failure signatures", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /function failureSignature\(flags: string\[\], failureType\?: string \| null\)/);
  assert.match(source, /let currentSignature = failureSignature\(currentFlags, currentValidation\.failureType\)/);
  assert.match(source, /if \(nextSignature !== currentSignature\) \{[\s\S]{0,120}attemptForSignature = 0;/);
  assert.match(source, /runBugfixAgent\(rootCwd, cwd, batch, config, context, currentValidation, currentFlags, totalAttempts\)/);
});

test("bugfix recovery retries invalid bugfix result contracts before escalation", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /BUGFIX_RESULT_INVALID/);
  assert.match(source, /currentFlags = \[\.\.\.bugfixGate\.flags, \.\.\.\(bugfix\.flags \?\? \[\]\), bugfix\.failureType \?\? "BUGFIX_RECOVERY_FAILED"\]/);
  assert.doesNotMatch(source, /if \(!bugfixGate\.passed \|\| bugfix\.status !== "SUCCESS"\) return \{ result: null/);
});

test("validation recovery retries runtime gate failures from recovered bugfixes", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /RUNTIME_GATES_REJECTED_AFTER_VALIDATION_BUGFIX/);
  assert.match(source, /currentValidation = \{ \.\.\.currentValidation, status: "FAILURE", failureType: "RUNTIME_GATES_REJECTED_AFTER_VALIDATION_BUGFIX", flags: currentFlags \}/);
  assert.doesNotMatch(source, /Recovered batch \$\{batch\.number\} rejected by gates/);
});

test("validation recovery accepts fixed stale validator red reproducers", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /validationFailureLooksStale/);
  assert.match(source, /currentValidation\.status === "FAILURE" && \(/);
  assert.match(source, /validationFailureContradictedByRecoveredEvidence\(currentValidation, recovered, bugfix\)/);
  assert.match(source, /execCommand\(red\.command, cwd, \{ timeoutMs: 5 \* 60_000 \}\)/);
});

test("runtime does not dispatch bugfix recovery for human security external ops gates", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /requiresHumanSecurityApproval\(flags\)/);
  assert.match(source, /EXTERNAL_MUTATION_NOT_ALLOWED/);
  assert.match(source, /requires human\/security approval/);
});

test("continue path merges existing successful bugfix results", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /mergeExistingBugfixResults/);
  assert.match(source, /batch-\$\{String\(batchNumber\)\.padStart\(3, "0"\)\}-bugfix/);
  assert.match(source, /mergeRecoveredResultFromDisk\(worktree, batchNumber, recovered, bugfix\)/);
});

test("continue path refuses only terminal non-recoverable results before gates", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /isNonResumableResult/);
  assert.match(source, /AUDIT_PREMATURE/);
  assert.match(source, /NON_RESUMABLE_BATCH/);
  assert.doesNotMatch(source, /result\.status === "FAILURE" \|\| result\.status === "INVALID_RESULT"/);
  assert.doesNotMatch(source, /return result\.status === "INVALID_RESULT"/);
});

test("runtime source keeps full and phase scopes as bounded iterative loops", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /scope\.mode === "full" \|\| scope\.mode === "phase"/);
  assert.match(source, /while \(true\)/);
  assert.match(source, /Full YOLO complete: no remaining items/);
  assert.match(source, /Phase scope complete/);
  assert.doesNotMatch(source, /maxIterations/);
});

test("runtime source lets high-priority inbox preempt support workflow batches", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /const pendingInbox = await readPendingInbox\(cwd\)/);
  assert.match(source, /const hasHighInbox = pendingInbox\.some\(\(entry\) => entry\.priority === "HIGH"\)/);
  assert.match(source, /scope\.mode === "full" && !hasHighInbox \? await nextSupportPlan/);
});

test("runtime repairs missing closeout for committed manual batch evidence", async () => {
  const dir = await tempDir();
  await execCommand("git init && git config user.email test@example.com && git config user.name Test", dir, 30_000);
  await mkdir(join(dir, ".yolo/batch-results"), { recursive: true });
  await mkdir(join(dir, ".yolo/gates"), { recursive: true });
  await writeFile(join(dir, ".yolo/batch-results/batch-003-implement.json"), JSON.stringify({ schemaVersion: 1, agent: "implement", batch: 3, status: "SUCCESS", itemsCompleted: [], filesChanged: [], flags: [] }));
  await writeFile(join(dir, ".yolo/gates/e2e-batch-003.md"), "workflow: e2e\nresult: PASS\n");
  await writeFile(join(dir, ".yolo/gates/journal-batch-003.md"), "workflow: journal\nresult: PASS\n");
  await execCommand("git add . && git commit -m 'fix(yolo): complete batch 003 recovery'", dir, 30_000);
  assert.equal(await repairCommittedCloseoutGate(dir, 3), true);
  assert.equal(await pathExists(join(dir, ".yolo/gates/closeout-batch-003.md")), true);
  assert.deepEqual(await verifyPreviousBatchGates(dir, 4), []);
  await rm(dir, { recursive: true, force: true });
});

test("runtime blocks new scopes when previous batch artifacts lack closeout", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /findIncompleteBatch/);
  assert.match(source, /INCOMPLETE_PREVIOUS_BATCH/);
  assert.match(source, /missing closeout; run \/klevar-yolo continue or \/yolo-clean/);
});

test("cli help exits without mutating runtime state", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo"), { recursive: true });
  const cli = join(process.cwd(), "dist/cli.js");
  const result = await execCommand(`node ${JSON.stringify(cli)} --help`, dir, 30_000);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Klevar YOLO Runtime/);
  assert.equal(await pathExists(join(dir, ".yolo/runtime-state.json")), false);
  await rm(dir, { recursive: true, force: true });
});

test("batch id normalization accepts common shapes", () => {
  assert.equal(normalizeBatch("2"), "002");
  assert.equal(normalizeBatch("batch-12"), "012");
});

test("runtime state records support workflow metadata", async () => {
  const dir = await tempDir();
  await resetRuntimeState(dir, 9, "full", { kind: "modularity", scope: "Phase 2" });
  const state = JSON.parse(await readFile(join(dir, ".yolo/runtime-state.json"), "utf8")) as { inspect: Record<string, string> };
  assert.equal(state.inspect.supportKind, "modularity");
  assert.equal(state.inspect.supportScope, "Phase 2");
  await rm(dir, { recursive: true, force: true });
});

test("runtime telemetry records phase checkpoints and preserves inspect scope", async () => {
  const dir = await tempDir();
  await resetRuntimeState(dir, 1, "phase 20");
  await setPhase(dir, "implement", "Implementing", { inspect: { risk: "high" } });
  await setCheckpoint(dir, "runtimeGates", "passed");
  const state = JSON.parse(await readFileText(join(dir, ".yolo/runtime-state.json")));
  assert.equal(state.checkpoints.implement, "running");
  assert.equal(state.checkpoints.runtimeGates, "passed");
  assert.equal(state.inspect.requestedScope, "phase 20");
  assert.equal(state.inspect.risk, "high");
  await rm(dir, { recursive: true, force: true });
});

test("runtime state records original full scope for resumed batches", async () => {
  const dir = await tempDir();
  await resetRuntimeState(dir, 1, "full");
  const state = JSON.parse(await readFileText(join(dir, ".yolo/runtime-state.json")));
  assert.equal(state.inspect.requestedScope, "full");
  await rm(dir, { recursive: true, force: true });
});

test("runtime source continues original full scope after resumed commit", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /requestedScope === "full"/);
  assert.match(source, /Continuing original full YOLO scope after resumed batch/);
});

test("continue success marks runtime claim done before committing", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /await markRuntimeClaim\(cwd, config, batch, "done"\);[\s\S]{0,220}await setPhase\(cwd, "commit", "Creating runtime-owned continued batch commit"\)/);
});

test("telegram notifications are env-gated and failure-first", () => {
  const env = { KLEVAR_TELEGRAM_BOT_TOKEN: "token", KLEVAR_TELEGRAM_CHAT_ID: "123" };
  assert.equal(telegramEnabled(env), true);
  assert.equal(shouldNotifyRuntimeFinish({ cwd: "C:/projects/example-app", status: "failed", batch: 5, phase: "failed", message: "Batch rejected" }, env), true);
  assert.equal(shouldNotifyRuntimeFinish({ cwd: "C:/projects/example-app", status: "complete", batch: 5, phase: "complete", message: "Batch committed" }, env), false);
  assert.match(formatRuntimeNotification({ cwd: "C:/projects/example-app", status: "failed", batch: 5, phase: "failed", message: "Needs input" }), /Batch: 005/);
  assert.equal(telegramEnabled({ ...env, KLEVAR_TELEGRAM_NOTIFY: "0" }), false);
});

test("runtime heartbeat resets failed status back to running", async () => {
  const dir = await tempDir();
  await resetRuntimeState(dir, 1);
  await failRuntimeFromError(dir, new Error("boom"));
  await markHeartbeat(dir, "validate agent running 1m0s");
  const state = JSON.parse(await readFileText(join(dir, ".yolo/runtime-state.json")));
  assert.equal(state.status, "running");
  assert.equal(state.phase, "validate");
  assert.equal(state.lastEvent, "validate agent running 1m0s");
  await rm(dir, { recursive: true, force: true });
});

test("runtime phase transitions reset failed status back to running", async () => {
  const dir = await tempDir();
  await resetRuntimeState(dir, 1);
  await failRuntimeFromError(dir, new Error("boom"));
  await setPhase(dir, "bugfix", "recovering");
  const state = JSON.parse(await readFileText(join(dir, ".yolo/runtime-state.json")));
  assert.equal(state.status, "running");
  assert.equal(state.phase, "bugfix");
  await rm(dir, { recursive: true, force: true });
});

test("runtime crash telemetry marks state failed", async () => {
  const dir = await tempDir();
  await failRuntimeFromError(dir, new Error("boom"));
  const state = JSON.parse(await readFile(join(dir, ".yolo/runtime-state.json"), "utf8")) as { status: string; phase: string; lastEvent: string };
  assert.equal(state.status, "failed");
  assert.equal(state.phase, "failed");
  assert.match(state.lastEvent, /Runtime crashed: Error: boom|Runtime crashed: boom/);
  await rm(dir, { recursive: true, force: true });
});

test("canonical runtime prompts override stale project-local prompts", async () => {
  const dir = await tempDir();
  const template = await tempDir();
  const prompt = ".agent/agents/yolo/yolo-subagent-journal.md";
  await mkdir(join(dir, ".agent/agents/yolo"), { recursive: true });
  await mkdir(join(template, ".agent/agents/yolo"), { recursive: true });
  await writeFile(join(dir, prompt), "STALE: fail if docs/build-journal.md exists\n");
  await writeFile(join(template, prompt), "CANONICAL: ignore docs/build-journal.md when directory exists\n");
  const previous = process.env.KLEVAR_TEMPLATE_ROOT;
  process.env.KLEVAR_TEMPLATE_ROOT = template;
  assert.equal(await readPromptTemplate(dir, prompt), "CANONICAL: ignore docs/build-journal.md when directory exists\n");
  if (previous === undefined) delete process.env.KLEVAR_TEMPLATE_ROOT;
  else process.env.KLEVAR_TEMPLATE_ROOT = previous;
  await rm(dir, { recursive: true, force: true });
  await rm(template, { recursive: true, force: true });
});

test("execCommand reports spawn results without throwing", async () => {
  const result = await execCommand("node -e \"process.exit(0)\"", process.cwd(), 30_000);
  assert.equal(result.exitCode, 0);
});

async function main(): Promise<void> {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name}`);
      console.error(error instanceof Error ? error.stack : error);
    }
  }
  if (failed) process.exitCode = 1;
}

function progressItem(tag: string, title: string, details: string[] = []): any {
  return { raw: [`- [ ] ${tag} ${title}`, ...details].join("\n"), tag, title, phase: "Phase 0", checked: false, details, affectedFiles: [] };
}

function configWithPatterns(blockedPaths: string[], protectedPaths: string[], allowedGeneratedPaths: string[]): RuntimeConfig {
  return {
    schemaVersion: 1,
    maxBatchSize: 1,
    reinforcementThreshold: 3,
    worktrees: { enabled: true, keepOnFailure: true },
    retention: { keepSuccessfulWorktrees: 2, keepFailedWorktrees: true },
    policy: { blockedPaths, protectedPaths, allowedGeneratedPaths, localOnlyPaths: [".env", ".env.*"] },
    models: {
      master: {}, knowledge: {}, inbox: {}, implement: {}, validate: {}, journal: {}, audit: {}, bugfix: {}, adjudicate: {}
    },
    gates: {
      requireTdd: true,
      requireE2eForEntrypoints: true,
      requireWiring: true,
      requireAdversarialValidation: false,
      requireProjectLocalChecks: true,
      requireBusinessLogicEvidence: true,
      requireArtifactUniqueness: true,
      requireFrontendImpeccable: true,
      requireProductQuality: true
    }
  };
}

function implementResult(extra: Partial<BatchResult> = {}): BatchResult {
  return {
    schemaVersion: 1,
    agent: "implement",
    batch: 1,
    status: "SUCCESS",
    itemsCompleted: [],
    filesChanged: [],
    flags: [],
    commit: null,
    ...extra
  };
}

function journalResult(extra: { journal_entry_written: boolean; gate_file_written: boolean }): BatchResult & typeof extra {
  return {
    schemaVersion: 1,
    agent: "journal",
    batch: 1,
    status: "SUCCESS",
    itemsCompleted: [],
    filesChanged: ["docs/build-journal/001-batch.md"],
    flags: [],
    commit: null,
    ...extra
  };
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "klevar-yolo-test-"));
}

async function readFileText(file: string): Promise<string> {
  return readFile(file, "utf8");
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

await main();
