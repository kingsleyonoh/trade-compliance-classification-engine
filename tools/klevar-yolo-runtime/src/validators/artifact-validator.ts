import { createHash } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { exists } from "../util/fs.js";
import type { BatchResult, GateResult } from "../types.js";

export async function validateArtifacts(cwd: string, result: BatchResult): Promise<GateResult> {
  const artifactPaths = [...new Set((result.artifacts ?? []).map(artifactPath).filter((value): value is string => Boolean(value)))];
  const flags = [];
  const hashes = new Map<string, string>();
  for (const rel of artifactPaths) {
    const file = path.join(cwd, rel);
    if (!(await exists(file))) {
      flags.push(`ARTIFACT_MISSING:${rel}`);
      continue;
    }
    const hash = createHash("md5").update(await readFile(file)).digest("hex");
    const prior = hashes.get(hash);
    if (prior) flags.push(`ARTIFACT_DUPLICATE_DETECTED:${prior}:${rel}`);
    hashes.set(hash, rel);
  }
  return { name: "artifacts", passed: flags.length === 0, flags };
}

function artifactPath(artifact: unknown): string | null {
  const value = typeof artifact === "string" ? artifact : artifact && typeof artifact === "object" ? (artifact as Record<string, unknown>).path ?? (artifact as Record<string, unknown>).file : null;
  if (typeof value !== "string") return null;
  return /^(?:unknown|n\/?a|not applicable|none|manual|tbd|todo|-)$/i.test(value.trim()) ? null : value;
}
