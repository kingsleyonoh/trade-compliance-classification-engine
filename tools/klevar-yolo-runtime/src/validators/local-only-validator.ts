import { exists } from "../util/fs.js";
import { execCommand } from "../util/process.js";
import type { BatchResult, GateResult, RuntimeConfig } from "../types.js";
import { isGeneratedDependencyPath, isRuntimeOwnedPath, matchesAnyPolicyPattern, normalizeComparablePath } from "../path-policy.js";

export async function validateLocalOnlyFiles(cwd: string, result: BatchResult, config: RuntimeConfig): Promise<GateResult> {
  const flags: string[] = [];
  const localOnly = [...new Set((result.localOnlyFiles ?? []).map(normalizeComparablePath))];
  const changed = new Set((result.filesChanged ?? []).map(normalizeComparablePath));
  for (const file of localOnly) {
    if (isRuntimeOwnedPath(file)) flags.push(`LOCAL_ONLY_PATH_UNSAFE:${file}`);
    if (!matchesAnyPolicyPattern(file, config.policy.localOnlyPaths ?? []) && !isGeneratedDependencyPath(file)) flags.push(`LOCAL_ONLY_PATH_NOT_ALLOWED:${file}`);
    if (changed.has(file) || changed.has(file.replace(/\/+$/, "")) || [...changed].some((changedFile) => pathContains(file, changedFile) || pathContains(file.replace(/\/+$/, ""), changedFile))) flags.push(`LOCAL_ONLY_LISTED_AS_CHANGED:${file}`);
    if (!isGeneratedDependencyPath(file) && !(await exists(`${cwd}/${file}`))) flags.push(`LOCAL_ONLY_FILE_MISSING:${file}`);
    const ignored = await execCommand(`git check-ignore ${JSON.stringify(file)}`, cwd, 30000);
    if (ignored.exitCode !== 0) flags.push(`LOCAL_ONLY_NOT_GITIGNORED:${file}`);
  }
  return { name: "local-only", passed: flags.length === 0, flags };
}


function pathContains(parent: string, child: string): boolean {
  const normalizedParent = parent.replace(/\/+$/, "");
  const normalizedChild = child.replace(/\/+$/, "");
  return Boolean(normalizedParent) && normalizedChild.startsWith(`${normalizedParent}/`);
}
