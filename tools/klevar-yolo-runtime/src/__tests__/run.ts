import { existsSync, readFileSync } from "node:fs";
import { access, mkdtemp, rm, writeFile, mkdir, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { staleUnansweredToolReason } from "../agent-session.js";
import { validatePaths } from "../validators/path-validator.js";
import { classifyRuntimePath } from "../path-policy.js";
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
import { gitStatus, nextBatchNumber, removeWindowsReservedDeviceFiles } from "../util/git.js";
import { failRuntimeFromError, markAffectedTestPlan, markHeartbeat, markJournalDecision, markRiskObservation, markSelfHeal, resetRuntimeState, setCheckpoint, setPhase } from "../telemetry.js";
import { validateJournalContract } from "../journal-contract.js";
import { validateAll, validateAllWithState, gatesPassed } from "../validators/index.js";
import { blockingRecoveryFlags, canonicalizeBatchResultManifests, classifyBatchType, completedBatchCommitExists, failureSignature, findLatestResumableBatch, hasNonRecoverableRuntimeBlocker, isRuntimeOwnedRecoverySignature, journalSource, mergeRecoveredResult, mergeRecoveredResultFromDisk, readLatestSuccessfulBugfixResult, recoveryAttemptsExhausted, runtimeOwnedFailureRequiresStop, runtimePoisonedRecoveryLoop, shouldCapturePoisonedBatchIncidentFixture, validationFailureContradictedByRecoveredEvidence } from "../runtime.js";
import { buildBatchContext } from "../context-builder.js";
import { adjudicationAccepted, adjudicationAllowed, adjudicationNeedsBugfix, normalizeAdjudication, readAdjudicationFile } from "../adjudication.js";
import { classifyGateFindings } from "../gate-findings.js";
import { clearSubagentOutput, fillLegacyPlaceholders } from "../subagent-runner.js";
import { appendSubagentEvent, budgetFromInvocation, summarizeSubagentSession } from "../subagent-telemetry.js";
import { defaultConfig, loadConfig } from "../config.js";
import { syncLocalOnlyFilesToRoot, syncWorktreeChangesToRoot, validateWorktreeMergeReadiness } from "../worktree-sync.js";
import { isTransientRemoveError, pruneSuccessfulWorktrees } from "../worktree-retention.js";
import { runPolicyConsistencyTests } from "./policy-consistency.js";
import { repairCommittedCloseoutGate, verifyPreviousBatchGates } from "../gates.js";
import { readPromptTemplate } from "../prompt-source.js";
import { cleanBatch, normalizeBatch, rollbackLast, undoLast } from "../recovery.js";
import { loadClaims, markRuntimeClaim, prepareRuntimeClaim, validateClaims } from "../collaboration/claims.js";
import { planParallelBatches } from "../collaboration/scheduler.js";
import { formatRuntimeNotification, shouldNotifyRuntimeFinish, telegramEnabled } from "../notifications.js";
import { readPendingInbox, reconcileInbox, routeInboxEntries } from "../inbox-router.js";
import { replayIncidentFixture } from "../incident-replay.js";
import { formatReleaseGateResult, runReleaseGate } from "../release-gate.js";
import { capturePoisonedBatchIncidentFixture } from "../incident-fixtures.js";
import { healUnreadableRuntimeState, isSelfHealingSafetyBlocker } from "../self-healing.js";
import { deterministicJournalPaths, writeDeterministicJournal } from "../journal-fast-path.js";
import { classifyObservedRisk } from "../speed-risk.js";
import { fixedFindingPrefix, isBlockingFlag, isPositiveFlag } from "../flag-classification.js";
import { planAffectedTests } from "../affected-tests.js";
import { routeInboxWithAi } from "../inbox-ai-router.js";
import { buildRelevantKnowledgePack, expandCandidateRequests } from "../knowledge-retriever.js";
import { markPhaseSupportDue, nextSupportPlan, supportGateName } from "../support-scheduler.js";
import { acquireRuntimeLock, releaseRuntimeLock } from "../runtime-lock.js";
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

test("path policy normalizes Windows paths blocks nested generated dirs and rejects unsafe runtime paths", () => {
  const gate = validatePaths([
    "node_modules\\pkg\\index.js",
    "apps\\web\\node_modules\\pkg\\index.js",
    ".agent\\rules\\CODING_STANDARDS.md",
    "../outside.txt",
    "src/../../.env",
    "C:\\tmp\\file",
    ".yolo/runtime-state.json",
    ".yolo/events/batch-001.jsonl",
    ".yolo/logs/runtime.log",
    ".yolo/worktrees/batch-001/src/app.ts",
    ".yolo/incidents/batch-017/logs/runtime.log",
    ".GIT/config",
    ".ENV.local",
    ".YOLO/runtime.config.json",
    ".yolo/pi-sessions/session.json"
  ], defaultConfig);
  assert.deepEqual(gate.flags, [
    "BLOCKED_PATH:node_modules\\pkg\\index.js",
    "BLOCKED_PATH:apps\\web\\node_modules\\pkg\\index.js",
    "TEMPLATE_MANAGED_PROTECTED_PATH:.agent\\rules\\CODING_STANDARDS.md",
    "UNSAFE_PATH:../outside.txt",
    "UNSAFE_PATH:src/../../.env",
    "UNSAFE_PATH:C:\\tmp\\file",
    "RUNTIME_ONLY_PATH:.yolo/runtime-state.json",
    "RUNTIME_ONLY_PATH:.yolo/events/batch-001.jsonl",
    "RUNTIME_ONLY_PATH:.yolo/logs/runtime.log",
    "RUNTIME_ONLY_PATH:.yolo/worktrees/batch-001/src/app.ts",
    "RUNTIME_ONLY_PATH:.yolo/incidents/batch-017/logs/runtime.log",
    "BLOCKED_PATH:.GIT/config",
    "BLOCKED_PATH:.ENV.local",
    "RUNTIME_ONLY_PATH:.YOLO/runtime.config.json",
    "RUNTIME_ONLY_PATH:.yolo/pi-sessions/session.json"
  ]);
  assert.equal(validatePaths([".yolo/gates/e2e-batch-001.md", ".yolo/batch-results/batch-001-implement.json"], defaultConfig).passed, true);
});

test("path classifier v2 assigns owner sync and deliverable dispositions", () => {
  assert.deepEqual(classifyRuntimePath("src/app.ts"), {
    path: "src/app.ts",
    safe: true,
    owner: "product",
    sync: "copy",
    deliverable: true,
    localOnlyAllowed: false,
    reason: "product-deliverable"
  });
  assert.deepEqual(classifyRuntimePath(".yolo/runtime/batches/batch-001/state.json"), {
    path: ".yolo/runtime/batches/batch-001/state.json",
    safe: true,
    owner: "runtime",
    sync: "ignore",
    deliverable: false,
    localOnlyAllowed: false,
    reason: "runtime-control-plane"
  });
  assert.deepEqual(classifyRuntimePath(".yolo/incidents/batch-017/logs/runtime.log"), {
    path: ".yolo/incidents/batch-017/logs/runtime.log",
    safe: true,
    owner: "runtime",
    sync: "ignore",
    deliverable: false,
    localOnlyAllowed: false,
    reason: "runtime-control-plane"
  });
  assert.equal(classifyRuntimePath(".yolo/gates/e2e-batch-001.md").sync, "runtime-artifact");
  assert.equal(classifyRuntimePath(".yolo/gates/e2e-batch-001.md").deliverable, true);
  assert.equal(classifyRuntimePath("tools/klevar-yolo-runtime/src/runtime.ts").owner, "tooling");
  assert.equal(classifyRuntimePath("tools/klevar-yolo-runtime/src/runtime.ts").sync, "copy");
  assert.equal(classifyRuntimePath("apps/web/node_modules/pkg/index.js").owner, "generated");
  assert.equal(classifyRuntimePath("apps/web/node_modules/pkg/index.js").localOnlyAllowed, true);
  assert.equal(classifyRuntimePath("../outside.txt").safe, false);
  assert.equal(classifyRuntimePath("../outside.txt").sync, "reject");
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

test("Windows command runner executes simple node commands without Bash shell state", async () => {
  const dir = await tempDir();
  const invocation = buildCommandInvocation(`node ${JSON.stringify("C:\\tmp\\cli.js")} --help`, dir, "win32");
  assert.equal(invocation.file, "node");
  assert.deepEqual(invocation.args, ["C:\\tmp\\cli.js", "--help"]);
  assert.equal(invocation.shell, false);
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

test("protected paths override broad generated path allowlists", () => {
  const config = configWithPatterns([], [".agent/", ".yolo/runtime.config.json"], [".yolo/", "docs/progress.md"]);
  assert.deepEqual(validatePaths([".agent/rules/CODEBASE_CONTEXT.md", ".yolo/runtime.config.json", "docs/progress.md"], config), {
    name: "paths",
    passed: false,
    flags: ["TEMPLATE_MANAGED_PROTECTED_PATH:.agent/rules/CODEBASE_CONTEXT.md", "RUNTIME_ONLY_PATH:.yolo/runtime.config.json"]
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
  assert.deepEqual(result, { name: "paths", passed: false, flags: ["TEMPLATE_MANAGED_PROTECTED_PATH:.agent/rules/CODEBASE_CONTEXT.md", "BLOCKED_PATH:.env.local"] });
});

test("path policy rejects support deliverables for protected coordination and control-plane paths", () => {
  const result = validatePaths(["AGENTS.md", "CLAUDE.md", ".cursorrules", ".agent/workflows/implement-next.md", ".agent/agents/yolo/yolo-subagent-support.md", ".yolo/runtime-state.json", ".env.production", "keys/prod.pem"], defaultConfig);
  assert.deepEqual(result, {
    name: "paths",
    passed: false,
    flags: [
      "TEMPLATE_MANAGED_PROTECTED_PATH:AGENTS.md",
      "TEMPLATE_MANAGED_PROTECTED_PATH:CLAUDE.md",
      "TEMPLATE_MANAGED_PROTECTED_PATH:.cursorrules",
      "TEMPLATE_MANAGED_PROTECTED_PATH:.agent/workflows/implement-next.md",
      "TEMPLATE_MANAGED_PROTECTED_PATH:.agent/agents/yolo/yolo-subagent-support.md",
      "RUNTIME_ONLY_PATH:.yolo/runtime-state.json",
      "BLOCKED_PATH:.env.production",
      "BLOCKED_PATH:keys/prod.pem"
    ]
  });
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

test("local-only changed comparison normalizes Windows slashes dot prefixes and trailing slashes", async () => {
  const dir = await tempDir();
  await execCommand("git init && git config user.email test@example.com && git config user.name Test", dir, 30_000);
  await writeFile(join(dir, ".gitignore"), "apps/web/.next/\n");
  await mkdir(join(dir, "apps/web/.next"), { recursive: true });
  const result = implementResult({ filesChanged: [".\\apps\\web\\.next"], localOnlyFiles: ["apps/web/.next/"] });
  const gate = await validateLocalOnlyFiles(dir, result, defaultConfig);
  assert.ok(gate.flags.includes("LOCAL_ONLY_LISTED_AS_CHANGED:apps/web/.next/"));
  await rm(dir, { recursive: true, force: true });
});

test("local-only directory children cannot also be changed deliverables", async () => {
  const dir = await tempDir();
  await execCommand("git init && git config user.email test@example.com && git config user.name Test", dir, 30_000);
  await writeFile(join(dir, ".gitignore"), "dist/\n");
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(join(dir, "dist/app.js"), "compiled\n");
  const gate = await validateLocalOnlyFiles(dir, implementResult({ filesChanged: ["dist/app.js"], localOnlyFiles: ["dist/"] }), defaultConfig);
  assert.ok(gate.flags.includes("LOCAL_ONLY_LISTED_AS_CHANGED:dist/"));
  await rm(dir, { recursive: true, force: true });
});

test("local-only allows files inside nested generated dependency dirs when gitignored", async () => {
  const dir = await tempDir();
  await execCommand("git init && git config user.email test@example.com && git config user.name Test", dir, 30_000);
  await writeFile(join(dir, ".gitignore"), "node_modules/\n");
  const result = implementResult({ filesChanged: [], localOnlyFiles: ["apps/web/node_modules/pkg/index.js"] });
  const gate = await validateLocalOnlyFiles(dir, result, defaultConfig);
  assert.deepEqual(gate, { name: "local-only", passed: true, flags: [] });
  await rm(dir, { recursive: true, force: true });
});

test("local-only nested framework build directories are allowed when gitignored", async () => {
  const dir = await tempDir();
  await execCommand("git init && git config user.email test@example.com && git config user.name Test", dir, 30_000);
  await mkdir(join(dir, "apps/web/.next/cache"), { recursive: true });
  await writeFile(join(dir, ".gitignore"), ".next/\n");
  await writeFile(join(dir, "apps/web/.next/cache/build.json"), "{}\n");
  await execCommand("git add .gitignore && git commit -m init", dir, 30_000);
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.localOnlyFiles = ["apps/web/.next/"];
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

test("git status preserves leading status space for first modified path", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "apps/web"), { recursive: true });
  await writeFile(join(dir, "apps/web/next-env.d.ts"), "initial");
  await execCommand("git init && git config user.email test@example.com && git config user.name Test && git add . && git commit -m init", dir, 30_000);
  await writeFile(join(dir, "apps/web/next-env.d.ts"), "changed");
  const status = await gitStatus(dir);
  assert.equal(status[0], " M apps/web/next-env.d.ts");
  const root = await tempDir();
  const synced = await syncWorktreeChangesToRoot(dir, root, ["apps/web/next-env.d.ts"]);
  assert.deepEqual(synced, ["apps/web/next-env.d.ts"]);
  await rm(root, { recursive: true, force: true });
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
  await writeFile(join(dir, ".yolo/batch-results/batch-029-bugfix-2.json"), JSON.stringify(implementResult({ agent: "bugfix" })));
  assert.deepEqual(await journalSource(dir, { number: 29, type: "audit", items: [] }), { file: ".yolo/batch-results/batch-029-bugfix-2.md", type: "bugfix" });
  await rm(dir, { recursive: true, force: true });
});

test("journal source ignores failed stale bugfix attempts and uses latest successful bugfix", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo/batch-results"), { recursive: true });
  await writeFile(join(dir, ".yolo/batch-results/batch-007-bugfix.md"), "# Failed stale bugfix\n");
  await writeFile(join(dir, ".yolo/batch-results/batch-007-bugfix.json"), JSON.stringify(implementResult({ agent: "bugfix", status: "FAILURE", failureType: "AGENT_STALE_TOOL_TIMEOUT", flags: ["AGENT_STALE_TOOL_TIMEOUT"] })));
  await writeFile(join(dir, ".yolo/batch-results/batch-007-bugfix-2.md"), "# Successful bugfix\n");
  await writeFile(join(dir, ".yolo/batch-results/batch-007-bugfix-2.json"), JSON.stringify(implementResult({ agent: "bugfix", status: "SUCCESS" })));
  assert.deepEqual(await journalSource(dir, { number: 7, type: "implement", items: [] }), { file: ".yolo/batch-results/batch-007-bugfix-2.md", type: "bugfix" });
  await rm(dir, { recursive: true, force: true });
});

test("journal prompt placeholders include runtime-selected source file and type", () => {
  const filled = fillLegacyPlaceholders("{{BATCH_RESULT_FILE}} {{BATCH_TYPE}} {{WORKSPACE_FILE}}", { id: "batch-029-journal", role: "journal", promptFile: "p.md", context: "", outputBase: ".yolo/batch-results/batch-029-journal", cwd: process.cwd(), route: {}, promptVars: { BATCH_RESULT_FILE: ".yolo/batch-results/batch-029-validate.md", BATCH_TYPE: "validate" } });
  assert.equal(filled, ".yolo/batch-results/batch-029-validate.md validate .yolo/batch-results/batch-029-journal.md");
});

test("deterministic journal fast path writes valid journal and gate artifacts", async () => {
  const dir = await tempDir();
  const batch = { number: 12, type: "implement", items: [progressItem("[UI]", "Leaf component polish — PRD §5b")] } as any;
  const result = implementResult({ batch: 12, filesChanged: ["apps/web/components/card.tsx"], tests: { green: { command: "npm test -- card", exitCode: 0, evidence: "pass" } } });
  const journal = await writeDeterministicJournal({ cwd: dir, batch, result, config: defaultConfig });
  assert.ok(journal);
  assert.deepEqual(validateJournalContract(journal!), { passed: true, flags: [] });
  const paths = deterministicJournalPaths(12);
  assert.match(await readFileText(join(dir, paths.journalPath)), /Deterministic journal fast path/);
  assert.match(await readFileText(join(dir, paths.gatePath)), /result: PASS/);
  await rm(dir, { recursive: true, force: true });
});

test("deterministic journal fast path declines audits and high-risk batches", async () => {
  const dir = await tempDir();
  const auditBatch = { number: 13, type: "audit", items: [progressItem("[AUDIT]", "Phase close-out — PRD §15")] } as any;
  const highRiskBatch = { number: 14, type: "implement", items: [progressItem("[API]", "Auth migration — PRD §8")] } as any;
  assert.equal(await writeDeterministicJournal({ cwd: dir, batch: auditBatch, result: implementResult({ batch: 13 }), config: defaultConfig }), null);
  assert.equal(await writeDeterministicJournal({ cwd: dir, batch: highRiskBatch, result: implementResult({ batch: 14, filesChanged: ["src/auth.ts"] }), config: defaultConfig }), null);
  await rm(dir, { recursive: true, force: true });
});

test("observe-only risk classification does not change validation policy", () => {
  const batch = { number: 15, type: "implement", items: [progressItem("[API]", "Auth route — PRD §8")] } as any;
  const result = implementResult({ filesChanged: ["src/auth.ts"] });
  const before = validationPolicyFor(batch, result, defaultConfig);
  const observed = classifyObservedRisk({ batch, result });
  const after = validationPolicyFor(batch, result, defaultConfig);
  assert.equal(observed.observedOnly, true);
  assert.deepEqual(after, before);
});

test("affected-test planner is observe-only and rejects unsafe runtime paths", () => {
  const result = implementResult({ filesChanged: ["src/service.ts", "tests/service.test.ts", ".yolo/runtime/batches/batch-001/state.json", "../outside.txt"] });
  result.tests = { regression: { command: "npm test", exitCode: 0, evidence: "pass" } };
  const batch = { number: 16, type: "implement", items: [{ ...progressItem("[API]", "Service — PRD §8"), affectedFiles: ["src/service.ts"] }] } as any;
  const beforeTests = JSON.stringify(result.tests);
  const plan = planAffectedTests({ batch, result });
  assert.equal(plan.observedOnly, true);
  assert.equal(plan.confidence, "medium");
  assert.ok(plan.files.includes("src/service.ts"));
  assert.ok(plan.candidateCommands.includes("npm test -- tests/service.test.ts"));
  assert.ok(plan.rejected.some((entry) => entry.path === ".yolo/runtime/batches/batch-001/state.json"));
  assert.ok(plan.rejected.some((entry) => entry.path === "../outside.txt"));
  assert.equal(JSON.stringify(result.tests), beforeTests);
});

test("speed v2 does not alter batch selection source", async () => {
  const progressSource = await readFileText(join(process.cwd(), "src/progress-parser.ts"));
  assert.doesNotMatch(progressSource, /deterministicJournal|observeRisk|observeAffectedTests|planAffectedTests|classifyObservedRisk/);
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
  await writeFile(join(dir, "scripts/run-e2e.ts"), "console.log('PASS POST /api/onboard invalid payload 400 without server-error log');\nconsole.log('PASS Fastify onClose closes rate-limit Redis singleton');\n");
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

test("wiring verifier infers Scala package class method entrypoints from focused tests", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "src/test/scala/solver"), { recursive: true });
  await writeFile(join(dir, "src/test/scala/solver/OrToolsSolverAdapterSpec.scala"), [
    "package solver",
    "class OrToolsSolverAdapterSpec extends munit.FunSuite {",
    "  test(\"solve returns a feasible assignment\") {",
    "    val adapter = new OrToolsSolverAdapter()",
    "    assert(adapter.solve(SolverInput.empty).isRight)",
    "  }",
    "}"
  ].join("\n"));
  const result = implementResult({ filesChanged: ["src/main/scala/solver/OrToolsSolverAdapter.scala"] });
  result.wiring = {
    required: true,
    entrypoints: [{ type: "module", path: "solver.OrToolsSolverAdapter.solve", verifiedBy: "SolverAdapterSpec" }]
  };
  const gate = await validateWiring(dir, { number: 15, type: "implement", items: [progressItem("[INTEGRATION]", "Solver adapter — PRD §5.4")] } as any, result, true);
  assert.deepEqual(gate, { name: "wiring", passed: true, flags: [] });
  await rm(dir, { recursive: true, force: true });
});

test("wiring verifier keeps prose-only diagnostics when Scala entrypoint proof is missing", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "src/test/scala/solver"), { recursive: true });
  await writeFile(join(dir, "src/test/scala/solver/OrToolsSolverAdapterSpec.scala"), [
    "package solver",
    "class OrToolsSolverAdapterSpec extends munit.FunSuite {",
    "  test(\"constructs adapter\") { assert(new OrToolsSolverAdapter() != null) }",
    "}"
  ].join("\n"));
  const result = implementResult({ filesChanged: ["src/main/scala/solver/OrToolsSolverAdapter.scala"] });
  result.wiring = {
    required: true,
    entrypoints: [{ type: "module", path: "solver.OrToolsSolverAdapter.solve", verifiedBy: "SolverAdapterSpec" }]
  };
  const gate = await validateWiring(dir, { number: 16, type: "implement", items: [progressItem("[INTEGRATION]", "Solver adapter — PRD §5.4")] } as any, result, true);
  assert.deepEqual(gate, { name: "wiring", passed: false, flags: ["ENTRYPOINT_VERIFIER_PROSE_ONLY:solver.OrToolsSolverAdapter.solve"] });
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

test("product quality validator does not treat missing-evidence flags as evidence", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs/demo_prd.md"), "# PRD\n## Frontend Product Quality Contract\nMOBILE_VIEWPORT_PASS required for mobile responsive UI.\n");
  await writeFile(join(dir, "DESIGN.md"), "# Design\n## Visual System\nColor spacing typography.\n## Accessibility\nKeyboard focus contrast.\n## Responsive\nMobile touch.\n## States\nLoading empty error offline warning success.\n");
  const result = implementResult({ filesChanged: ["src/App.tsx"], flags: ["MOBILE_VIEWPORT_EVIDENCE_MISSING"] });
  const gate = await validateProductQuality(dir, { number: 1, type: "implement", items: [progressItem("[UI]", "UI — PRD §5b")] } as any, result, true);
  assert.equal(gate.passed, false);
  assert.ok(gate.flags.includes("MOBILE_VIEWPORT_EVIDENCE_MISSING"));
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
  const success = await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "SUCCESS", flags: [], tests: { green: { command: "npm test", exitCode: 0, evidence: "generic pass only" } } }), agent: "validate" });
  assert.equal(blockingOpenFindings(success).length, 0);
  assert.ok(success.closureTraces?.some((trace) => trace.findingId === "UNIMPLEMENTED_ASSIGNED_ITEM" && trace.cause === "validate-evidence"));
  await rm(dir, { recursive: true, force: true });
});

test("artifact-only bugfix fixed flags do not close canonical findings", async () => {
  const batch = { number: 27, type: "implement", items: [progressItem("[API]", "Supplier operations — PRD §8b")] } as any;
  const dir = await tempDir();
  await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "FAILURE", failureType: "BUSINESS_LOGIC_DRIFT", flags: ["BUSINESS_LOGIC_DRIFT"] }), agent: "validate" });
  const state = await importAgentResultToState(dir, batch, "bugfix", { ...implementResult({ agent: "bugfix", flags: ["BUSINESS_LOGIC_DRIFT_FIXED"], filesChanged: [".yolo/gates/bugfix-batch-027-contract.mjs", ".yolo/batch-results/batch-027-bugfix.json"] }) });
  assert.deepEqual(blockingOpenFindings(state).map((finding) => finding.id), ["BUSINESS_LOGIC_DRIFT"]);
  await rm(dir, { recursive: true, force: true });
});

test("artifact-only recovery evidence closes matching canonical findings when commands pass", async () => {
  const batch = { number: 45, type: "implement", items: [progressItem("[FIX]", "Runtime validation recovery — PRD §7")] } as any;
  const dir = await tempDir();
  await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "FAILURE", flags: ["BUSINESS_LOGIC_DRIFT_APPEND_ONLY_NOTELOG_OVERWRITE", "BUSINESS_LOGIC_DRIFT_TENANT_FAIRNESS_DROPS_RATE_LIMITED_JOBS"] }), agent: "validate" });
  const state = await importAgentResultToState(dir, batch, "bugfix", { ...implementResult({ agent: "bugfix", flags: ["BUSINESS_LOGIC_EVIDENCE_APPEND_ONLY_NOTELOG_PASS", "BUSINESS_LOGIC_EVIDENCE_TENANT_FAIRNESS_DELAYED_REQUEUE_PASS"], filesChanged: [".yolo/batch-results/batch-045-bugfix-3.json", ".yolo/gates/bugfix-batch-045.md"], tests: { green: { command: "npm run test:unit -- tests/setup/batch-045-runtime-contract.vitest.ts", exitCode: 0, evidence: "artifact recovery contract passed" } } }) });
  assert.deepEqual(blockingOpenFindings(state), []);
  assert.equal(findingSummary(state).fixed, 2);
  await rm(dir, { recursive: true, force: true });
});

test("canonical reconciliation records closure trace for runtime-only command-backed bugfix evidence", async () => {
  const batch = { number: 45, type: "implement", items: [progressItem("[FIX]", "Runtime validation recovery — PRD §7")] } as any;
  const dir = await tempDir();
  await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "FAILURE", flags: ["BUSINESS_LOGIC_DRIFT_APPEND_ONLY_NOTELOG_OVERWRITE"] }), agent: "validate" });
  const state = await importAgentResultToState(dir, batch, "bugfix", { ...implementResult({ agent: "bugfix", flags: ["BUSINESS_LOGIC_EVIDENCE_APPEND_ONLY_NOTELOG_PASS"], filesChanged: [".yolo/batch-results/batch-045-bugfix-2.json", ".yolo/gates/bugfix-batch-045.md"], tests: { green: { command: "npm run test:unit -- tests/setup/batch-045-runtime-contract.vitest.ts", exitCode: 0, evidence: "artifact recovery contract passed" } } }) });
  assert.deepEqual(blockingOpenFindings(state), []);
  assert.ok(state.closureTraces?.some((trace) => trace.findingId === "BUSINESS_LOGIC_DRIFT_APPEND_ONLY_NOTELOG_OVERWRITE" && trace.cause === "artifact-command-evidence"));
  assert.deepEqual(state.openExplanations, []);
  await rm(dir, { recursive: true, force: true });
});

test("canonical reconciliation explains runtime-only fixed flags without passing command evidence", async () => {
  const batch = { number: 45, type: "implement", items: [progressItem("[FIX]", "Runtime validation recovery — PRD §7")] } as any;
  const dir = await tempDir();
  await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "FAILURE", flags: ["BUSINESS_LOGIC_DRIFT_APPEND_ONLY_NOTELOG_OVERWRITE"] }), agent: "validate" });
  const state = await importAgentResultToState(dir, batch, "bugfix", { ...implementResult({ agent: "bugfix", flags: ["BUSINESS_LOGIC_DRIFT_FIXED"], filesChanged: [".yolo/batch-results/batch-045-bugfix-2.json"], tests: { green: { command: "", exitCode: 0, evidence: "not runnable" } } }) });
  assert.deepEqual(blockingOpenFindings(state).map((finding) => finding.id), ["BUSINESS_LOGIC_DRIFT_APPEND_ONLY_NOTELOG_OVERWRITE"]);
  assert.ok(state.openExplanations?.some((item) => item.findingId === "BUSINESS_LOGIC_DRIFT_APPEND_ONLY_NOTELOG_OVERWRITE" && item.reason.includes("runtime-only result lacks passing command evidence")));
  await rm(dir, { recursive: true, force: true });
});

test("semantic bugfix fixed flags close matching canonical findings", async () => {
  const batch = { number: 27, type: "implement", items: [progressItem("[API]", "Supplier operations — PRD §8b")] } as any;
  const dir = await tempDir();
  await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "FAILURE", failureType: "BUSINESS_LOGIC_DRIFT", flags: ["BUSINESS_LOGIC_DRIFT"] }), agent: "validate" });
  const state = await importAgentResultToState(dir, batch, "bugfix", { ...implementResult({ agent: "bugfix", flags: ["BUSINESS_LOGIC_DRIFT_FIXED"], filesChanged: ["apps/web/app/api/supplier-orders/route.ts", "tests/e2e/api/supplier-operations.spec.ts"] }) });
  assert.deepEqual(blockingOpenFindings(state), []);
  assert.equal(findingSummary(state).fixed, 1);
  await rm(dir, { recursive: true, force: true });
});

test("semantic recovered flags close matching replay planner job and expected-totals findings", async () => {
  const batch = { number: 16, type: "implement", items: [progressItem("[JOB]", "Replay and planner recovery — PRD §7")] } as any;
  const dir = await tempDir();
  await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "FAILURE", flags: ["REPLAY_EXPECTED_TOTALS_EVIDENCE_GAP", "PLANNER_REPLAY_PARITY_GAP", "JOB_RUN_ONCE_ENTRYPOINT_UNVERIFIED"] }), agent: "validate" });
  const state = await importAgentResultToState(dir, batch, "bugfix", { ...implementResult({ agent: "bugfix", flags: ["REPLAY_EXPECTED_TOTALS_EVIDENCE_GAP_RECOVERED", "PLANNER_REPLAY_PARITY_RECOVERED", "JOB_RUN_ONCE_ENTRYPOINT_VERIFIED"], filesChanged: ["src/jobs/replay_worker.nim", "tests/verify_batch_016_replay.sh"] }) });
  assert.deepEqual(blockingOpenFindings(state), []);
  assert.equal(findingSummary(state).fixed, 3);
  assert.ok(state.closureTraces?.some((trace) => trace.findingId === "REPLAY_EXPECTED_TOTALS_EVIDENCE_GAP" && trace.cause === "bugfix-semantic-evidence"));
  await rm(dir, { recursive: true, force: true });
});

test("state hygiene quarantines stale runtime support findings after trusted Billbee B065-style recovery", async () => {
  const batch = { number: 65, type: "support", items: [progressItem("[TOOLING]", "Runtime support recovery — PRD N/A")] } as any;
  const dir = await tempDir();
  await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "FAILURE", flags: ["RUNTIME_GATES_REJECTED", "PROTECTED_PATH:.agent/rules/CODING_STANDARDS.md", "MODULARITY_RULE_FILE_LIMIT_VIOLATION"] }), agent: "validate" });
  const state = await importAgentResultToState(dir, batch, "bugfix", { ...implementResult({ agent: "bugfix", flags: ["MODULARITY_RULE_FILE_WARNING_ROUTED_NON_BLOCKING", "PROTECTED_PATH_METADATA_REMOVED"], filesChanged: [".yolo/batch-results/batch-065-bugfix-2.json", ".yolo/gates/bugfix-batch-065.md"], tests: { green: { command: "npm test -- --runtime-hygiene", exitCode: 0, evidence: "trusted recovery contract passed" } } }) });
  assert.deepEqual(blockingOpenFindings(state), []);
  assert.ok(state.findings.some((finding) => finding.id === "RUNTIME_GATES_REJECTED" && finding.status === "stale"));
  await rm(dir, { recursive: true, force: true });
});

test("state hygiene preserves real product blockers while quarantining stale Commercial B016-style tooling findings", async () => {
  const batch = { number: 16, type: "implement", items: [progressItem("[JOB]", "Replay and planner recovery — PRD §7")] } as any;
  const dir = await tempDir();
  await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "FAILURE", flags: ["RUNTIME_GATES_REJECTED", "BUSINESS_LOGIC_DRIFT_EXPECTED_TOTALS"] }), agent: "validate" });
  const state = await importAgentResultToState(dir, batch, "bugfix", { ...implementResult({ agent: "bugfix", flags: ["GENERATED_FILE_DRIFT_REVERTED"], filesChanged: [".yolo/batch-results/batch-016-bugfix.json", ".yolo/gates/bugfix-batch-016.md"], tests: { green: { command: "npm test -- --commercial-b016-runtime-contract", exitCode: 0, evidence: "runtime artifact recovery passed" } } }) });
  assert.deepEqual(blockingOpenFindings(state).map((finding) => finding.id), ["BUSINESS_LOGIC_DRIFT_EXPECTED_TOTALS"]);
  assert.ok(state.findings.some((finding) => finding.id === "RUNTIME_GATES_REJECTED" && finding.status === "stale"));
  await rm(dir, { recursive: true, force: true });
});

test("bugfix success does not close unrelated open findings without explicit fix evidence", async () => {
  const batch = { number: 21, type: "implement", items: [progressItem("[DATA]", "Authority guardrail — PRD §5.2")] } as any;
  const dir = await tempDir();
  await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "FAILURE", failureType: "BUSINESS_LOGIC_DRIFT", flags: ["BUSINESS_LOGIC_DRIFT", "CUSTOMER_NOTE_ALLOWLIST_GAP"] }), agent: "validate" });
  const state = await importAgentResultToState(dir, batch, "bugfix", { ...implementResult({ status: "SUCCESS", flags: ["AUTH_BOUNDARY_GAP_FIXED", "REGRESSION_PASS"], tests: { green: { command: "npm test", exitCode: 0, evidence: "auth fixed" } } }), agent: "bugfix" });
  assert.deepEqual(blockingOpenFindings(state).map((finding) => finding.id).sort(), ["BUSINESS_LOGIC_DRIFT", "CUSTOMER_NOTE_ALLOWLIST_GAP"]);
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

test("canonical runtime state treats positive verified flags with explanatory missing text as non-blocking", async () => {
  const dir = await tempDir();
  const batch = { number: 32, type: "implement", items: [progressItem("[FIX]", "Phase support validation — PRD N/A")] } as any;
  const result = implementResult({
    flags: ["ALREADY_IMPLEMENTED_VERIFIED: Phase implementation surfaces were already present; objective gap was missing progress support item."]
  });
  const state = await importAgentResultToState(dir, batch, "implement", result);
  assert.deepEqual(blockingOpenFindings(state), []);
  await rm(dir, { recursive: true, force: true });
});

test("canonical runtime state ignores stale positive verified findings when deciding blockers", () => {
  const state = {
    schemaVersion: 1 as const,
    batch: 32,
    selectedItems: [],
    changedFiles: [],
    risk: { class: "low" as const, reasons: [] },
    currentResult: implementResult(),
    findings: [{ id: "ALREADY_IMPLEMENTED_VERIFIED: implementation present; missing progress proof was added", source: "bugfix", status: "open" as const, evidence: [], lastCheckedAt: new Date().toISOString() }],
    commands: [],
    gates: {},
    updatedAt: new Date().toISOString()
  };
  assert.deepEqual(blockingOpenFindings(state), []);
});

test("canonical runtime state classifies flags by code before explanatory blocker prose", async () => {
  const dir = await tempDir();
  const batch = { number: 33, type: "implement", items: [progressItem("[FIX]", "Flag taxonomy — PRD N/A")] } as any;
  const result = implementResult({
    flags: [
      "TENANT_NEUTRALITY_SWEEP_NO_LEAKS: no leakage or missing tenant secrets found",
      "PRIVACY_MATRIX_NOT_APPLICABLE: privacy gap is missing by design for docs-only work",
      "BUNDLE_DYNAMIC_IMPORT_AUDIT_EVIDENCE_RECORDED: missing bundle metric recorded as not applicable",
      "FUTURE_PHASE_SUCCESS_CRITERIA_RECORDED_AS_MANUAL_NOT_FINDINGS",
      "CROSS_ORDER_SUPPLIER_BUNDLING_REJECTED: invalid cross-order bundling correctly rejected"
    ]
  });
  const state = await importAgentResultToState(dir, batch, "implement", result);
  assert.deepEqual(blockingOpenFindings(state), []);
  await rm(dir, { recursive: true, force: true });
});

test("canonical runtime state treats explicit non-blocking failed-attempt flags as warnings", async () => {
  const dir = await tempDir();
  const batch = { number: 39, type: "implement", items: [progressItem("[FIX]", "Structural support sweep — PRD N/A")] } as any;
  const state = await importAgentResultToState(dir, batch, "implement", implementResult({
    flags: ["E2E_ATTEMPT_FAILED_NON_BLOCKING"],
    tests: { e2e: { command: "not applicable", exitCode: 0, evidence: "SKIPPED_NO_ENDPOINTS", required: false } }
  }));
  assert.deepEqual(blockingOpenFindings(state), []);
  const gateState = recordGateState(state, [{ name: "e2e", passed: false, flags: ["E2E_ATTEMPT_FAILED_NON_BLOCKING"] }]);
  assert.deepEqual(blockingOpenFindings(gateState), []);
  await rm(dir, { recursive: true, force: true });
});

test("canonical finding lifecycle does not let warning-only gate reruns close hard findings", () => {
  const opened = recordGateState({ schemaVersion: 1, batch: 34, selectedItems: [], changedFiles: [], risk: { class: "low", reasons: [] }, currentResult: implementResult(), findings: [], commands: [], gates: {}, updatedAt: new Date().toISOString() }, [
    { name: "frontend", passed: false, flags: ["IMPECCABLE_DETECTOR_FINDINGS:1"] }
  ]);
  assert.deepEqual(blockingOpenFindings(opened).map((finding) => finding.id), ["IMPECCABLE_DETECTOR_FINDINGS:1"]);
  const stillOpen = recordGateState(opened, [{ name: "frontend", passed: false, flags: ["IMPECCABLE_DETECTOR_UNAVAILABLE:detector unavailable after source reverted"] }]);
  assert.deepEqual(blockingOpenFindings(stillOpen).map((finding) => finding.id), ["IMPECCABLE_DETECTOR_FINDINGS:1"]);
  const closed = recordGateState(stillOpen, [{ name: "frontend", passed: true, flags: [] }]);
  assert.deepEqual(blockingOpenFindings(closed), []);
});

test("semantic bugfix fixed flags with explanatory details close matching findings", async () => {
  const batch = { number: 35, type: "implement", items: [progressItem("[API]", "Business rule — PRD §8")] } as any;
  const dir = await tempDir();
  await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "FAILURE", failureType: "BUSINESS_LOGIC_DRIFT", flags: ["BUSINESS_LOGIC_DRIFT"] }), agent: "validate" });
  const state = await importAgentResultToState(dir, batch, "bugfix", { ...implementResult({ agent: "bugfix", flags: ["BUSINESS_LOGIC_DRIFT_FIXED: verified by regression"], filesChanged: ["src/business.ts"] }) });
  assert.deepEqual(blockingOpenFindings(state), []);
  await rm(dir, { recursive: true, force: true });
});

test("semantic verified flags close matching unverified gate findings with detail", async () => {
  const batch = { number: 45, type: "implement", items: [progressItem("[JOB]", "Queue fairness — PRD §7")] } as any;
  const dir = await tempDir();
  const base = await importAgentResultToState(dir, batch, "implement", implementResult());
  const opened = recordGateState(base, [{ name: "wiring", passed: false, flags: ["ENTRYPOINT_UNVERIFIED:tenant-aware queue fairness"] }]);
  assert.equal(blockingOpenFindings(opened).length, 1);
  const state = await importAgentResultToState(dir, batch, "bugfix", { ...implementResult({ agent: "bugfix", flags: ["ENTRYPOINT_VERIFIED:tenant-aware queue fairness"], filesChanged: ["apps/worker/src/queues.ts", "tests/setup/batch-045-shipment-automation.vitest.ts"] }) }, opened);
  assert.deepEqual(blockingOpenFindings(state), []);
  assert.equal(findingSummary(state).fixed, 1);
  await rm(dir, { recursive: true, force: true });
});

test("semantic verified flags close worker queue findings across colon detail token variants", async () => {
  const batch = { number: 52, type: "implement", items: [progressItem("[JOB]", "Worker queues — PRD §7")] } as any;
  const dir = await tempDir();
  const base = await importAgentResultToState(dir, batch, "implement", implementResult());
  const opened = recordGateState(base, [{ name: "wiring", passed: false, flags: ["ENTRYPOINT_UNVERIFIED:worker-queues"] }]);
  assert.deepEqual(blockingOpenFindings(opened).map((finding) => finding.id), ["ENTRYPOINT_UNVERIFIED:worker-queues"]);
  const state = await importAgentResultToState(dir, batch, "bugfix", { ...implementResult({ agent: "bugfix", flags: ["ENTRYPOINT_VERIFIED:worker queue wiring"], filesChanged: ["apps/worker/src/queues.ts", "tests/setup/batch-052-worker-queues.vitest.ts"], tests: { regression: { command: "npm test -- tests/setup/batch-052-worker-queues.vitest.ts", exitCode: 0, evidence: "worker queue wiring source regression passed" } } }) }, opened);
  assert.deepEqual(blockingOpenFindings(state), []);
  assert.ok(state.closureTraces?.some((trace) => trace.findingId === "ENTRYPOINT_UNVERIFIED:worker-queues" && trace.cause === "bugfix-semantic-evidence"));
  await rm(dir, { recursive: true, force: true });
});

test("dangerous exact non-blocking flags remain blockers", () => {
  const gates = [{ name: "security", passed: false, flags: ["SECURITY_NON_BLOCKING"] }];
  assert.equal(gatesPassed(gates), false);
  const state = recordGateState({ schemaVersion: 1, batch: 46, selectedItems: [], changedFiles: [], risk: { class: "critical", reasons: [] }, currentResult: implementResult(), findings: [], commands: [], gates: {}, updatedAt: new Date().toISOString() }, gates);
  assert.deepEqual(blockingOpenFindings(state).map((finding) => finding.id), ["SECURITY_NON_BLOCKING"]);
});

test("agent result unverified flags open canonical findings", async () => {
  const dir = await tempDir();
  const batch = { number: 47, type: "implement", items: [progressItem("[JOB]", "Worker wiring — PRD §7")] } as any;
  const state = await importAgentResultToState(dir, batch, "validate", { ...implementResult({ flags: ["ENTRYPOINT_UNVERIFIED:queue worker", "BUSINESS_LOGIC_UNVERIFIED:pricing rule"] }), agent: "validate" });
  assert.deepEqual(blockingOpenFindings(state).map((finding) => finding.id).sort(), ["BUSINESS_LOGIC_UNVERIFIED:pricing rule", "ENTRYPOINT_UNVERIFIED:queue worker"]);
  await rm(dir, { recursive: true, force: true });
});

test("generic pass flags do not close same-root blockers or substring-prune blockers", async () => {
  const dir = await tempDir();
  const batch = { number: 48, type: "implement", items: [progressItem("[API]", "Auth boundary — PRD §8")] } as any;
  await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "FAILURE", flags: ["AUTH_BOUNDARY_GAP", "AUTHORIZATION_GAP"] }), agent: "validate" });
  const state = await importAgentResultToState(dir, batch, "bugfix", { ...implementResult({ agent: "bugfix", flags: ["AUTH_PASS"], filesChanged: ["src/auth.ts"] }) });
  assert.deepEqual(blockingOpenFindings(state).map((finding) => finding.id).sort(), ["AUTHORIZATION_GAP", "AUTH_BOUNDARY_GAP"]);
  await rm(dir, { recursive: true, force: true });
});

test("specific positive evidence flags close matching unwired and business drift findings", async () => {
  const dir = await tempDir();
  const batch = { number: 52, type: "implement", items: [progressItem("[JOB]", "Shipment automation — PRD §7")] } as any;
  await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "FAILURE", flags: ["UNWIRED_WORKER_ENTRYPOINTS", "ENTRYPOINT_UNWIRED_TRACKING_EMAIL_PARSE", "QUEUE_FAIRNESS_NOT_WIRED", "BUSINESS_LOGIC_DRIFT_FALLBACK_CONFIDENCE"] }), agent: "validate" });
  const state = await importAgentResultToState(dir, batch, "bugfix", { ...implementResult({ agent: "bugfix", flags: ["ENTRYPOINT_VERIFIED_TRACKING_EMAIL_PARSE", "ENTRYPOINT_VERIFIED_TENANT_AWARE_QUEUE_FAIRNESS", "BUSINESS_LOGIC_EVIDENCE_FALLBACK_CONFIDENCE_PASS"], filesChanged: ["apps/worker/src/index.ts", "tests/setup/batch-045-shipment-automation.vitest.ts"] }) });
  assert.deepEqual(blockingOpenFindings(state), []);
  assert.equal(findingSummary(state).fixed, 4);
  await rm(dir, { recursive: true, force: true });
});

test("sweep and reverted positive flags close matching late validation findings", async () => {
  const dir = await tempDir();
  const batch = { number: 58, type: "implement", items: [progressItem("[JOB]", "Shipment automation — PRD §7")] } as any;
  await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "FAILURE", flags: ["BUSINESS_LOGIC_DRIFT_APPEND_ONLY_NOTELOG_OVERWRITE", "BUSINESS_LOGIC_DRIFT_TENANT_FAIRNESS_DROPS_RATE_LIMITED_JOBS", "GENERATED_FILE_DRIFT_UNREPORTED"] }), agent: "validate" });
  const state = await importAgentResultToState(dir, batch, "bugfix", { ...implementResult({ agent: "bugfix", flags: ["BUSINESS_LOGIC_DRIFT_SWEEP_PASS", "TENANT_FAIRNESS_RATE_LIMIT_RETRY_PASS", "GENERATED_FILE_DRIFT_REVERTED"], filesChanged: ["apps/worker/src/queues.ts", "apps/web/next-env.d.ts"] }) });
  assert.deepEqual(blockingOpenFindings(state), []);
  assert.equal(findingSummary(state).fixed, 3);
  await rm(dir, { recursive: true, force: true });
});

test("tenant fairness retry evidence closes matching drift without broad sweep", async () => {
  const dir = await tempDir();
  const batch = { number: 59, type: "implement", items: [progressItem("[JOB]", "Tenant queue fairness — PRD §7")] } as any;
  await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "FAILURE", flags: ["BUSINESS_LOGIC_DRIFT_TENANT_FAIRNESS_DROPS_RATE_LIMITED_JOBS"] }), agent: "validate" });
  const state = await importAgentResultToState(dir, batch, "bugfix", { ...implementResult({ agent: "bugfix", flags: ["TENANT_FAIRNESS_RATE_LIMIT_RETRY_PASS"], filesChanged: ["apps/worker/src/queues.ts"] }) });
  assert.deepEqual(blockingOpenFindings(state), []);
  await rm(dir, { recursive: true, force: true });
});

test("stale raw flags do not reopen recovered canonical findings", async () => {
  const dir = await tempDir();
  const batch = { number: 53, type: "implement", items: [progressItem("[API]", "Auth boundary — PRD §8")] } as any;
  const opened = await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "FAILURE", flags: ["AUTH_BOUNDARY_GAP"] }), agent: "validate" });
  assert.equal(blockingOpenFindings(opened).length, 1);
  const fixed = await importAgentResultToState(dir, batch, "bugfix", { ...implementResult({ agent: "bugfix", flags: ["AUTH_BOUNDARY_FIXED"], filesChanged: ["src/auth.ts"] }) });
  assert.deepEqual(blockingOpenFindings(fixed), []);
  const replay = await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "SUCCESS", flags: ["AUTH_BOUNDARY_GAP"], tests: { regression: { command: "npm test", exitCode: 0, evidence: "green" } } }), agent: "validate" });
  assert.deepEqual(blockingOpenFindings(replay), []);
  await rm(dir, { recursive: true, force: true });
});

test("validate success does not close unrelated open findings without semantic fix evidence", async () => {
  const dir = await tempDir();
  const batch = { number: 54, type: "implement", items: [progressItem("[DATA]", "Payment auth — PRD §5")] } as any;
  await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "FAILURE", flags: ["BUSINESS_LOGIC_DRIFT_PAYMENT_AUTH"] }), agent: "validate" });
  const state = await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "SUCCESS", tests: { regression: { command: "npm run lint", exitCode: 0, evidence: "lint passed only" } } }), agent: "validate" });
  assert.deepEqual(blockingOpenFindings(state).map((finding) => finding.id), ["BUSINESS_LOGIC_DRIFT_PAYMENT_AUTH"]);
  await rm(dir, { recursive: true, force: true });
});

test("latest successful validate outranks older validate failure for non-product findings", async () => {
  const dir = await tempDir();
  const batch = { number: 60, type: "support", items: [progressItem("[FIX]", "Runtime gate cleanup — PRD N/A")] } as any;
  await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "FAILURE", flags: ["RUNTIME_GATES_REJECTED", "ARTIFACT_MISSING:.yolo/gates/batch-060.md"] }), agent: "validate" });
  const state = await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "SUCCESS", tests: { regression: { command: "npm test", exitCode: 0, evidence: "green after runtime artifact repair" } } }), agent: "validate" });
  assert.deepEqual(blockingOpenFindings(state), []);
  assert.equal(findingSummary(state).fixed, 2);
  await rm(dir, { recursive: true, force: true });
});

test("latest source-backed bugfix closes only semantically matched product findings", async () => {
  const dir = await tempDir();
  const batch = { number: 61, type: "implement", items: [progressItem("[API]", "Payment and tenant boundaries — PRD §8")] } as any;
  await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "FAILURE", flags: ["BUSINESS_LOGIC_DRIFT_PAYMENT_AUTH", "TENANT_BOUNDARY_GAP"] }), agent: "validate" });
  const state = await importAgentResultToState(dir, batch, "bugfix", { ...implementResult({ agent: "bugfix", flags: ["BUSINESS_LOGIC_EVIDENCE_PAYMENT_AUTH_PASS"], filesChanged: ["src/payment.ts", "src/tenant.ts"], tests: { regression: { command: "npm test", exitCode: 0, evidence: "payment regression green" } } }) });
  assert.deepEqual(blockingOpenFindings(state).map((finding) => finding.id), ["TENANT_BOUNDARY_GAP"]);
  assert.ok(state.findings.some((finding) => finding.id === "BUSINESS_LOGIC_DRIFT_PAYMENT_AUTH" && finding.status === "fixed"));
  await rm(dir, { recursive: true, force: true });
});

test("runtime-only recovery with passing commands quarantines stale runtime support findings without positive flags", async () => {
  const dir = await tempDir();
  const batch = { number: 62, type: "support", items: [progressItem("[FIX]", "Recover runtime artifacts — PRD N/A")] } as any;
  await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "FAILURE", flags: ["RUNTIME_GATES_REJECTED", "PLAN_REJECTED: missing runtime gate artifact .yolo/gates/bugfix-batch-062.md", "BUSINESS_LOGIC_DRIFT_TENANT_FAIRNESS"] }), agent: "validate" });
  const state = await importAgentResultToState(dir, batch, "bugfix", { ...implementResult({ agent: "bugfix", flags: [], filesChanged: [".yolo/batch-results/batch-062-bugfix.json", ".yolo/gates/bugfix-batch-062.md"], tests: { regression: { command: "npm test", exitCode: 0, evidence: "runtime recovery green" } } }) });
  assert.deepEqual(state.findings.filter((finding) => finding.status === "stale").map((finding) => finding.id).sort(), ["PLAN_REJECTED: missing runtime gate artifact .yolo/gates/bugfix-batch-062.md", "RUNTIME_GATES_REJECTED"]);
  assert.deepEqual(blockingOpenFindings(state).map((finding) => finding.id), ["BUSINESS_LOGIC_DRIFT_TENANT_FAIRNESS"]);
  await rm(dir, { recursive: true, force: true });
});

test("old yolo artifact flags never reopen current fixed canonical state", async () => {
  const dir = await tempDir();
  const batch = { number: 63, type: "support", items: [progressItem("[FIX]", "Runtime artifact replay — PRD N/A")] } as any;
  await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "FAILURE", flags: ["ARTIFACT_MISSING:.yolo/gates/batch-063.md"] }), agent: "validate" });
  const fixed = await importAgentResultToState(dir, batch, "bugfix", { ...implementResult({ agent: "bugfix", flags: ["ARTIFACT_MISSING_FIXED:.yolo/gates/batch-063.md"], filesChanged: [".yolo/gates/batch-063.md"], tests: { regression: { command: "npm test", exitCode: 0, evidence: "artifact exists" } } }) });
  assert.deepEqual(blockingOpenFindings(fixed), []);
  const staleReplay = await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "SUCCESS", flags: ["ARTIFACT_MISSING:.yolo/gates/batch-063.md"], tests: { regression: { command: "npm test", exitCode: 0, evidence: "old artifact replay ignored" } } }), agent: "validate" });
  assert.deepEqual(blockingOpenFindings(staleReplay), []);
  await rm(dir, { recursive: true, force: true });
});

test("product source blockers do not auto-close from passing source bugfix without semantic evidence", async () => {
  const dir = await tempDir();
  const batch = { number: 64, type: "implement", items: [progressItem("[DATA]", "Tenant data isolation — PRD §4")] } as any;
  await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "FAILURE", flags: ["TENANT_BOUNDARY_GAP"] }), agent: "validate" });
  const state = await importAgentResultToState(dir, batch, "bugfix", { ...implementResult({ agent: "bugfix", flags: ["NO_BLOCKING_FINDINGS"], filesChanged: ["src/tenant.ts"], tests: { regression: { command: "npm test", exitCode: 0, evidence: "generic green" } } }) });
  assert.deepEqual(blockingOpenFindings(state).map((finding) => finding.id), ["TENANT_BOUNDARY_GAP"]);
  await rm(dir, { recursive: true, force: true });
});

test("specific positive closure does not overreach shorter queue or business tokens", async () => {
  const dir = await tempDir();
  const batch = { number: 55, type: "implement", items: [progressItem("[JOB]", "Queue safety — PRD §7")] } as any;
  await importAgentResultToState(dir, batch, "validate", { ...implementResult({ status: "FAILURE", flags: ["TENANT_AWARE_QUEUE_NOT_WIRED", "BUSINESS_LOGIC_DRIFT_PAYMENT_AUTH"] }), agent: "validate" });
  const state = await importAgentResultToState(dir, batch, "bugfix", { ...implementResult({ agent: "bugfix", flags: ["ENTRYPOINT_VERIFIED_QUEUE", "BUSINESS_LOGIC_EVIDENCE_AUTH_PASS"], filesChanged: ["src/queue.ts"] }) });
  assert.deepEqual(blockingOpenFindings(state).map((finding) => finding.id).sort(), ["BUSINESS_LOGIC_DRIFT_PAYMENT_AUTH", "TENANT_AWARE_QUEUE_NOT_WIRED"]);
  await rm(dir, { recursive: true, force: true });
});

test("no findings flags are positive and non-blocking", () => {
  const state = recordGateState({ schemaVersion: 1, batch: 56, selectedItems: [], changedFiles: [], risk: { class: "low", reasons: [] }, currentResult: implementResult(), findings: [], commands: [], gates: {}, updatedAt: new Date().toISOString() }, [{ name: "audit", passed: true, flags: ["NO_FINDINGS", "NO_BLOCKING_FINDINGS"] }]);
  assert.deepEqual(blockingOpenFindings(state), []);
});

test("wiring verifier rejects implementation-only verifier files", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "worker.ts"), "export const tracking_email_parse = true;\n");
  const batch = { number: 57, type: "implement", items: [progressItem("[JOB]", "Tracking job — PRD §7")] } as any;
  const gate = await validateWiring(dir, batch, implementResult({ wiring: { required: true, entrypoints: [{ type: "job", path: "tracking_email_parse", verifiedBy: "src/worker.ts" }] } as any }), true);
  assert.equal(gate.passed, false);
  assert.ok(gate.flags.includes("ENTRYPOINT_VERIFIER_IMPLEMENTATION_ONLY:tracking_email_parse"));
  await rm(dir, { recursive: true, force: true });
});

test("business logic touched false cannot bypass business-tagged source changes", () => {
  const batch = { number: 58, type: "implement", items: [progressItem("[DATA]", "Payment rules — PRD §5")] } as any;
  const gate = validateBusinessLogic(batch, implementResult({ filesChanged: ["src/payment.ts"], businessLogic: { touched: false } as any }));
  assert.equal(gate.passed, false);
  assert.ok(gate.flags.includes("BUSINESS_LOGIC_UNTOUCHED_CONTRADICTS_BATCH_SCOPE"));
});

test("gatesPassed and canonical findings reject hard flags even when gate passed is true", () => {
  const gates = [{ name: "artifacts", passed: true, flags: ["ARTIFACT_MISSING:.yolo/tests/missing.mjs"] }];
  assert.equal(gatesPassed(gates), false);
  assert.equal(classifyGateFindings(gates).hardFailures.length, 1);
  const state = recordGateState({ schemaVersion: 1, batch: 49, selectedItems: [], changedFiles: [], risk: { class: "medium", reasons: [] }, currentResult: implementResult(), findings: [], commands: [], gates: {}, updatedAt: new Date().toISOString() }, gates);
  assert.deepEqual(blockingOpenFindings(state).map((finding) => finding.id), ["ARTIFACT_MISSING:.yolo/tests/missing.mjs"]);
});

test("positive gate fix flags close matching canonical findings when gates pass by positive evidence", () => {
  const base = { schemaVersion: 1 as const, batch: 50, selectedItems: [], changedFiles: [], risk: { class: "medium" as const, reasons: [] }, currentResult: implementResult(), findings: [], commands: [], gates: {}, updatedAt: new Date().toISOString() };
  const opened = recordGateState(base, [{ name: "wiring", passed: false, flags: ["ENTRYPOINT_UNVERIFIED:tenant-aware queue fairness"] }]);
  const gates = [{ name: "wiring", passed: false, flags: ["ENTRYPOINT_VERIFIED:tenant-aware queue fairness"] }];
  assert.equal(gatesPassed(gates), true);
  const closed = recordGateState(opened, gates);
  assert.deepEqual(blockingOpenFindings(closed), []);
});

test("passed warning-only gate reruns do not close existing hard findings", () => {
  const base = { schemaVersion: 1 as const, batch: 51, selectedItems: [], changedFiles: [], risk: { class: "low" as const, reasons: [] }, currentResult: implementResult(), findings: [], commands: [], gates: {}, updatedAt: new Date().toISOString() };
  const opened = recordGateState(base, [{ name: "frontend", passed: false, flags: ["IMPECCABLE_DETECTOR_FINDINGS:1"] }]);
  const next = recordGateState(opened, [{ name: "frontend", passed: true, flags: ["IMPECCABLE_DETECTOR_UNAVAILABLE:detector unavailable"] }]);
  assert.deepEqual(blockingOpenFindings(next).map((finding) => finding.id), ["IMPECCABLE_DETECTOR_FINDINGS:1"]);
});

test("negative runtime rejection flags remain blocking while business-rule rejected flags are non-blocking", async () => {
  const batch = { number: 36, type: "implement", items: [progressItem("[API]", "Reject invalid input — PRD §8")] } as any;
  const dir = await tempDir();
  const state = await importAgentResultToState(dir, batch, "validate", { ...implementResult({ flags: ["VALIDATOR_REJECTED", "SECURITY_REJECTED", "CROSS_ORDER_SUPPLIER_BUNDLING_REJECTED"] }), agent: "validate" });
  assert.deepEqual(blockingOpenFindings(state).map((finding) => finding.id).sort(), ["SECURITY_REJECTED", "VALIDATOR_REJECTED"]);
  await rm(dir, { recursive: true, force: true });
});

test("canonical state opens e2e setup-missing findings even when result claims success", async () => {
  const dir = await tempDir();
  const batch = { number: 1, type: "implement", items: [progressItem("[SETUP]", "Install frontend framework — PRD §3")] } as any;
  const result = implementResult({ flags: ["e2e_setup_missing:true"], tests: { e2e: { command: "not applicable", exitCode: 0, evidence: "E2E framework is not configured yet", required: true } } });
  const state = await importAgentResultToState(dir, batch, "implement", result);
  assert.deepEqual(blockingOpenFindings(state).map((finding) => finding.id), ["e2e_setup_missing:true"]);
  await rm(dir, { recursive: true, force: true });
});

test("runtime source uses canonical batch state and recovers open findings after green gates", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /importAgentResultToState/);
  assert.match(source, /recordGateState/);
  assert.match(source, /acquireRuntimeLock/);
  assert.match(source, /heartbeatRuntimeLock/);
  assert.match(source, /releaseRuntimeLock/);
  assert.match(source, /gatesPassed\(gates\) && openFindings\.length > 0/);
  assert.match(source, /recoverGateFailure\(cwd, lease\.cwd, batch, config, context, result, openFindings\.map/);
  assert.match(source, /const remainingFindings = blockingOpenFindings\(postFindingValidation\.state\)/);
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

test("config merge preserves intentional high and xhigh thinking overrides", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo"), { recursive: true });
  await writeFile(join(dir, ".yolo/runtime.config.json"), JSON.stringify({ schemaVersion: 1, models: { master: { thinking: "xhigh" }, validate: { thinking: "xhigh" }, bugfix: { thinking: "high" }, audit: { thinking: "high" }, adjudicate: { thinking: "xhigh" } } }));
  const config = await loadConfig(dir);
  assert.equal(config.models.master.thinking, "xhigh");
  assert.equal(config.models.validate.thinking, "xhigh");
  assert.equal(config.models.bugfix.thinking, "high");
  assert.equal(config.models.audit.thinking, "high");
  assert.equal(config.models.adjudicate.thinking, "xhigh");
  await rm(dir, { recursive: true, force: true });
});

test("config merge promotes stale generated medium judgment routes", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo"), { recursive: true });
  await writeFile(join(dir, ".yolo/runtime.config.json"), JSON.stringify({ schemaVersion: 1, models: { master: { thinking: "medium" }, validate: { thinking: "medium", budget: { staleMs: 1 } }, bugfix: { thinking: "medium" }, audit: { thinking: "medium" }, adjudicate: { thinking: "medium" }, implement: { thinking: "medium" } } }));
  const config = await loadConfig(dir);
  assert.equal(config.models.master.thinking, "xhigh");
  assert.equal(config.models.validate.thinking, "high");
  assert.equal(config.models.validate.budget?.staleMs, 1);
  assert.equal(config.models.bugfix.thinking, "high");
  assert.equal(config.models.audit.thinking, "xhigh");
  assert.equal(config.models.adjudicate.thinking, "xhigh");
  assert.equal(config.models.implement.thinking, "xhigh");
  await rm(dir, { recursive: true, force: true });
});

test("config merge preserves explicit medium when a project pins a custom model", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo"), { recursive: true });
  await writeFile(join(dir, ".yolo/runtime.config.json"), JSON.stringify({ schemaVersion: 1, models: { bugfix: { model: "local/debug-model", thinking: "medium" } } }));
  const config = await loadConfig(dir);
  assert.equal(config.models.bugfix.model, "local/debug-model");
  assert.equal(config.models.bugfix.thinking, "medium");
  await rm(dir, { recursive: true, force: true });
});

test("config merge preserves recovery defaults for older project configs", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo"), { recursive: true });
  await writeFile(join(dir, ".yolo/runtime.config.json"), JSON.stringify({ schemaVersion: 1, policy: { allowedGeneratedPaths: [] } }));
  const config = await loadConfig(dir);
  assert.equal(config.recovery?.maxBugfixAttempts, 2);
  assert.equal(config.recovery?.retryJournalOnce, true);
  assert.equal(config.recovery?.selfHealRuntime, true);
  assert.equal(config.recovery?.maxSelfHealAttempts, 1);
  assert.equal(config.recovery?.repairUnreadableRuntimeState, true);
  assert.equal(config.speed?.deterministicJournal, true);
  assert.equal(config.speed?.observeRisk, true);
  assert.equal(config.speed?.observeAffectedTests, true);
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

test("support workflow instructions prevent protected coordination files from becoming refactor deliverables", async () => {
  const prompt = await readPromptTemplate(process.cwd(), ".agent/agents/yolo/yolo-subagent-implement.md");
  assert.match(prompt, /Support\/refactor\/modularity\/audit sweeps MUST NOT edit, recreate, delete, or list template-managed protected coordination files as deliverables/);
  assert.match(prompt, /\.agent\/rules\/\*\*/);
  assert.match(prompt, /AGENTS\.md/);
  assert.match(prompt, /\.yolo\/runtime-state\.json/);
  assert.match(prompt, /secret files/);
});

test("composite support resume fixture accepts bugfix-only recovered artifacts while preserving blockers and full-scope identity", async () => {
  const dir = await tempDir();
  const worktree = join(dir, ".yolo/worktrees/batch-052");
  await mkdir(join(worktree, ".yolo/batch-results"), { recursive: true });
  await mkdir(join(dir, ".yolo/logs"), { recursive: true });
  const bugfix = implementResult({
    agent: "bugfix",
    batch: 52,
    itemsCompleted: ["Support modularity sweep — PRD N/A"],
    filesChanged: ["src/support/modularity.ts", "tests/runtime/support-modularity.test.ts", ".yolo/gates/bugfix-batch-052.md"],
    flags: ["MODULARITY_RULE_FILE_LIMIT_VIOLATION:.agent/rules/support-metadata.md", "CHANGED_FILE_MISSING_METADATA_REMOVED:.agent/rules/support-metadata.md", "ENTRYPOINT_VERIFIED_SUPPORT_MODULARITY", "BUSINESS_LOGIC_EVIDENCE_SUPPORT_PASS"],
    tests: { regression: { command: "npm test -- tests/runtime/support-modularity.test.ts", exitCode: 0, evidence: "support recovery passed" } }
  });
  await writeFile(join(worktree, ".yolo/batch-results/batch-052-bugfix-2.json"), JSON.stringify(bugfix));
  await writeFile(join(dir, ".yolo/logs/runtime-2026-06-06.log"), "Continuing original full YOLO scope after resumed batch.\nSelected batch 52: Support modularity sweep — PRD N/A\n");

  assert.equal(await pathExists(join(worktree, ".yolo/batch-results/batch-052-implement.json")), false);
  assert.equal(await readLatestSuccessfulBugfixResult(worktree, 52).then(Boolean), true);
  assert.deepEqual(await findLatestResumableBatch(dir), { batch: 52, worktree, requestedScope: "full" });

  const pathGate = validatePaths([".agent/agents/yolo/yolo-subagent-support.md", "src/support/modularity.ts"], defaultConfig);
  assert.deepEqual(pathGate.flags, ["TEMPLATE_MANAGED_PROTECTED_PATH:.agent/agents/yolo/yolo-subagent-support.md"]);
  const state = await importAgentResultToState(worktree, { number: 52, type: "implement", items: [progressItem("[SUPPORT]", "Support modularity sweep — PRD N/A")] } as any, "bugfix", bugfix);
  assert.equal(blockingOpenFindings(state).length, 0);
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

test("subagent runner converts stale tool timeouts into synthetic failure results", async () => {
  const source = await readFileText(join(process.cwd(), "src/subagent-runner.ts"));
  assert.match(source, /rm\(sessionFile, \{ force: true \}\)/);
  assert.match(source, /clearSubagentOutput\(invocation\.cwd, invocation\.outputBase\)/);
  assert.match(source, /staleToolTimeoutMs: budget\.staleMs/);
  assert.match(source, /isRecoverableAgentTimeout\(error\)/);
  assert.match(source, /writeSyntheticFailureResult\(invocation, error\)/);
  assert.match(source, /AGENT_STALE_TOOL_TIMEOUT/);
});

test("default model routes use xhigh reasoning for instruction-heavy implement roles without raising routine roles", () => {
  assert.equal(defaultConfig.models.master.thinking, "xhigh");
  assert.equal(defaultConfig.models.implement.thinking, "xhigh");
  assert.equal(defaultConfig.models.validate.thinking, "high");
  assert.equal(defaultConfig.models.bugfix.thinking, "high");
  assert.equal(defaultConfig.models.audit.thinking, "xhigh");
  assert.equal(defaultConfig.models.adjudicate.thinking, "xhigh");
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

test("bugfix recovery strips runtime-owned paths from recovered changed-file manifests", () => {
  const implementation = implementResult();
  implementation.filesChanged = ["src/main.ts", ".yolo/runtime/batches/batch-011/state.json"];
  const bugfix = implementResult({ agent: "bugfix" });
  bugfix.filesChanged = [".yolo/runtime/batches/batch-011/state.json", ".yolo/runtime-state.json", ".yolo/batch-results/batch-011-bugfix.json"];
  const recovered = mergeRecoveredResult(implementation, bugfix);
  assert.ok(recovered.filesChanged.includes("src/main.ts"));
  assert.ok(!recovered.filesChanged.includes(".yolo/runtime/batches/batch-011/state.json"));
  assert.ok(!recovered.filesChanged.includes(".yolo/runtime-state.json"));
  assert.ok(recovered.filesChanged.includes(".yolo/batch-results/batch-011-bugfix.json"));
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
  bugfix.filesChanged = ["src/features/import/importParser.ts"];
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

test("bugfix recovery preserves runnable passing evidence when later narrow bugfix marks checks not applicable", () => {
  const implementation = implementResult();
  implementation.tests = {
    green: { command: "npm run test:unit -- tenant.test.ts", exitCode: 0, evidence: "targeted tenant tests passed" },
    regression: { command: "npm test", exitCode: 0, evidence: "full suite passed" },
    e2e: { required: true, command: "npm run test:e2e", exitCode: 0, evidence: "4 Playwright tests passed over real HTTP" }
  };
  const bugfix = implementResult({ agent: "bugfix" });
  bugfix.tests = {
    green: { command: "not applicable", exitCode: 0, evidence: "docs-only bugfix" },
    regression: { command: "not applicable", exitCode: 0, evidence: "docs-only bugfix" },
    e2e: { required: false, command: "not applicable", exitCode: 0, evidence: "docs-only bugfix" }
  };
  const recovered = mergeRecoveredResult(implementation, bugfix);
  assert.equal(recovered.tests?.green?.command, "npm run test:unit -- tenant.test.ts");
  assert.equal(recovered.tests?.regression?.command, "npm test");
  assert.equal(recovered.tests?.e2e?.command, "npm run test:e2e");
  assert.equal(recovered.tests?.e2e?.required, true);
});

test("bugfix recovery preserves existing passing evidence when later bugfix evidence fails", () => {
  const implementation = implementResult();
  implementation.tests = {
    green: { command: "npm test", exitCode: 0, evidence: "green passed" },
    regression: { command: "npm run regression", exitCode: 0, evidence: "regression passed" },
    e2e: { required: true, command: "npm run e2e", exitCode: 0, evidence: "e2e passed" }
  };
  const bugfix = implementResult({ agent: "bugfix" });
  bugfix.tests = {
    green: { command: "npm test", exitCode: 1, evidence: "later narrow rerun failed" },
    regression: { command: "not applicable", exitCode: 0, evidence: "not runnable" },
    e2e: { required: false, command: "npm run e2e", exitCode: 1, evidence: "later e2e failed" }
  };
  const recovered = mergeRecoveredResult(implementation, bugfix);
  assert.equal(recovered.tests?.green?.command, "npm test");
  assert.equal(recovered.tests?.green?.exitCode, 0);
  assert.equal(recovered.tests?.regression?.command, "npm run regression");
  assert.equal(recovered.tests?.e2e?.command, "npm run e2e");
  assert.equal(recovered.tests?.e2e?.exitCode, 0);
  assert.equal(recovered.tests?.e2e?.required, true);
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

test("protected template-managed rule path blockers require human/tooling instead of bugfix", () => {
  const gates = [
    { name: "paths", passed: false, flags: ["TEMPLATE_MANAGED_PROTECTED_PATH:.agent/rules/CODING_STANDARDS.md"] },
    { name: "secrets", passed: false, flags: ["CHANGED_FILE_MISSING:.agent\\rules\\CODING_STANDARDS.md"] }
  ];
  const report = classifyGateFindings(gates);
  assert.deepEqual(report.hardFailures.map((finding) => finding.recommendedAction), ["human", "human"]);
  assert.equal(hasNonRecoverableRuntimeBlocker(gates.flatMap((gate) => gate.flags)), true);
});

test("missing protected blocked runtime-owned artifacts require human/tooling instead of repeated bugfix", () => {
  const gates = [
    { name: "artifacts", passed: false, flags: ["ARTIFACT_MISSING:.yolo/runtime/batches/batch-011/state.json"] },
    { name: "paths", passed: false, flags: ["CHANGED_FILE_MISSING:.env.local"] },
    { name: "wiring", passed: false, flags: ["WIRING_VERIFIER_FILE_MISSING:node_modules/pkg/index.js"] },
    { name: "artifacts", passed: false, flags: ["ARTIFACT_MISSING:src/product-fixture.json"] }
  ];
  const report = classifyGateFindings(gates);
  assert.deepEqual(report.hardFailures.map((finding) => finding.recommendedAction), ["human", "human", "human", "bugfix"]);
  assert.equal(hasNonRecoverableRuntimeBlocker(gates.slice(0, 3).flatMap((gate) => gate.flags)), true);
  assert.equal(hasNonRecoverableRuntimeBlocker([gates[3].flags[0]]), false);
});

test("warning-only advisory gates pass consistently across gate and finding classifiers", () => {
  const gates = [
    { name: "quality", passed: false, flags: ["QUALITY_WARNING:MOBILE_VIEWPORT_EVIDENCE_MISSING"] },
    { name: "support", passed: false, flags: ["FUTURE_PHASE_SUCCESS_CRITERIA_RECORDED_AS_MANUAL_NOT_FINDINGS"] },
    { name: "business-logic", passed: false, flags: ["BUSINESS_LOGIC_UNTOUCHED_DOCS"] },
    { name: "e2e", passed: false, flags: ["E2E_ATTEMPT_FAILED_NON_BLOCKING"] }
  ];
  assert.equal(gatesPassed(gates), true);
  const report = classifyGateFindings(gates);
  assert.equal(report.hardFailures.length, 0);
  assert.equal(report.warnings.length, 4);
});

test("support sync-context advisory flags for template rule modularity and removed metadata are non-blocking", async () => {
  const gates = [
    { name: "support", passed: false, flags: ["MODULARITY_RULE_FILE_LIMIT_VIOLATION:.agent/rules/CODING_STANDARDS_DOMAIN.md"] },
    { name: "secrets", passed: false, flags: ["CHANGED_FILE_MISSING_METADATA_REMOVED:.agent/rules/CODEBASE_CONTEXT.md"] }
  ];
  assert.equal(gatesPassed(gates), true);
  const report = classifyGateFindings(gates);
  assert.equal(report.hardFailures.length, 0);
  assert.equal(report.warnings.length, 1);
  assert.equal(report.ambiguities.length, 0);

  const dir = await tempDir();
  const batch = { number: 56, type: "support", items: [progressItem("[FIX]", "Sync template-managed runtime support rules — PRD N/A")] } as any;
  const state = await importAgentResultToState(dir, batch, "validate", { ...implementResult({ flags: gates.flatMap((gate) => gate.flags) }), agent: "validate" });
  assert.deepEqual(blockingOpenFindings(state), []);
  await rm(dir, { recursive: true, force: true });
});

test("source product and bare modularity and metadata flags remain blocking", () => {
  const gates = [
    { name: "support", passed: false, flags: ["MODULARITY_RULE_FILE_LIMIT_VIOLATION:src/services/oversized-service.ts"] },
    { name: "support", passed: false, flags: ["MODULARITY_RULE_FILE_LIMIT_VIOLATION"] },
    { name: "secrets", passed: false, flags: ["CHANGED_FILE_MISSING_METADATA_REMOVED:src/services/important.ts"] },
    { name: "secrets", passed: false, flags: ["CHANGED_FILE_MISSING_METADATA_REMOVED"] },
    { name: "support", passed: false, flags: ["MODULARITY_RULE_FILE_LIMIT_VIOLATION:src/CODING_STANDARDS_fixture.ts"] },
    { name: "secrets", passed: false, flags: ["CHANGED_FILE_MISSING_METADATA_REMOVED:src/sync-context-report.ts"] }
  ];
  assert.equal(gatesPassed(gates), false);
  const report = classifyGateFindings(gates);
  assert.deepEqual(report.hardFailures.map((finding) => finding.message), gates.flatMap((gate) => gate.flags));
});

test("runtime batch state closes recovered advisory support flags with explicit positive recovery evidence", async () => {
  const dir = await tempDir();
  const batch = { number: 56, type: "support", items: [progressItem("[FIX]", "Recover protected support artifacts — PRD N/A")] } as any;
  let state = await importAgentResultToState(dir, batch, "validate", {
    ...implementResult({ flags: ["MODULARITY_RULE_FILE_LIMIT_VIOLATION", "CHANGED_FILE_MISSING_METADATA_REMOVED"] }),
    agent: "validate"
  });
  state = await importAgentResultToState(dir, batch, "bugfix", {
    ...implementResult({
      filesChanged: [".yolo/batch-results/batch-056-bugfix.json", ".yolo/gates/bugfix-batch-056.md"],
      flags: ["MODULARITY_RULE_FILE_WARNING_ROUTED_NON_BLOCKING", "PROTECTED_PATH_METADATA_REMOVED", "MISSING_CHANGED_FILE_CLAIMS_RESOLVED"],
      tests: { regression: { command: "npm test", exitCode: 0 } as any }
    }),
    agent: "bugfix"
  }, state);
  assert.deepEqual(blockingOpenFindings(state), []);
  await rm(dir, { recursive: true, force: true });
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

test("command validator does not adopt bash result with nonzero exit text", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo/pi-sessions"), { recursive: true });
  const session = join(dir, ".yolo/pi-sessions/batch-002-implement.jsonl");
  await writeFile(session, [
    JSON.stringify({ message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } }] } }),
    JSON.stringify({ message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", isError: false, content: [{ type: "text", text: "Command exited with code 1" }] } })
  ].join("\n") + "\n");
  assert.equal(adoptedSessionCommandPassed(dir, "npm test"), false);
  await rm(dir, { recursive: true, force: true });
});

test("command validator treats mutating find and redirection as source mutations", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo/pi-sessions"), { recursive: true });
  const session = join(dir, ".yolo/pi-sessions/batch-003-implement.jsonl");
  await writeFile(session, [
    JSON.stringify({ message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } }] } }),
    JSON.stringify({ message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", isError: false, content: [{ type: "text", text: "passed" }] } }),
    JSON.stringify({ message: { role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "bash", arguments: { command: "find src -name '*.tmp' -delete" } }] } })
  ].join("\n") + "\n");
  assert.equal(adoptedSessionCommandPassed(dir, "npm test"), false);
  await writeFile(session, [
    JSON.stringify({ message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } }] } }),
    JSON.stringify({ message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", isError: false, content: [{ type: "text", text: "passed" }] } }),
    JSON.stringify({ message: { role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "bash", arguments: { command: "grep foo src/a.ts > src/generated.ts" } }] } })
  ].join("\n") + "\n");
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

test("command validator rejects prose parentheticals before shell rerun", async () => {
  const dir = await tempDir();
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.tests = {
    regression: {
      command: "node -e \"process.exit(0)\" (passes locally after retry)",
      exitCode: 0,
      evidence: "agent added prose to the command field"
    }
  };
  const gate = await validateCommandEvidence(dir, result, dir);
  assert.equal(gate.passed, false);
  assert.match(gate.flags[0] ?? "", /^COMMAND_RERUN_PROSE_PARENTHETICAL:regression:/);
  await rm(dir, { recursive: true, force: true });
});

test("command validator allows shell grouping parentheticals in rerun commands", async () => {
  const dir = await tempDir();
  const runtimeDir = join(dir, "tools", "klevar-yolo-runtime");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(join(runtimeDir, "package.json"), JSON.stringify({
    scripts: {
      typecheck: "node -e \"process.exit(0)\"",
      test: "node -e \"process.exit(0)\""
    }
  }));
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.tests = {
    regression: {
      command: "node -e \"process.exit(0)\" && (cd tools/klevar-yolo-runtime && npm run typecheck && npm test) && node -e \"process.exit(0)\"",
      exitCode: 0,
      evidence: "runtime command reruns nested tooling checks through a shell group"
    }
  };
  const gate = await validateCommandEvidence(dir, result, dir);
  assert.equal(gate.passed, true);
  assert.deepEqual(gate.flags, []);
  await rm(dir, { recursive: true, force: true });
});

test("command validator reports missing host binaries without spending rerun budget", async () => {
  const dir = await tempDir();
  const missing = "klevar-definitely-missing-binary-xyz";
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.tests = {
    regression: {
      command: `${missing} --version`,
      exitCode: 0,
      evidence: "agent claimed local binary existed"
    }
  };
  const gate = await validateCommandEvidence(dir, result, dir);
  assert.equal(gate.passed, false);
  assert.deepEqual(gate.flags, [`COMMAND_RERUN_MISSING_HOST_BINARY:regression:${missing}:${missing} --version`]);
  await rm(dir, { recursive: true, force: true });
});

test("command validator treats empty inline env assignments as missing required env, not host binaries", async () => {
  const dir = await tempDir();
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.tests = {
    regression: {
      command: "TEST_DATABASE_URL= node -e \"process.exit(0)\"",
      exitCode: 0,
      evidence: "agent left a required database URL blank"
    }
  };
  const gate = await validateCommandEvidence(dir, result, dir);
  assert.equal(gate.passed, false);
  assert.deepEqual(gate.flags, ["COMMAND_RERUN_MISSING_REQUIRED_ENV:regression:TEST_DATABASE_URL:empty-assignment:TEST_DATABASE_URL= node -e \"process.exit(0)\""]);
  assert.ok(!gate.flags.some((flag) => flag.includes("MISSING_HOST_BINARY")));
  await rm(dir, { recursive: true, force: true });
});

test("command validator hydrates required dev env from official local env files", async () => {
  const dir = await tempDir();
  await writeFile(join(dir, ".env.local"), "DATABASE_URL=postgres://placeholder:placeholder@localhost:5432/dev\nJWT_SECRET=local-dev-secret\n");
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.tests = {
    regression: {
      command: "TEST_DATABASE_URL= node -e \"process.exit(process.env.TEST_DATABASE_URL ? 0 : 1)\"",
      exitCode: 0,
      evidence: "runtime can hydrate TEST_DATABASE_URL from local DATABASE_URL for dev reruns"
    }
  };
  const gate = await validateCommandEvidence(dir, result, dir);
  assert.equal(gate.passed, true);
  await rm(dir, { recursive: true, force: true });
});

test("command validator strips non-required empty env assignments before host-binary detection", async () => {
  const dir = await tempDir();
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.tests = {
    regression: {
      command: "CI= node -e \"process.exit(0)\"",
      exitCode: 0,
      evidence: "empty non-required env assignments can be intentional command modifiers"
    }
  };
  const gate = await validateCommandEvidence(dir, result, dir);
  assert.equal(gate.passed, true);
  await rm(dir, { recursive: true, force: true });
});

test("command validator rejects required env placeholders when the referenced host env is unset or empty", async () => {
  const dir = await tempDir();
  const envName = "KLEVAR_TEST_REQUIRED_DATABASE_URL_PLACEHOLDER";
  const previous = process.env[envName];
  delete process.env[envName];
  const result = journalResult({ journal_entry_written: true, gate_file_written: true });
  result.tests = {
    regression: {
      command: `TEST_DATABASE_URL=$${envName} node -e "process.exit(0)"`,
      exitCode: 0,
      evidence: "agent referenced a required database URL from the host environment"
    }
  };
  const gate = await validateCommandEvidence(dir, result, dir);
  assert.equal(gate.passed, false);
  assert.deepEqual(gate.flags, [`COMMAND_RERUN_MISSING_REQUIRED_ENV:regression:TEST_DATABASE_URL:unset-placeholder:${envName}:TEST_DATABASE_URL=$${envName} node -e "process.exit(0)"`]);
  process.env[envName] = "   ";
  const emptyGate = await validateCommandEvidence(dir, result, dir);
  assert.equal(emptyGate.passed, false);
  assert.deepEqual(emptyGate.flags, gate.flags);
  if (previous === undefined) delete process.env[envName];
  else process.env[envName] = previous;
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

test("validator scheduler skips expensive gates after cheap blockers outside safe mode", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo"), { recursive: true });
  await writeFile(join(dir, ".yolo/expensive-probe.js"), "const fs=require('fs'); fs.writeFileSync('.yolo/expensive-count','1');\n");
  const result = implementResult({ tests: { green: { command: "node .yolo/expensive-probe.js", exitCode: 0, evidence: "probe" } } });
  const batch = { number: 1, type: "implement", items: [progressItem("[SETUP]", "Speed lane — PRD §3")] } as any;
  const { gates } = await validateAllWithState(dir, batch, result, defaultConfig, dir);
  assert.ok(gates.some((gate) => gate.name === "progress-contract" && !gate.passed && gate.flags.includes("MISSING_PROGRESS_MD")));
  assert.deepEqual(gates.find((gate) => gate.name === "command-rerun"), {
    name: "command-rerun",
    passed: false,
    flags: ["SKIPPED_EXPENSIVE_GATE_DUE_TO_CHEAP_BLOCKERS:progress-contract|tdd"]
  });
  assert.equal(await pathExists(join(dir, ".yolo/expensive-count")), false);
  const runtimeState = JSON.parse(await readFileText(join(dir, ".yolo/runtime-state.json"))) as { speed?: { validators?: Record<string, { status: string }> } };
  assert.equal(runtimeState.speed?.validators?.["command-rerun"]?.status, "skipped");
  await rm(dir, { recursive: true, force: true });
});

test("validator scheduler safe mode still runs expensive gates for complete diagnostics", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo"), { recursive: true });
  await writeFile(join(dir, ".yolo/expensive-probe.js"), "const fs=require('fs'); fs.writeFileSync('.yolo/expensive-count','1');\n");
  const result = implementResult({ tests: { green: { command: "node .yolo/expensive-probe.js", exitCode: 0, evidence: "probe" } } });
  const batch = { number: 1, type: "implement", items: [progressItem("[SETUP]", "Speed lane — PRD §3")] } as any;
  const config = { ...defaultConfig, validationMode: "safe" as const };
  const { gates } = await validateAllWithState(dir, batch, result, config, dir);
  assert.ok(gates.some((gate) => gate.name === "progress-contract" && !gate.passed));
  assert.equal(gates.find((gate) => gate.name === "command-rerun")?.passed, true);
  assert.equal(await readFileText(join(dir, ".yolo/expensive-count")), "1");
  await rm(dir, { recursive: true, force: true });
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
  const runtimeState = JSON.parse(await readFileText(join(dir, ".yolo/runtime-state.json"))) as { speed?: { commands?: Array<{ status: string; provenance: string }> } };
  assert.ok(runtimeState.speed?.commands?.some((entry) => entry.provenance === "cache" && entry.status === "recorded"));
  assert.ok(runtimeState.speed?.commands?.some((entry) => entry.provenance === "cache" && entry.status === "hit"));
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

test("bugfix recovery keeps stale-missing paths that the bugfix actually recreates", () => {
  const implementation = journalResult({ journal_entry_written: true, gate_file_written: true });
  implementation.filesChanged = ["src/foo.ts"];
  implementation.flags = ["CHANGED_FILE_MISSING:src/foo.ts"];
  const bugfix = journalResult({ journal_entry_written: true, gate_file_written: true });
  bugfix.agent = "bugfix";
  bugfix.filesChanged = ["src/foo.ts", ".yolo/batch-results/batch-001-bugfix.json"];
  bugfix.flags = ["CHANGED_FILE_MISSING:src/foo.ts fixed by recreating the file."];
  const recovered = mergeRecoveredResult(implementation, bugfix);
  assert.ok(recovered.filesChanged.includes("src/foo.ts"));
});

test("bugfix recovery ignores source manifest rewrites for unrelated batch numbers", () => {
  const implementation = journalResult({ journal_entry_written: true, gate_file_written: true });
  implementation.batch = 12;
  implementation.filesChanged = ["src/real.ts"];
  const bugfix = journalResult({ journal_entry_written: true, gate_file_written: true });
  bugfix.agent = "bugfix";
  bugfix.batch = 12;
  bugfix.filesChanged = [".yolo/batch-results/batch-999-implement.json"];
  const recovered = mergeRecoveredResult(implementation, bugfix);
  assert.ok(recovered.filesChanged.includes("src/real.ts"));
});

test("bugfix recovery preserves implementation when claimed corrected manifest is invalid", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo/batch-results"), { recursive: true });
  const implementation = journalResult({ journal_entry_written: true, gate_file_written: true });
  implementation.batch = 12;
  implementation.agent = "implement";
  implementation.filesChanged = ["src/real.ts"];
  const bugfix = journalResult({ journal_entry_written: true, gate_file_written: true });
  bugfix.agent = "bugfix";
  bugfix.batch = 12;
  bugfix.filesChanged = [".yolo/batch-results/batch-012-implement.json", ".yolo/batch-results/batch-012-bugfix.json"];
  await writeFile(join(dir, ".yolo/batch-results/batch-012-implement.json"), "{ invalid json");
  const recovered = await mergeRecoveredResultFromDisk(dir, 12, implementation, bugfix);
  assert.ok(recovered.filesChanged.includes("src/real.ts"));
  await rm(dir, { recursive: true, force: true });
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
  bugfix.filesChanged = ["tests/race-repro.test.ts"];
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

test("bugfix recovery does not replace implementation RED with artifact-only bugfix RED", () => {
  const implementation = journalResult({ journal_entry_written: true, gate_file_written: true });
  implementation.tests = {
    red: { command: "npm test -- supplier", exitCode: 1, evidence: "Initial feature RED failed before implementation" },
    green: { command: "npm test -- supplier", exitCode: 0, evidence: "targeted green" },
    regression: { command: "npm test", exitCode: 0, evidence: "full suite green" }
  };
  implementation.flags = ["RED evidence used initial schema/export failure before final green corrections"];
  const bugfix = journalResult({ journal_entry_written: true, gate_file_written: true });
  bugfix.agent = "bugfix";
  bugfix.filesChanged = [".yolo/gates/bugfix-batch-027-contract.mjs", ".yolo/batch-results/batch-027-bugfix.json"];
  bugfix.tests = {
    red: { command: "node .yolo/gates/bugfix-batch-027-contract.mjs", exitCode: 1, evidence: "artifact contract missing before bugfix" },
    green: { command: "node .yolo/gates/bugfix-batch-027-contract.mjs", exitCode: 0, evidence: "artifact contract passed" },
    regression: { command: "npm test", exitCode: 0, evidence: "full suite green" }
  };
  bugfix.flags = ["RUNTIME_GATES_REJECTED_RECOVERED", "BUSINESS_LOGIC_DRIFT_FIXED"];
  const recovered = mergeRecoveredResult(implementation, bugfix);
  assert.equal(recovered.tests?.red?.command, "npm test -- supplier");
  assert.ok(!recovered.flags.includes("BUSINESS_LOGIC_DRIFT_FIXED"));
  assert.ok(!recovered.flags.includes("RECOVERED_SOURCE_FLAG:RED evidence used initial schema/export failure before final green corrections"));
});

test("artifact-only bugfix recovery preserves evidence pass flags when commands prove runtime recovery", () => {
  const implementation = journalResult({ journal_entry_written: true, gate_file_written: true });
  implementation.failureType = "RUNTIME_GATES_REJECTED";
  implementation.flags = ["BUSINESS_LOGIC_DRIFT_APPEND_ONLY_NOTELOG_OVERWRITE", "BUSINESS_LOGIC_DRIFT_TENANT_FAIRNESS_DROPS_RATE_LIMITED_JOBS"];
  const bugfix = journalResult({ journal_entry_written: true, gate_file_written: true });
  bugfix.agent = "bugfix";
  bugfix.filesChanged = [".yolo/batch-results/batch-045-bugfix-2.json", ".yolo/gates/bugfix-batch-045.md"];
  bugfix.flags = ["BUSINESS_LOGIC_EVIDENCE_APPEND_ONLY_NOTELOG_PASS", "BUSINESS_LOGIC_EVIDENCE_TENANT_FAIRNESS_DELAYED_REQUEUE_PASS", "BUSINESS_LOGIC_DRIFT_FIXED"];
  bugfix.tests = { green: { command: "npm run test:unit -- tests/setup/batch-045-runtime-contract.vitest.ts", exitCode: 0, evidence: "artifact recovery contract passed" } };
  const recovered = mergeRecoveredResult(implementation, bugfix);
  assert.ok(recovered.flags.includes("BUSINESS_LOGIC_EVIDENCE_APPEND_ONLY_NOTELOG_PASS"));
  assert.ok(recovered.flags.includes("BUSINESS_LOGIC_EVIDENCE_TENANT_FAIRNESS_DELAYED_REQUEUE_PASS"));
  assert.ok(!recovered.flags.includes("BUSINESS_LOGIC_DRIFT_FIXED"));
});

test("artifact-only bugfix recovery cannot replace business wiring or local-only evidence", () => {
  const implementation = journalResult({ journal_entry_written: true, gate_file_written: true });
  implementation.businessLogic = {
    rule: "Supplier orders remain tenant-scoped and canonical status is the source of truth.",
    sourceOfTruth: "PRD §4.7 and §8b",
    observablePaths: ["packages/db/prisma/schema.prisma", "apps/web/app/api/supplier-orders/route.ts"],
    test: "tests/setup/supplier-operations.vitest.ts"
  };
  implementation.wiring = {
    required: true,
    entrypoints: [{ type: "http-route", path: "POST /api/supplier-orders", verifiedBy: "tests/e2e/api/supplier-operations.spec.ts" }]
  };
  implementation.localOnlyFiles = ["apps/web/.next/"];
  const bugfix = journalResult({ journal_entry_written: true, gate_file_written: true });
  bugfix.agent = "bugfix";
  bugfix.filesChanged = [".yolo/gates/bugfix-batch-027-contract.mjs", ".yolo/batch-results/batch-027-bugfix.json"];
  bugfix.businessLogic = {
    rule: "TDD recovery artifacts are structured.",
    sourceOfTruth: ".agent/agents/yolo/yolo-honesty-checks.md",
    observablePaths: [".yolo/batch-results/batch-027-bugfix.json"],
    test: ".yolo/gates/bugfix-batch-027-contract.mjs"
  };
  bugfix.wiring = { required: false, entrypoints: [] };
  bugfix.localOnlyFiles = [];
  const recovered = mergeRecoveredResult(implementation, bugfix);
  assert.equal(recovered.businessLogic?.rule, implementation.businessLogic.rule);
  assert.deepEqual(recovered.wiring?.entrypoints, implementation.wiring.entrypoints);
  assert.deepEqual(recovered.localOnlyFiles, ["apps/web/.next/"]);
});

test("semantic bugfix recovery can update business wiring and local-only evidence", () => {
  const implementation = journalResult({ journal_entry_written: true, gate_file_written: true });
  implementation.businessLogic = {
    rule: "Original supplier invariant.",
    sourceOfTruth: "PRD §4.7",
    observablePaths: ["packages/db/prisma/schema.prisma"],
    test: "tests/setup/supplier-operations.vitest.ts"
  };
  implementation.wiring = { required: true, entrypoints: [{ type: "http-route", path: "POST /api/supplier-orders", verifiedBy: "old test" }] };
  implementation.localOnlyFiles = ["apps/web/.next/"];
  const bugfix = journalResult({ journal_entry_written: true, gate_file_written: true });
  bugfix.agent = "bugfix";
  bugfix.filesChanged = ["apps/web/app/api/supplier-orders/route.ts", "tests/e2e/api/supplier-operations.spec.ts"];
  bugfix.businessLogic = {
    rule: "Supplier orders remain tenant-scoped and status transitions are canonical after fix.",
    sourceOfTruth: "PRD §4.7 and §8b",
    observablePaths: ["apps/web/app/api/supplier-orders/route.ts"],
    test: "tests/e2e/api/supplier-operations.spec.ts"
  };
  bugfix.wiring = { required: true, entrypoints: [{ type: "http-route", path: "PATCH /api/supplier-orders/:id/status", verifiedBy: "tests/e2e/api/supplier-operations.spec.ts" }] };
  bugfix.localOnlyFiles = [];
  const recovered = mergeRecoveredResult(implementation, bugfix);
  assert.equal(recovered.businessLogic?.rule, bugfix.businessLogic.rule);
  assert.deepEqual(recovered.wiring?.entrypoints?.map((entry) => entry.path).sort(), ["PATCH /api/supplier-orders/:id/status", "POST /api/supplier-orders"]);
  assert.deepEqual(recovered.localOnlyFiles, []);
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

test("stale validation contradiction does not accept business logic drift fixed by unrelated pass flags", () => {
  const recovered = implementResult({ flags: ["AUTH_BOUNDARY_GAP_FIXED", "REGRESSION_PASS"], tests: { e2e: { command: "npm run test:e2e", exitCode: 0, evidence: "passed", required: true } } });
  const bugfix = implementResult({ agent: "bugfix", flags: ["AUTH_BOUNDARY_GAP_FIXED", "E2E_PASS"], tests: { green: { command: "npm test", exitCode: 0, evidence: "auth fixed" } } });
  const validation = implementResult({ agent: "validate", status: "FAILURE", failureType: "BUSINESS_LOGIC_DRIFT", flags: ["BUSINESS_LOGIC_DRIFT"] });
  assert.equal(validationFailureContradictedByRecoveredEvidence(validation, recovered, bugfix), false);
});

test("stale validation contradiction accepts explicitly related commercial recovered gap flags", () => {
  const recovered = implementResult({ flags: ["COMMERCIAL_MARGIN_EVIDENCE_RECOVERED", "FULL_TEST_SUITE_PASS"], tests: { e2e: { command: "npm run test:e2e", exitCode: 0, evidence: "commercial margin browser proof passed", required: true } } });
  const bugfix = implementResult({ agent: "bugfix", flags: ["COMMERCIAL_MARGIN_EVIDENCE_RECOVERED", "FULL_TEST_SUITE_PASS"], tests: { green: { command: "npm test", exitCode: 0, evidence: "commercial margin fixed" } } });
  const validation = implementResult({ agent: "validate", status: "FAILURE", failureType: "COMMERCIAL_MARGIN_EVIDENCE_GAP", flags: ["COMMERCIAL_MARGIN_EVIDENCE_GAP"] });
  assert.equal(validationFailureContradictedByRecoveredEvidence(validation, recovered, bugfix), true);

  bugfix.flags = ["AUTH_BOUNDARY_GAP_FIXED", "FULL_TEST_SUITE_PASS"];
  assert.equal(validationFailureContradictedByRecoveredEvidence(validation, recovered, bugfix), false);
});

test("recovered source flags remain non-blocking after repeated recovery merges", () => {
  const nested = "RECOVERED_SOURCE_FLAG:RECOVERED_SOURCE_FLAG:REPLAY_EXPECTED_TOTALS_EVIDENCE_GAP_RECOVERED";
  assert.equal(isPositiveFlag(nested), true);
  assert.equal(isBlockingFlag(nested), false);
});

test("preserved flags are accepted as positive closure evidence", () => {
  assert.equal(isPositiveFlag("UI_MODIFIED_ACTIONS_PRESERVED"), true);
  assert.equal(fixedFindingPrefix("UI_MODIFIED_ACTIONS_PRESERVED"), "UI_MODIFIED_ACTIONS");
});

test("bugfix recovery can replace corrected implementation manifest fields", () => {
  const implementation = journalResult({ journal_entry_written: true, gate_file_written: true });
  implementation.batch = 12;
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

test("local-only sync rejects unsafe and excluded paths", async () => {
  const root = await tempDir();
  const worktree = await tempDir();
  await mkdir(join(worktree, "tmp"), { recursive: true });
  await writeFile(join(worktree, "tmp/report.txt"), "report");
  await assert.rejects(() => syncLocalOnlyFilesToRoot(worktree, root, ["../escape.txt"]), /LOCAL_ONLY_PATH_UNSAFE/);
  await assert.rejects(() => syncLocalOnlyFilesToRoot(worktree, root, [".git/config"]), /LOCAL_ONLY_PATH_UNSAFE/);
  assert.deepEqual(await syncLocalOnlyFilesToRoot(worktree, root, ["tmp/report.txt"]), ["tmp/report.txt"]);
  await rm(root, { recursive: true, force: true });
  await rm(worktree, { recursive: true, force: true });
});

test("worktree sync rejects protected coordination paths instead of copying declared deliverables", async () => {
  const root = await tempDir();
  const worktree = await tempDir();
  await mkdir(join(worktree, ".agent/rules"), { recursive: true });
  await writeFile(join(worktree, ".agent/rules/CODING_STANDARDS.md"), "mutated");
  await writeFile(join(worktree, "AGENTS.md"), "mutated");
  await execCommand("git init && git config user.email test@example.com && git config user.name Test", worktree, 30_000);
  await assert.rejects(() => syncWorktreeChangesToRoot(worktree, root, [".agent/rules/CODING_STANDARDS.md", "AGENTS.md"]), /WORKTREE_SYNC_REJECTED_PROTECTED_PATH:.agent\/rules\/CODING_STANDARDS.md,AGENTS.md/);
  const gate = await validateWorktreeMergeReadiness(worktree, root, [".agent/rules/CODING_STANDARDS.md"]);
  assert.equal(gate.passed, false);
  assert.match(gate.flags.join("\n"), /WORKTREE_SYNC_REJECTED_PROTECTED_PATH/);
  await rm(worktree, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

test("worktree sync ignores stale protected coordination candidates when content matches root", async () => {
  const root = await tempDir();
  const worktree = await tempDir();
  await mkdir(join(root, ".agent/rules"), { recursive: true });
  await mkdir(join(worktree, ".agent/rules"), { recursive: true });
  await mkdir(join(worktree, "docs"), { recursive: true });
  await writeFile(join(root, ".agent/rules/CODING_STANDARDS.md"), "canonical");
  await writeFile(join(worktree, ".agent/rules/CODING_STANDARDS.md"), "canonical");
  await writeFile(join(worktree, "docs/progress.md"), "initial");
  await execCommand("git init && git config user.email test@example.com && git config user.name Test && git add . && git commit -m init", worktree, 30_000);
  await writeFile(join(worktree, "docs/progress.md"), "done");
  const gate = await validateWorktreeMergeReadiness(worktree, root, [".agent/rules/CODING_STANDARDS.md", "docs/progress.md"]);
  assert.equal(gate.passed, true, gate.flags.join("\n"));
  const synced = await syncWorktreeChangesToRoot(worktree, root, [".agent/rules/CODING_STANDARDS.md", "docs/progress.md"]);
  assert.deepEqual(synced, ["docs/progress.md"]);
  assert.equal(await readFile(join(root, "docs/progress.md"), "utf8"), "done");
  await rm(worktree, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
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
  await mkdir(join(worktree, "src/jobs"), { recursive: true });
  await writeFile(join(worktree, "src/jobs/worker.txt"), "job");
  await writeFile(join(worktree, "docs/build-journal/001-batch.md"), "journal changed");
  await writeFile(join(worktree, ".yolo/gates/journal-batch-001.md"), "gate changed");
  await mkdir(join(worktree, ".yolo/batch-results"), { recursive: true });
  await mkdir(join(worktree, ".yolo/knowledge-packs"), { recursive: true });
  await mkdir(join(worktree, ".yolo/runtime/batches/batch-001"), { recursive: true });
  await mkdir(join(worktree, ".yolo/subagent-events"), { recursive: true });
  await mkdir(join(worktree, "tools/klevar-yolo-runtime/src"), { recursive: true });
  await writeFile(join(worktree, ".yolo/batch-results/batch-001-validate.json"), "{}");
  await writeFile(join(worktree, ".yolo/gates/validate-prd.md"), "validate");
  await writeFile(join(worktree, ".yolo/knowledge-packs/batch-001.json"), "{}");
  await writeFile(join(worktree, ".yolo/runtime/batches/batch-001/state.json"), "{}");
  await writeFile(join(worktree, ".yolo/subagent-events/events.jsonl"), "{}");
  await writeFile(join(worktree, ".yolo/command-cache.json"), "{}");
  await writeFile(join(worktree, "tools/klevar-yolo-runtime/package.json"), "{}");
  await writeFile(join(worktree, "tools/klevar-yolo-runtime/src/runtime.ts"), "runtime");
  await writeFile(join(worktree, ".env.local"), "local=true");
  const synced = await syncWorktreeChangesToRoot(worktree, root, ["src/app.txt", "src/new.txt", "src/jobs/worker.txt", "docs/build-journal/001-batch.md", ".github/workflows/ci.yml", ".git/hooks/pre-commit", ".yolo/gates/journal-batch-001.md", "tools/klevar-yolo-runtime/src/runtime.ts"]);
  const localSynced = await syncLocalOnlyFilesToRoot(worktree, root, [".env.local"]);
  assert.ok(synced.includes("src/app.txt"));
  assert.ok(synced.includes("src/new.txt"));
  assert.ok(synced.includes("src/jobs/worker.txt"));
  assert.ok(synced.includes("docs/build-journal/001-batch.md"));
  assert.ok(synced.includes(".github/workflows/ci.yml"));
  assert.ok(!synced.includes(".git/hooks/pre-commit"));
  assert.ok(synced.includes(".yolo/gates/journal-batch-001.md"));
  assert.ok(synced.includes("tools/klevar-yolo-runtime/src/runtime.ts"));
  assert.equal(await readFileText(join(root, "src/app.txt")), "changed");
  assert.deepEqual(localSynced, [".env.local"]);
  assert.equal(await readFileText(join(root, "docs/build-journal/001-batch.md")), "journal changed");
  assert.equal(await readFileText(join(root, ".github/workflows/ci.yml")), "ci");
  assert.equal(existsSync(join(root, ".git/hooks/pre-commit")), false);
  assert.equal(await readFileText(join(root, ".env.local")), "local=true");
  await rm(root, { recursive: true, force: true });
  await rm(worktree, { recursive: true, force: true });
});

test("worktree sync ignores declared runtime-owned control-plane paths", async () => {
  const root = await tempDir();
  const worktree = await tempDir();
  await mkdir(join(worktree, ".yolo/runtime/batches/batch-001"), { recursive: true });
  await writeFile(join(worktree, ".yolo/runtime/batches/batch-001/state.json"), "{}");
  await writeFile(join(worktree, ".yolo/runtime-state.json"), "{}");
  await execCommand("git init && git config user.email test@example.com && git config user.name Test", worktree, 30_000);
  const synced = await syncWorktreeChangesToRoot(worktree, root, [".yolo/runtime/batches/batch-001/state.json", ".yolo/runtime-state.json"]);
  assert.deepEqual(synced, []);
  assert.equal(existsSync(join(root, ".yolo/runtime/batches/batch-001/state.json")), false);
  assert.equal(existsSync(join(root, ".yolo/runtime-state.json")), false);
  await rm(root, { recursive: true, force: true });
  await rm(worktree, { recursive: true, force: true });
});

test("merge-readiness gate reports undeclared material changes without copying", async () => {
  const root = await tempDir();
  const worktree = await tempDir();
  await mkdir(join(worktree, "src"), { recursive: true });
  await writeFile(join(worktree, "src/declared.txt"), "declared");
  await execCommand("git init && git config user.email test@example.com && git config user.name Test && git add . && git commit -m init", worktree, 30_000);
  await writeFile(join(worktree, "src/declared.txt"), "declared changed");
  await writeFile(join(worktree, "src/undeclared.txt"), "undeclared material");
  const gate = await validateWorktreeMergeReadiness(worktree, root, ["src/declared.txt"]);
  assert.equal(gate.passed, false);
  assert.match(gate.flags.join("\n"), /MERGE_READINESS_FAILED:WORKTREE_CHANGED_FILES_UNDECLARED:src\/undeclared.txt/);
  assert.equal(existsSync(join(root, "src/declared.txt")), false);
  await rm(root, { recursive: true, force: true });
  await rm(worktree, { recursive: true, force: true });
});

test("merge-readiness gate ignores undeclared generated drift and accepts declared directories", async () => {
  const root = await tempDir();
  const worktree = await tempDir();
  await mkdir(join(worktree, "src/features"), { recursive: true });
  await mkdir(join(worktree, "apps/web/.next/cache"), { recursive: true });
  await writeFile(join(worktree, "src/features/route.ts"), "base");
  await writeFile(join(worktree, "apps/web/.next/cache/meta.json"), "generated");
  await execCommand("git init && git config user.email test@example.com && git config user.name Test && git add . && git commit -m init", worktree, 30_000);
  await writeFile(join(worktree, "src/features/route.ts"), "semantic change");
  await writeFile(join(worktree, "apps/web/.next/cache/meta.json"), "generated drift");
  const gate = await validateWorktreeMergeReadiness(worktree, root, ["src/features/"]);
  assert.equal(gate.passed, true, gate.flags.join("\n"));
  await rm(root, { recursive: true, force: true });
  await rm(worktree, { recursive: true, force: true });
});

test("merge-readiness gate allows identical dirty root source and blocks divergent source", async () => {
  const root = await tempDir();
  const worktree = await tempDir();
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/app.txt"), "old");
  await execCommand("git init && git config user.email test@example.com && git config user.name Test && git add . && git commit -m init", root, 30_000);
  await writeFile(join(root, "src/app.txt"), "same change");
  await mkdir(join(worktree, "src"), { recursive: true });
  await writeFile(join(worktree, "src/app.txt"), "old");
  await execCommand("git init && git config user.email test@example.com && git config user.name Test && git add . && git commit -m init", worktree, 30_000);
  await writeFile(join(worktree, "src/app.txt"), "same change");
  const identical = await validateWorktreeMergeReadiness(worktree, root, ["src/app.txt"]);
  assert.equal(identical.passed, true, identical.flags.join("\n"));
  await writeFile(join(worktree, "src/app.txt"), "different worktree change");
  const divergent = await validateWorktreeMergeReadiness(worktree, root, ["src/app.txt"]);
  assert.equal(divergent.passed, false);
  assert.match(divergent.flags.join("\n"), /ROOT_DIRTY_PATH_CONFLICT:src\/app.txt/);
  await rm(root, { recursive: true, force: true });
  await rm(worktree, { recursive: true, force: true });
});

test("merge-readiness gate allows runtime artifact conflicts and blocks source conflicts", async () => {
  const root = await tempDir();
  const worktree = await tempDir();
  await mkdir(join(root, ".yolo/gates"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, ".yolo/gates/e2e-batch-001.md"), "dirty root gate");
  await writeFile(join(root, "src/app.txt"), "root");
  await execCommand("git init && git config user.email test@example.com && git config user.name Test && git add . && git commit -m init", root, 30_000);
  await writeFile(join(root, ".yolo/gates/e2e-batch-001.md"), "dirty root gate changed");
  await writeFile(join(root, "src/app.txt"), "dirty root source");
  await mkdir(join(worktree, ".yolo/gates"), { recursive: true });
  await mkdir(join(worktree, "src"), { recursive: true });
  await writeFile(join(worktree, ".yolo/gates/e2e-batch-001.md"), "worktree gate base");
  await execCommand("git init && git config user.email test@example.com && git config user.name Test && git add . && git commit -m init", worktree, 30_000);
  await writeFile(join(worktree, ".yolo/gates/e2e-batch-001.md"), "worktree gate");
  const gateOnly = await validateWorktreeMergeReadiness(worktree, root, [".yolo/gates/e2e-batch-001.md"]);
  assert.equal(gateOnly.passed, true);
  await writeFile(join(worktree, "src/app.txt"), "worktree source");
  const sourceConflict = await validateWorktreeMergeReadiness(worktree, root, ["src/app.txt"]);
  assert.equal(sourceConflict.passed, false);
  assert.match(sourceConflict.flags.join("\n"), /ROOT_DIRTY_PATH_CONFLICT:src\/app.txt/);
  await rm(root, { recursive: true, force: true });
  await rm(worktree, { recursive: true, force: true });
});

test("runtime source runs merge-readiness before journal in normal and continue flows", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /runMergeReadinessGate\(cwd, lease\.cwd, batch, config, batchState, result\)/);
  assert.match(source, /runMergeReadinessGate\(cwd, worktree, batch, config, batchState, result\)/);
  assert.ok(source.indexOf("runMergeReadinessGate(cwd, lease.cwd") < source.indexOf("reuseOrRunJournalAgent(cwd, lease.cwd"));
  assert.ok(source.indexOf("runMergeReadinessGate(cwd, worktree") < source.indexOf("reuseOrRunJournalAgent(cwd, worktree"));
});

test("incident replay fixtures cover runtime-only recovery metadata", async () => {
  const fixture = await tempDir();
  const implementation = implementResult();
  implementation.filesChanged = ["src/main.ts", ".yolo/runtime/batches/batch-011/state.json"];
  const bugfix = implementResult({ agent: "bugfix" });
  bugfix.filesChanged = [".yolo/runtime/batches/batch-011/state.json", ".yolo/batch-results/batch-011-bugfix.json"];
  await writeFile(join(fixture, "scenario.json"), JSON.stringify({
    kind: "recovery-merge",
    implementation,
    bugfix,
    expectedFilesChanged: ["src/main.ts", ".yolo/batch-results/batch-011-bugfix.json"],
    forbiddenFilesChanged: [".yolo/runtime/batches/batch-011/state.json"]
  }, null, 2));
  const result = await replayIncidentFixture(fixture);
  assert.equal(result.passed, true);
  await rm(fixture, { recursive: true, force: true });
});

test("release gate fails closed when required acceptance surfaces are missing", async () => {
  const root = await tempDir();
  const result = await runReleaseGate({ root, skipSandbox: true });
  assert.equal(result.passed, false);
  assert.match(formatReleaseGateResult(result), /FAIL release\/stabilization gate/);
  assert.match(formatReleaseGateResult(result), /Release gate failed closed/);
  assert.ok(result.steps.some((step) => step.name === "runtime npm test" && step.status === "fail"));
  assert.ok(result.steps.some((step) => step.name === "pi package npm test" && step.status === "fail"));
  assert.ok(result.steps.some((step) => step.name === "incident replay suite" && step.status === "fail"));
  await rm(root, { recursive: true, force: true });
});

test("poisoned-batch incident fixture captures state logs results gates and worktree status", async () => {
  const root = await tempDir();
  const worktree = join(root, ".yolo/worktrees/batch-004");
  await mkdir(join(root, ".yolo/logs"), { recursive: true });
  await mkdir(join(root, ".yolo/batch-results"), { recursive: true });
  await mkdir(join(root, ".yolo/gates"), { recursive: true });
  await mkdir(join(worktree, ".yolo/batch-results"), { recursive: true });
  await mkdir(join(worktree, ".yolo/gates"), { recursive: true });
  await writeFile(join(root, ".yolo/runtime-state.json"), JSON.stringify({ batch: 4, status: "failed", worktree }, null, 2));
  await writeFile(join(root, ".yolo/logs/runtime-2026-06-07.log"), "runtime failure log");
  await writeFile(join(root, ".yolo/batch-results/batch-004-implement.json"), "{\"status\":\"FAILURE\"}");
  await writeFile(join(root, ".yolo/gates/tdd-batch-004.md"), "FAIL");
  await writeFile(join(worktree, ".yolo/batch-results/batch-004-bugfix.json"), "{\"status\":\"FAILURE\"}");
  await writeFile(join(worktree, ".yolo/gates/bugfix-batch-004.md"), "FAIL");
  await execCommand("git init && git config user.email test@example.com && git config user.name Test && git add . && git commit -m init", worktree, 30_000);
  await writeFile(join(worktree, "changed.txt"), "dirty");
  const fixture = await capturePoisonedBatchIncidentFixture(root, { number: 4, type: "implement", items: [] }, implementResult({ status: "FAILURE", failureType: "RUNTIME_GATES_REJECTED" }), ["RUNTIME_GATES_REJECTED"]);
  const manifest = JSON.parse(await readFileText(fixture.manifestPath));
  assert.equal(manifest.kind, "poisoned-batch-exit");
  assert.ok(fixture.copied.some((file) => file.includes("runtime-state.json")));
  assert.ok(fixture.copied.some((file) => file.includes("runtime-2026-06-07.log")));
  assert.ok(fixture.copied.some((file) => file.includes("batch-004-implement.json")));
  assert.ok(fixture.copied.some((file) => file.includes("tdd-batch-004.md")));
  assert.ok(fixture.copied.some((file) => file.startsWith("worktreeResults/.yolo__worktrees__batch-004__")));
  assert.ok(fixture.copied.every((file) => !file.includes(".yolo/worktrees/")), fixture.copied.join("\n"));
  assert.ok(fixture.copied.includes("worktree-status.txt"));
  assert.match(await readFileText(join(fixture.dir, "worktree-status.txt")), /changed\.txt/);
  await rm(root, { recursive: true, force: true });
});

test("known live runtime incident fixtures replay expected classifications", async () => {
  const fixturesRoot = join(process.cwd(), "src/__fixtures__/incidents");
  const fixtureNames = [
    "billbee-b056-protected-path-stale-metadata",
    "billbee-b065-plan-rejected-support-loop",
    "commercial-b016-stale-recovery-poisoned-exit",
    "field-service-undeclared-changed-files",
    "trade-compliance-runtime-only-path-leakage"
  ];
  assert.deepEqual((await readdir(fixturesRoot)).filter((name) => fixtureNames.includes(name)).sort(), fixtureNames.sort());
  for (const fixtureName of fixtureNames) {
    const result = await replayIncidentFixture(join(fixturesRoot, fixtureName));
    assert.equal(result.passed, true, `${fixtureName}\n${result.details.join("\n")}`);
  }
});

test("incident replay fixtures cover undeclared material worktree sync failures", async () => {
  const fixture = await tempDir();
  const root = join(fixture, "root");
  const worktree = join(fixture, "worktree");
  await mkdir(join(worktree, "src"), { recursive: true });
  await mkdir(root, { recursive: true });
  await writeFile(join(worktree, "src/declared.txt"), "declared");
  await execCommand("git init && git config user.email test@example.com && git config user.name Test && git add . && git commit -m init", worktree, 30_000);
  await writeFile(join(worktree, "src/declared.txt"), "declared changed");
  await writeFile(join(worktree, "src/undeclared.txt"), "undeclared material change");
  await writeFile(join(fixture, "scenario.json"), JSON.stringify({
    kind: "worktree-sync",
    candidatePaths: ["src/declared.txt"],
    expectedErrorIncludes: "WORKTREE_CHANGED_FILES_UNDECLARED:src/undeclared.txt"
  }, null, 2));
  const result = await replayIncidentFixture(fixture);
  assert.equal(result.passed, true, result.details.join("\n"));
  await rm(fixture, { recursive: true, force: true });
});

test("worktree sync allows runtime-owned root artifact conflicts but blocks source conflicts", async () => {
  const root = await tempDir();
  const worktree = await tempDir();
  await mkdir(join(root, ".yolo/batch-results"), { recursive: true });
  await mkdir(join(root, ".yolo/gates"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, ".yolo/batch-results/batch-014-implement.json"), "old");
  await writeFile(join(root, ".yolo/gates/e2e-batch-014.md"), "old");
  await writeFile(join(root, "src/app.txt"), "old");
  await execCommand("git init && git config user.email test@example.com && git config user.name Test && git add . && git commit -m init", root, 30_000);
  await writeFile(join(root, ".yolo/batch-results/batch-014-implement.json"), "dirty root");
  await writeFile(join(root, ".yolo/gates/e2e-batch-014.md"), "dirty root");

  await mkdir(join(worktree, ".yolo/batch-results"), { recursive: true });
  await mkdir(join(worktree, ".yolo/gates"), { recursive: true });
  await mkdir(join(worktree, "src"), { recursive: true });
  await writeFile(join(worktree, ".yolo/batch-results/batch-014-implement.json"), "old");
  await writeFile(join(worktree, ".yolo/gates/e2e-batch-014.md"), "old");
  await writeFile(join(worktree, "src/app.txt"), "old");
  await execCommand("git init && git config user.email test@example.com && git config user.name Test && git add . && git commit -m init", worktree, 30_000);
  await writeFile(join(worktree, ".yolo/batch-results/batch-014-implement.json"), "worktree");
  await writeFile(join(worktree, ".yolo/gates/e2e-batch-014.md"), "worktree");

  const synced = await syncWorktreeChangesToRoot(worktree, root, [".yolo/batch-results/batch-014-implement.json", ".yolo/gates/e2e-batch-014.md"]);
  assert.deepEqual(synced.sort(), [".yolo/batch-results/batch-014-implement.json", ".yolo/gates/e2e-batch-014.md"].sort());
  assert.equal(await readFileText(join(root, ".yolo/batch-results/batch-014-implement.json")), "worktree");

  await writeFile(join(worktree, "src/app.txt"), "worktree");
  await writeFile(join(root, "src/app.txt"), "dirty root source");
  await assert.rejects(() => syncWorktreeChangesToRoot(worktree, root, ["src/app.txt"]), /ROOT_DIRTY_PATH_CONFLICT:src\/app\.txt/);
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

test("cli help path keeps runtime modules lazy before argument parsing", async () => {
  const source = await readFileText(join(process.cwd(), "src/cli.ts"));
  assert.doesNotMatch(source, /^import \{[^\n]+\} from "\.\/(runtime|telemetry|agent-session|config|recovery|replay|release-gate|worktree-retention)\.js";/m);
  assert.match(source, /if \(args\.includes\("--help"\) \|\| args\.includes\("-h"\)\) \{\n    console\.log\(helpText\(\)\);\n    return;\n  \}/);
  assert.match(source, /await import\("\.\/runtime\.js"\)/);
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
  for (let i = 0; i < 55; i += 1) {
    await writeFile(join(dir, "README.md"), `x\ny\n${i}`);
    await execCommand(`git add . && git commit -m filler-${i}`, dir, 30_000);
  }
  assert.equal(await completedBatchCommitExists(dir, 11), true);
  assert.equal(await completedBatchCommitExists(dir, 12), false);
  await rm(dir, { recursive: true, force: true });
});

test("runtime lock acquisition is reentrant for same process continuation", async () => {
  const dir = await tempDir();
  const first = acquireRuntimeLock(dir, "continue");
  assert.equal(first.ok, true);
  const second = acquireRuntimeLock(dir, "full");
  assert.equal(second.ok, true);
  releaseRuntimeLock(dir);
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

test("continue path can infer latest resumable audit worktree after state loss", async () => {
  const dir = await tempDir();
  const worktree = join(dir, ".yolo/worktrees/batch-018");
  await mkdir(join(worktree, ".yolo/batch-results"), { recursive: true });
  await writeFile(join(worktree, ".yolo/batch-results/batch-018-audit.json"), JSON.stringify({ schemaVersion: 1, agent: "audit", batch: 18, status: "SUCCESS", itemsCompleted: [], filesChanged: [], flags: [] }));
  const inferred = await findLatestResumableBatch(dir);
  assert.equal(inferred?.batch, 18);
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

test("continue path recovers open canonical findings even when gates pass", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /Continuing from existing worktree result/);
  assert.match(source, /gatesPassed\(gates\) && openFindings\.length > 0/);
  assert.match(source, /recoverGateFailure\(cwd, worktree, batch, config, context, result, openFindings\.map/);
  assert.match(source, /const remainingFindings = blockingOpenFindings\(postFindingValidation\.state\)/);
});

test("parallel runtime rejects shards with open canonical findings even when gates pass", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /const openFindingFlags: string\[\] = \[\]/);
  assert.match(source, /PARALLEL_\$\{shard\}_OPEN_FINDING:\$\{finding\.id\}/);
  assert.match(source, /failed\.length \|\| openFindingFlags\.length/);
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

test("continue path can reuse existing valid journal retry artifacts", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /reuseOrRunJournalAgent/);
  assert.match(source, /Reusing existing valid journal artifacts/);
  assert.match(source, /batch-\$\{padded\}-journal-retry\.json/);
});

test("continue path merges bugfix results in numeric attempt order", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /sort\(\(a, b\) => bugfixJsonOrder\(a\) - bugfixJsonOrder\(b\)/);
  assert.match(source, /function bugfixJsonOrder/);
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
  assert.match(source, /const openFindings = blockingOpenFindings\(validation\.state\)/);
  assert.match(source, /gatesPassed\(gates\) && openFindings\.length === 0/);
  assert.match(source, /openFindings\.map\(\(finding\) => finding\.id\)/);
});

test("runtime source treats protected path blockers as non-recoverable before bugfix dispatch", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /requiresHumanSecurityApproval\(flags\) \|\| hasNonRecoverableRuntimeBlocker\(flags\)/);
  assert.match(source, /hasNonRecoverableRuntimeBlocker\(currentFlags\)/);
  assert.match(source, /requires human\/security approval or tooling intervention/);
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
  assert.match(source, /const recoveryFlags = blockingRecoveryFlags\(currentFlags, currentValidation\.failureType\)/);
  assert.match(source, /runBugfixAgent\(rootCwd, cwd, batch, config, context, currentValidation, recoveryFlags, totalAttempts\)/);
});

test("bugfix recovery signatures ignore runtime recovery meta flags", () => {
  const signature = failureSignature(["RUNTIME_GATES_REJECTED_RECOVERED", "BUGFIX_RECOVERY_APPLIED", "RECOVERED_FROM:RUNTIME_GATES_REJECTED", "RED evidence used initial schema/export failure before final green corrections"], "VALIDATOR_REJECTED");
  assert.equal(signature, "RED evidence used initial schema/export failure before final green corrections|VALIDATOR_REJECTED");
});

test("runtime batch findings ignore runtime recovery meta flags", async () => {
  const dir = await tempDir();
  const batch = { number: 27, type: "implement" as const, items: [{ tag: "[API]", title: "Supplier operations", raw: "- [ ] [API] Supplier operations", phase: "Phase 1", checked: false }] };
  const result = implementResult({ agent: "bugfix", flags: ["RUNTIME_GATES_REJECTED_RECOVERED", "BUGFIX_RECOVERY_APPLIED"] });
  const state = await importAgentResultToState(dir, batch, "bugfix", result);
  assert.deepEqual(blockingOpenFindings(state), []);
  await rm(dir, { recursive: true, force: true });
});

test("canonical state closes retained positive recovered flags instead of counting them open", async () => {
  const dir = await tempDir();
  const batch = { number: 28, type: "implement" as const, items: [{ tag: "[API]", title: "Supplier operations", raw: "- [ ] [API] Supplier operations", phase: "Phase 1", checked: false }] };
  const previous = {
    schemaVersion: 1 as const,
    batch: 28,
    selectedItems: [],
    changedFiles: [],
    risk: { class: "medium" as const, reasons: [] },
    currentResult: implementResult(),
    findings: [{ id: "COMMERCIAL_MARGIN_EVIDENCE_RECOVERED", source: "bugfix", status: "open" as const, evidence: [], lastCheckedAt: new Date().toISOString() }],
    commands: [],
    gates: {},
    updatedAt: new Date().toISOString()
  };
  const state = await importAgentResultToState(dir, batch, "implement", implementResult({ flags: ["BUSINESS_LOGIC_DRIFT_MARGIN"] }), previous);
  assert.equal(state.findings.find((finding) => finding.id === "COMMERCIAL_MARGIN_EVIDENCE_RECOVERED")?.status, "fixed");
  assert.deepEqual(blockingOpenFindings(state).map((finding) => finding.id), ["BUSINESS_LOGIC_DRIFT_MARGIN"]);
  await rm(dir, { recursive: true, force: true });
});

test("passing runtime-only recovery quarantines stale runtime-owned findings but preserves product blockers", async () => {
  const dir = await tempDir();
  const batch = { number: 65, type: "implement" as const, items: [{ tag: "[API]", title: "Supplier operations", raw: "- [ ] [API] Supplier operations", phase: "Phase 1", checked: false }] };
  const opened = recordGateState({ schemaVersion: 1, batch: 65, selectedItems: [], changedFiles: [], risk: { class: "high", reasons: [] }, currentResult: implementResult(), findings: [], commands: [], gates: {}, updatedAt: new Date().toISOString() }, [
    { name: "contract", passed: false, flags: ["ARTIFACT_MISSING:.yolo/gates/bugfix-batch-065.md", "PLAN_REJECTED: missing runtime gate artifact .yolo/gates/bugfix-batch-065.md", "BUSINESS_LOGIC_DRIFT_PAYMENT_AUTH"] }
  ]);
  const recovered = await importAgentResultToState(dir, batch, "bugfix", implementResult({
    agent: "bugfix",
    filesChanged: [".yolo/batch-results/batch-065-bugfix.json", ".yolo/gates/bugfix-batch-065.md"],
    tests: { green: { command: "npm test -- tests/runtime/recovery-contract.test.ts", exitCode: 0, evidence: "runtime recovery contract passed" } },
    flags: ["RUNTIME_GATES_REJECTED_RECOVERED", "BUGFIX_RECOVERY_APPLIED"]
  }), opened);
  assert.deepEqual(blockingOpenFindings(recovered).map((finding) => finding.id), ["BUSINESS_LOGIC_DRIFT_PAYMENT_AUTH"]);
  assert.deepEqual(recovered.findings.filter((finding) => finding.status === "stale").map((finding) => finding.id).sort(), ["ARTIFACT_MISSING:.yolo/gates/bugfix-batch-065.md", "PLAN_REJECTED: missing runtime gate artifact .yolo/gates/bugfix-batch-065.md"]);
  await rm(dir, { recursive: true, force: true });
});

test("runtime-owned recovery signatures are capped cumulatively across successful recovery loops", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /const attemptsByRuntimeOwnedSignature = new Map<string, number>\(\);/);
  assert.match(source, /previousRuntimeOwnedAttempts >= attempts/);
  assert.match(source, /attemptsByRuntimeOwnedSignature\.set\(currentSignature, previousRuntimeOwnedAttempts \+ 1\)/);
  assert.equal(isRuntimeOwnedRecoverySignature("RUNTIME_GATES_REJECTED|CONTRACT_SCHEMA_MISMATCH"), true);
  assert.equal(isRuntimeOwnedRecoverySignature("VALIDATOR_REJECTED|BUGFIX_RESULT_INVALID|CONTRACT_SCHEMA_MISMATCH"), true);
  assert.equal(isRuntimeOwnedRecoverySignature("BUSINESS_LOGIC_DRIFT|CUSTOMER_NOTE_ALLOWLIST_GAP"), false);
});

test("bugfix recovery signatures ignore positive and advisory validation flags", () => {
  const noisy = [
    "ALREADY_IMPLEMENTED_VERIFIED: Phase surfaces were present but progress proof was missing before the fix.",
    "TENANT_NEUTRALITY_SWEEP_NO_LEAKS: no leakage or missing tenant secrets found",
    "PRIVACY_MATRIX_NOT_APPLICABLE: privacy gap missing by design",
    "BUNDLE_DYNAMIC_IMPORT_AUDIT_EVIDENCE_RECORDED: missing bundle proof recorded as N/A",
    "FUTURE_PHASE_SUCCESS_CRITERIA_RECORDED_AS_MANUAL_NOT_FINDINGS",
    "CROSS_ORDER_SUPPLIER_BUNDLING_REJECTED: invalid bundling correctly rejected",
    "RECOVERED_SOURCE_FLAG:BUSINESS_LOGIC_DRIFT",
    "CUSTOMER_NOTE_ALLOWLIST_GAP",
    "REGRESSION_PASS",
    "E2E_PASS",
    "TENANT_NEUTRALITY_SWEEP_PASS",
    "FRONTEND_IMPECCABLE_AUDIT_PASS",
    "AUTH_BOUNDARY_GAP_FIXED",
    "ROUTE_INVENTORY_MEDIUM_FINDING",
    "BUSINESS_LOGIC_DRIFT"
  ];
  assert.deepEqual(blockingRecoveryFlags(noisy, "BUSINESS_LOGIC_DRIFT").sort(), ["BUSINESS_LOGIC_DRIFT", "CUSTOMER_NOTE_ALLOWLIST_GAP"]);
  assert.equal(failureSignature(noisy, "BUSINESS_LOGIC_DRIFT"), "BUSINESS_LOGIC_DRIFT|CUSTOMER_NOTE_ALLOWLIST_GAP");
});

test("gate recovery exhaustion returns explicit terminal stop condition flags", async () => {
  const flags = ["BUSINESS_LOGIC_DRIFT", "COMMERCIAL_RULE_MISSING:discount-threshold"];
  const signature = failureSignature(flags, "RUNTIME_GATES_REJECTED");
  const exhausted = recoveryAttemptsExhausted(16, signature, flags, 2, 2);
  assert.equal(exhausted.code, "RECOVERY_ATTEMPTS_EXHAUSTED");
  assert.equal(exhausted.signature, "BUSINESS_LOGIC_DRIFT|COMMERCIAL_RULE_MISSING:discount-threshold|RUNTIME_GATES_REJECTED");
  assert.deepEqual(exhausted.flags.sort(), ["BUSINESS_LOGIC_DRIFT", "COMMERCIAL_RULE_MISSING:discount-threshold", "RUNTIME_GATES_REJECTED"].sort());
  assert.equal(exhausted.attemptsPerSignature, 2);
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /RECOVERY_ATTEMPTS_EXHAUSTED/);
  assert.match(source, /recoveryAttemptsExhausted\(batch\.number, currentSignature, currentFlags, attempts, totalAttempts\)/);
  assert.match(source, /RECOVERY_SIGNATURE:\$\{exhausted\.signature\}/);
});

test("runtime poisoned recovery loop classifies repeated runtime-owned signature after successful bugfix", () => {
  const flags = ["ARTIFACT_MISSING:.yolo/gates/bugfix-batch-056.md", "CONTRACT_FAILURE"];
  const signature = failureSignature(flags, "RUNTIME_GATES_REJECTED");
  const poisoned = runtimePoisonedRecoveryLoop(signature, flags, "RUNTIME_GATES_REJECTED");
  assert.equal(poisoned?.code, "RUNTIME_POISONED_RECOVERY_LOOP");
  assert.equal(poisoned?.signature, signature);
  assert.ok(poisoned?.flags.includes("ARTIFACT_MISSING:.yolo/gates/bugfix-batch-056.md"));
});

test("poisoned incident capture is limited to poisoned or runtime-owned failures", () => {
  assert.equal(shouldCapturePoisonedBatchIncidentFixture(["BUSINESS_LOGIC_DRIFT_MARGIN", "CUSTOMER_NOTE_ALLOWLIST_GAP"], "BUSINESS_LOGIC_DRIFT"), false);
  assert.equal(shouldCapturePoisonedBatchIncidentFixture(["RUNTIME_POISONED_RECOVERY_LOOP", "BUSINESS_LOGIC_DRIFT_MARGIN"], "BUSINESS_LOGIC_DRIFT"), true);
  assert.equal(shouldCapturePoisonedBatchIncidentFixture(["ARTIFACT_MISSING:.yolo/gates/bugfix-batch-056.md", "CONTRACT_FAILURE"], "RUNTIME_GATES_REJECTED"), true);
});

test("runtime poisoned recovery loop treats repeated plan rejection as runtime-owned", () => {
  const flags = ["PLAN_REJECTED: missing runtime gate artifact .yolo/gates/bugfix-batch-065.md"];
  const signature = failureSignature(flags, "PLAN_REJECTED");
  const poisoned = runtimePoisonedRecoveryLoop(signature, flags, "PLAN_REJECTED");
  assert.equal(poisoned?.code, "RUNTIME_POISONED_RECOVERY_LOOP");
  assert.equal(poisoned?.signature, signature);
});

test("runtime poisoned recovery loop does not trigger for product source blockers", () => {
  const flags = ["BUSINESS_LOGIC_DRIFT", "ENTRYPOINT_UNVERIFIED:POST /api/orders"];
  const signature = failureSignature(flags, "VALIDATOR_REJECTED");
  assert.equal(runtimePoisonedRecoveryLoop(signature, flags, "VALIDATOR_REJECTED"), null);
});

test("runtime poisoned recovery loop is primary terminal UX instead of ordinary rejection", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /flags\.includes\("RUNTIME_POISONED_RECOVERY_LOOP"\)/);
  assert.match(source, /runtimePoisonedRecommendation\(batch\.number/);
  assert.match(source, /shouldCapturePoisonedBatchIncidentFixture\(flags, result\.failureType\)/);
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

test("protected coordination modularity findings stop before bugfix recovery", () => {
  const flags = [
    "PROTECTED_COORDINATION_FILE_MODULARITY_FINDING",
    "TOOLING_HUMAN_REQUIRED_SYNC_CONTEXT",
    "NO_PRODUCTION_SOURCE_REFACTOR"
  ];
  assert.equal(hasNonRecoverableRuntimeBlocker(flags), true);
  assert.deepEqual(blockingRecoveryFlags(flags, "PLAN_REJECTED").sort(), [
    "PLAN_REJECTED",
    "PROTECTED_COORDINATION_FILE_MODULARITY_FINDING",
    "TOOLING_HUMAN_REQUIRED_SYNC_CONTEXT"
  ]);
  assert.equal(runtimeOwnedFailureRequiresStop(failureSignature(flags, "PLAN_REJECTED")), true);
});

test("runtime-owned plan rejection and stale runtime artifacts stop before product bugfix dispatch", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /runtimeOwnedFailureRequiresStop\(nextSignature\)[\s\S]{0,420}return null/);
  assert.match(source, /runtimeOwnedFailureRequiresStop\(nextSignature\)[\s\S]{0,420}return \{ result: null, flags: blockingRecoveryFlags/);
  assert.doesNotMatch(source, /runtimeOwnedFailureRequiresStop\(nextSignature\)[\s\S]{0,260}runBugfixAgent/);
  assert.equal(runtimeOwnedFailureRequiresStop(failureSignature(["PLAN_REJECTED: missing runtime gate artifact .yolo/gates/bugfix-batch-065.md"], "PLAN_REJECTED")), true);
  assert.equal(runtimeOwnedFailureRequiresStop(failureSignature(["ARTIFACT_MISSING:.yolo/gates/bugfix-batch-065.md"], "RUNTIME_GATES_REJECTED")), true);
});

test("product source blockers remain bugfix recoverable", () => {
  const productSignature = failureSignature(["BUSINESS_LOGIC_DRIFT_PAYMENT_AUTH", "ENTRYPOINT_UNVERIFIED:src/routes/payments.ts"], "VALIDATOR_REJECTED");
  assert.equal(isRuntimeOwnedRecoverySignature(productSignature), false);
  assert.equal(runtimeOwnedFailureRequiresStop(productSignature), false);
  assert.equal(hasNonRecoverableRuntimeBlocker(["ARTIFACT_MISSING:src/product-fixture.json"]), false);
});

test("continue path merges existing successful bugfix results", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /mergeExistingBugfixResults/);
  assert.match(source, /canonicalBugfixResultName\(entry, padded\)/);
  assert.match(source, /mergeRecoveredResultFromDisk\(worktree, batchNumber, recovered, bugfix\)/);
});

test("continue path reconstructs missing implementation result from latest successful bugfix", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo/batch-results"), { recursive: true });
  await writeFile(join(dir, ".yolo/batch-results/batch-052-bugfix.json"), JSON.stringify(implementResult({ agent: "bugfix", batch: 52, status: "FAILURE", failureType: "RUNTIME_GATES_REJECTED" })));
  await writeFile(join(dir, ".yolo/batch-results/batch-052-bugfix-2.json"), JSON.stringify(implementResult({ agent: "bugfix", batch: 52, status: "SUCCESS", filesChanged: ["src/old.ts"] })));
  await writeFile(join(dir, ".yolo/batch-results/batch-052-bugfix-3.json"), JSON.stringify(implementResult({ agent: "bugfix", batch: 52, status: "SUCCESS", filesChanged: ["src/fixed.ts"], itemsCompleted: ["Fixed resumable batch"] })));
  const recovered = await readLatestSuccessfulBugfixResult(dir, 52);
  assert.equal(recovered?.status, "SUCCESS");
  assert.deepEqual(recovered?.filesChanged, ["src/fixed.ts"]);
  assert.deepEqual(recovered?.itemsCompleted, ["Fixed resumable batch"]);
  await rm(dir, { recursive: true, force: true });
});

test("continue path rejects non-canonical bugfix artifact names during missing result reconstruction", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo/batch-results"), { recursive: true });
  await writeFile(join(dir, ".yolo/batch-results/batch-052-bugfix-copy.json"), JSON.stringify(implementResult({ agent: "bugfix", batch: 52, status: "SUCCESS", filesChanged: ["src/wrong-name.ts"] })));
  await writeFile(join(dir, ".yolo/batch-results/batch-052-bugfix-2.json"), JSON.stringify(implementResult({ agent: "bugfix", batch: 52, status: "SUCCESS", filesChanged: ["src/canonical.ts"] })));
  const recovered = await readLatestSuccessfulBugfixResult(dir, 52);
  assert.deepEqual(recovered?.filesChanged, ["src/canonical.ts"]);
  await rm(dir, { recursive: true, force: true });
});

test("continue path rejects wrong-agent bugfix artifacts during missing result reconstruction", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo/batch-results"), { recursive: true });
  await writeFile(join(dir, ".yolo/batch-results/batch-052-bugfix-2.json"), JSON.stringify(implementResult({ agent: "implement", batch: 52, status: "SUCCESS", filesChanged: ["src/wrong-agent.ts"] })));
  await writeFile(join(dir, ".yolo/batch-results/batch-052-bugfix-3.json"), JSON.stringify(implementResult({ agent: "bugfix", batch: 52, status: "SUCCESS", filesChanged: ["src/canonical.ts"] })));
  const recovered = await readLatestSuccessfulBugfixResult(dir, 52);
  assert.deepEqual(recovered?.filesChanged, ["src/canonical.ts"]);
  await rm(dir, { recursive: true, force: true });
});

test("continue path rejects wrong-batch bugfix artifacts during missing result reconstruction", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo/batch-results"), { recursive: true });
  await writeFile(join(dir, ".yolo/batch-results/batch-052-bugfix-2.json"), JSON.stringify(implementResult({ agent: "bugfix", batch: 51, status: "SUCCESS", filesChanged: ["src/wrong-batch.ts"] })));
  await writeFile(join(dir, ".yolo/batch-results/batch-052-bugfix-3.json"), JSON.stringify(implementResult({ agent: "bugfix", batch: 52, status: "SUCCESS", filesChanged: ["src/canonical.ts"] })));
  const recovered = await readLatestSuccessfulBugfixResult(dir, 52);
  assert.deepEqual(recovered?.filesChanged, ["src/canonical.ts"]);
  await rm(dir, { recursive: true, force: true });
});

test("continue path validates claims previous gates missing artifacts and progress item identity", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /verifyPreviousBatchGates\(cwd, batchNumber\)/);
  assert.match(source, /const claimGate = await prepareRuntimeClaim\(cwd, config, batch\)/);
  assert.match(source, /readLatestSuccessfulBugfixResult\(worktree, batchNumber\)/);
  assert.match(source, /MISSING_RESUMABLE_RESULT_ARTIFACT/);
  assert.match(source, /batchMatchesResultItems\(batch, result\)/);
  assert.match(source, /RESUME_PROGRESS_ITEM_MISMATCH/);
  assert.match(source, /result\.status === "INVALID_RESULT"/);
});

test("continue path resumes existing worktree against persisted batch identity instead of fresh progress selection", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /progressItemsFromPersistedSelection\(state\.selectedItems\)/);
  assert.match(source, /progressItemsFromPersistedSelection\(result\.itemsCompleted\)/);
  assert.match(source, /result items do not match persisted batch identity/);
  assert.match(source, /result\.agent === "bugfix" && result\.batch === batchNumber/);
  assert.match(source, /canonicalBugfixResultName/);
  assert.doesNotMatch(source, /result items do not match current progress selection/);
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

test("runtime state and events record version and refresh proof metadata", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".klevar"), { recursive: true });
  await writeFile(join(dir, ".klevar/project.json"), JSON.stringify({ templateRuntimeSyncedAt: "2026-06-08T00:00:00.000Z" }));
  await resetRuntimeState(dir, 2, "full");
  const state = JSON.parse(await readFile(join(dir, ".yolo/runtime-state.json"), "utf8")) as { runtimeMetadata?: Record<string, string> };
  assert.equal(state.runtimeMetadata?.runtimeVersion, "0.1.0");
  assert.equal(state.runtimeMetadata?.stateHygieneRevision, "2026-06-07-trusted-state-hygiene");
  assert.equal(state.runtimeMetadata?.templateRuntimeSyncedAt, "2026-06-08T00:00:00.000Z");
  assert.match(state.runtimeMetadata?.runtimeSourceVersion ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(state.runtimeMetadata?.piPackageVersion, "0.1.0");
  const events = await readFile(join(dir, ".yolo/events/batch-002.jsonl"), "utf8");
  assert.match(events, /"type":"runtime_version_proof"/);
  assert.match(events, /"stateHygieneRevision":"2026-06-07-trusted-state-hygiene"/);
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
  assert.equal(shouldNotifyRuntimeFinish({ cwd: "C:/Users/harri/AppData/Local/Temp/klevar-yolo-test-abc123", status: "failed", batch: 1, phase: "failed", message: "Runtime crashed" }, env), false);
  assert.equal(shouldNotifyRuntimeFinish({ cwd: "C:/Users/harri/AppData/Local/Temp/klevar-yolo-test-abc123", status: "failed", batch: 1, phase: "failed", message: "Runtime crashed" }, { ...env, KLEVAR_TELEGRAM_NOTIFY_TESTS: "1" }), true);
  assert.match(formatRuntimeNotification({ cwd: "C:/projects/example-app", status: "failed", batch: 5, phase: "failed", message: "Needs input" }), /Batch: 005/);
  assert.equal(telegramEnabled({ ...env, KLEVAR_TELEGRAM_NOTIFY: "0" }), false);
});

test("runtime heartbeat does not resurrect failed status", async () => {
  const dir = await tempDir();
  await resetRuntimeState(dir, 1);
  await failRuntimeFromError(dir, new Error("boom"));
  await markHeartbeat(dir, "validate agent running 1m0s");
  const state = JSON.parse(await readFileText(join(dir, ".yolo/runtime-state.json")));
  assert.equal(state.status, "failed");
  assert.equal(state.phase, "failed");
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

test("runtime telemetry records speed v2 journal risk and affected-test observations", async () => {
  const dir = await tempDir();
  await resetRuntimeState(dir, 17);
  await markJournalDecision(dir, 17, "fast_path_used", "eligible simple batch");
  await markRiskObservation(dir, 17, { class: "low", reasons: ["test"], observedOnly: true });
  await markAffectedTestPlan(dir, 17, { confidence: "medium", files: ["src/app.ts"], candidateCommands: ["npm test"], rejected: [], observedOnly: true });
  const state = JSON.parse(await readFileText(join(dir, ".yolo/runtime-state.json"))) as { speed?: { journalDecisions?: unknown[]; riskObservations?: unknown[]; affectedTestPlans?: unknown[] } };
  assert.equal(state.speed?.journalDecisions?.length, 1);
  assert.equal(state.speed?.riskObservations?.length, 1);
  assert.equal(state.speed?.affectedTestPlans?.length, 1);
  const events = await readFileText(join(dir, ".yolo/events/batch-017.jsonl"));
  assert.match(events, /"type":"journal_decision"/);
  assert.match(events, /"type":"risk_observation"/);
  assert.match(events, /"type":"affected_test_plan"/);
  await rm(dir, { recursive: true, force: true });
});

test("runtime telemetry records self-healing attempts", async () => {
  const dir = await tempDir();
  await resetRuntimeState(dir, 3);
  await markSelfHeal(dir, "journal", "journal", true, ["retry:batch-003-journal-retry"]);
  const state = JSON.parse(await readFile(join(dir, ".yolo/runtime-state.json"), "utf8")) as { recovery?: { attempts?: Array<{ phase: string; kind: string; healed: boolean; actions: string[]; at: string }> } };
  assert.deepEqual(state.recovery?.attempts?.[0], { phase: "journal", kind: "journal", healed: true, actions: ["retry:batch-003-journal-retry"], at: state.recovery?.attempts?.[0].at });
  assert.match(await readFileText(join(dir, ".yolo/events/batch-003.jsonl")), /"type":"self_heal"/);
  await rm(dir, { recursive: true, force: true });
});

test("self-healing archives unreadable runtime state before rewrite", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, ".yolo"), { recursive: true });
  await writeFile(join(dir, ".yolo/runtime-state.json"), "{bad json");
  const actions = await healUnreadableRuntimeState(dir);
  assert.match(actions[0] ?? "", /^archived:\.yolo\/recovery\/runtime-state\..*\.bad\.json$/);
  assert.equal(await pathExists(join(dir, ".yolo/runtime-state.json")), false);
  await resetRuntimeState(dir, 4);
  const state = JSON.parse(await readFileText(join(dir, ".yolo/runtime-state.json"))) as { status: string; batch: number };
  assert.equal(state.status, "running");
  assert.equal(state.batch, 4);
  await rm(dir, { recursive: true, force: true });
});

test("self-healing refuses safety and human blockers", () => {
  assert.equal(isSelfHealingSafetyBlocker(["HARDCODED_SECRET_DETECTED"]), true);
  assert.equal(isSelfHealingSafetyBlocker(["EXTERNAL_MUTATION_NOT_ALLOWED:ssh prod rm file"]), true);
  assert.equal(isSelfHealingSafetyBlocker(["EXTERNALLY_CLAIMED:docs/progress.md"]), true);
  assert.equal(isSelfHealingSafetyBlocker(["PROTECTED_PATH_MODIFIED:.agent/rules/CODING_STANDARDS.md"]), true);
  assert.equal(isSelfHealingSafetyBlocker(["TENANT_ISOLATION_GAP"]), true);
  assert.equal(isSelfHealingSafetyBlocker(["MERGE_CONFLICT:src/app.ts"]), true);
  assert.equal(isSelfHealingSafetyBlocker(["JOURNAL_REJECTED"]), false);
});

test("runtime source wraps only operational self-healing surfaces", async () => {
  const source = await readFileText(join(process.cwd(), "src/runtime.ts"));
  assert.match(source, /healUnreadableRuntimeState/);
  assert.match(source, /markSelfHeal\(rootCwd, "journal", "journal"/);
  assert.match(source, /markSelfHeal\(cwd, "cleanup", kind, true/);
  assert.doesNotMatch(source, /withRuntimeSelfHealing[\s\S]*runImplementationAgent/);
  assert.doesNotMatch(source, /withRuntimeSelfHealing[\s\S]*syncWorktreeChangesToRoot/);
  assert.doesNotMatch(source, /withRuntimeSelfHealing[\s\S]*createCommit/);
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
