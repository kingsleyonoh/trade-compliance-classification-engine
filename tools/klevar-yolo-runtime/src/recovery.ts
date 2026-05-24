import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pruneFailurePatternsForBatch } from "./failure-patterns.js";
import { exists } from "./util/fs.js";
import { git } from "./util/git.js";

export interface RecoveryResult {
  ok: boolean;
  message: string;
  actions: string[];
  dryRun?: boolean;
}

export interface UndoOptions {
  yes?: boolean;
  push?: boolean;
  revert?: boolean;
}

export async function cleanBatch(cwd: string, batchArg: string, options: { logs?: boolean } = {}): Promise<RecoveryResult> {
  const batch = normalizeBatch(batchArg);
  const actions: string[] = [];
  await removeWorktree(cwd, batch, actions);
  await tryGit(cwd, "worktree prune", actions);
  await tryGit(cwd, `branch -D yolo/batch-${batch}`, actions);
  await removeMatching(join(cwd, ".yolo/batch-results"), `batch-${batch}-`, actions);
  await removeMatching(join(cwd, ".yolo/gates"), `batch-${batch}.md`, actions, true);
  await removePath(join(cwd, `.yolo/events/batch-${batch}.jsonl`), actions);
  await restoreRuntimeJournal(cwd, actions);
  actions.push(...(await pruneFailurePatternsForBatch(cwd, Number(batch))));
  if (options.logs) await removeMatching(join(cwd, ".yolo/logs"), "runtime-", actions);
  await removePath(join(cwd, ".yolo/runtime-state.json"), actions);
  return { ok: true, message: `Cleaned YOLO batch ${batch}.`, actions };
}

export async function undoLast(cwd: string, options: UndoOptions = {}): Promise<RecoveryResult> {
  const hash = await git(cwd, "rev-parse --short HEAD");
  const message = await git(cwd, "log -1 --pretty=%s");
  const files = await git(cwd, "show --name-only --pretty=format: HEAD");
  const match = /^feat\(yolo\): complete batch (\d{3})$/.exec(message.trim());
  if (!options.yes && !options.revert) {
    return { ok: true, dryRun: true, message: dryRunMessage("undo last commit", hash, message, files), actions: [] };
  }
  const actions = options.revert ? await revertHead(cwd, options.push) : await resetHead(cwd, options.push);
  if (match) actions.push(...(await cleanBatch(cwd, match[1], { logs: false })).actions);
  return { ok: true, message: `${options.revert ? "Reverted" : "Undid"} last commit ${hash}: ${message}.`, actions };
}

export async function rollbackLast(cwd: string, options: UndoOptions = {}): Promise<RecoveryResult> {
  const hash = await git(cwd, "rev-parse --short HEAD");
  const message = await git(cwd, "log -1 --pretty=%s");
  const match = /^feat\(yolo\): complete batch (\d{3})$/.exec(message.trim());
  if (!match) {
    return { ok: false, message: `HEAD is not a runtime-owned YOLO batch commit: ${message}`, actions: [] };
  }
  const batch = match[1];
  if (!options.yes && !options.revert) {
    const files = await git(cwd, "show --name-only --pretty=format: HEAD");
    return { ok: true, dryRun: true, message: dryRunMessage(`rollback YOLO batch ${batch}`, hash, message, files), actions: [] };
  }
  const actions = options.revert ? await revertHead(cwd, options.push) : await resetHead(cwd, options.push);
  const clean = await cleanBatch(cwd, batch, { logs: false });
  actions.push(...clean.actions);
  return { ok: true, message: `${options.revert ? "Reverted" : "Rolled back"} YOLO batch ${batch}.`, actions };
}

export function normalizeBatch(value: string): string {
  const match = /(?:batch-)?(\d+)/i.exec(value.trim());
  if (!match) throw new Error(`Invalid batch id: ${value}`);
  return match[1].padStart(3, "0");
}

function dryRunMessage(action: string, hash: string, message: string, files: string): string {
  return [
    `Dry-run ${action} ${hash}: ${message}.`,
    "Apply local history rewrite with --yes (git reset --hard HEAD~1).",
    "Apply and update remote with --yes --push (git push --force-with-lease).",
    "Collaboration-safe alternative: use --revert to create a revert commit; add --push to push it.",
    files
  ].join("\n");
}

async function resetHead(cwd: string, push?: boolean): Promise<string[]> {
  const actions = [];
  await git(cwd, "reset --hard HEAD~1");
  actions.push("git reset --hard HEAD~1");
  if (push) {
    await git(cwd, "push --force-with-lease");
    actions.push("git push --force-with-lease");
  }
  return actions;
}

async function revertHead(cwd: string, push?: boolean): Promise<string[]> {
  const actions = [];
  await git(cwd, "revert --no-edit HEAD");
  actions.push("git revert --no-edit HEAD");
  if (push) {
    await git(cwd, "push");
    actions.push("git push");
  }
  return actions;
}

async function restoreRuntimeJournal(cwd: string, actions: string[]): Promise<void> {
  if (!(await exists(join(cwd, ".yolo/journal.md")))) return;
  await tryGit(cwd, "restore -- .yolo/journal.md", actions);
}

async function removeWorktree(cwd: string, batch: string, actions: string[]): Promise<void> {
  const worktreePath = join(cwd, `.yolo/worktrees/batch-${batch}`);
  if (!(await exists(worktreePath))) return;
  try {
    await git(cwd, `worktree remove --force .yolo/worktrees/batch-${batch}`);
    actions.push(`git worktree remove --force .yolo/worktrees/batch-${batch}`);
    return;
  } catch (error) {
    actions.push(`git worktree remove --force .yolo/worktrees/batch-${batch} skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
  await removePath(worktreePath, actions);
}

async function removePath(path: string, actions: string[]): Promise<void> {
  if (!(await exists(path))) return;
  await rm(path, { recursive: true, force: true });
  actions.push(`removed ${path}`);
}

async function removeMatching(dir: string, token: string, actions: string[], contains = false): Promise<void> {
  if (!(await exists(dir))) return;
  for (const name of await readdir(dir)) {
    if (contains ? name.includes(token) : name.startsWith(token)) await removePath(join(dir, name), actions);
  }
}

async function tryGit(cwd: string, args: string, actions: string[]): Promise<void> {
  try {
    await git(cwd, args);
    actions.push(`git ${args}`);
  } catch (error) {
    actions.push(`git ${args} skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}
