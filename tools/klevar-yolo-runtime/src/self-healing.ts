import path from "node:path";
import { rename } from "node:fs/promises";
import { exists, ensureDir } from "./util/fs.js";
import type { RuntimeConfig } from "./types.js";

export type SelfHealKind = "journal" | "runtime-state" | "worktree-cleanup" | "tooling-transient" | "safety" | "unknown";

export interface SelfHealOutcome {
  attempted: boolean;
  healed: boolean;
  blocker?: string;
  actions: string[];
}

const SAFETY_BLOCKERS = [
  /SECRET|CREDENTIAL|TOKEN|KEY_LEAK/i,
  /EXTERNAL_MUTATION|REMOTE_MUTATION|PRODUCTION|LIVE_SERVICE/i,
  /EXTERNALLY_CLAIMED|CLAIMS_CONTRACT|CLAIM_CONFLICT|HUMAN/i,
  /PROTECTED_PATH|BLOCKED_PATH|UNSAFE_PATH|\.env|\.git\//i,
  /AUTH|TENANT|PAYMENT|PERMISSION|PRIVACY|SECURITY|RATE_LIMIT/i,
  /MERGE_CONFLICT|ROOT_DIRTY_PATH_CONFLICT|NON_YOLO_HEAD|COMMIT_FAILED|PUSH_FAILED/i,
  /MIGRATION|SCHEMA|DESTRUCTIVE/i
];

export function isSelfHealingSafetyBlocker(flagsOrMessages: string[]): boolean {
  return flagsOrMessages.some((flag) => SAFETY_BLOCKERS.some((pattern) => pattern.test(flag)));
}

export function classifySelfHealError(error: unknown): SelfHealKind {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  if (isSelfHealingSafetyBlocker([message])) return "safety";
  if (/journal|build-journal|journal_entry|gate_file|JOURNAL_REJECTED/i.test(message)) return "journal";
  if (/runtime-state\.json|Unexpected token|JSON\.parse/i.test(message)) return "runtime-state";
  if (/EBUSY|EPERM|ENOTEMPTY|resource busy|locked|worktree.*(?:remove|cleanup|prune)/i.test(message)) return "worktree-cleanup";
  if (/ENOENT|missing/i.test(message) && /\.yolo[\/\\](?:batch-results|gates|runtime)/i.test(message)) return "tooling-transient";
  return "unknown";
}

export async function withRuntimeSelfHealing<T>(cwd: string, config: RuntimeConfig, phase: string, action: () => Promise<T>, heal?: (kind: SelfHealKind, error: unknown) => Promise<string[]>): Promise<T> {
  const attempts = Math.max(0, config.recovery?.maxSelfHealAttempts ?? 0);
  let lastError: unknown;
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      const kind = classifySelfHealError(error);
      if (attempt >= attempts || !config.recovery?.selfHealRuntime || kind === "safety" || kind === "unknown") break;
      const actions = heal ? await heal(kind, error) : kind === "runtime-state" && config.recovery?.repairUnreadableRuntimeState ? await healUnreadableRuntimeState(cwd) : [];
      if (!actions.length) break;
      // Marking telemetry is owned by callers to avoid a dependency cycle with telemetry.ts.
      void phase;
    }
  }
  throw lastError;
}

export async function healUnreadableRuntimeState(cwd: string): Promise<string[]> {
  const file = path.join(cwd, ".yolo/runtime-state.json");
  if (!(await exists(file))) return [];
  const recoveryDir = path.join(cwd, ".yolo/recovery");
  await ensureDir(recoveryDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(recoveryDir, `runtime-state.${stamp}.bad.json`);
  await rename(file, target);
  return [`archived:${path.relative(cwd, target).replace(/\\/g, "/")}`];
}
