import type { BatchResult, GateResult, RuntimeConfig } from "../types.js";
import { isGeneratedDependencyPath, isRuntimeOwnedPath, isSafeRelativePath, isTemplateManagedProtectedPath, matchesAnyPolicyPattern, normalizeRuntimePath } from "../path-policy.js";

export function validatePaths(files: string[], config: RuntimeConfig, result?: BatchResult): GateResult {
  const flags = [];
  for (const rawFile of files) {
    const file = normalizeRuntimePath(rawFile);
    if (!isSafeRelativePath(rawFile, file)) {
      flags.push(`UNSAFE_PATH:${rawFile}`);
      continue;
    }
    const policyFile = file.toLowerCase();
    if (isRuntimeOwnedPath(policyFile)) {
      flags.push(`RUNTIME_ONLY_PATH:${rawFile}`);
      continue;
    }
    if (isTemplateManagedProtectedPath(policyFile) && !isEvidenceBackedProtectedContextUpdate(file, result)) {
      flags.push(`TEMPLATE_MANAGED_PROTECTED_PATH:${rawFile}`);
      continue;
    }
    const explicitlyAllowed = matchesAnyPolicyPattern(policyFile, config.policy.allowedGeneratedPaths);
    const evidenceAllowed = isEvidenceBackedProtectedContextUpdate(file, result);
    const blocked = !explicitlyAllowed && !evidenceAllowed && matchesAnyPolicyPattern(policyFile, config.policy.blockedPaths);
    if (blocked) flags.push(`BLOCKED_PATH:${rawFile}`);
    if (!explicitlyAllowed && !evidenceAllowed && matchesAnyPolicyPattern(policyFile, config.policy.protectedPaths)) flags.push(`PROTECTED_PATH:${rawFile}`);
    if (!blocked && !explicitlyAllowed && !evidenceAllowed && isGeneratedDependencyPath(policyFile)) flags.push(`GENERATED_DEPENDENCY_PATH:${rawFile}`);
  }
  return { name: "paths", passed: flags.length === 0, flags };
}

function isEvidenceBackedProtectedContextUpdate(file: string, result?: BatchResult): boolean {
  if (file !== ".agent/rules/CODEBASE_CONTEXT.md") return false;
  const text = JSON.stringify({ flags: result?.flags ?? [], itemsCompleted: result?.itemsCompleted ?? [], tests: result?.tests ?? {}, businessLogic: result?.businessLogic ?? {} });
  const fixesBrokenDocumentedCommand = /BROKEN_DOCUMENTED_.*COMMAND|DOCUMENTED_.*COMMAND_(?:PASS|FIXED)|DOCUMENTED_CHECK_FAILED|documented .*command/i.test(text);
  const hasRunnableEvidence = /exitCode"?:0|"exitCode"\s*:\s*0|passed|PASS/i.test(text) && /command|test|check/i.test(text);
  return fixesBrokenDocumentedCommand && hasRunnableEvidence;
}
