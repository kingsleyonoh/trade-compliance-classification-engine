import type { Batch, BatchResult, GateResult, RuntimeConfig } from "../types.js";
import { importAgentResultToState, loadRuntimeBatchState, recordGateState, writeRuntimeBatchState, type RuntimeBatchState } from "../runtime-batch-state.js";
import { validateContract } from "../result-contracts.js";
import { validateTdd } from "./tdd-validator.js";
import { needsE2e, validateE2e } from "./e2e-validator.js";
import { validateWiring } from "./wiring-validator.js";
import { validateSecrets } from "./secret-validator.js";
import { validatePaths } from "./path-validator.js";
import { validateCommandEvidence } from "./command-validator.js";
import { validateProjectChecks } from "./project-check-validator.js";
import { validateBusinessLogic } from "./business-logic-validator.js";
import { validateArtifacts } from "./artifact-validator.js";
import { validateFrontendImpeccable } from "./frontend-validator.js";
import { validateProductQuality } from "./product-quality-validator.js";
import { validateLocalOnlyFiles } from "./local-only-validator.js";
import { validateProgressContract } from "./progress-contract-validator.js";
import { validateExternalOps } from "./external-ops-validator.js";
import { isBlockingFlag, isPositiveFlag, isWarningFlag } from "../flag-classification.js";
import { markValidator } from "../telemetry.js";

export async function validateAll(cwd: string, batch: Batch, result: BatchResult, config: RuntimeConfig, telemetryCwd = cwd): Promise<GateResult[]> {
  return (await validateAllWithState(cwd, batch, result, config, telemetryCwd)).gates;
}

export async function validateAllWithState(cwd: string, batch: Batch, result: BatchResult, config: RuntimeConfig, telemetryCwd = cwd): Promise<{ gates: GateResult[]; state: RuntimeBatchState }> {
  let state = await loadRuntimeBatchState(cwd, batch, result);
  if (state.currentResult !== result && JSON.stringify(state.currentResult) !== JSON.stringify(result)) state = await importAgentResultToState(cwd, batch, result.agent ?? "implement", result, state);
  const canonical = state.currentResult;
  const cheapGates: GateTask[] = [
    { name: "progress-contract", run: () => validateProgressContract(cwd) },
    { name: "contract", run: () => validateContract(canonical) },
    { name: "tdd", run: () => validateTdd(canonical, config.gates.requireTdd && batch.type === "implement") },
    { name: "e2e", run: () => validateE2e(batch, canonical, config.gates.requireE2eForEntrypoints && needsE2e(batch)) },
    { name: "paths", run: () => validatePaths(canonical.filesChanged, config, canonical) },
    { name: "local-only", run: () => validateLocalOnlyFiles(cwd, canonical, config) },
    { name: "external-ops", run: () => validateExternalOps(canonical, config) },
    { name: "secrets", run: () => validateSecrets(cwd, canonical) },
    { name: "project-local-checks", run: () => config.gates.requireProjectLocalChecks ? validateProjectChecks(cwd, canonical) : { name: "project-local-checks", passed: true, flags: [] } },
    { name: "business-logic", run: () => config.gates.requireBusinessLogicEvidence ? validateBusinessLogic(batch, canonical) : { name: "business-logic", passed: true, flags: [] } },
    { name: "artifacts", run: () => config.gates.requireArtifactUniqueness ? validateArtifacts(cwd, canonical) : { name: "artifacts", passed: true, flags: [] } }
  ];
  const expensiveGates: GateTask[] = [
    { name: "wiring", run: () => validateWiring(cwd, batch, canonical, config.gates.requireWiring) },
    { name: "command-rerun", run: () => validateCommandEvidence(cwd, canonical, telemetryCwd) },
    { name: "frontend", run: () => validateFrontendImpeccable(cwd, batch, canonical, config) },
    { name: "quality", run: () => config.gates.requireProductQuality ? validateProductQuality(cwd, batch, canonical, true) : { name: "quality", passed: true, flags: [] } }
  ];
  const gates: GateResult[] = [];
  for (const task of cheapGates) gates.push(await runGateTask(telemetryCwd, task));
  const blockers = blockingGateNames(gates);
  if ((config.validationMode ?? "balanced") !== "safe" && blockers.length > 0) {
    for (const task of expensiveGates) gates.push(await skippedGate(telemetryCwd, task.name, blockers));
  } else {
    for (const task of expensiveGates) gates.push(await runGateTask(telemetryCwd, task));
  }
  const next = recordGateState(state, gates);
  await writeRuntimeBatchState(cwd, next);
  return { gates, state: next };
}

type GateTask = { name: string; run: () => GateResult | Promise<GateResult> };

async function runGateTask(telemetryCwd: string, task: GateTask): Promise<GateResult> {
  const started = Date.now();
  await markValidator(telemetryCwd, task.name, "started");
  const gate = await task.run();
  await markValidator(telemetryCwd, gate.name, gate.passed ? "passed" : "failed", Date.now() - started, gate.flags.join(", "));
  return gate;
}

async function skippedGate(telemetryCwd: string, name: string, blockers: string[]): Promise<GateResult> {
  const flags = [`SKIPPED_EXPENSIVE_GATE_DUE_TO_CHEAP_BLOCKERS:${blockers.join("|")}`];
  await markValidator(telemetryCwd, name, "skipped", 0, flags[0]);
  return { name, passed: false, flags };
}

function blockingGateNames(gates: GateResult[]): string[] {
  return gates.filter((gate) => gate.flags.some((flag) => isBlockingFlag(flag)) || (!gate.passed && gate.flags.length === 0)).map((gate) => gate.name);
}

export function gatesPassed(gates: GateResult[]): boolean {
  return gates.every((gate) => !gate.flags.some((flag) => isBlockingFlag(flag)) && (gate.passed || gate.flags.every((flag) => isWarningFlag(flag, gate.name) || isPositiveFlag(flag))));
}
