import type { Batch, BatchResult, GateResult, RuntimeConfig } from "../types.js";
import { loadRuntimeBatchState, recordGateState, writeRuntimeBatchState, type RuntimeBatchState } from "../runtime-batch-state.js";
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

export async function validateAll(cwd: string, batch: Batch, result: BatchResult, config: RuntimeConfig, telemetryCwd = cwd): Promise<GateResult[]> {
  return (await validateAllWithState(cwd, batch, result, config, telemetryCwd)).gates;
}

export async function validateAllWithState(cwd: string, batch: Batch, result: BatchResult, config: RuntimeConfig, telemetryCwd = cwd): Promise<{ gates: GateResult[]; state: RuntimeBatchState }> {
  const state = await loadRuntimeBatchState(cwd, batch, result);
  const canonical = state.currentResult;
  const gates = [
    await validateProgressContract(cwd),
    validateContract(canonical),
    validateTdd(canonical, config.gates.requireTdd && batch.type === "implement"),
    validateE2e(batch, canonical, config.gates.requireE2eForEntrypoints && needsE2e(batch)),
    await validateWiring(cwd, batch, canonical, config.gates.requireWiring),
    validatePaths(canonical.filesChanged, config, canonical),
    await validateLocalOnlyFiles(cwd, canonical, config),
    validateExternalOps(canonical, config),
    await validateSecrets(cwd, canonical),
    await validateCommandEvidence(cwd, canonical, telemetryCwd),
    config.gates.requireProjectLocalChecks ? await validateProjectChecks(cwd, canonical) : { name: "project-local-checks", passed: true, flags: [] },
    config.gates.requireBusinessLogicEvidence ? validateBusinessLogic(batch, canonical) : { name: "business-logic", passed: true, flags: [] },
    await validateFrontendImpeccable(cwd, batch, canonical, config),
    config.gates.requireProductQuality ? await validateProductQuality(cwd, batch, canonical, true) : { name: "quality", passed: true, flags: [] },
    config.gates.requireArtifactUniqueness ? await validateArtifacts(cwd, canonical) : { name: "artifacts", passed: true, flags: [] }
  ];
  const next = recordGateState(state, gates);
  await writeRuntimeBatchState(cwd, next);
  return { gates, state: next };
}

export function gatesPassed(gates: GateResult[]): boolean {
  return gates.every((gate) => gate.passed || gate.flags.every(isWarningFlag));
}

function isWarningFlag(flag: string): boolean {
  return flag.startsWith("QUALITY_WARNING:") || flag.startsWith("IMPECCABLE_DETECTOR_UNAVAILABLE:");
}
