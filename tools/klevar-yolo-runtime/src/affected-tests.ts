import { classifyRuntimePath, normalizeRuntimePath } from "./path-policy.js";
import type { Batch, BatchResult } from "./types.js";

export interface AffectedTestPlan {
  observedOnly: true;
  confidence: "none" | "low" | "medium";
  files: string[];
  candidateCommands: string[];
  rejected: Array<{ path: string; reason: string }>;
}

export function planAffectedTests(input: { batch: Batch; result: BatchResult }): AffectedTestPlan {
  const rawFiles = [
    ...input.batch.items.flatMap((item) => item.affectedFiles ?? []),
    ...(input.result.filesChanged ?? [])
  ];
  const files: string[] = [];
  const rejected: Array<{ path: string; reason: string }> = [];
  for (const raw of rawFiles) {
    const classification = classifyRuntimePath(raw);
    if (!classification.safe || classification.sync === "reject" || classification.owner === "runtime" || classification.owner === "generated" || classification.owner === "environment") {
      rejected.push({ path: normalizeRuntimePath(raw), reason: classification.reason });
      continue;
    }
    files.push(classification.path);
  }
  const unique = [...new Set(files)].sort();
  const candidateCommands = [...new Set(unique.flatMap(candidateCommandsForFile))];
  const confidence = candidateCommands.length > 0 ? "medium" : unique.length > 0 ? "low" : "none";
  return { observedOnly: true, confidence, files: unique, candidateCommands, rejected };
}

function candidateCommandsForFile(file: string): string[] {
  const commands: string[] = [];
  const testFile = /(?:^|\/)(?:__tests__|tests?|spec|it)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|_(?:test|spec)\.(?:py|rb)$/i.test(file);
  if (testFile) {
    if (/\.[cm]?[jt]sx?$/.test(file)) commands.push(`npm test -- ${file}`);
    else if (/\.py$/.test(file)) commands.push(`pytest ${file}`);
    else if (/\.rb$/.test(file)) commands.push(`bundle exec ruby ${file}`);
    else commands.push(`test ${file}`);
  }
  if (/\.(?:ts|tsx|js|jsx)$/.test(file) && !testFile) commands.push("npm test");
  if (/\.py$/.test(file) && !testFile) commands.push("pytest");
  if (/\.(?:rs)$/.test(file)) commands.push("cargo test");
  if (/\.(?:go)$/.test(file)) commands.push("go test ./...");
  if (/\.(?:scala|java|kt)$/.test(file)) commands.push("./gradlew test");
  return commands;
}
