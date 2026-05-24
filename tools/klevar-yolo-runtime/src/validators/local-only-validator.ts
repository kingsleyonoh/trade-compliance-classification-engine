import { exists } from "../util/fs.js";
import { execCommand } from "../util/process.js";
import type { BatchResult, GateResult, RuntimeConfig } from "../types.js";

export async function validateLocalOnlyFiles(cwd: string, result: BatchResult, config: RuntimeConfig): Promise<GateResult> {
  const flags: string[] = [];
  const localOnly = [...new Set(result.localOnlyFiles ?? [])];
  const changed = new Set(result.filesChanged ?? []);
  for (const file of localOnly) {
    if (!matchesAny(file, config.policy.localOnlyPaths ?? []) && !isGeneratedDependencyDir(file)) flags.push(`LOCAL_ONLY_PATH_NOT_ALLOWED:${file}`);
    if (changed.has(file)) flags.push(`LOCAL_ONLY_LISTED_AS_CHANGED:${file}`);
    if (!(await exists(`${cwd}/${file}`))) flags.push(`LOCAL_ONLY_FILE_MISSING:${file}`);
    const ignored = await execCommand(`git check-ignore ${JSON.stringify(file)}`, cwd, 30000);
    if (ignored.exitCode !== 0) flags.push(`LOCAL_ONLY_NOT_GITIGNORED:${file}`);
  }
  return { name: "local-only", passed: flags.length === 0, flags };
}

function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matches(file, pattern));
}

function isGeneratedDependencyDir(file: string): boolean {
  const normalized = file.replace(/\\/g, "/").replace(/\/$/, "");
  return /(^|\/)node_modules$/.test(normalized) || /(^|\/)\.pnpm$/.test(normalized) || /(^|\/)vendor\/bundle$/.test(normalized);
}

function matches(file: string, pattern: string): boolean {
  if (pattern.endsWith("/")) return file.startsWith(pattern);
  if (pattern.includes("*")) return new RegExp(`^${globToRegex(pattern)}$`).test(file);
  return file === pattern || file.startsWith(`${pattern}/`);
}

function globToRegex(pattern: string): string {
  return pattern.split("*").map(escapeRegex).join(".*");
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$+?.()|{}[\]]/g, "\\$&");
}
