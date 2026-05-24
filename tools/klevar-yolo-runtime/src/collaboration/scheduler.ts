import { isAuditItem } from "../progress-parser.js";
import type { Batch, ProgressItem, RuntimeConfig } from "../types.js";
import { activeClaims, conflictsWithClaimedFiles, isClaimedByExternalOperator, type Claim } from "./claims.js";

export interface ParallelPlan {
  shards: Batch[];
  skipped: string[];
  flags: string[];
}

const DOMAIN_BY_TAG: Record<string, string> = {
  "[UI]": "frontend",
  "[API]": "backend",
  "[JOB]": "backend",
  "[INTEGRATION]": "integration",
  "[DATA]": "data",
  "[SETUP]": "setup",
  "[FEATURE]": "feature",
  "[FIX]": "fix",
  "[BUG]": "bug",
  "[AUDIT]": "audit"
};

const SHARED_FILE_PREFIXES = [
  "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "deno.lock",
  "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradle/", "gradlew", "gradlew.bat",
  "Cargo.toml", "Cargo.lock", "go.mod", "go.sum", "pyproject.toml", "poetry.lock", "Pipfile", "Pipfile.lock", "requirements.txt",
  "Gemfile", "Gemfile.lock", "composer.json", "composer.lock", "mix.exs", "mix.lock", "pubspec.yaml", "pubspec.lock",
  ".csproj", ".fsproj", ".sln", "Makefile", "CMakeLists.txt", "Dockerfile", "docker-compose", ".github/workflows/",
  ".yolo/", ".agent/rules/", ".agent/agents/", ".agent/workflows/", ".agent/guides/"
];

export function planParallelBatches(items: ProgressItem[], batchNumber: number, count: number, config: RuntimeConfig, claims: Claim[]): ParallelPlan {
  const max = Math.max(2, Math.min(count, config.collaboration?.maxParallelAgents ?? 2));
  const shards: Batch[] = [];
  const skipped: string[] = [];
  const flags: string[] = [];
  const usedFiles = new Set<string>();
  const usedDomains = new Set<string>();

  for (const item of items.filter((candidate) => !candidate.checked)) {
    if (shards.length >= max) break;
    if (isAuditItem(item)) {
      skipped.push(`AUDIT_NOT_PARALLEL:${item.title}`);
      continue;
    }
    if (isClaimedByExternalOperator(item.title, claims)) {
      skipped.push(`EXTERNALLY_CLAIMED:${item.title}`);
      continue;
    }
    const files = item.affectedFiles ?? [];
    const claimConflicts = conflictsWithClaimedFiles(files, activeClaims(claims));
    if (claimConflicts.length) {
      skipped.push(`CLAIM_FILE_CONFLICT:${item.title}:${claimConflicts.join("|")}`);
      continue;
    }
    if (files.some((file) => isSharedFile(file))) {
      skipped.push(`SHARED_FILE_NOT_PARALLEL:${item.title}`);
      continue;
    }
    if (files.some((file) => usedFiles.has(file))) {
      skipped.push(`LOCAL_FILE_CONFLICT:${item.title}`);
      continue;
    }
    const domain = DOMAIN_BY_TAG[item.tag] ?? item.tag;
    if (usedDomains.has(domain) && files.length === 0) {
      skipped.push(`UNKNOWN_FILES_SAME_DOMAIN:${item.title}`);
      continue;
    }
    for (const file of files) usedFiles.add(file);
    usedDomains.add(domain);
    shards.push({ number: batchNumber, type: "implement", items: [item] });
  }

  if (shards.length < 2) flags.push("PARALLEL_PLAN_INSUFFICIENT_INDEPENDENT_WORK");
  return { shards, skipped, flags };
}

function isSharedFile(file: string): boolean {
  return SHARED_FILE_PREFIXES.some((prefix) => file === prefix || file.startsWith(prefix) || (prefix.startsWith(".") && file.endsWith(prefix)));
}
