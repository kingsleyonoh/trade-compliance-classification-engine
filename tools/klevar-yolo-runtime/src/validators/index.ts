import type { Batch, BatchResult, GateResult, RuntimeConfig } from "../types.js";
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
  return [
    await validateProgressContract(cwd),
    validateContract(result),
    validateTdd(result, config.gates.requireTdd && batch.type === "implement"),
    validateE2e(result, config.gates.requireE2eForEntrypoints && needsE2e(batch)),
    await validateWiring(cwd, batch, result, config.gates.requireWiring),
    validatePaths(result.filesChanged, config, result),
    await validateLocalOnlyFiles(cwd, result, config),
    validateExternalOps(result, config),
    await validateSecrets(cwd, result),
    await validateCommandEvidence(cwd, result, telemetryCwd),
    config.gates.requireProjectLocalChecks ? await validateProjectChecks(cwd, result) : { name: "project-local-checks", passed: true, flags: [] },
    config.gates.requireBusinessLogicEvidence ? validateBusinessLogic(batch, result) : { name: "business-logic", passed: true, flags: [] },
    await validateFrontendImpeccable(cwd, batch, result, config),
    config.gates.requireProductQuality ? await validateProductQuality(cwd, batch, result, true) : { name: "quality", passed: true, flags: [] },
    config.gates.requireArtifactUniqueness ? await validateArtifacts(cwd, result) : { name: "artifacts", passed: true, flags: [] }
  ];
}

export function gatesPassed(gates: GateResult[]): boolean {
  return gates.every((gate) => gate.passed || gate.flags.every(isWarningFlag));
}

function isWarningFlag(flag: string): boolean {
  return flag.startsWith("QUALITY_WARNING:") || flag.startsWith("IMPECCABLE_DETECTOR_UNAVAILABLE:");
}
