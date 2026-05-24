import path from "node:path";
import { exists, readText, writeText } from "./util/fs.js";
import type { Batch, BatchResult } from "./types.js";

interface FailureRecord {
  key: string;
  failureType: string;
  signature: string;
  count: number;
  batches: number[];
  reinforced: boolean;
  lastSeen: string;
}

export interface FailureUpdate {
  key: string;
  count: number;
  thresholdReached: boolean;
  reinforced: boolean;
}

export async function recordFailure(cwd: string, batch: Batch, result: BatchResult, threshold = 3): Promise<FailureUpdate | null> {
  if (result.status !== "FAILURE" && result.status !== "INVALID_RESULT") return null;
  const failureType = result.failureType ?? result.flags[0] ?? "UNKNOWN_FAILURE";
  const signature = signatureFor(result);
  const key = `${failureType}::${signature}`;
  const records = await readRecords(cwd);
  const existing = records.find((record) => record.key === key);
  const record = existing ?? { key, failureType, signature, count: 0, batches: [], reinforced: false, lastSeen: "" };
  record.count += 1;
  record.batches.push(batch.number);
  record.lastSeen = new Date().toISOString();
  if (!existing) records.push(record);
  await writeRecords(cwd, records);
  return { key, count: record.count, thresholdReached: record.count >= threshold, reinforced: record.reinforced };
}

export async function markReinforced(cwd: string, key: string): Promise<void> {
  const records = await readRecords(cwd);
  for (const record of records) if (record.key === key) record.reinforced = true;
  await writeRecords(cwd, records);
}

export async function pruneFailurePatternsForBatch(cwd: string, batchNumber: number): Promise<string[]> {
  const records = await readRecords(cwd);
  const actions: string[] = [];
  const next: FailureRecord[] = [];
  for (const record of records) {
    const remainingBatches = record.batches.filter((batch) => batch !== batchNumber);
    const removed = record.batches.length - remainingBatches.length;
    if (!removed) {
      next.push(record);
      continue;
    }
    if (remainingBatches.length === 0) {
      actions.push(`removed failure pattern ${record.key}`);
      continue;
    }
    next.push({ ...record, batches: remainingBatches, count: Math.max(remainingBatches.length, record.count - removed) });
    actions.push(`pruned batch-${String(batchNumber).padStart(3, "0")} from failure pattern ${record.key}`);
  }
  if (actions.length) await writeRecords(cwd, next);
  return actions;
}

function signatureFor(result: BatchResult): string {
  const text = [...(result.flags ?? []), result.failureType ?? ""].join("|");
  return text.toLowerCase().replace(/[^a-z0-9|:_-]+/g, "-").slice(0, 120) || "no-signature";
}

async function readRecords(cwd: string): Promise<FailureRecord[]> {
  const file = path.join(cwd, ".yolo/failure-patterns.json");
  if (!(await exists(file))) return [];
  return JSON.parse(await readText(file)) as FailureRecord[];
}

async function writeRecords(cwd: string, records: FailureRecord[]): Promise<void> {
  await writeText(path.join(cwd, ".yolo/failure-patterns.json"), JSON.stringify(records, null, 2) + "\n");
}
