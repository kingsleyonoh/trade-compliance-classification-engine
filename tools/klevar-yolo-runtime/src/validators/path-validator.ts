import type { BatchResult, GateResult, RuntimeConfig } from "../types.js";

export function validatePaths(files: string[], config: RuntimeConfig, result?: BatchResult): GateResult {
  const flags = [];
  for (const file of files) {
    const explicitlyAllowed = matchesAny(file, config.policy.allowedGeneratedPaths);
    const evidenceAllowed = isEvidenceBackedProtectedContextUpdate(file, result);
    if (!explicitlyAllowed && !evidenceAllowed && matchesAny(file, config.policy.blockedPaths)) flags.push(`BLOCKED_PATH:${file}`);
    if (!explicitlyAllowed && !evidenceAllowed && matchesAny(file, config.policy.protectedPaths)) flags.push(`PROTECTED_PATH:${file}`);
  }
  return { name: "paths", passed: flags.length === 0, flags };
}

function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matches(file, pattern));
}

function isEvidenceBackedProtectedContextUpdate(file: string, result?: BatchResult): boolean {
  if (file !== ".agent/rules/CODEBASE_CONTEXT.md") return false;
  const text = JSON.stringify({ flags: result?.flags ?? [], itemsCompleted: result?.itemsCompleted ?? [], tests: result?.tests ?? {}, businessLogic: result?.businessLogic ?? {} });
  const fixesBrokenDocumentedCommand = /BROKEN_DOCUMENTED_.*COMMAND|DOCUMENTED_.*COMMAND_(?:PASS|FIXED)|DOCUMENTED_CHECK_FAILED|documented .*command/i.test(text);
  const hasRunnableEvidence = /exitCode"?:0|"exitCode"\s*:\s*0|passed|PASS/i.test(text) && /command|test|check/i.test(text);
  return fixesBrokenDocumentedCommand && hasRunnableEvidence;
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
