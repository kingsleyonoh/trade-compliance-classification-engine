import { classifyBatchRisk, type RiskClass } from "./runtime-batch-state.js";
import type { Batch, BatchResult } from "./types.js";

export interface ObservedRisk {
  class: RiskClass;
  reasons: string[];
  observedOnly: true;
}

export function classifyObservedRisk(input: { batch: Batch; result?: BatchResult }): ObservedRisk {
  const risk = classifyBatchRisk(input.batch, input.result);
  return { ...risk, observedOnly: true };
}
