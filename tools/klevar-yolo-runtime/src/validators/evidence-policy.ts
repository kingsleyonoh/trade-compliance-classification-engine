import type { TestEvidence } from "../types.js";

const NON_RUNNABLE_COMMAND = /^(?:N\/A|not applicable|not run|skipped|none|manual)$/i;
const DISHONEST_SKIP_CLAIM = /covered by integration|deferred|not needed|manual(?: testing)? only|manually verified|manual check|will do later|not enough time/i;

export function isRunnableEvidence(evidence?: Pick<TestEvidence, "command">): boolean {
  const command = evidence?.command?.trim() ?? "";
  return command.length > 0 && !NON_RUNNABLE_COMMAND.test(command);
}

export function isPassingRunnableEvidence(evidence?: Pick<TestEvidence, "command" | "exitCode">): boolean {
  return Boolean(evidence && isRunnableEvidence(evidence) && evidence.exitCode === 0);
}

export function hasDishonestSkipClaim(text: string): boolean {
  return DISHONEST_SKIP_CLAIM.test(text);
}
