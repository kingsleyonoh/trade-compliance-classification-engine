import type { Batch, BatchResult, RuntimeConfig } from "./types.js";
import { classifyBatchRisk, type RiskClass } from "./runtime-batch-state.js";

export type ValidationMode = "safe" | "balanced" | "fast";

export interface ValidationPolicy {
  mode: ValidationMode;
  risk: RiskClass;
  requireAdversarialValidation: boolean;
  allowRegressionCache: boolean;
  requireFullRegression: boolean;
  reasons: string[];
}

export function validationPolicyFor(batch: Batch, result: BatchResult, config: RuntimeConfig): ValidationPolicy {
  const risk = classifyBatchRisk(batch, result);
  const configured = (config as RuntimeConfig & { validationMode?: ValidationMode }).validationMode ?? "balanced";
  const mode: ValidationMode = configured;
  const strict = mode === "safe" || risk.class === "critical";
  const high = risk.class === "high";
  return {
    mode,
    risk: risk.class,
    requireAdversarialValidation: Boolean(config.gates.requireAdversarialValidation && (strict || high || mode !== "fast")),
    allowRegressionCache: mode !== "safe" && risk.class !== "critical",
    requireFullRegression: strict || high || mode === "balanced",
    reasons: risk.reasons
  };
}
