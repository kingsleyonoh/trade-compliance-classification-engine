import { cp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, exists } from "./util/fs.js";
import { gitStatus } from "./util/git.js";
import { execCommand } from "./util/process.js";
import { classifyRuntimePath, isRuntimeArtifactDeliverablePath, isRuntimeOperationalPath, isRuntimeOwnedPath, isSafeRelativePath as isSafePath, isSyncExcludedPath, isVendoredKlevarToolingPath, normalizeRuntimePath } from "./path-policy.js";
import type { GateResult } from "./types.js";

export async function syncLocalOnlyFilesToRoot(worktree: string, root: string, paths: string[] = []): Promise<string[]> {
  const synced: string[] = [];
  for (const rel of uniqueNormalized(paths)) {
    if (!isSafeRelative(rel) || isUnsafeLocalOnlyPath(rel)) throw new Error(`LOCAL_ONLY_PATH_UNSAFE:${rel}`);
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
  await assertNoRejectedSyncPaths(paths, worktree, root);
  await assertMergeReady(worktree, root, paths, candidatePaths.length > 0);
  const synced: string[] = [];
  for (const rel of uniqueNormalized(paths)) {
    if (shouldExclude(rel) || !isSafeRelative(rel)) continue;
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
  return statuses.flatMap((line) => parseStatusLine(line)).filter((value): value is string => Boolean(value));
}

function parseStatusLine(line: string): string[] {
  if (!line.trim()) return [];
  const rawPath = line.length >= 4 && line[2] === " " ? line.slice(3).trim() : line.replace(/^\S+\s+/, "").trim();
  return rawPath.includes(" -> ") ? rawPath.split(" -> ").map((value) => value.trim()).filter(Boolean) : [rawPath];
}

function uniqueNormalized(paths: string[]): string[] {
  return [...new Set(paths.map(normalizeRuntimePath).filter(Boolean))];
}

export async function validateWorktreeMergeReadiness(worktree: string, root: string, candidatePaths: string[] = []): Promise<GateResult> {
  if (worktree === root) return { name: "merge-readiness", passed: true, flags: [] };
  const paths = candidatePaths.length ? candidatePaths : await changedPathsFromGit(worktree);
  try {
    await assertNoRejectedSyncPaths(paths, worktree, root);
    await assertMergeReady(worktree, root, paths, candidatePaths.length > 0);
    return { name: "merge-readiness", passed: true, flags: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: "merge-readiness", passed: false, flags: [`MERGE_READINESS_FAILED:${message}`] };
  }
}

async function assertMergeReady(worktree: string, root: string, candidatePaths: string[], strictDeclared: boolean): Promise<void> {
  if (strictDeclared) await assertDeclaredWorktreeChanges(worktree, candidatePaths);
  await assertRootDoesNotConflict(worktree, root, candidatePaths);
}

async function assertDeclaredWorktreeChanges(worktree: string, candidatePaths: string[]): Promise<void> {
  const declared = new Set(uniqueNormalized(candidatePaths).filter((item) => !shouldExclude(item)));
  const actualEntries = (await changedPathEntriesFromGit(worktree)).filter((entry) => !shouldIgnoreUndeclaredActual(entry.path));
  const missing: string[] = [];
  for (const entry of actualEntries) {
    if (declared.has(entry.path) || declaredCoversActualPath(declared, entry.path)) continue;
    if (await isNonMaterialStatusOnlyChange(worktree, entry)) continue;
    missing.push(entry.path);
  }
  if (missing.length) throw new Error(`WORKTREE_CHANGED_FILES_UNDECLARED:${missing.join(",")}`);
}

async function assertRootDoesNotConflict(worktree: string, root: string, candidatePaths: string[]): Promise<void> {
  const candidates = new Set(uniqueNormalized(candidatePaths));
  let dirty: string[] = [];
  try {
    dirty = (await changedPathsFromGit(root)).filter((item) => !shouldExclude(item));
  } catch {
    return;
  }
  const conflicts: string[] = [];
  for (const item of dirty) {
    if (!candidates.has(item) || isRuntimeOwnedSyncConflict(item)) continue;
    if (await pathsHaveSameContent(join(root, item), join(worktree, item))) continue;
    conflicts.push(item);
  }
  if (conflicts.length) throw new Error(`ROOT_DIRTY_PATH_CONFLICT:${conflicts.join(",")}`);
}

function isSafeRelative(path: string): boolean {
  return isSafePath(path);
}

function isUnsafeLocalOnlyPath(path: string): boolean {
  return path === ".git" || path.startsWith(".git/") || isRuntimeOwnedPath(path) || isVendoredKlevarToolingPath(path);
}

function shouldExclude(path: string): boolean {
  return isSyncExcludedPath(path);
}

async function assertNoRejectedSyncPaths(paths: string[], worktree: string, root: string): Promise<void> {
  const rejected: string[] = [];
  for (const item of uniqueNormalized(paths)) {
    const classification = classifyRuntimePath(item);
    if (classification.reason === "git-control-plane" || classification.reason !== "template-managed-protected") continue;
    if (await pathsHaveSameContent(join(root, item), join(worktree, item))) continue;
    rejected.push(item);
  }
  if (rejected.length) throw new Error(`WORKTREE_SYNC_REJECTED_PROTECTED_PATH:${rejected.join(",")}`);
}

function shouldIgnoreUndeclaredActual(path: string): boolean {
  const normalized = normalizeRuntimePath(path);
  if (shouldExclude(normalized)) return true;
  const classification = classifyRuntimePath(normalized);
  return classification.sync === "ignore"
    || classification.reason === "generated-local-output"
    || isRuntimeOperationalPath(normalized)
    || isVendoredKlevarToolingPath(normalized)
    || normalized === ".yolo" || normalized === ".yolo/"
    || /^\.yolo\/(?:batch-results|gates|knowledge-packs|subagent-events)(?:\/|$)/i.test(normalized)
    || normalized === "tools" || normalized === "tools/";
}

async function changedPathEntriesFromGit(worktree: string): Promise<Array<{ path: string; status: string }>> {
  const statuses = await gitStatus(worktree);
  return statuses.flatMap((line) => parseStatusEntries(line));
}

function parseStatusEntries(line: string): Array<{ path: string; status: string }> {
  if (!line.trim()) return [];
  const status = line.length >= 2 ? line.slice(0, 2) : "";
  return parseStatusLine(line).map((path) => ({ path, status }));
}

async function isNonMaterialStatusOnlyChange(worktree: string, entry: { path: string; status: string }): Promise<boolean> {
  if (/[?ADRU]/.test(entry.status)) return false;
  const pathArg = shellSingleQuote(entry.path);
  const unstaged = await execCommand(`git diff --quiet -- ${pathArg}`, worktree, 30_000);
  if (unstaged.exitCode !== 0) return false;
  const staged = await execCommand(`git diff --cached --quiet -- ${pathArg}`, worktree, 30_000);
  return staged.exitCode === 0;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isRuntimeOwnedSyncConflict(path: string): boolean {
  return isRuntimeArtifactDeliverablePath(path);
}

function declaredCoversActualPath(declared: Set<string>, actual: string): boolean {
  const normalized = normalizeRuntimePath(actual);
  for (const item of declared) {
    const declaredPath = normalizeRuntimePath(item);
    const prefix = declaredPath.endsWith("/") ? declaredPath : `${declaredPath}/`;
    const actualPrefix = normalized.endsWith("/") ? normalized : `${normalized}/`;
    if (normalized.startsWith(prefix) || declaredPath.startsWith(actualPrefix)) return true;
  }
  return false;
}

async function pathsHaveSameContent(left: string, right: string): Promise<boolean> {
  try {
    const [leftInfo, rightInfo] = await Promise.all([stat(left), stat(right)]);
    if (leftInfo.isDirectory() || rightInfo.isDirectory()) return leftInfo.isDirectory() && rightInfo.isDirectory();
    if (leftInfo.size !== rightInfo.size) return false;
    const [leftBuffer, rightBuffer] = await Promise.all([readFile(left), readFile(right)]);
    return leftBuffer.equals(rightBuffer);
  } catch {
    return false;
  }
}
