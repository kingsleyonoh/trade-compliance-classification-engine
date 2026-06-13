import path from "node:path";
import { writeGate } from "./gates.js";
import { validateJournalContract } from "./journal-contract.js";
import { classifyBatchRisk, type RuntimeBatchState } from "./runtime-batch-state.js";
import { isBlockingFlag } from "./flag-classification.js";
import { writeText } from "./util/fs.js";
import type { Batch, BatchResult, RuntimeConfig } from "./types.js";

export interface DeterministicJournalInput {
  cwd: string;
  batch: Batch;
  result: BatchResult;
  config: RuntimeConfig;
  runtimeState?: RuntimeBatchState;
}

export function deterministicJournalPaths(batchNumber: number): { journalPath: string; gatePath: string } {
  const padded = String(batchNumber).padStart(3, "0");
  return { journalPath: `docs/build-journal/${padded}-batch.md`, gatePath: `.yolo/gates/journal-batch-${padded}.md` };
}

export async function writeDeterministicJournal(input: DeterministicJournalInput): Promise<BatchResult | null> {
  if (!deterministicJournalEligible(input)) return null;
  const { cwd, batch, result } = input;
  const paths = deterministicJournalPaths(batch.number);
  await writeText(path.join(cwd, paths.journalPath), deterministicJournalMarkdown(input));
  await writeGate(cwd, "journal", `batch-${String(batch.number).padStart(3, "0")}`, "PASS", batch.number, ["deterministic-journal-fast-path"]);
  const journalResult = deterministicJournalResult(batch, paths);
  const contract = validateJournalContract(journalResult);
  return contract.passed ? journalResult : null;
}

function deterministicJournalEligible({ batch, result, config, runtimeState }: DeterministicJournalInput): boolean {
  if (config.speed?.deterministicJournal === false) return false;
  if (batch.type !== "implement" || batch.supportKind) return false;
  if (batch.items.some((item) => /close-?out|audit/i.test(item.title) || item.tag === "[AUDIT]")) return false;
  if (result.status !== "SUCCESS") return false;
  if ((result.flags ?? []).some((flag) => isBlockingFlag(flag))) return false;
  if ((runtimeState?.findings ?? []).some((finding) => finding.status === "open")) return false;
  const risk = classifyBatchRisk(batch, result);
  return risk.class === "low" || risk.class === "medium";
}

function deterministicJournalResult(batch: Batch, paths: { journalPath: string; gatePath: string }): BatchResult & { journal_entry_written: true; gate_file_written: true } {
  return {
    schemaVersion: 1,
    agent: "journal",
    batch: batch.number,
    status: "SUCCESS",
    itemsCompleted: batch.items.map((item) => item.title),
    filesChanged: [paths.journalPath, paths.gatePath],
    artifacts: [
      { path: paths.journalPath, description: "Deterministic build-journal entry" },
      { path: paths.gatePath, description: "Deterministic journal gate" }
    ],
    flags: ["JOURNAL_ENTRY_WRITTEN", "JOURNAL_GATE_WRITTEN", "DETERMINISTIC_JOURNAL_FAST_PATH"],
    commit: null,
    journal_entry_written: true,
    gate_file_written: true
  };
}

function deterministicJournalMarkdown({ batch, result, runtimeState }: DeterministicJournalInput): string {
  const padded = String(batch.number).padStart(3, "0");
  const files = [...new Set([...(runtimeState?.changedFiles ?? []), ...(result.filesChanged ?? [])])];
  const tests = result.tests ? Object.entries(result.tests).map(([name, evidence]) => evidence ? `- ${name}: ${evidence.command} (exit ${evidence.exitCode})` : `- ${name}: not provided`) : [];
  return [
    `# Batch ${padded}`,
    "",
    "## Summary",
    `Deterministic journal fast path recorded a successful ${batch.type} batch after runtime gates and merge-readiness passed.`,
    "",
    "## Items",
    ...batch.items.map((item) => `- ${item.tag} ${item.title}`),
    "",
    "## Files Changed",
    ...(files.length ? files.map((file) => `- ${file}`) : ["- none reported"]),
    "",
    "## Tests",
    ...(tests.length ? tests : ["- no test evidence reported"]),
    "",
    "## Runtime Evidence",
    "- journal_entry_written: true",
    "- gate_file_written: true",
    "- source: deterministic-journal-fast-path",
    ""
  ].join("\n");
}
