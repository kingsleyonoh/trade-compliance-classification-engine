import { normalizeTests } from "../result-contracts.js";
import type { BatchResult, GateResult } from "../types.js";
import { hasDishonestSkipClaim, isPassingRunnableEvidence } from "./evidence-policy.js";

export function validateTdd(result: BatchResult, required: boolean): GateResult {
  if (!required) return { name: "tdd", passed: true, flags: [] };
  const flags = [];
  const tests = normalizeTests(result.tests);
  if (!tests?.red) flags.push("MISSING_RED_EVIDENCE");
  if (!tests?.green) flags.push("MISSING_GREEN_EVIDENCE");
  if (!tests?.regression) flags.push("MISSING_REGRESSION_EVIDENCE");
  if (tests?.red && tests.red.exitCode === 0 && !hasSetupTddException(result) && !isFailingStateProbe(tests.red.command, tests.red.evidence)) flags.push("RED_DID_NOT_FAIL");
  if (tests?.green && tests.green.exitCode !== 0) flags.push("GREEN_DID_NOT_PASS");
  if (tests?.regression && tests.regression.exitCode !== 0) flags.push("REGRESSION_DID_NOT_PASS");
  if (containsDishonestSkip(result) && !hasCompleteObjectiveEvidence(result)) flags.push("DISHONEST_TEST_SKIP_LANGUAGE");
  return { name: "tdd", passed: flags.length === 0, flags };
}

function containsDishonestSkip(result: BatchResult): boolean {
  return hasDishonestSkipClaim(JSON.stringify(result.tests ?? {}));
}

function hasCompleteObjectiveEvidence(result: BatchResult): boolean {
  const tests = normalizeTests(result.tests);
  return Boolean(tests?.red && tests.red.exitCode !== 0 && isPassingRunnableEvidence(tests.green) && isPassingRunnableEvidence(tests.regression));
}

function hasSetupTddException(result: BatchResult): boolean {
  return result.flags.includes("SETUP_TDD_EXCEPTION");
}

function isFailingStateProbe(command: string, evidence: string): boolean {
  const text = `${command}\n${evidence}`;
  const isProbe = /\b(test\s+!?\s*-e|test\s+!?\s*-f|grep\b|rg\b|curl\b|ssh\b|SELECT\b|SHOW\b)/i.test(command);
  const reportsFailureState = /\b(before|pre[- ]?fix|reproduc|returned|reported|observed|matching validator failure|failing acceptance condition)\b/i.test(evidence)
    && /\b(present|absent|found|missing|exists|not found|failure|failed|invalid|drift|blocked)\b/i.test(evidence);
  return isProbe && reportsFailureState && !/\b(after|post[- ]?fix|green|passed after)\b/i.test(text);
}
