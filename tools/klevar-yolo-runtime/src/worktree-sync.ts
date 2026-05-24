import { cp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, exists } from "./util/fs.js";
import { gitStatus } from "./util/git.js";

const EXCLUDED_PREFIXES = [".git", ".yolo/worktrees/", ".yolo/pi-sessions/", ".yolo/subagent-prompts/", ".yolo/subagent-runs/", ".yolo/events/", ".yolo/logs/", ".yolo/runtime-state.json"];

export async function syncLocalOnlyFilesToRoot(worktree: string, root: string, paths: string[] = []): Promise<string[]> {
  const synced: string[] = [];
  for (const rel of uniqueNormalized(paths)) {
    const source = join(worktree, rel);
    if (!(await exists(source))) continue;
    const dest = join(root, rel);
    const info = await stat(source);
    await ensureDir(join(dest, ".."));
    await cp(source, dest, { recursive: info.isDirectory(), force: true });
    synced.push(rel);
  }
  return synced;
}

export async function syncWorktreeChangesToRoot(worktree: string, root: string, candidatePaths: string[] = []): Promise<string[]> {
  if (worktree === root) return [];
  const paths = candidatePaths.length ? candidatePaths : await changedPathsFromGit(worktree);
  const synced: string[] = [];
  for (const rel of uniqueNormalized(paths)) {
    if (shouldExclude(rel)) continue;
    const source = join(worktree, rel);
    const dest = join(root, rel);
    if (!(await exists(source))) {
      await rm(dest, { recursive: true, force: true });
      synced.push(rel);
      continue;
    }
    const info = await stat(source);
    await ensureDir(join(dest, ".."));
    await cp(source, dest, { recursive: info.isDirectory(), force: true });
    synced.push(rel);
  }
  return synced;
}

async function changedPathsFromGit(worktree: string): Promise<string[]> {
  const statuses = await gitStatus(worktree);
  return statuses.map((line) => parseStatusLine(line)).filter((value): value is string => Boolean(value));
}

function parseStatusLine(line: string): string | null {
  if (line.length < 4) return null;
  const rawPath = line.slice(3).trim();
  return rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() ?? rawPath : rawPath;
}

function uniqueNormalized(paths: string[]): string[] {
  return [...new Set(paths.map((path) => path.replace(/\\/g, "/").trim()).filter(Boolean))];
}

function shouldExclude(path: string): boolean {
  return EXCLUDED_PREFIXES.some((prefix) => {
    const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
    return path === prefix || path.startsWith(normalizedPrefix);
  });
}
