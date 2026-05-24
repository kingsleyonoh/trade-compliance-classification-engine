import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { exists } from "./util/fs.js";
import { git } from "./util/git.js";

export interface PruneOptions {
  keepSuccessfulWorktrees: number;
  keepFailedWorktrees?: boolean;
  allSuccess?: boolean;
}

export interface PruneResult {
  pruned: string[];
  kept: string[];
  skipped: string[];
}

export async function pruneSuccessfulWorktrees(cwd: string, options: PruneOptions): Promise<PruneResult> {
  const worktreesDir = join(cwd, ".yolo/worktrees");
  if (!(await exists(worktreesDir))) return { pruned: [], kept: [], skipped: [] };
  const batches = (await readdir(worktreesDir))
    .map((name) => /^batch-(\d{3})$/.exec(name)?.[1])
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => Number(b) - Number(a));

  const successful: string[] = [];
  const skipped: string[] = [];
  for (const batch of batches) {
    if (await isSuccessfulBatch(cwd, batch)) successful.push(batch);
    else skipped.push(`batch-${batch}`);
  }

  const keepCount = Math.max(0, options.allSuccess ? 0 : options.keepSuccessfulWorktrees);
  const kept = successful.slice(0, keepCount).map((batch) => `batch-${batch}`);
  const prune = successful.slice(keepCount);
  const pruned: string[] = [];
  for (const batch of prune) {
    const removed = await removeWorktree(cwd, batch);
    if (removed) pruned.push(`batch-${batch}`);
    else skipped.push(`batch-${batch}:cleanup-busy`);
  }
  if (pruned.length) await tryGit(cwd, "worktree prune");
  return { pruned, kept, skipped };
}

async function isSuccessfulBatch(cwd: string, batch: string): Promise<boolean> {
  return exists(join(cwd, `.yolo/gates/closeout-batch-${batch}.md`));
}

async function removeWorktree(cwd: string, batch: string): Promise<boolean> {
  const rel = `.yolo/worktrees/batch-${batch}`;
  if (await exists(join(cwd, rel))) await tryGit(cwd, `worktree remove ${rel} --force`);
  await tryGit(cwd, `branch -D yolo/batch-${batch}`);
  try {
    await rm(join(cwd, rel), { recursive: true, force: true });
    return true;
  } catch (error) {
    if (isTransientRemoveError(error)) return false;
    return false;
  }
}

export function isTransientRemoveError(error: unknown): boolean {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
  return ["EBUSY", "ENOTEMPTY", "EPERM", "EACCES"].includes(code);
}

async function tryGit(cwd: string, args: string): Promise<void> {
  try {
    await git(cwd, args);
  } catch {
    // Best-effort retention cleanup must not fail a successful batch.
  }
}
