import path from "node:path";
import { exists, readText, writeText } from "./util/fs.js";
import type { AgentRole, ModelRoute, RuntimeConfig } from "./types.js";

export const defaultConfig: RuntimeConfig = {
  schemaVersion: 1,
  maxBatchSize: 5,
  validationMode: "balanced",
  reinforcementThreshold: 3,
  speed: { deterministicJournal: true, observeRisk: true, observeAffectedTests: true },
  worktrees: { enabled: true, keepOnFailure: true },
  retention: { keepSuccessfulWorktrees: 2, keepFailedWorktrees: true },
  recovery: { maxBugfixAttempts: 2, retryJournalOnce: true, selfHealRuntime: true, maxSelfHealAttempts: 1, repairUnreadableRuntimeState: true },
  docker: { enabled: true, cleanupBatchResources: true, removeVolumesOnSuccess: true, removeVolumesOnFailure: true },
  collaboration: { enabled: false, claimsDir: "docs/claims", staleClaimHours: 24, maxParallelAgents: 2 },
  frontend: { impeccableCommand: "npx --yes impeccable@latest detect --fast --json", failOnDetectorFindings: true, detectorTimeoutMs: 120000 },
  policy: {
    blockedPaths: [".env", ".env.*", ".git/", "node_modules/", "*.pem", "*.key"],
    protectedPaths: [".agent/rules/", ".agent/workflows/", ".agent/guides/", ".agent/agents/", "AGENTS.md", "CLAUDE.md", ".cursorrules", ".yolo/runtime.config.json"],
    allowedGeneratedPaths: [".env.example", ".yolo/", "docs/build-journal/", "docs/progress.md", ".agent/knowledge/foundation/", ".agent/knowledge/gotchas/", ".agent/knowledge/patterns/", ".agent/knowledge/modules/", ".agent/knowledge/checks/"],
    localOnlyPaths: [".env", ".env.*", "build/test-results/", "build/reports/", "target/surefire-reports/", "target/failsafe-reports/", "coverage/", "dist/", ".next/", ".pytest_cache/", ".coverage"],
    allowExternalMutations: false
  },
  models: {
    master: { thinking: "xhigh", tools: ["read", "bash"] },
    knowledge: { thinking: "medium", tools: ["read", "write"], timeoutSeconds: 300 },
    inbox: { thinking: "low", tools: ["read", "write"], timeoutSeconds: 180 },
    implement: { thinking: "xhigh", tools: ["read", "bash", "edit", "write"], budget: { staleMs: 30 * 60_000, maxToolCalls: 300 } },
    validate: { thinking: "high", tools: ["read", "bash"], budget: { staleMs: 30 * 60_000, maxToolCalls: 300 } },
    journal: { thinking: "low", tools: ["read", "edit", "write"], budget: { staleMs: 15 * 60_000, maxToolCalls: 120 } },
    audit: { thinking: "xhigh", tools: ["read", "bash", "write"], budget: { staleMs: 30 * 60_000, maxToolCalls: 250 } },
    bugfix: { thinking: "high", tools: ["read", "bash", "edit", "write"], budget: { staleMs: 30 * 60_000, maxToolCalls: 300 } },
    adjudicate: { thinking: "xhigh", tools: ["read", "bash", "write"] }
  },
  gates: {
    requireTdd: true,
    requireE2eForEntrypoints: true,
    requireWiring: true,
    requireAdversarialValidation: true,
    requireProjectLocalChecks: true,
    requireBusinessLogicEvidence: true,
    requireArtifactUniqueness: true,
    requireFrontendImpeccable: true,
    requireProductQuality: true
  }
};

export async function loadConfig(cwd: string): Promise<RuntimeConfig> {
  const file = path.join(cwd, ".yolo/runtime.config.json");
  if (!(await exists(file))) {
    await writeText(file, JSON.stringify(defaultConfig, null, 2) + "\n");
    return defaultConfig;
  }
  return mergeConfig(defaultConfig, JSON.parse(await readText(file)) as Partial<RuntimeConfig>);
}

function mergeConfig(base: RuntimeConfig, override: Partial<RuntimeConfig>): RuntimeConfig {
  return {
    ...base,
    ...override,
    worktrees: { ...base.worktrees, ...override.worktrees },
    retention: { ...base.retention, ...override.retention },
    speed: { ...(base.speed ?? defaultConfig.speed!), ...(override.speed ?? {}) },
    recovery: { ...(base.recovery ?? defaultConfig.recovery!), ...(override.recovery ?? {}) },
    docker: { ...(base.docker ?? defaultConfig.docker!), ...(override.docker ?? {}) },
    collaboration: { ...(base.collaboration ?? defaultConfig.collaboration!), ...(override.collaboration ?? {}) },
    frontend: { ...(base.frontend ?? defaultConfig.frontend!), ...(override.frontend ?? {}) },
    policy: {
      ...base.policy,
      ...override.policy,
      blockedPaths: [...new Set([...(base.policy.blockedPaths ?? []), ...(override.policy?.blockedPaths ?? [])])],
      protectedPaths: [...new Set([...(base.policy.protectedPaths ?? []), ...(override.policy?.protectedPaths ?? [])])],
      allowedGeneratedPaths: [...new Set([...(base.policy.allowedGeneratedPaths ?? []), ...(override.policy?.allowedGeneratedPaths ?? [])])],
      localOnlyPaths: [...new Set([...(base.policy.localOnlyPaths ?? []), ...(override.policy?.localOnlyPaths ?? [])])]
    },
    gates: { ...base.gates, ...override.gates },
    models: mergeModelRoutes(base.models, override.models)
  };
}

function mergeModelRoutes(base: RuntimeConfig["models"], override?: Partial<Record<AgentRole, ModelRoute>>): RuntimeConfig["models"] {
  const merged = { ...base } as RuntimeConfig["models"];
  for (const role of Object.keys(base) as AgentRole[]) {
    const route = { ...base[role], ...(override?.[role] ?? {}), budget: { ...(base[role].budget ?? {}), ...(override?.[role]?.budget ?? {}) } };
    merged[role] = promoteLegacyGeneratedThinking(role, route, override?.[role]);
  }
  return merged;
}

function promoteLegacyGeneratedThinking(role: AgentRole, route: ModelRoute, override?: ModelRoute): ModelRoute {
  if (!override || override.model || override.thinking !== "medium") return route;
  const upgraded: Partial<Record<AgentRole, ModelRoute["thinking"]>> = {
    master: "xhigh",
    implement: "xhigh",
    validate: "high",
    audit: "xhigh",
    bugfix: "high",
    adjudicate: "xhigh"
  };
  return upgraded[role] ? { ...route, thinking: upgraded[role] } : route;
}
