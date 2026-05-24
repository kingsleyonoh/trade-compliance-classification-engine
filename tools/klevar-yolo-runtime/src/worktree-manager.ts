import path from "node:path";
import { exists } from "./util/fs.js";
import { git } from "./util/git.js";

export interface WorktreeLease {
  cwd: string;
  branch: string;
  path: string;
}

export async function createWorktree(root: string, id: string, enabled: boolean): Promise<WorktreeLease> {
  if (!enabled) return { cwd: root, branch: await git(root, "rev-parse --abbrev-ref HEAD"), path: root };
  const worktreePath = path.join(root, ".yolo/worktrees", id);
  const branch = `yolo/${id}`;
  if (!(await exists(worktreePath))) {
    await git(root, `worktree add -B ${branch} ${JSON.stringify(worktreePath)} HEAD`);
  }
  return { cwd: worktreePath, branch, path: worktreePath };
}

export async function mergeWorktree(root: string, lease: WorktreeLease): Promise<void> {
  if (lease.path === root) return;
  await git(root, `merge --no-ff ${lease.branch}`);
}
