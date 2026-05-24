import type { BatchResult, GateResult } from "../types.js";
import { loadProjectChecks } from "../project-checks.js";

export async function validateProjectChecks(cwd: string, result: BatchResult): Promise<GateResult> {
  const checks = await loadProjectChecks(cwd);
  if (checks.length === 0) return { name: "project-local-checks", passed: true, flags: [] };
  const flags = [];
  const evidence = result.projectLocalChecks;
  if (!evidence) flags.push("MISSING_PROJECT_LOCAL_CHECK_EVIDENCE");
  if (evidence && evidence.evaluated < checks.length) flags.push(`PROJECT_LOCAL_CHECKS_UNDER_EVALUATED:${evidence.evaluated}/${checks.length}`);
  for (const triggered of evidence?.triggered ?? []) flags.push(`PROJECT_LOCAL_CHECK_TRIGGERED:${triggered}`);
  return { name: "project-local-checks", passed: flags.length === 0, flags };
}
