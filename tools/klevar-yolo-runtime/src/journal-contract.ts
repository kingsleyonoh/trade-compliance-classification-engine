import type { BatchResult } from "./types.js";

export interface ContractResult {
  passed: boolean;
  flags: string[];
}

export function validateJournalContract(result: BatchResult): ContractResult {
  const data = result as BatchResult & { journal_entry_written?: boolean; gate_file_written?: boolean; batch?: number | string };
  const flags: string[] = [];
  if (data.schemaVersion !== 1) flags.push("INVALID_SCHEMA_VERSION");
  if (data.agent !== "journal") flags.push("INVALID_JOURNAL_AGENT");
  if (!data.status) flags.push("MISSING_STATUS");
  if (!Array.isArray(data.flags)) flags.push("MISSING_FLAGS_ARRAY");
  if (data.status === "FAILURE" && !data.failureType) flags.push("FAILURE_WITHOUT_FAILURE_TYPE");
  if (data.status === "SUCCESS" && !journalEntryConfirmed(data)) flags.push("JOURNAL_ENTRY_NOT_CONFIRMED");
  if (data.status === "SUCCESS" && !journalGateConfirmed(data)) flags.push("JOURNAL_GATE_NOT_CONFIRMED");
  if (data.commit !== null && data.commit !== undefined) flags.push("COMMIT_CLAIMED_BY_AGENT");
  return { passed: flags.length === 0, flags };
}

function journalEntryConfirmed(data: BatchResult & { journal_entry_written?: boolean; batch?: number | string }): boolean {
  if (data.journal_entry_written === true || hasFlag(data, "JOURNAL_ENTRY_WRITTEN")) return true;
  const batch = String(data.batch).padStart(3, "0");
  return hasChangedOrArtifact(data, `docs/build-journal/${batch}-batch.md`);
}

function journalGateConfirmed(data: BatchResult & { gate_file_written?: boolean; batch?: number | string }): boolean {
  if (data.gate_file_written === true || hasFlag(data, "JOURNAL_GATE_WRITTEN") || hasFlag(data, "GATE_FILE_WRITTEN")) return true;
  const batch = String(data.batch).padStart(3, "0");
  return hasChangedOrArtifact(data, `.yolo/gates/journal-batch-${batch}.md`);
}

function hasFlag(data: BatchResult, flag: string): boolean {
  return data.flags?.some((item) => item.toUpperCase() === flag) ?? false;
}

function hasChangedOrArtifact(data: BatchResult, target: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, "/");
  return Boolean(data.filesChanged?.some((file) => normalize(file) === target) || data.artifacts?.some((artifact) => normalize(artifact.path) === target));
}
