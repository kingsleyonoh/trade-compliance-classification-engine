import path from "node:path";

export function normalizeRuntimePath(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "").replace(/\\/g, "/").replace(/^\.\//, "");
}

export function normalizeComparablePath(value: string): string {
  return normalizeRuntimePath(value).replace(/\/+$/, "/");
}

export function isSafeRelativePath(raw: string, normalized = normalizeRuntimePath(raw)): boolean {
  if (!raw || raw.includes("\0")) return false;
  const unquoted = raw.trim().replace(/^['"]|['"]$/g, "");
  if (path.isAbsolute(unquoted) || path.posix.isAbsolute(unquoted.replace(/\\/g, "/")) || path.win32.isAbsolute(unquoted) || /^[A-Za-z]:[\\/]/.test(unquoted) || /^\\\\/.test(unquoted)) return false;
  return !normalized.split("/").includes("..");
}

export type RuntimePathOwner = "product" | "runtime" | "runtime-artifact" | "tooling" | "generated" | "environment";
export type RuntimePathSyncDisposition = "copy" | "ignore" | "reject" | "runtime-artifact";

export interface RuntimePathClassification {
  path: string;
  safe: boolean;
  owner: RuntimePathOwner;
  sync: RuntimePathSyncDisposition;
  deliverable: boolean;
  localOnlyAllowed: boolean;
  reason: string;
}

export function classifyRuntimePath(value: string): RuntimePathClassification {
  const file = normalizeRuntimePath(value);
  const safe = isSafeRelativePath(value, file);
  if (!safe) return { path: file, safe, owner: "product", sync: "reject", deliverable: false, localOnlyAllowed: false, reason: "unsafe-relative-path" };
  if (file === ".git" || file.startsWith(".git/")) return { path: file, safe, owner: "runtime", sync: "reject", deliverable: false, localOnlyAllowed: false, reason: "git-control-plane" };
  if (file === ".env" || file.startsWith(".env.")) return { path: file, safe, owner: "environment", sync: "ignore", deliverable: false, localOnlyAllowed: true, reason: "environment-local-only" };
  if (isRuntimeOwnedPath(file)) return { path: file, safe, owner: "runtime", sync: "ignore", deliverable: false, localOnlyAllowed: false, reason: "runtime-control-plane" };
  if (isTemplateManagedProtectedPath(file)) return { path: file, safe, owner: "tooling", sync: "reject", deliverable: false, localOnlyAllowed: false, reason: "template-managed-protected" };
  if (isRuntimeArtifactDeliverablePath(file)) return { path: file, safe, owner: "runtime-artifact", sync: "runtime-artifact", deliverable: true, localOnlyAllowed: false, reason: "runtime-artifact-deliverable" };
  if (isVendoredKlevarToolingPath(file)) return { path: file, safe, owner: "tooling", sync: "copy", deliverable: true, localOnlyAllowed: false, reason: "vendored-klevar-tooling" };
  if (isGeneratedDependencyPath(file)) return { path: file, safe, owner: "generated", sync: "ignore", deliverable: false, localOnlyAllowed: true, reason: "generated-local-output" };
  return { path: file, safe, owner: "product", sync: "copy", deliverable: true, localOnlyAllowed: false, reason: "product-deliverable" };
}

export function isRuntimeOwnedPath(value: string): boolean {
  const file = normalizeRuntimePath(value).toLowerCase();
  return file === ".yolo/runtime-state.json"
    || file === ".yolo/runtime-lock.json"
    || file === ".yolo/runtime.config.json"
    || /^\.yolo\/(?:runtime|events|logs|worktrees|pi-sessions|subagent-prompts|subagent-runs|incidents)(?:\/|$)/i.test(file);
}

export function isTemplateManagedProtectedPath(value: string): boolean {
  const file = normalizeRuntimePath(value).toLowerCase();
  return file === "agents.md"
    || file === "claude.md"
    || file === ".cursorrules"
    || /^\.agent\/(?:rules|workflows|guides|agents)(?:\/|$)/i.test(file);
}

export function isVendoredKlevarToolingPath(value: string): boolean {
  const file = normalizeRuntimePath(value).toLowerCase();
  return /^tools\/(?:klevar-yolo-runtime|klevar-pi-package)(?:\/|$)/i.test(file);
}

export function isRuntimeArtifactDeliverablePath(value: string): boolean {
  const file = normalizeRuntimePath(value).toLowerCase();
  return /^\.yolo\/(?:batch-results|gates)\/[^/]+\.(?:json|md|jsonl|txt)$/i.test(file);
}

export function isRuntimeOperationalPath(value: string): boolean {
  const file = normalizeRuntimePath(value);
  return isRuntimeOwnedPath(file)
    || isVendoredKlevarToolingPath(file)
    || file === ".yolo/command-cache.json";
}

export function isSyncExcludedPath(value: string): boolean {
  const classification = classifyRuntimePath(value);
  return classification.sync === "ignore" || classification.sync === "reject";
}

export function isGeneratedDependencyPath(value: string): boolean {
  const file = normalizeComparablePath(value).replace(/\/+$/, "");
  return /(^|\/)(?:node_modules|\.pnpm|vendor\/bundle)(?:\/|$)/i.test(file)
    || /(^|\/)(?:dist|build|coverage|\.next)(?:\/|$)/i.test(file);
}

export function matchesPolicyPattern(file: string, pattern: string): boolean {
  const normalizedFile = normalizeRuntimePath(file).toLowerCase();
  const normalizedPattern = normalizeRuntimePath(pattern).toLowerCase();
  if (normalizedPattern.endsWith("/")) return matchesDirectoryPattern(normalizedFile, normalizedPattern);
  if (normalizedPattern.includes("*")) return new RegExp(`^${globToRegex(normalizedPattern)}$`).test(normalizedFile);
  return normalizedFile === normalizedPattern || normalizedFile.startsWith(`${normalizedPattern}/`);
}

export function matchesAnyPolicyPattern(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPolicyPattern(file, pattern));
}

function matchesDirectoryPattern(file: string, pattern: string): boolean {
  const directory = pattern.replace(/\/+$/, "");
  if (!directory) return false;
  if (directory.includes("/")) return file === directory || file.startsWith(`${directory}/`);
  return file === directory || file.startsWith(`${directory}/`) || file.includes(`/${directory}/`) || file.endsWith(`/${directory}`);
}

function globToRegex(pattern: string): string {
  return pattern.split("*").map(escapeRegex).join(".*");
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$+?.()|{}[\]]/g, "\\$&");
}
