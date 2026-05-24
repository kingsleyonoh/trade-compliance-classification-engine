import type { BatchResult, GateResult, RuntimeConfig, TestEvidence } from "../types.js";

export function validateExternalOps(result: BatchResult, config: RuntimeConfig): GateResult {
  const flags: string[] = [];
  const allowed = Boolean(config.policy.allowExternalMutations);
  const changedExternal = result.filesChanged.filter(isExternalMutationMarker);
  const commandMutations = collectTestEvidence(result)
    .filter((entry) => entry.evidence.command && isRemoteMutationCommand(entry.evidence.command))
    .map((entry) => `${entry.phase}:${entry.evidence.command}`);
  const evidenceMutations = collectTestEvidence(result)
    .filter((entry) => entry.evidence.evidence && mentionsRemoteMutation(entry.evidence.evidence))
    .map((entry) => `${entry.phase}:${entry.evidence.evidence}`);

  if (!allowed) {
    for (const file of changedExternal) flags.push(`EXTERNAL_MUTATION_NOT_ALLOWED:${file}`);
    for (const command of commandMutations) flags.push(`EXTERNAL_MUTATION_COMMAND_NOT_ALLOWED:${command}`);
    for (const evidence of evidenceMutations) flags.push(`EXTERNAL_MUTATION_EVIDENCE_NOT_ALLOWED:${summarize(evidence)}`);
  }

  return { name: "external-ops", passed: flags.length === 0, flags };
}

function collectTestEvidence(result: BatchResult): Array<{ phase: string; evidence: TestEvidence }> {
  const tests = result.tests ?? {};
  return Object.entries(tests)
    .filter((entry): entry is [string, TestEvidence] => Boolean(entry[1]))
    .map(([phase, evidence]) => ({ phase, evidence }));
}

function isExternalMutationMarker(value: string): boolean {
  const text = value.trim();
  if (/^remote:[^:]+:.+\s\((deleted|removed|created|modified|updated)\)$/i.test(text)) return true;
  if (/^(ssh|scp|sftp|rsync):/i.test(text) && /\b(deleted|removed|created|modified|updated)\b/i.test(text)) return true;
  return false;
}

function isRemoteMutationCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!/\b(?:ssh|scp|sftp|rsync|kubectl|aws|gcloud|az|doctl|flyctl|vercel|netlify)\b/i.test(normalized)) return false;
  return /\b(?:rm|mv|cp|chmod|chown|mkdir|rmdir|touch|truncate|tee|sed\s+-i|perl\s+-pi|docker\s+compose\s+(?:up|down|restart)|systemctl\s+(?:restart|stop|start)|kubectl\s+(?:apply|delete|patch|scale|rollout)|aws\s+s3\s+(?:rm|mv|cp|sync))\b/i.test(normalized);
}

function mentionsRemoteMutation(evidence: string): boolean {
  return /\b(?:after|ran|executed|removed|deleted|created|modified|updated|rotated)\b/i.test(evidence)
    && /`?\b(?:rm|mv|chmod|chown|mkdir|touch|truncate|sed\s+-i|docker\s+compose\s+(?:up|down|restart)|systemctl\s+(?:restart|stop|start)|kubectl\s+(?:apply|delete|patch)|aws\s+s3\s+(?:rm|mv|cp|sync))\b/i.test(evidence)
    && /\b(?:ssh|remote|vps|server|production|prod|host|root@|\/[a-z0-9_-]+\/[a-z0-9_.-]+)\b/i.test(evidence);
}

function summarize(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 220);
}
