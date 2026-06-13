import { loadConfig } from "./config.js";
import { buildBatchContextWithKnowledge } from "./context-builder.js";
import { recordFailure, markReinforced } from "./failure-patterns.js";
import { readPendingInbox, reconcileInbox } from "./inbox-router.js";
import { routeInboxWithAi, writeInboxRouteGate } from "./inbox-ai-router.js";
import { repairCommittedCloseoutGate, writeGate, writeRuntimeGates, verifyPreviousBatchGates } from "./gates.js";
import { appendJournal } from "./journal.js";
import { validateJournalContract } from "./journal-contract.js";
import { isAuditItem, isMatrixCoverageAudit, isPhaseCloseout, parseProgress, selectBatch } from "./progress-parser.js";
import { tickProgressItems } from "./progress-updater.js";
import { readBatchResult, validateContract, writeBatchResult } from "./result-contracts.js";
import { runSubagent } from "./subagent-runner.js";
import { finishRuntime, markAffectedTestPlan, markJournalDecision, markRiskObservation, markSelfHeal, markTiming, resetRuntimeState, setAgent, setCheckpoint, setGates, setPhase } from "./telemetry.js";
import { adjudicationAccepted, adjudicationAllowed, adjudicationNeedsBugfix, adjudicationNeedsHuman, adjudicationReport, readAdjudicationFile, readExistingAdjudication } from "./adjudication.js";
import { gatesPassed, validateAllWithState } from "./validators/index.js";
import { loadClaims, markRuntimeClaim, prepareRuntimeClaim, validateClaims } from "./collaboration/claims.js";
import { planParallelBatches } from "./collaboration/scheduler.js";
import { createWorktree } from "./worktree-manager.js";
import { pruneSuccessfulWorktrees } from "./worktree-retention.js";
import { syncLocalOnlyFilesToRoot, syncWorktreeChangesToRoot, validateWorktreeMergeReadiness } from "./worktree-sync.js";
import { applySupportPlan, makeSupportPlan, markPhaseSupportDue, nextSupportPlan, supportGateStem, type SupportKind, type SupportPlan } from "./support-scheduler.js";
import { cleanupBatchDockerResources } from "./docker-cleanup.js";
import { blockingOpenFindings, canonicalizeBatchResultForRuntime, importAgentResultToState, recordGateState, writeRuntimeBatchState, type RuntimeBatchState } from "./runtime-batch-state.js";
import { validationPolicyFor } from "./validation-policy.js";
import { acquireRuntimeLock, heartbeatRuntimeLock, releaseRuntimeLock } from "./runtime-lock.js";
import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { copyPath, exists } from "./util/fs.js";
import { createCommit, git, nextBatchNumber } from "./util/git.js";
import { execCommand } from "./util/process.js";
export { mergeRecoveredResult, mergeRecoveredResultFromDisk } from "./recovery-merge.js";
import { mergeRecoveredResultFromDisk } from "./recovery-merge.js";
import type { AgentRole, Batch, BatchResult, GateResult, ProgressItem, RuntimeConfig, YoloScope } from "./types.js";
import { flagCode, isPositiveFlag, isRuntimeRecoveryMetaFlag, isWarningFlag } from "./flag-classification.js";
import { isNonRecoverableRuntimeFlag } from "./gate-findings.js";
import { classifySelfHealError, healUnreadableRuntimeState, isSelfHealingSafetyBlocker } from "./self-healing.js";
import { writeDeterministicJournal } from "./journal-fast-path.js";
import { classifyObservedRisk } from "./speed-risk.js";
import { planAffectedTests } from "./affected-tests.js";
import { capturePoisonedBatchIncidentFixture } from "./incident-fixtures.js";

export async function runYolo(cwd: string, scope: YoloScope, dryRun: boolean): Promise<void> {
  const lock = dryRun ? null : acquireRuntimeLock(cwd, scopeLabel(scope));
  if (lock && !lock.ok) throw new Error(`Klevar YOLO already running: ${lock.reason}`);
  const lockHeartbeat = dryRun ? null : setInterval(() => heartbeatRuntimeLock(cwd), 30_000);
  try {
  const config = await loadConfig(cwd);
  if (scope.mode === "resume") return continueYolo(cwd, config, dryRun);
  if (scope.mode === "parallel") return runParallelYolo(cwd, config, scope, dryRun);
  const incomplete = await findIncompleteBatch(cwd);
  if (incomplete && !dryRun) {
    await resetRuntimeState(cwd, incomplete, scopeLabel(scope));
    await finishRuntime(cwd, "failed", `Incomplete previous batch ${incomplete} is missing closeout; run /klevar-yolo continue or /yolo-clean batch-${String(incomplete).padStart(3, "0")} before starting new scope.`);
    rejectBatch(incomplete, [`INCOMPLETE_PREVIOUS_BATCH:${String(incomplete).padStart(3, "0")}`]);
    return;
  }
  if ((scope.mode === "full" || scope.mode === "phase") && !dryRun) {
    while (true) {
      const outcome = await runSingleBatch(cwd, config, scope, dryRun);
      if (outcome === "none") return console.log(scope.mode === "phase" ? `Phase scope complete: ${scope.target}` : "Full YOLO complete: no remaining items.");
      if (outcome === "failed") return;
    }
  }
  await runSingleBatch(cwd, config, scope, dryRun);
  } finally {
    if (lockHeartbeat) clearInterval(lockHeartbeat);
    if (!dryRun) releaseRuntimeLock(cwd);
  }
}

async function runSingleBatch(cwd: string, config: RuntimeConfig, scope: YoloScope, dryRun: boolean): Promise<"complete" | "none" | "failed"> {
  const batch = await makeBatch(cwd, config, scope);
  if (batch.items.length === 0) return "none";
  await resetRuntimeState(cwd, batch.number, scopeLabel(scope), { kind: batch.supportKind, scope: batch.supportScope });
  const missingGates = await verifyPreviousBatchGates(cwd, batch.number);
  if (missingGates.length) {
    await finishRuntime(cwd, "failed", `Missing previous batch gates: ${missingGates.join(", ")}`);
    rejectBatch(batch.number, [`MISSING_PREVIOUS_BATCH_GATES:${missingGates.join("|")}`]);
    return "failed";
  }
  console.log(`Selected batch ${batch.number}: ${batch.items.map((item) => item.title).join(" | ")}`);
  if (dryRun) {
    await finishRuntime(cwd, "complete", `Dry-run selected batch ${batch.number}`);
    return "complete";
  }
  const claimGate = await prepareRuntimeClaim(cwd, config, batch);
  if (!claimGate.passed) {
    await setGates(cwd, [claimGate]);
    await writeRuntimeGates(cwd, batch, [claimGate]);
    await finishRuntime(cwd, "failed", `Claims contract rejected batch ${batch.number}: ${claimGate.flags.join(", ")}`);
    rejectBatch(batch.number, claimGate.flags);
    return "failed";
  }
  await setGates(cwd, [claimGate]);
  await writeRuntimeGates(cwd, batch, [claimGate]);
  await setPhase(cwd, "worktree", "Creating isolated batch worktree");
  const wtStart = Date.now();
  const lease = await createWorktree(cwd, `batch-${String(batch.number).padStart(3, "0")}`, config.worktrees.enabled);
  await markTiming(cwd, "worktreeMs", Date.now() - wtStart);
  await setCheckpoint(cwd, "worktree", "passed");
  const context = await buildVisibleBatchContext(cwd, lease.cwd, batch, config);
  await setPhase(cwd, "implement", "Starting implement agent", { worktree: lease.cwd });
  const implStart = Date.now();
  let result = await runImplementationAgent(cwd, lease.cwd, batch, config, context);
  let batchState = await importAgentResultToState(lease.cwd, batch, result.agent, result);
  result = batchState.currentResult;
  await recordSpeedObservations(cwd, batch, result, config);
  await copyBatchResultArtifacts(lease.cwd, cwd, batch, batch.type === "audit" ? "audit" : "implement");
  await markTiming(cwd, "implementMs", Date.now() - implStart);
  await setCheckpoint(cwd, "implement", "passed");
  await setPhase(cwd, "validate", "Running runtime gates");
  const gateStart = Date.now();
  const validation = await validateAllWithState(lease.cwd, batch, result, config, cwd);
  const gates = [claimGate, ...validation.gates];
  const gateState = recordGateState(validation.state, gates);
  await writeRuntimeBatchState(lease.cwd, gateState);
  await markTiming(cwd, "runtimeGatesMs", Date.now() - gateStart);
  await setGates(cwd, gates);
  await writeRuntimeGates(cwd, batch, gates);
  await setCheckpoint(cwd, "runtimeGates", gatesPassed(gates) ? "passed" : "failed");
  await appendJournal(cwd, batch, result, gates);
  const openFindings = blockingOpenFindings(gateState);
  if (!gatesPassed(gates) && openFindings.length === 0) await writeGate(cwd, "findings", `batch-${String(batch.number).padStart(3, "0")}`, "PASS", batch.number, ["no open blocking canonical findings"]);
  if (gatesPassed(gates) && openFindings.length > 0) {
    const recovery = await recoverGateFailure(cwd, lease.cwd, batch, config, context, result, openFindings.map((finding) => finding.id));
    if (!recovery.result) {
      await markRuntimeClaim(cwd, config, batch, "blocked");
      await handleRejected(cwd, batch, result, recovery.flags.length ? recovery.flags : openFindings.map((finding) => finding.id), config);
      return "failed";
    }
    batchState = await importAgentResultToState(lease.cwd, batch, "bugfix", recovery.result);
    result = batchState.currentResult;
    const postFindingValidation = await validateAllWithState(lease.cwd, batch, result, config, cwd);
    await setGates(cwd, postFindingValidation.gates);
    await writeRuntimeGates(cwd, batch, postFindingValidation.gates);
    const remainingFindings = blockingOpenFindings(postFindingValidation.state);
    if (!gatesPassed(postFindingValidation.gates) || remainingFindings.length > 0) {
      await markRuntimeClaim(cwd, config, batch, "blocked");
      await handleRejected(cwd, batch, result, remainingFindings.length ? remainingFindings.map((finding) => finding.id) : postFindingValidation.gates.flatMap((gate) => gate.flags), config);
      return "failed";
    }
  }
  const adjudication = !gatesPassed(gates) ? await adjudicateIfPossible(cwd, lease.cwd, batch, config, context, result, gates) : "none";
  if (adjudication === "accepted") {
    await setCheckpoint(cwd, "runtimeGates", "passed");
  } else if (!gatesPassed(gates)) {
    const recovery = await recoverGateFailure(cwd, lease.cwd, batch, config, context, result, gates.flatMap((gate) => gate.flags));
    if (!recovery.result) {
      await markRuntimeClaim(cwd, config, batch, "blocked");
      await handleRejected(cwd, batch, result, recovery.flags.length ? recovery.flags : gates.flatMap((gate) => gate.flags), config);
      return "failed";
    }
    batchState = await importAgentResultToState(lease.cwd, batch, "bugfix", recovery.result);
    result = batchState.currentResult;
    await setCheckpoint(cwd, "runtimeGates", "passed");
  }
  const policy = validationPolicyFor(batch, result, config);
  if (policy.requireAdversarialValidation) {
    await setPhase(cwd, "validate", `Adversarial validation (${policy.mode}/${policy.risk})`, { inspect: { risk: policy.risk, validationMode: policy.mode } });
    const recovered = await validateAdversarial(cwd, lease.cwd, batch, config, context, result);
    if (!recovered) {
      await markRuntimeClaim(cwd, config, batch, "blocked");
      return "failed";
    }
    batchState = await importAgentResultToState(lease.cwd, batch, "validate", recovered);
    result = batchState.currentResult;
  }
  await setCheckpoint(cwd, "validate", "passed");
  if (!await runMergeReadinessGate(cwd, lease.cwd, batch, config, batchState, result)) return "failed";
  const journalResult = await reuseOrRunJournalAgent(cwd, lease.cwd, batch, config, context, batchState, result);
  if (!journalResult) {
    await markRuntimeClaim(cwd, config, batch, "blocked");
    return "failed";
  }
  await setCheckpoint(cwd, "journal", "passed");
  await setPhase(cwd, "merge", "Syncing validated worktree changes back to main project");
  await syncWorktreeChangesToRoot(lease.cwd, cwd, finalSyncCandidates(batchState, result, journalResult));
  await syncLocalOnlyFilesToRoot(lease.cwd, cwd, result.localOnlyFiles ?? []);
  await tickProgressItems(cwd, batch);
  await markPhaseSupportDue(cwd, batch, await parseProgress(cwd));
  await reconcileInbox(cwd, result);
  await setCheckpoint(cwd, "merge", "passed");
  await writeGate(cwd, "closeout", `batch-${String(batch.number).padStart(3, "0")}`, "PASS", batch.number);
  if (batch.supportKind && batch.supportScope) await writeGate(cwd, `support-${batch.supportKind}`, supportGateStem(batch.supportScope), "PASS", batch.number, [`scope:${batch.supportScope}`]);
  await setGates(cwd, [{ name: "closeout", passed: true, flags: [] }]);
  await markRuntimeClaim(cwd, config, batch, "done");
  await cleanupDockerForBatch(cwd, batch.number, "success", config);
  await setPhase(cwd, "commit", "Creating runtime-owned batch commit");
  const commit = await createCommit(cwd, `feat(yolo): complete batch ${String(batch.number).padStart(3, "0")}`);
  await setCheckpoint(cwd, "commit", "passed");
  const retention = await pruneSuccessfulWorktrees(cwd, config.retention);
  await finishRuntime(cwd, "complete", `Batch ${batch.number} committed: ${commit}`);
  console.log(`Batch ${batch.number} passed and committed: ${commit}`);
  if (retention.pruned.length) console.log(`Pruned successful worktrees: ${retention.pruned.join(", ")}`);
  return "complete";
}

async function continueYolo(cwd: string, config: RuntimeConfig, dryRun: boolean): Promise<void> {
  const state = await readRuntimeState(cwd, config);
  const inferred = await findLatestResumableBatch(cwd);
  const stateWorktree = state?.worktree && await exists(String(state.worktree)) ? String(state.worktree) : "";
  const batchNumber = stateWorktree ? Number(state?.batch ?? 0) : Number(inferred?.batch ?? state?.batch ?? 0);
  const worktree = stateWorktree || inferred?.worktree || "";
  const requestedScope = stateWorktree ? state?.inspect?.requestedScope ?? inferred?.requestedScope ?? "unknown" : inferred?.requestedScope ?? state?.inspect?.requestedScope ?? "unknown";
  if (!batchNumber || !worktree || !(await exists(worktree))) {
    await finishRuntime(cwd, "failed", "No resumable YOLO batch found. Start a new batch with next/phase/full.");
    console.log("No resumable YOLO batch found. Start a new batch with next/phase/full.");
    return;
  }
  const missingPreviousGates = await verifyPreviousBatchGates(cwd, batchNumber);
  if (missingPreviousGates.length) {
    await finishRuntime(cwd, "failed", `Batch ${batchNumber} cannot continue until previous batch gates are complete: ${missingPreviousGates.join(", ")}`);
    rejectBatch(batchNumber, ["MISSING_PREVIOUS_BATCH_GATES", ...missingPreviousGates]);
    return;
  }
  if (await completedBatchCommitExists(cwd, batchNumber)) {
    await finishRuntime(cwd, "complete", `Batch ${batchNumber} was already committed; continuing requested scope.`);
    console.log(`Batch ${batchNumber} was already committed; continuing requested scope.`);
    if (requestedScope === "full") await runYolo(cwd, { mode: "full" }, false);
    return;
  }
  const items = await parseProgress(cwd);
  const support = supportPlanFromRuntimeState(state);
  const selected = support ? [support.item] : selectBatch(items, config.maxBatchSize, `next 1`);
  let batch: Batch = support ? applySupportPlan({ number: batchNumber, type: "implement", items: selected }, support) : { number: batchNumber, type: classifyBatchType(selected), items: selected };
  if (stateWorktree && !batchMatchesStateItems(batch, state) && state?.selectedItems?.length) {
    batch = { ...batch, items: progressItemsFromPersistedSelection(state.selectedItems) };
  }
  if (batch.items.length === 0) {
    await finishRuntime(cwd, "failed", "No unchecked progress item found for resumable batch; refusing ambiguous continue.");
    rejectBatch(batchNumber, ["RESUME_PROGRESS_ITEM_MISSING"]);
    return;
  }
  if (stateWorktree && !batchMatchesStateItems(batch, state)) {
    await finishRuntime(cwd, "failed", `Batch ${batchNumber} runtime state items do not match current progress selection; refusing ambiguous continue.`);
    rejectBatch(batchNumber, ["RESUME_PROGRESS_ITEM_MISMATCH"]);
    return;
  }
  console.log(`Continuing batch ${batchNumber} from ${worktree}`);
  if (dryRun) return;
  const suffix = batch.type === "audit" ? "audit" : "implement";
  const resultFile = path.join(worktree, `.yolo/batch-results/batch-${String(batchNumber).padStart(3, "0")}-${suffix}.json`);
  const hasResult = await exists(resultFile);
  const context = await buildVisibleBatchContext(cwd, worktree, batch, config);
  let result: BatchResult;
  let batchState: RuntimeBatchState | undefined;
  if (state?.status === "running" && !hasResult) {
    if (!runningNoResultIsStale(state, config, batch)) {
      console.log(`Batch ${batchNumber} is already running; no ${suffix} result exists yet. Use /yolo-dashboard instead of /klevar-yolo continue until the active agent finishes.`);
      return;
    }
    await setPhase(cwd, "implement", `Recovering stale running batch ${batchNumber}; restarting ${suffix} agent in existing worktree`, { batch: batchNumber, worktree, inspect: { ...(state?.inspect ?? {}), requestedScope } });
    const implStart = Date.now();
    result = await runImplementationAgent(cwd, worktree, batch, config, context);
    batchState = await importAgentResultToState(worktree, batch, result.agent, result);
    result = batchState.currentResult;
    await recordSpeedObservations(cwd, batch, result, config);
    await copyBatchResultArtifacts(worktree, cwd, batch, suffix);
    await markTiming(cwd, "implementMs", Date.now() - implStart);
    await setCheckpoint(cwd, "implement", "passed");
  } else {
    if (!hasResult) {
      const recovered = await readLatestSuccessfulBugfixResult(worktree, batchNumber);
      if (!recovered) {
        await finishRuntime(cwd, "failed", `Batch ${batchNumber} has no ${suffix} result artifact in existing worktree; clean and rerun.`);
        rejectBatch(batchNumber, ["MISSING_RESUMABLE_RESULT_ARTIFACT"]);
        return;
      }
      result = recovered;
    } else {
      result = await readBatchResult(resultFile);
      result = await mergeExistingBugfixResults(worktree, batchNumber, result);
    }
    await recordSpeedObservations(cwd, batch, result, config);
    if (!batchMatchesResultItems(batch, result)) {
      if (stateWorktree && result.itemsCompleted?.length) {
        batch = { ...batch, items: progressItemsFromPersistedSelection(result.itemsCompleted) };
      }
      if (!batchMatchesResultItems(batch, result)) {
        await finishRuntime(cwd, "failed", `Batch ${batchNumber} result items do not match persisted batch identity; refusing ambiguous continue.`);
        rejectBatch(batchNumber, ["RESUME_PROGRESS_ITEM_MISMATCH"]);
        return;
      }
    }
    batchState = await importAgentResultToState(worktree, batch, result.agent, result);
    result = batchState.currentResult;
    if (isNonResumableResult(result)) {
      const flags = [result.failureType ?? result.status, ...(result.flags ?? [])].filter(Boolean);
      await finishRuntime(cwd, "failed", `Batch ${batchNumber} is not safely resumable; clean and rerun: ${flags.join(", ")}`);
      rejectBatch(batchNumber, ["NON_RESUMABLE_BATCH", ...flags]);
      return;
    }
    await copyBatchResultArtifacts(worktree, cwd, batch, suffix);
  }
  const claimGate = await prepareRuntimeClaim(cwd, config, batch);
  await writeRuntimeGates(cwd, batch, [claimGate]);
  if (!claimGate.passed) {
    await finishRuntime(cwd, "failed", `Batch ${batchNumber} cannot continue due to claim conflicts: ${claimGate.flags.join(", ")}`);
    rejectBatch(batchNumber, claimGate.flags);
    return;
  }
  await setPhase(cwd, "validate", "Continuing from existing worktree result", { batch: batchNumber, worktree, inspect: { ...(state?.inspect ?? {}), requestedScope } });
  const validation = await validateAllWithState(worktree, batch, result, config, cwd);
  const gates = validation.gates;
  const gateState = recordGateState(validation.state, gates);
  await writeRuntimeBatchState(worktree, gateState);
  await setGates(cwd, gates);
  await writeRuntimeGates(cwd, batch, gates);
  await setCheckpoint(cwd, "runtimeGates", gatesPassed(gates) ? "passed" : "failed");
  await appendJournal(cwd, batch, result, gates);
  const openFindings = blockingOpenFindings(gateState);
  if (!gatesPassed(gates) && openFindings.length === 0) await writeGate(cwd, "findings", `batch-${String(batch.number).padStart(3, "0")}`, "PASS", batch.number, ["no open blocking canonical findings"]);
  if (gatesPassed(gates) && openFindings.length > 0) {
    const recovery = await recoverGateFailure(cwd, worktree, batch, config, context, result, openFindings.map((finding) => finding.id));
    if (!recovery.result) return handleRejected(cwd, batch, result, recovery.flags.length ? recovery.flags : openFindings.map((finding) => finding.id), config);
    batchState = await importAgentResultToState(worktree, batch, "bugfix", recovery.result);
    result = batchState.currentResult;
    const postFindingValidation = await validateAllWithState(worktree, batch, result, config, cwd);
    await setGates(cwd, postFindingValidation.gates);
    await writeRuntimeGates(cwd, batch, postFindingValidation.gates);
    const remainingFindings = blockingOpenFindings(postFindingValidation.state);
    if (!gatesPassed(postFindingValidation.gates) || remainingFindings.length > 0) return handleRejected(cwd, batch, result, remainingFindings.length ? remainingFindings.map((finding) => finding.id) : postFindingValidation.gates.flatMap((gate) => gate.flags), config);
  }
  const adjudication = !gatesPassed(gates) ? await adjudicateIfPossible(cwd, worktree, batch, config, context, result, gates) : "none";
  if (adjudication === "accepted") {
    await setCheckpoint(cwd, "runtimeGates", "passed");
  } else if (!gatesPassed(gates)) {
    const recovery = await recoverGateFailure(cwd, worktree, batch, config, context, result, gates.flatMap((gate) => gate.flags));
    if (!recovery.result) return handleRejected(cwd, batch, result, recovery.flags.length ? recovery.flags : gates.flatMap((gate) => gate.flags), config);
    batchState = await importAgentResultToState(worktree, batch, "bugfix", recovery.result);
    result = batchState.currentResult;
    await setCheckpoint(cwd, "runtimeGates", "passed");
  }
  const policy = validationPolicyFor(batch, result, config);
  if (policy.requireAdversarialValidation) {
    await setPhase(cwd, "validate", `Adversarial validation (${policy.mode}/${policy.risk})`, { inspect: { risk: policy.risk, validationMode: policy.mode } });
    const recovered = await validateAdversarial(cwd, worktree, batch, config, context, result);
    if (!recovered) return;
    batchState = await importAgentResultToState(worktree, batch, "validate", recovered);
    result = batchState.currentResult;
  }
  await setCheckpoint(cwd, "validate", "passed");
  if (!await runMergeReadinessGate(cwd, worktree, batch, config, batchState, result)) return;
  const journalResult = await reuseOrRunJournalAgent(cwd, worktree, batch, config, context, batchState, result);
  if (!journalResult) return;
  await setCheckpoint(cwd, "journal", "passed");
  await setPhase(cwd, "merge", "Syncing continued worktree changes back to main project");
  await syncWorktreeChangesToRoot(worktree, cwd, finalSyncCandidates(batchState, result, journalResult));
  await syncLocalOnlyFilesToRoot(worktree, cwd, result.localOnlyFiles ?? []);
  await tickProgressItems(cwd, batch);
  await markPhaseSupportDue(cwd, batch, await parseProgress(cwd));
  await reconcileInbox(cwd, result);
  await setCheckpoint(cwd, "merge", "passed");
  await writeGate(cwd, "closeout", `batch-${String(batch.number).padStart(3, "0")}`, "PASS", batch.number);
  if (batch.supportKind && batch.supportScope) await writeGate(cwd, `support-${batch.supportKind}`, supportGateStem(batch.supportScope), "PASS", batch.number, [`scope:${batch.supportScope}`]);
  await setGates(cwd, [{ name: "closeout", passed: true, flags: [] }]);
  await markRuntimeClaim(cwd, config, batch, "done");
  await cleanupDockerForBatch(cwd, batch.number, "success", config);
  await setPhase(cwd, "commit", "Creating runtime-owned continued batch commit");
  const commit = await createCommit(cwd, `feat(yolo): complete batch ${String(batch.number).padStart(3, "0")}`);
  await setCheckpoint(cwd, "commit", "passed");
  await pruneSuccessfulWorktrees(cwd, config.retention);
  await finishRuntime(cwd, "complete", `Continued batch ${batch.number} committed: ${commit}`);
  console.log(`Continued batch ${batch.number} passed and committed: ${commit}`);
  if (requestedScope === "full") {
    console.log("Continuing original full YOLO scope after resumed batch.");
    await runYolo(cwd, { mode: "full" }, false);
  } else if (requestedScope.startsWith("phase ")) {
    const target = requestedScope.replace(/^phase\s+/i, "").trim();
    console.log(`Continuing original phase YOLO scope after resumed batch: ${target}.`);
    await runYolo(cwd, { mode: "phase", target }, false);
  }
}

async function recordSpeedObservations(cwd: string, batch: Batch, result: BatchResult, config: RuntimeConfig): Promise<void> {
  if (config.speed?.observeRisk !== false) await markRiskObservation(cwd, batch.number, classifyObservedRisk({ batch, result }));
  if (config.speed?.observeAffectedTests !== false) await markAffectedTestPlan(cwd, batch.number, planAffectedTests({ batch, result }));
}

function finalSyncCandidates(state: RuntimeBatchState | undefined, result: BatchResult, journalResult: BatchResult): string[] {
  return uniquePaths([...(state?.changedFiles ?? []), ...(result.filesChanged ?? []), ...(journalResult.filesChanged ?? [])]);
}

function preJournalSyncCandidates(state: RuntimeBatchState | undefined, result: BatchResult): string[] {
  return uniquePaths([...(state?.changedFiles ?? []), ...(result.filesChanged ?? [])]);
}

async function runMergeReadinessGate(cwd: string, worktree: string, batch: Batch, config: RuntimeConfig, state: RuntimeBatchState | undefined, result: BatchResult): Promise<boolean> {
  await setPhase(cwd, "merge", "Checking merge readiness before journal");
  const gate = await validateWorktreeMergeReadiness(worktree, cwd, preJournalSyncCandidates(state, result));
  await setGates(cwd, [gate]);
  await writeRuntimeGates(cwd, batch, [gate]);
  await setCheckpoint(cwd, "merge", gate.passed ? "passed" : "failed");
  if (gate.passed) return true;
  await markRuntimeClaim(cwd, config, batch, "blocked");
  await handleRejected(cwd, batch, result, gate.flags, config);
  return false;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((item) => item.replace(/\\/g, "/").trim()).filter(Boolean))];
}

async function findIncompleteBatch(cwd: string): Promise<number | null> {
  const resultNumbers = await listBatchNumbers(cwd, ".yolo/batch-results", /^batch-(\d+)-.+\.json$/);
  if (!resultNumbers.length) return null;
  let closeoutNumbers = await listBatchNumbers(cwd, ".yolo/gates", /^closeout-batch-(\d+)\.md$/);
  let maxCloseout = closeoutNumbers.length ? Math.max(...closeoutNumbers) : 0;
  for (const number of resultNumbers.filter((value) => value > maxCloseout).sort((a, b) => a - b)) {
    await repairCommittedCloseoutGate(cwd, number);
  }
  closeoutNumbers = await listBatchNumbers(cwd, ".yolo/gates", /^closeout-batch-(\d+)\.md$/);
  maxCloseout = closeoutNumbers.length ? Math.max(...closeoutNumbers) : 0;
  const incomplete = resultNumbers.filter((number) => number > maxCloseout).sort((a, b) => a - b)[0];
  return incomplete ?? null;
}

async function listBatchNumbers(cwd: string, relDir: string, pattern: RegExp): Promise<number[]> {
  try {
    return (await readdir(path.join(cwd, relDir)))
      .map((name) => pattern.exec(name)?.[1])
      .filter((value): value is string => Boolean(value))
      .map(Number)
      .filter((value) => Number.isFinite(value));
  } catch {
    return [];
  }
}

export async function completedBatchCommitExists(cwd: string, batchNumber: number): Promise<boolean> {
  try {
    const padded = String(batchNumber).padStart(3, "0");
    const patterns = [`feat(yolo): complete batch ${padded}`, `feat(yolo): complete batch ${batchNumber}`];
    const subjects = await git(cwd, `log --all --fixed-strings --format=%s --grep=${JSON.stringify(patterns[0])} --grep=${JSON.stringify(patterns[1])}`);
    return subjects.split(/\r?\n/).some((subject) => patterns.includes(subject.trim()));
  } catch {
    return false;
  }
}

export async function findLatestResumableBatch(cwd: string): Promise<{ batch: number; worktree: string; requestedScope?: string } | null> {
  const dir = path.join(cwd, ".yolo/worktrees");
  try {
    const names = await readdir(dir);
    const candidates = await Promise.all(names.map(async (name) => {
      const match = /^batch-(\d+)$/.exec(name);
      if (!match) return null;
      const batch = Number(match[1]);
      const worktree = path.join(dir, name);
      const padded = String(batch).padStart(3, "0");
      const implement = path.join(worktree, `.yolo/batch-results/batch-${padded}-implement.json`);
      const audit = path.join(worktree, `.yolo/batch-results/batch-${padded}-audit.json`);
      const bugfix = await readLatestSuccessfulBugfixResult(worktree, batch);
      return (await exists(implement)) || (await exists(audit)) || bugfix ? { batch, worktree } : null;
    }));
    const latest = candidates.filter((item): item is { batch: number; worktree: string } => Boolean(item)).sort((a, b) => b.batch - a.batch)[0] ?? null;
    return latest ? { ...latest, requestedScope: await inferRequestedScope(cwd, latest.batch) } : null;
  } catch {
    return null;
  }
}

async function inferRequestedScope(cwd: string, batch: number): Promise<string | undefined> {
  const logsDir = path.join(cwd, ".yolo/logs");
  try {
    const logs = (await readdir(logsDir)).filter((file) => file.startsWith("runtime-") && file.endsWith(".log")).sort().reverse().slice(0, 5);
    for (const log of logs) {
      const text = await readFile(path.join(logsDir, log), "utf8");
      if (logShowsFullContinuation(text, batch)) return "full";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function logShowsFullContinuation(text: string, batch: number): boolean {
  const selected = new RegExp(`Selected batch ${batch}\\b`);
  const index = text.search(selected);
  if (index < 0) return false;
  return text.slice(0, index).includes("Continuing original full YOLO scope after resumed batch.");
}

async function mergeExistingBugfixResults(worktree: string, batchNumber: number, implementation: BatchResult): Promise<BatchResult> {
  const files = await successfulBugfixResultFiles(worktree, batchNumber);
  let recovered = implementation;
  for (const file of files) {
    const bugfix = await readBatchResult(file);
    recovered = await mergeRecoveredResultFromDisk(worktree, batchNumber, recovered, bugfix);
  }
  return recovered;
}

export async function readLatestSuccessfulBugfixResult(worktree: string, batchNumber: number): Promise<BatchResult | null> {
  const files = await successfulBugfixResultFiles(worktree, batchNumber);
  const latest = files.at(-1);
  return latest ? readBatchResult(latest) : null;
}

async function successfulBugfixResultFiles(worktree: string, batchNumber: number): Promise<string[]> {
  const dir = path.join(worktree, ".yolo/batch-results");
  try {
    const padded = String(batchNumber).padStart(3, "0");
    const files: string[] = [];
    for (const file of (await readdir(dir)).filter((entry) => canonicalBugfixResultName(entry, padded)).sort((a, b) => bugfixJsonOrder(a) - bugfixJsonOrder(b) || a.localeCompare(b))) {
      const result = await readBatchResult(path.join(dir, file));
      if (result.status === "SUCCESS" && result.agent === "bugfix" && result.batch === batchNumber) files.push(path.join(dir, file));
    }
    return files;
  } catch {
    return [];
  }
}

function canonicalBugfixResultName(file: string, paddedBatch: string): boolean {
  return new RegExp(`^batch-${paddedBatch}-bugfix(?:-(\\d+))?\\.json$`).test(file);
}

function bugfixJsonOrder(file: string): number {
  const match = /-bugfix(?:-(\d+))?\.json$/.exec(file);
  return match?.[1] ? Number(match[1]) : 1;
}

function isNonResumableResult(result: BatchResult): boolean {
  return result.failureType === "AUDIT_PREMATURE" || result.status === "BUG_FOUND" || result.status === "INVALID_RESULT";
}

function batchMatchesResultItems(batch: Batch, result: BatchResult): boolean {
  if (!result.itemsCompleted?.length) return false;
  const completed = result.itemsCompleted.join("\n").toLowerCase();
  return batch.items.every((item) => completed.includes(item.title.toLowerCase()) || Boolean(item.raw && completed.includes(item.raw.toLowerCase())));
}

function batchMatchesStateItems(batch: Batch, state: { selectedItems?: string[] } | null): boolean {
  const selected = state?.selectedItems ?? [];
  if (!selected.length) return true;
  const expected = selected.join("\n").toLowerCase();
  return batch.items.every((item) => expected.includes(item.title.toLowerCase()) || Boolean(item.raw && expected.includes(item.raw.toLowerCase())));
}

function progressItemsFromPersistedSelection(selectedItems: string[]): ProgressItem[] {
  return selectedItems.map((value) => {
    const raw = String(value);
    const title = raw.replace(/^\s*-\s*\[[ xX]\]\s*/, "").trim() || raw.trim() || "Persisted resumed batch item";
    return { raw, title, tag: "RESUME", phase: "resumed", checked: false };
  });
}

function scopeLabel(scope: YoloScope): string {
  return scope.mode === "full" ? "full" : scope.mode === "count" ? `next ${scope.target}` : scope.mode === "phase" ? `phase ${scope.target}` : scope.mode;
}

async function readRuntimeState(cwd: string, config?: RuntimeConfig): Promise<{ status?: string; batch?: number; worktree?: string; inspect?: Record<string, string>; updatedAt?: string; selectedItems?: string[] } | null> {
  const file = path.join(cwd, ".yolo/runtime-state.json");
  try {
    return JSON.parse(await readFile(file, "utf8")) as { status?: string; batch?: number; worktree?: string; inspect?: Record<string, string>; updatedAt?: string; selectedItems?: string[] };
  } catch (error) {
    if (config?.recovery?.selfHealRuntime && config.recovery.repairUnreadableRuntimeState && classifySelfHealError(error) === "runtime-state") {
      const actions = await healUnreadableRuntimeState(cwd).catch(() => []);
      if (actions.length) await markSelfHeal(cwd, "resume", "runtime-state", true, actions);
    }
    return null;
  }
}

function supportPlanFromRuntimeState(state: { inspect?: Record<string, string> } | null): SupportPlan | null {
  const kind = state?.inspect?.supportKind;
  const scope = state?.inspect?.supportScope;
  if (!isSupportKind(kind) || !scope) return null;
  return makeSupportPlan(kind, scope, scope === "final" ? undefined : scope);
}

function isSupportKind(value: unknown): value is SupportKind {
  return value === "modularity" || value === "validate-prd" || value === "security-audit";
}

function runningNoResultIsStale(state: { updatedAt?: string } | null, config: RuntimeConfig, batch: Batch): boolean {
  const updatedAt = state?.updatedAt ? Date.parse(state.updatedAt) : NaN;
  if (!Number.isFinite(updatedAt)) return false;
  const role: AgentRole = batch.type === "audit" ? "audit" : "implement";
  const staleMs = config.models[role].budget?.staleMs ?? 30 * 60_000;
  return Date.now() - updatedAt > staleMs;
}

async function runParallelYolo(cwd: string, config: RuntimeConfig, scope: Extract<YoloScope, { mode: "parallel" }>, dryRun: boolean): Promise<void> {
  const batchNumber = await nextBatchNumber(cwd);
  const items = await parseProgress(cwd);
  const claims = await loadClaims(cwd, config);
  const claimGate = validateClaims(claims);
  if (!claimGate.passed) {
    await resetRuntimeState(cwd, batchNumber);
    await setGates(cwd, [claimGate]);
    await finishRuntime(cwd, "failed", `Claims contract rejected parallel run: ${claimGate.flags.join(", ")}`);
    return rejectBatch(batchNumber, claimGate.flags);
  }
  const plan = planParallelBatches(items, batchNumber, Number(scope.target) || 2, config, claims.claims);
  if (plan.shards.length < 2) {
    await resetRuntimeState(cwd, batchNumber);
    await finishRuntime(cwd, "failed", `Parallel run needs at least two independent shards: ${[...plan.flags, ...plan.skipped].join(", ")}`);
    return rejectBatch(batchNumber, [...plan.flags, ...plan.skipped]);
  }
  await resetRuntimeState(cwd, batchNumber);
  console.log(`Selected parallel batch ${batchNumber}: ${plan.shards.map((shard) => shard.items[0]?.title).join(" | ")}`);
  if (dryRun) {
    await finishRuntime(cwd, "complete", `Dry-run selected parallel batch ${batchNumber} with ${plan.shards.length} shards`);
    return;
  }
  await setPhase(cwd, "worktree", `Creating ${plan.shards.length} isolated parallel worktrees`);
  const wtStart = Date.now();
  const leases = await Promise.all(plan.shards.map((_, index) => createWorktree(cwd, `batch-${String(batchNumber).padStart(3, "0")}-p${String(index + 1).padStart(2, "0")}`, config.worktrees.enabled)));
  await markTiming(cwd, "worktreeMs", Date.now() - wtStart);
  await setPhase(cwd, "implement", `Running ${plan.shards.length} implement agents in parallel`, { worktree: leases.map((lease) => lease.cwd).join("; ") });
  const implStart = Date.now();
  const contexts = await Promise.all(leases.map((lease, index) => buildVisibleBatchContext(cwd, lease.cwd, plan.shards[index], config)));
  const results = await Promise.all(leases.map((lease, index) => runShardImplementationAgent(cwd, lease.cwd, plan.shards[index], config, contexts[index], index + 1)));
  await markTiming(cwd, "implementMs", Date.now() - implStart);
  await setPhase(cwd, "validate", "Running runtime gates for parallel shards");
  const allGates = [];
  const openFindingFlags: string[] = [];
  for (let index = 0; index < plan.shards.length; index += 1) {
    const validation = await validateAllWithState(leases[index].cwd, plan.shards[index], results[index], config, cwd);
    const gates = validation.gates;
    const shard = `p${String(index + 1).padStart(2, "0")}`;
    const openFindings = blockingOpenFindings(validation.state);
    if (openFindings.length) openFindingFlags.push(...openFindings.map((finding) => `PARALLEL_${shard}_OPEN_FINDING:${finding.id}`));
    allGates.push(...gates.map((gate) => ({ ...gate, name: `${gate.name}-${shard}` })));
    for (const gate of gates) await writeGate(cwd, gate.name, `batch-${String(batchNumber).padStart(3, "0")}-${shard}`, gate.passed ? "PASS" : "FAIL", batchNumber, gate.flags);
  }
  const failed = allGates.filter((gate) => !gate.passed);
  await setGates(cwd, [claimGate, ...allGates]);
  if (failed.length || openFindingFlags.length) return handleRejected(cwd, { number: batchNumber, type: "implement", items: plan.shards.flatMap((shard) => shard.items) }, results[0], failed.length ? failed.flatMap((gate) => gate.flags) : openFindingFlags, config);
  await setPhase(cwd, "merge", "Syncing validated parallel shard changes back to main project");
  const conflicts = detectResultFileConflicts(results);
  if (conflicts.length) {
    await finishRuntime(cwd, "failed", `Parallel merge conflict: ${conflicts.join(", ")}`);
    return rejectBatch(batchNumber, conflicts.map((file) => `PARALLEL_FILE_CONFLICT:${file}`));
  }
  for (let index = 0; index < leases.length; index += 1) {
    await copyBatchResultArtifacts(leases[index].cwd, cwd, plan.shards[index], `p${String(index + 1).padStart(2, "0")}-implement`);
    await syncWorktreeChangesToRoot(leases[index].cwd, cwd, results[index].filesChanged);
    await syncLocalOnlyFilesToRoot(leases[index].cwd, cwd, results[index].localOnlyFiles ?? []);
  }
  const parallelBatch = { number: batchNumber, type: "implement" as const, items: plan.shards.flatMap((shard) => shard.items) };
  await tickProgressItems(cwd, parallelBatch);
  await markPhaseSupportDue(cwd, parallelBatch, await parseProgress(cwd));
  await writeGate(cwd, "parallel", `batch-${String(batchNumber).padStart(3, "0")}`, "PASS", batchNumber);
  await writeGate(cwd, "e2e", `batch-${String(batchNumber).padStart(3, "0")}`, "PASS", batchNumber, ["aggregate parallel shard e2e gates passed"]);
  await writeGate(cwd, "journal", `batch-${String(batchNumber).padStart(3, "0")}`, "PASS", batchNumber, ["parallel runtime summary"]);
  await writeGate(cwd, "closeout", `batch-${String(batchNumber).padStart(3, "0")}`, "PASS", batchNumber);
  await setGates(cwd, [{ name: "parallel", passed: true, flags: [] }, { name: "e2e", passed: true, flags: [] }, { name: "journal", passed: true, flags: [] }, { name: "closeout", passed: true, flags: [] }]);
  await setPhase(cwd, "commit", "Creating runtime-owned parallel batch commit");
  const commit = await createCommit(cwd, `feat(yolo): complete batch ${String(batchNumber).padStart(3, "0")}`);
  await pruneSuccessfulWorktrees(cwd, config.retention);
  await finishRuntime(cwd, "complete", `Parallel batch ${batchNumber} committed: ${commit}`);
  console.log(`Parallel batch ${batchNumber} passed and committed: ${commit}`);
}

function detectResultFileConflicts(results: BatchResult[]): string[] {
  const seen = new Set<string>();
  const conflicts = new Set<string>();
  for (const file of results.flatMap((result) => result.filesChanged ?? [])) {
    if (file === "docs/progress.md" || file.startsWith(".yolo/")) continue;
    if (seen.has(file)) conflicts.add(file);
    seen.add(file);
  }
  return [...conflicts];
}

async function copyBatchResultArtifacts(fromCwd: string, toCwd: string, batch: Batch, suffix: string): Promise<void> {
  const padded = String(batch.number).padStart(3, "0");
  for (const ext of ["md", "json"]) {
    const rel = `.yolo/batch-results/batch-${padded}-${suffix}.${ext}`;
    if (await exists(`${fromCwd}/${rel}`)) await copyPath(`${fromCwd}/${rel}`, `${toCwd}/${rel}`);
  }
}

async function makeBatch(cwd: string, config: RuntimeConfig, scope: YoloScope): Promise<Batch> {
  const items = await parseProgress(cwd);
  const scopeText = scope.mode === "count" ? `next ${scope.target}` : scope.mode === "phase" ? `phase ${scope.target}` : "full";
  const selected = selectBatch(items, config.maxBatchSize, scopeText);
  const batchNumber = await nextBatchNumber(cwd);
  const pendingInbox = await readPendingInbox(cwd);
  const hasHighInbox = pendingInbox.some((entry) => entry.priority === "HIGH");
  const support = scope.mode === "full" && !hasHighInbox ? await nextSupportPlan(cwd, items) : null;
  const routed = support ? { items: [support.item], entries: [], mode: "none" as const, gate: { name: "inbox", passed: true, flags: [`SUPPORT_WORKFLOW:${support.kind}`, `SUPPORT_SCOPE:${support.scope}`] } } : await routeInboxWithAi(cwd, batchNumber, selected, pendingInbox, config);
  const batch = applySupportPlan({ number: batchNumber, items: routed.items, type: classifyBatchType(routed.items) }, support);
  if (batch.items.length > 0) await writeInboxRouteGate(cwd, batch, routed.gate);
  return batch;
}

export function classifyBatchType(items: ProgressItem[]): Batch["type"] {
  return items.some((item) => isPhaseCloseout(item) || isMatrixCoverageAudit(item)) ? "audit" : "implement";
}

async function runShardImplementationAgent(rootCwd: string, cwd: string, batch: Batch, config: RuntimeConfig, context: string, shardNumber: number): Promise<BatchResult> {
  const suffix = `p${String(shardNumber).padStart(2, "0")}-implement`;
  const id = `batch-${String(batch.number).padStart(3, "0")}-${suffix}`;
  await setAgent(rootCwd, "implement", id);
  return runSubagent({ id, role: "implement", promptFile: ".agent/agents/yolo/yolo-subagent-implement.md", context, outputBase: `.yolo/batch-results/${id}`, cwd, route: config.models.implement, telemetryRoot: rootCwd });
}

async function buildVisibleBatchContext(rootCwd: string, cwd: string, batch: Batch, config: RuntimeConfig): Promise<string> {
  const id = `batch-${String(batch.number).padStart(3, "0")}-knowledge`;
  await setPhase(rootCwd, "knowledge", "Selecting relevant project knowledge", { worktree: cwd });
  await setAgent(rootCwd, "knowledge", id);
  const started = Date.now();
  const { context, knowledgePack } = await buildBatchContextWithKnowledge(cwd, batch, rootCwd, config);
  await markTiming(rootCwd, "knowledgeMs", Date.now() - started);
  const flags = [`KNOWLEDGE_MODE:${knowledgePack.mode}`, `KNOWLEDGE_FILES:${knowledgePack.selectedFiles.length}`, ...knowledgePack.warnings];
  const gate = { name: "knowledge", passed: true, flags };
  await setGates(rootCwd, [gate]);
  await writeRuntimeGates(rootCwd, batch, [gate]);
  await setCheckpoint(rootCwd, "knowledge", "passed");
  return context;
}

async function runImplementationAgent(rootCwd: string, cwd: string, batch: Batch, config: RuntimeConfig, context: string): Promise<BatchResult> {
  const role: AgentRole = batch.type === "audit" ? "audit" : "implement";
  const promptFile = batch.type === "audit" ? ".agent/agents/yolo/yolo-subagent-audit-coverage.md" : ".agent/agents/yolo/yolo-subagent-implement.md";
  const suffix = batch.type === "audit" ? "audit" : "implement";
  const id = `batch-${String(batch.number).padStart(3, "0")}-${suffix}`;
  await setAgent(rootCwd, role, id);
  return runSubagent({ id, role, promptFile, context, outputBase: `.yolo/batch-results/batch-${String(batch.number).padStart(3, "0")}-${suffix}`, cwd, route: config.models[role], telemetryRoot: rootCwd });
}

async function validateAdversarial(rootCwd: string, cwd: string, batch: Batch, config: RuntimeConfig, context: string, implementation: BatchResult): Promise<BatchResult | null> {
  await setPhase(rootCwd, "validate", "Running adversarial validation agent");
  const validation = (await importAgentResultToState(cwd, batch, "validate", await runValidator(rootCwd, cwd, batch, config, context))).currentResult;
  const validationGate = validateContract(validation);
  if (validationGate.passed && validation.status === "SUCCESS") return implementation;
  const flags = [...validationGate.flags, ...(validation.flags ?? []), validation.failureType ?? "VALIDATOR_REJECTED"];
  let recovered = implementation;
  let currentValidation = validation;
  let currentFlags = flags;
  const attempts = Math.max(1, config.recovery?.maxBugfixAttempts ?? 1);
  const maxTotalAttempts = attempts * 4;
  let totalAttempts = 0;
  let currentSignature = failureSignature(currentFlags, currentValidation.failureType);
  let attemptForSignature = 0;
  const attemptsByRuntimeOwnedSignature = new Map<string, number>();
  while (totalAttempts < maxTotalAttempts) {
    if (hasNonRecoverableRuntimeBlocker(currentFlags)) {
      await finishRuntime(rootCwd, "failed", `Batch ${batch.number} has non-recoverable runtime safety blockers: ${currentFlags.join(", ")}`);
      rejectBatch(batch.number, currentFlags);
      return null;
    }
    const nextSignature = failureSignature(currentFlags, currentValidation.failureType);
    if (runtimeOwnedFailureRequiresStop(nextSignature)) {
      await finishRuntime(rootCwd, "failed", runtimeOwnedFailureRecommendation(batch.number, nextSignature));
      rejectBatch(batch.number, blockingRecoveryFlags(currentFlags, currentValidation.failureType));
      return null;
    }
    if (nextSignature !== currentSignature) {
      currentSignature = nextSignature;
      attemptForSignature = 0;
    }
    const runtimeOwnedSignature = isRuntimeOwnedRecoverySignature(currentSignature);
    const previousRuntimeOwnedAttempts = attemptsByRuntimeOwnedSignature.get(currentSignature) ?? 0;
    if (attemptForSignature >= attempts || (runtimeOwnedSignature && previousRuntimeOwnedAttempts >= attempts)) {
      const poisoned = runtimePoisonedRecoveryLoop(currentSignature, currentFlags, currentValidation.failureType);
      if (poisoned) {
        await finishRuntime(rootCwd, "failed", runtimePoisonedRecommendation(batch.number, poisoned));
        rejectBatch(batch.number, [poisoned.code, ...poisoned.flags]);
        return null;
      }
      break;
    }
    attemptForSignature += 1;
    totalAttempts += 1;
    if (runtimeOwnedSignature) attemptsByRuntimeOwnedSignature.set(currentSignature, previousRuntimeOwnedAttempts + 1);
    const recoveryFlags = blockingRecoveryFlags(currentFlags, currentValidation.failureType);
    await setPhase(rootCwd, "bugfix", `Validation rejected batch ${batch.number}; dispatching bugfix recovery attempt ${attemptForSignature}/${attempts} for ${currentSignature}`);
    const bugfix = await runBugfixAgent(rootCwd, cwd, batch, config, context, currentValidation, recoveryFlags, totalAttempts);
    const bugfixGate = validateContract(bugfix);
    if (!bugfixGate.passed || bugfix.status !== "SUCCESS") {
      currentFlags = [...bugfixGate.flags, ...(bugfix.flags ?? []), bugfix.failureType ?? "BUGFIX_RECOVERY_FAILED"];
      currentValidation = { ...currentValidation, status: "FAILURE", failureType: "BUGFIX_RESULT_INVALID", flags: currentFlags };
      continue;
    }
    await canonicalizeBatchResultManifests(cwd, batch.number);
    recovered = (await importAgentResultToState(cwd, batch, "bugfix", await mergeRecoveredResultFromDisk(cwd, batch.number, recovered, bugfix))).currentResult;
    await setPhase(rootCwd, "validate", "Re-running runtime gates after bugfix recovery");
    const validation = await validateAllWithState(cwd, batch, recovered, config, rootCwd);
    const gates = validation.gates;
    await setGates(rootCwd, gates);
    await writeRuntimeGates(rootCwd, batch, gates);
    if (!gatesPassed(gates)) {
      const adjudication = await adjudicateIfPossible(rootCwd, cwd, batch, config, context, recovered, gates);
      if (adjudication === "accepted") return recovered;
      if (adjudication === "human") return null;
      currentFlags = gates.flatMap((gate) => gate.flags);
      currentValidation = { ...currentValidation, status: "FAILURE", failureType: "RUNTIME_GATES_REJECTED_AFTER_VALIDATION_BUGFIX", flags: currentFlags };
      continue;
    }
    await setPhase(rootCwd, "validate", "Re-running adversarial validation after bugfix recovery");
    currentValidation = (await importAgentResultToState(cwd, batch, "validate", await runValidator(rootCwd, cwd, batch, config, `${context}\n\n---\n\n# Bugfix Recovery Applied\n${JSON.stringify(bugfix, null, 2)}`))).currentResult;
    const secondGate = validateContract(currentValidation);
    if (secondGate.passed && currentValidation.status === "SUCCESS") return recovered;
    if (secondGate.passed && currentValidation.status === "FAILURE" && (
      await validationFailureLooksStale(cwd, currentValidation)
      || validationFailureContradictedByRecoveredEvidence(currentValidation, recovered, bugfix)
    )) return recovered;
    currentFlags = [...secondGate.flags, ...(currentValidation.flags ?? []), currentValidation.failureType ?? "VALIDATOR_REJECTED_AFTER_BUGFIX"];
    const poisoned = runtimePoisonedRecoveryLoop(currentSignature, currentFlags, currentValidation.failureType);
    if (poisoned) {
      await finishRuntime(rootCwd, "failed", runtimePoisonedRecommendation(batch.number, poisoned));
      rejectBatch(batch.number, [poisoned.code, ...currentFlags]);
      return null;
    }
  }
  await finishRuntime(rootCwd, "failed", `Adversarial validation rejected recovered batch ${batch.number}: ${currentFlags.join(", ")}`);
  rejectBatch(batch.number, currentFlags);
  return null;
}

async function validationFailureLooksStale(cwd: string, validation: BatchResult): Promise<boolean> {
  const red = validation.tests?.red;
  if (!red || red.exitCode === 0 || !isRunnableValidationCommand(red.command)) return false;
  const run = await execCommand(red.command, cwd, { timeoutMs: 5 * 60_000 });
  return run.exitCode === 0;
}

export function validationFailureContradictedByRecoveredEvidence(validation: BatchResult, recovered: BatchResult, bugfix: BatchResult): boolean {
  if (validation.status !== "FAILURE") return false;
  const flags = [...(validation.flags ?? []), validation.failureType].filter((flag): flag is string => Boolean(flag));
  const blocking = flags.filter((flag) => !isPositiveValidationFlag(flag));
  if (blocking.length === 0) return false;
  return blocking.every((flag) => recoveredEvidenceContradictsFlag(flag, recovered, bugfix));
}

function recoveredEvidenceContradictsFlag(flag: string, recovered: BatchResult, bugfix: BatchResult): boolean {
  if (flag === "MISSING_RUNNABLE_E2E_COMMAND") return hasPassingRunnableE2e(recovered) || hasPassingRunnableE2e(bugfix);
  if (flag.startsWith("ENTRYPOINT_UNVERIFIED:")) {
    const entrypoint = flag.slice("ENTRYPOINT_UNVERIFIED:".length);
    return hasWiringEntrypointEvidence(recovered, entrypoint) || hasWiringEntrypointEvidence(bugfix, entrypoint);
  }
  if (/UNWIRED|DRIFT|NOT_PROPAGATED|MISSING|GAP/i.test(flag)) {
    if (/BUSINESS_LOGIC_DRIFT|AUTHORITY|ALLOWLIST|PAYMENT|TENANT|SECURITY|SECRET|COMMERCIAL|PRICING|BILLING/i.test(flag)) return hasExplicitRelatedFixFlag(flag, bugfix);
    return hasPassingValidationEvidence(bugfix) && (bugfix.flags ?? []).some((fixedFlag) => /WIRED|PROPAGATED|FIXED|PASS|RECOVERED|COVERED|VERIFIED/i.test(fixedFlag));
  }
  return false;
}

function hasExplicitRelatedFixFlag(flag: string, bugfix: BatchResult): boolean {
  const blocker = evidenceKey(flag.replace(/^RESULT_STATUS_FAILURE:/, ""));
  return (bugfix.flags ?? []).some((fixedFlag) => {
    if (!isPositiveValidationFlag(fixedFlag)) return false;
    const fixed = evidenceKey(fixedFlag.replace(/(?:FIXED|PASS|PASSED|WIRED|PROPAGATED|SATISFIED|COVERED|ENFORCED|RECOVERED|VERIFIED)$/i, ""));
    return Boolean(fixed && blocker && (blocker.includes(fixed) || fixed.includes(blocker)));
  });
}

function isPositiveValidationFlag(flag: string): boolean {
  return isPositiveFlag(flag);
}

function hasPassingRunnableE2e(result: BatchResult): boolean {
  const e2e = result.tests?.e2e;
  return Boolean(e2e?.command && e2e.exitCode === 0 && isRunnableValidationCommand(e2e.command));
}

function hasPassingValidationEvidence(result: BatchResult): boolean {
  return Object.values(result.tests ?? {}).some((test) => Boolean(test?.command && test.exitCode === 0));
}

function hasWiringEntrypointEvidence(result: BatchResult, expected: string): boolean {
  const expectedKey = evidenceKey(expected);
  return (result.wiring?.entrypoints ?? []).some((entrypoint) => evidenceKey(typeof entrypoint === "string" ? entrypoint : JSON.stringify(entrypoint)).includes(expectedKey));
}

function evidenceKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isRunnableValidationCommand(command: string | undefined): command is string {
  const value = command?.trim() ?? "";
  if (!value || /^(not applicable|n\/a|none|skipped?|manual|unknown)$/i.test(value)) return false;
  return /^(node|npm|npx|bash|sh|python|python3|ruby|go|cargo|pytest|julia|nim|deno|bun|pnpm|yarn)\b/i.test(value);
}

async function recoverGateFailure(rootCwd: string, cwd: string, batch: Batch, config: RuntimeConfig, context: string, implementation: BatchResult, flags: string[]): Promise<{ result: BatchResult | null; flags: string[] }> {
  if (requiresHumanSecurityApproval(flags) || hasNonRecoverableRuntimeBlocker(flags)) {
    await finishRuntime(rootCwd, "failed", `Batch ${batch.number} requires human/security approval or tooling intervention: ${flags.join(", ")}`);
    return { result: null, flags };
  }
  let recovered = implementation;
  let currentFlags = flags;
  const attempts = Math.max(1, config.recovery?.maxBugfixAttempts ?? 1);
  const maxTotalAttempts = attempts * 4;
  let totalAttempts = 0;
  let currentSignature = failureSignature(currentFlags, "RUNTIME_GATES_REJECTED");
  let attemptForSignature = 0;
  const attemptsByRuntimeOwnedSignature = new Map<string, number>();
  while (totalAttempts < maxTotalAttempts) {
    const nextSignature = failureSignature(currentFlags, "RUNTIME_GATES_REJECTED");
    if (runtimeOwnedFailureRequiresStop(nextSignature)) {
      await finishRuntime(rootCwd, "failed", runtimeOwnedFailureRecommendation(batch.number, nextSignature));
      return { result: null, flags: blockingRecoveryFlags(currentFlags, "RUNTIME_GATES_REJECTED") };
    }
    if (nextSignature !== currentSignature) {
      currentSignature = nextSignature;
      attemptForSignature = 0;
    }
    const runtimeOwnedSignature = isRuntimeOwnedRecoverySignature(currentSignature);
    const previousRuntimeOwnedAttempts = attemptsByRuntimeOwnedSignature.get(currentSignature) ?? 0;
    if (attemptForSignature >= attempts || (runtimeOwnedSignature && previousRuntimeOwnedAttempts >= attempts)) {
      const poisoned = runtimePoisonedRecoveryLoop(currentSignature, currentFlags, "RUNTIME_GATES_REJECTED");
      if (poisoned) return { result: null, flags: [poisoned.code, ...poisoned.flags] };
      break;
    }
    attemptForSignature += 1;
    totalAttempts += 1;
    if (runtimeOwnedSignature) attemptsByRuntimeOwnedSignature.set(currentSignature, previousRuntimeOwnedAttempts + 1);
    const recoveryFlags = blockingRecoveryFlags(currentFlags, "RUNTIME_GATES_REJECTED");
    await setPhase(rootCwd, "bugfix", `Runtime gates rejected batch ${batch.number}; dispatching bugfix recovery attempt ${attemptForSignature}/${attempts} for ${currentSignature}`);
    const pseudoValidation: BatchResult = { ...implementation, status: "FAILURE", failureType: "RUNTIME_GATES_REJECTED", flags: recoveryFlags };
    const bugfix = await runBugfixAgent(rootCwd, cwd, batch, config, context, pseudoValidation, recoveryFlags, totalAttempts);
    const bugfixGate = validateContract(bugfix);
    if (!bugfixGate.passed || bugfix.status !== "SUCCESS") {
      currentFlags = [...bugfixGate.flags, ...(bugfix.flags ?? []), bugfix.failureType ?? "BUGFIX_RECOVERY_FAILED"];
      continue;
    }
    await canonicalizeBatchResultManifests(cwd, batch.number);
    recovered = (await importAgentResultToState(cwd, batch, "bugfix", await mergeRecoveredResultFromDisk(cwd, batch.number, recovered, bugfix))).currentResult;
    await setPhase(rootCwd, "validate", "Re-running runtime gates after gate-failure bugfix recovery");
    const validation = await validateAllWithState(cwd, batch, recovered, config, rootCwd);
    const gates = validation.gates;
    await setGates(rootCwd, gates);
    await writeRuntimeGates(rootCwd, batch, gates);
    const openFindings = blockingOpenFindings(validation.state);
    if (gatesPassed(gates) && openFindings.length === 0) return { result: recovered, flags: [] };
    const adjudication = !gatesPassed(gates) ? await adjudicateIfPossible(rootCwd, cwd, batch, config, context, recovered, gates) : "none";
    if (adjudication === "accepted") return { result: recovered, flags: [] };
    currentFlags = gatesPassed(gates) && openFindings.length > 0 ? openFindings.map((finding) => finding.id) : gates.flatMap((gate) => gate.flags);
    const poisoned = runtimePoisonedRecoveryLoop(currentSignature, currentFlags, "RUNTIME_GATES_REJECTED");
    if (poisoned) {
      await finishRuntime(rootCwd, "failed", runtimePoisonedRecommendation(batch.number, poisoned));
      return { result: null, flags: [poisoned.code, ...currentFlags] };
    }
    if (adjudication === "human") return { result: null, flags: currentFlags };
  }
  const exhausted = recoveryAttemptsExhausted(batch.number, currentSignature, currentFlags, attempts, totalAttempts);
  await finishRuntime(rootCwd, "failed", recoveryAttemptsExhaustedRecommendation(exhausted));
  return { result: null, flags: [exhausted.code, `RECOVERY_SIGNATURE:${exhausted.signature}`, `RECOVERY_ATTEMPTS:${exhausted.attemptsPerSignature}/${exhausted.maxAttemptsPerSignature}`, `RECOVERY_TOTAL_ATTEMPTS:${exhausted.totalAttempts}`, ...exhausted.flags] };
}

export interface RecoveryAttemptsExhausted {
  code: "RECOVERY_ATTEMPTS_EXHAUSTED";
  batchNumber: number;
  signature: string;
  flags: string[];
  attemptsPerSignature: number;
  maxAttemptsPerSignature: number;
  totalAttempts: number;
}

export function recoveryAttemptsExhausted(batchNumber: number, signature: string, flags: string[], maxAttemptsPerSignature: number, totalAttempts: number): RecoveryAttemptsExhausted {
  return {
    code: "RECOVERY_ATTEMPTS_EXHAUSTED",
    batchNumber,
    signature,
    flags: blockingRecoveryFlags(flags, "RUNTIME_GATES_REJECTED"),
    attemptsPerSignature: maxAttemptsPerSignature,
    maxAttemptsPerSignature,
    totalAttempts
  };
}

function recoveryAttemptsExhaustedRecommendation(exhausted: RecoveryAttemptsExhausted): string {
  return `RECOVERY_ATTEMPTS_EXHAUSTED: Batch ${exhausted.batchNumber} exhausted bugfix recovery budget for blocker signature ${exhausted.signature} after ${exhausted.attemptsPerSignature}/${exhausted.maxAttemptsPerSignature} attempts for that signature (${exhausted.totalAttempts} total). Resolve the blocker or increase recovery.maxBugfixAttempts intentionally; do not treat this as an ordinary recoverable continue.`;
}

export interface RuntimePoisonedRecoveryLoop {
  code: "RUNTIME_POISONED_RECOVERY_LOOP";
  signature: string;
  flags: string[];
}

export function runtimePoisonedRecoveryLoop(previousSignature: string, flags: string[], failureType?: string | null): RuntimePoisonedRecoveryLoop | null {
  const signature = failureSignature(flags, failureType);
  if (signature !== previousSignature) return null;
  const blocking = blockingRecoveryFlags(flags, failureType);
  if (blocking.length === 0) return null;
  if (!blocking.every(isRuntimeOwnedRecoveryFlag)) return null;
  return { code: "RUNTIME_POISONED_RECOVERY_LOOP", signature, flags: blocking };
}

function runtimePoisonedRecommendation(batchNumber: number, poisoned: RuntimePoisonedRecoveryLoop): string {
  return `RUNTIME_POISONED_RECOVERY_LOOP: Batch ${batchNumber} repeated runtime/support/tooling blocker signature after a successful bugfix (${poisoned.signature}). Preserve an incident fixture, then clean the failed batch and restart YOLO; do not spend more bugfix attempts on this runtime-owned state.`;
}

function runtimeOwnedFailureRecommendation(batchNumber: number, signature: string): string {
  return `RUNTIME_OWNED_FAILURE_STOP: Batch ${batchNumber} hit runtime/tooling/support-owned blocker signature before product bugfix dispatch (${signature}). Preserve incident evidence if state looks poisoned, refresh/fix the runtime, then restart instead of patching product code.`;
}

export function runtimeOwnedFailureRequiresStop(signature: string): boolean {
  return isRuntimeOwnedRecoverySignature(signature);
}

export function failureSignature(flags: string[], failureType?: string | null): string {
  const normalized = blockingRecoveryFlags(flags, failureType).sort();
  return normalized.join("|") || "UNKNOWN_FAILURE";
}

export function isRuntimeOwnedRecoverySignature(signature: string): boolean {
  const flags = signature.split("|").map((flag) => flag.trim()).filter(Boolean);
  if (flags.length === 0) return false;
  return flags.every((flag) => isRuntimeOwnedRecoveryFlag(flag));
}

export function blockingRecoveryFlags(flags: string[], failureType?: string | null): string[] {
  const normalized = new Set<string>();
  for (const flag of [failureType ?? "UNKNOWN_FAILURE", ...flags]) {
    const cleaned = normalizeRecoveryFlag(flag);
    if (cleaned) normalized.add(cleaned);
  }
  return [...normalized];
}

function normalizeRecoveryFlag(flag: string | null | undefined): string | null {
  const value = flag?.replace(/^RECOVERED_SOURCE_FLAG:/, "").trim();
  if (!value) return null;
  if (isRuntimeRecoveryMetaFlag(value)) return null;
  if (isPositiveValidationFlag(value) || isWarningFlag(value)) return null;
  if (/_(?:LOW|MEDIUM)_FINDING$/i.test(value)) return null;
  return value;
}

function isRuntimeOwnedRecoveryFlag(flag: string): boolean {
  const code = flagCode(flag);
  if (isNonRecoverableRuntimeFlag(flag)) return true;
  if (/^(?:VALIDATOR_REJECTED|PLAN_REJECTED|RUNTIME|BUGFIX|CONTRACT|RESULT_STATUS|GATE|JOURNAL|AGENT|WORKTREE|COMMAND_RERUN|ADJUDICATION)(?:_|$)/i.test(code)) return true;
  if (/^(?:MISSING_|INVALID_).*?(?:ARTIFACT|MANIFEST|RESULT|GATE|JOURNAL|REPORT|SHAPE)/i.test(code)) return true;
  if (/^(?:ARTIFACT|CHANGED_FILE|LOCAL_ONLY_FILE|WIRING_VERIFIER_FILE)_(?:MISSING|MISSING_METADATA)$/i.test(code)) {
    const path = flag.includes(":") ? flag.slice(flag.indexOf(":") + 1).replace(/\\/g, "/") : "";
    return path.startsWith(".yolo/") || path.startsWith(".pi/") || path.startsWith(".agent/") || path === "AGENTS.md" || path === "CLAUDE.md" || path === "docs/progress.md";
  }
  if (/^(?:TEMPLATE_MANAGED_PROTECTED_PATH|PROTECTED_PATH|RUNTIME_ONLY_PATH|SUPPORT_LOOP_STALE)$/i.test(code)) return true;
  if (/^(?:MODULARITY_RULE_FILE_LIMIT_VIOLATION|FUTURE_PHASE_SUCCESS_CRITERIA_RECORDED_AS_MANUAL_NOT_FINDINGS|WORKFLOW_INFERRED_VALIDATE_PRD_RUNTIME_PLACEHOLDER_UNAVAILABLE)$/i.test(code)) return true;
  return false;
}

function requiresHumanSecurityApproval(flags: string[]): boolean {
  return flags.some((flag) => flag.startsWith("EXTERNAL_MUTATION_NOT_ALLOWED:") || flag.startsWith("EXTERNAL_MUTATION_COMMAND_NOT_ALLOWED:") || flag.startsWith("EXTERNAL_MUTATION_EVIDENCE_NOT_ALLOWED:"));
}

export function hasNonRecoverableRuntimeBlocker(flags: string[]): boolean {
  return flags.some(isNonRecoverableRuntimeFlag);
}

export async function canonicalizeBatchResultManifests(cwd: string, batchNumber: number): Promise<string[]> {
  const dir = path.join(cwd, ".yolo/batch-results");
  const padded = String(batchNumber).padStart(3, "0");
  const changed: string[] = [];
  try {
    const files = (await readdir(dir)).filter((file) => file.startsWith(`batch-${padded}-`) && file.endsWith(".json"));
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const result = await readBatchResult(fullPath);
      await writeBatchResult(fullPath, result);
      changed.push(`.yolo/batch-results/${file}`);
    }
  } catch {
    return changed;
  }
  return changed;
}

async function adjudicateIfPossible(rootCwd: string, cwd: string, batch: Batch, config: RuntimeConfig, context: string, result: BatchResult, gates: GateResult[]): Promise<"accepted" | "bugfix" | "human" | "none"> {
  if (!adjudicationAllowed(gates)) return "none";
  const report = adjudicationReport(gates);
  const existing = await readExistingAdjudication(cwd, batch.number);
  if (existing && adjudicationAccepted(existing)) {
    await writeGate(rootCwd, "adjudication", `batch-${String(batch.number).padStart(3, "0")}`, "PASS", batch.number, [`Reused adjudication: ${existing.rationale}`]);
    return "accepted";
  }
  if (existing && adjudicationNeedsBugfix(existing)) return "bugfix";
  if (existing && adjudicationNeedsHuman(existing)) {
    await finishRuntime(rootCwd, "failed", `Adjudication requires human input for batch ${batch.number}: ${existing.rationale}`);
    return "human";
  }
  await setPhase(rootCwd, "validate", `Adjudicating ambiguous runtime findings for batch ${batch.number}`);
  await runAdjudicationAgent(rootCwd, cwd, batch, config, context, result, report);
  const adjudication = await readAdjudicationFile(path.join(cwd, `.yolo/batch-results/batch-${String(batch.number).padStart(3, "0")}-adjudicate.json`));
  if (!adjudication) return "none";
  await copyBatchResultArtifacts(cwd, rootCwd, batch, "adjudicate");
  if (adjudicationAccepted(adjudication)) {
    await writeGate(rootCwd, "adjudication", `batch-${String(batch.number).padStart(3, "0")}`, "PASS", batch.number, [`Accepted ambiguities: ${report.ambiguities.map((finding) => finding.message).join(", ")}`, `Rationale: ${adjudication.rationale}`]);
    return "accepted";
  }
  if (adjudicationNeedsBugfix(adjudication)) return "bugfix";
  await finishRuntime(rootCwd, "failed", `Adjudication requires human input for batch ${batch.number}: ${adjudication.rationale}`);
  return "human";
}

async function runAdjudicationAgent(rootCwd: string, cwd: string, batch: Batch, config: RuntimeConfig, context: string, result: BatchResult, report: unknown): Promise<BatchResult> {
  const id = `batch-${String(batch.number).padStart(3, "0")}-adjudicate`;
  const adjudicationContext = [
    context,
    "# Runtime Ambiguity Adjudication",
    `Batch: ${batch.number}`,
    "## Normalized Result JSON",
    JSON.stringify(result, null, 2),
    "## Gate Finding Report",
    JSON.stringify(report, null, 2),
    "## Runtime instruction",
    "Accept only adjudicable ambiguity. Do not override hard safety failures. Write markdown and JSON adjudication artifacts."
  ].join("\n\n");
  await setAgent(rootCwd, "adjudicate", id);
  return runSubagent({ id, role: "adjudicate", promptFile: ".agent/agents/yolo/yolo-subagent-adjudicate.md", context: adjudicationContext, outputBase: `.yolo/batch-results/${id}`, cwd, route: config.models.adjudicate, telemetryRoot: rootCwd });
}

async function runBugfixAgent(rootCwd: string, cwd: string, batch: Batch, config: RuntimeConfig, context: string, validation: BatchResult, flags: string[], attempt = 1): Promise<BatchResult> {
  const id = `batch-${String(batch.number).padStart(3, "0")}-bugfix${attempt > 1 ? `-${attempt}` : ""}`;
  const bugContext = [
    context,
    "# Validation Failure Recovery",
    `Batch: ${batch.number}`,
    `Failure flags: ${flags.join(", ")}`,
    "## Validator Result JSON",
    JSON.stringify(validation, null, 2),
    "## Runtime instruction",
    "Fix the root cause in this same worktree. Do not commit. Write both markdown and JSON result files using the runtime machine contract. Include every fixed file in filesChanged."
  ].join("\n\n");
  await setAgent(rootCwd, "bugfix", id);
  return runSubagent({ id, role: "bugfix", promptFile: ".agent/agents/yolo/yolo-subagent-bugfix.md", context: bugContext, outputBase: `.yolo/batch-results/${id}`, cwd, route: config.models.bugfix, telemetryRoot: rootCwd });
}

function resultFlags(result: BatchResult): string[] {
  return Array.isArray(result.flags) ? result.flags : result.flags === undefined ? [] : ["INVALID_FLAGS_SHAPE"];
}

async function reuseOrRunJournalAgent(rootCwd: string, cwd: string, batch: Batch, config: RuntimeConfig, context: string, state?: RuntimeBatchState, result?: BatchResult): Promise<BatchResult | null> {
  const existing = await readExistingJournalResult(cwd, batch);
  if (existing) {
    await setPhase(rootCwd, "journal", "Reusing existing valid journal artifacts");
    await markJournalDecision(rootCwd, batch.number, "reused_existing", "valid journal artifacts already exist");
    await writeGate(cwd, "journal", `batch-${String(batch.number).padStart(3, "0")}`, "PASS", batch.number);
    await setGates(rootCwd, [{ name: "journal", passed: true, flags: [] }]);
    return existing;
  }
  if (result) {
    const deterministic = await writeDeterministicJournal({ cwd, batch, result, config, runtimeState: state }).catch(async (error) => {
      await markJournalDecision(rootCwd, batch.number, "fallback", error instanceof Error ? error.message : String(error));
      return null;
    });
    if (deterministic) {
      await setPhase(rootCwd, "journal", "Writing deterministic build journal fast path");
      await markJournalDecision(rootCwd, batch.number, "fast_path_used", "eligible simple validated batch");
      await setGates(rootCwd, [{ name: "journal", passed: true, flags: [] }]);
      return deterministic;
    }
    await markJournalDecision(rootCwd, batch.number, "fallback", "deterministic journal not eligible or contract failed");
  }
  return runJournalAgent(rootCwd, cwd, batch, config, context);
}

async function readExistingJournalResult(cwd: string, batch: Batch): Promise<BatchResult | null> {
  const padded = String(batch.number).padStart(3, "0");
  const candidates = [`batch-${padded}-journal-retry.json`, `batch-${padded}-journal.json`];
  for (const file of candidates) {
    const result = await readBatchResult(path.join(cwd, `.yolo/batch-results/${file}`));
    const contract = validateJournalContract(result);
    if (contract.passed && result.status === "SUCCESS") return result;
  }
  return null;
}

export async function journalSource(cwd: string, batch: Batch): Promise<{ file: string; type: string }> {
  const padded = String(batch.number).padStart(3, "0");
  const dir = path.join(cwd, ".yolo/batch-results");
  const candidates = await journalSourceCandidates(dir, padded, batch.type);
  for (const candidate of candidates) {
    if (await exists(path.join(cwd, candidate.file))) return candidate;
  }
  return { file: `.yolo/batch-results/batch-${padded}-${batch.type === "audit" ? "audit" : "implement"}.md`, type: batch.type === "audit" ? "audit" : "implement" };
}

async function journalSourceCandidates(dir: string, padded: string, batchType: Batch["type"]): Promise<Array<{ file: string; type: string }>> {
  const bugfixes = await latestBugfixJournalSources(dir, padded);
  const base = batchType === "audit"
    ? [
      { file: `.yolo/batch-results/batch-${padded}-audit.md`, type: "audit" },
      { file: `.yolo/batch-results/batch-${padded}-validate.md`, type: "validate" },
      { file: `.yolo/batch-results/batch-${padded}-implement.md`, type: "implement" }
    ]
    : [{ file: `.yolo/batch-results/batch-${padded}-implement.md`, type: "implement" }];
  return [...bugfixes, ...base];
}

async function latestBugfixJournalSources(dir: string, padded: string): Promise<Array<{ file: string; type: string }>> {
  try {
    const candidates: Array<{ file: string; order: number }> = [];
    for (const file of await readdir(dir)) {
      if (!file.startsWith(`batch-${padded}-bugfix`) || !file.endsWith(".md")) continue;
      const json = await readBatchResult(path.join(dir, file.replace(/\.md$/, ".json")));
      if (json.status !== "SUCCESS") continue;
      candidates.push({ file, order: bugfixJournalOrder(file) });
    }
    return candidates
      .sort((a, b) => b.order - a.order || b.file.localeCompare(a.file))
      .map((candidate) => ({ file: `.yolo/batch-results/${candidate.file}`, type: "bugfix" }));
  } catch {
    return [];
  }
}

function bugfixJournalOrder(file: string): number {
  const match = /-bugfix(?:-(\d+))?\.md$/.exec(file);
  return match?.[1] ? Number(match[1]) : 1;
}

async function runJournalAgent(rootCwd: string, cwd: string, batch: Batch, config: RuntimeConfig, context: string): Promise<BatchResult | null> {
  const id = `batch-${String(batch.number).padStart(3, "0")}-journal`;
  const source = await journalSource(cwd, batch);
  await setPhase(rootCwd, "journal", `Writing build journal from ${source.type} result`);
  await setAgent(rootCwd, "journal", id);
  let result = await runSubagent({ id, role: "journal", promptFile: ".agent/agents/yolo/yolo-subagent-journal.md", context, outputBase: `.yolo/batch-results/${id}`, cwd, route: config.models.journal, telemetryRoot: rootCwd, promptVars: { BATCH_RESULT_FILE: source.file, BATCH_TYPE: source.type } });
  let contract = validateJournalContract(result);
  if (!(contract.passed && result.status === "SUCCESS") && config.recovery?.retryJournalOnce) {
    const retryId = `${id}-retry`;
    const retryFlags = [...contract.flags, ...resultFlags(result)];
    await markSelfHeal(rootCwd, "journal", "journal", true, [`retry:${retryId}`, ...retryFlags]);
    await setAgent(rootCwd, "journal", retryId);
    const retryContext = `${context}\n\n---\n\n# Journal Retry\nPrevious journal failed: ${retryFlags.join(", ")}. Source result file is ${source.file}; source type is ${source.type}. Rewrite the journal entry and gate evidence, then emit valid JSON.`;
    result = await runSubagent({ id: retryId, role: "journal", promptFile: ".agent/agents/yolo/yolo-subagent-journal.md", context: retryContext, outputBase: `.yolo/batch-results/${retryId}`, cwd, route: config.models.journal, telemetryRoot: rootCwd, promptVars: { BATCH_RESULT_FILE: source.file, BATCH_TYPE: source.type } });
    contract = validateJournalContract(result);
  }
  await writeGate(cwd, "journal", `batch-${String(batch.number).padStart(3, "0")}`, contract.passed && result.status === "SUCCESS" ? "PASS" : "FAIL", batch.number, [...contract.flags, ...resultFlags(result)]);
  if (contract.passed && result.status === "SUCCESS") {
    await setGates(rootCwd, [{ name: "journal", passed: true, flags: [] }]);
    return result;
  }
  const flags = [...contract.flags, ...resultFlags(result), result.failureType ?? "JOURNAL_REJECTED"];
  await finishRuntime(rootCwd, "failed", `Journal agent rejected batch ${batch.number}: ${flags.join(", ")}`);
  rejectBatch(batch.number, flags);
  return null;
}

async function runValidator(rootCwd: string, cwd: string, batch: Batch, config: RuntimeConfig, context: string): Promise<BatchResult> {
  const id = `batch-${String(batch.number).padStart(3, "0")}-validate`;
  await setAgent(rootCwd, "validate", id);
  await runSubagent({ id, role: "validate", promptFile: ".agent/agents/yolo/yolo-subagent-validate.md", context, outputBase: `.yolo/batch-results/${id}`, cwd, route: config.models.validate, telemetryRoot: rootCwd });
  return readBatchResult(`${cwd}/.yolo/batch-results/${id}.json`);
}

async function handleRejected(cwd: string, batch: Batch, result: BatchResult, flags: string[], config: RuntimeConfig): Promise<void> {
  if (config.recovery?.selfHealRuntime && isSelfHealingSafetyBlocker(flags)) await markSelfHeal(cwd, "reject", "safety", false, flags.slice(0, 12));
  await cleanupDockerForBatch(cwd, batch.number, "failure", config);
  const update = await recordFailure(cwd, batch, { ...result, flags }, config.reinforcementThreshold);
  if (update?.thresholdReached && !update.reinforced) await runReinforcement(cwd, batch, flags, config, update.key);
  const terminalMessage = flags.includes("RUNTIME_POISONED_RECOVERY_LOOP")
    ? runtimePoisonedRecommendation(batch.number, { code: "RUNTIME_POISONED_RECOVERY_LOOP", signature: failureSignature(flags, result.failureType), flags: blockingRecoveryFlags(flags, result.failureType) })
    : flags.includes("RECOVERY_ATTEMPTS_EXHAUSTED")
      ? `RECOVERY_ATTEMPTS_EXHAUSTED: Batch ${batch.number} exhausted recovery budget: ${flags.join(", ")}`
      : `Batch ${batch.number} rejected: ${flags.join(", ")}`;
  await finishRuntime(cwd, "failed", terminalMessage);
  if (shouldCapturePoisonedBatchIncidentFixture(flags, result.failureType)) {
    try {
      const fixture = await capturePoisonedBatchIncidentFixture(cwd, batch, result, flags);
      console.error(`Incident fixture captured: ${path.relative(cwd, fixture.dir).split(path.sep).join("/")}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Incident fixture capture failed: ${message}`);
    }
  }
  rejectBatch(batch.number, flags);
}

export function shouldCapturePoisonedBatchIncidentFixture(flags: string[], failureType?: string | null): boolean {
  return flags.includes("RUNTIME_POISONED_RECOVERY_LOOP") || runtimeOwnedFailureRequiresStop(failureSignature(flags, failureType));
}

async function cleanupDockerForBatch(cwd: string, batchNumber: number, outcome: "success" | "failure", config: RuntimeConfig): Promise<void> {
  if (config.docker?.cleanupBatchResources === false) return;
  await setPhase(cwd, "cleanup", `Cleaning Docker resources for batch ${batchNumber}`);
  try {
    const result = await cleanupBatchDockerResources(cwd, batchNumber, outcome, config.docker);
    if (result.skipped) await writeGate(cwd, "docker-cleanup", `batch-${String(batchNumber).padStart(3, "0")}`, "PASS", batchNumber, [`project:${result.project}`, `skipped:${result.skipped}`]);
    else await writeGate(cwd, "docker-cleanup", `batch-${String(batchNumber).padStart(3, "0")}`, "PASS", batchNumber, [`project:${result.project}`, ...result.actions]);
  } catch (error) {
    const kind = classifySelfHealError(error);
    if (!config.recovery?.selfHealRuntime || kind === "safety" || kind === "unknown") throw error;
    const message = error instanceof Error ? error.message : String(error);
    await markSelfHeal(cwd, "cleanup", kind, true, [`cleanup-skipped:${message}`]);
    await writeGate(cwd, "docker-cleanup", `batch-${String(batchNumber).padStart(3, "0")}`, "PASS", batchNumber, [`self-healed:${kind}`, `cleanup-skipped:${message}`]);
  }
}

async function runReinforcement(cwd: string, batch: Batch, flags: string[], config: RuntimeConfig, key: string): Promise<void> {
  const id = `batch-${String(batch.number).padStart(3, "0")}-reinforce`;
  const context = [`# Reinforcement Trigger`, `Batch: ${batch.number}`, `Failure key: ${key}`, `Flags: ${flags.join(", ")}`].join("\n");
  await setAgent(cwd, "validate", id);
  const result = await runSubagent({ id, role: "validate", promptFile: ".agent/agents/yolo/yolo-subagent-reinforce.md", context, outputBase: `.yolo/batch-results/${id}`, cwd, route: config.models.validate, telemetryRoot: cwd });
  if (result.status === "SUCCESS") await markReinforced(cwd, key);
}

function rejectBatch(batchNumber: number, flags: string[]): void {
  console.error(`Batch ${batchNumber} rejected: ${flags.join(", ")}`);
  process.exitCode = 2;
}
