import path from "node:path";
import { exists, writeText } from "./util/fs.js";
import type { Batch, GateResult } from "./types.js";

export async function writeRuntimeGates(cwd: string, batch: Batch, gates: GateResult[]): Promise<void> {
  const padded = String(batch.number).padStart(3, "0");
  for (const gate of gates) {
    await writeGate(cwd, gate.name, `batch-${padded}`, gate.passed ? "PASS" : "FAIL", batch.number, gate.flags);
  }
}

export async function writeGate(cwd: string, workflow: string, stem: string, result: string, batch: number, flags: string[] = []): Promise<void> {
  const body = [`workflow: ${workflow}`, `timestamp: ${new Date().toISOString()}`, `result: ${result}`, `batch: ${batch}`, `flags: ${flags.join(", ") || "none"}`, ""].join("\n");
  await writeText(path.join(cwd, `.yolo/gates/${workflow}-${stem}.md`), body);
}

export async function verifyPreviousBatchGates(cwd: string, batchNumber: number): Promise<string[]> {
  if (batchNumber <= 1) return [];
  const prev = batchNumber - 1;
  await repairCommittedCloseoutGate(cwd, prev);
  const padded = String(prev).padStart(3, "0");
  const required = ["e2e", "journal", "closeout"];
  const missing = [];
  for (const gate of required) {
    const rel = `.yolo/gates/${gate}-batch-${padded}.md`;
    if (!(await exists(path.join(cwd, rel)))) missing.push(rel);
  }
  return missing;
}

export async function repairCommittedCloseoutGate(cwd: string, batchNumber: number): Promise<boolean> {
  const padded = String(batchNumber).padStart(3, "0");
  const closeout = path.join(cwd, `.yolo/gates/closeout-batch-${padded}.md`);
  if (await exists(closeout)) return false;
  const hasJournal = await exists(path.join(cwd, `.yolo/gates/journal-batch-${padded}.md`));
  const hasResult = await hasBatchResult(cwd, padded);
  const hasCommit = await hasCompletedBatchCommit(cwd, batchNumber);
  if (!hasJournal || !hasResult || !hasCommit) return false;
  await writeGate(cwd, "closeout", `batch-${padded}`, "PASS", batchNumber, ["runtime_repaired_committed_closeout", "evidence_preserved"]);
  return true;
}

async function hasBatchResult(cwd: string, padded: string): Promise<boolean> {
  const candidates = ["implement", "audit", "validate", "bugfix", "bugfix-2"];
  for (const suffix of candidates) {
    if (await exists(path.join(cwd, `.yolo/batch-results/batch-${padded}-${suffix}.json`))) return true;
  }
  return false;
}

async function hasCompletedBatchCommit(cwd: string, batchNumber: number): Promise<boolean> {
  const gitHead = path.join(cwd, ".git/HEAD");
  if (!(await exists(gitHead))) return false;
  const padded = String(batchNumber).padStart(3, "0");
  const log = await runGitLog(cwd);
  return log.split(/\r?\n/).some((subject) => {
    const normalized = subject.trim().toLowerCase();
    return normalized.includes(`batch ${padded}`) && /\b(complete|completed|reconcile|closeout|recovery|manual)\b/.test(normalized);
  });
}

async function runGitLog(cwd: string): Promise<string> {
  const { execCommand } = await import("./util/process.js");
  const result = await execCommand("git log -n 100 --format=%s", cwd, 120000);
  return result.exitCode === 0 ? result.stdout : "";
}
