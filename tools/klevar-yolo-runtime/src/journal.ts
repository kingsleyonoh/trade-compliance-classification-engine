import path from "node:path";
import { readFile } from "node:fs/promises";
import { exists, writeText } from "./util/fs.js";
import type { Batch, BatchResult, GateResult } from "./types.js";

export async function appendJournal(cwd: string, batch: Batch, result: BatchResult, gates: GateResult[]): Promise<void> {
  const file = path.join(cwd, ".yolo/journal.md");
  const previous = (await exists(file)) ? await readFile(file, "utf8") : "# YOLO Runtime Journal\n";
  const section = [
    `## Batch ${String(batch.number).padStart(3, "0")} — ${new Date().toISOString()}`,
    `Status: ${result.status}`,
    `Items: ${batch.items.map((item) => item.title).join("; ")}`,
    "### Gates",
    ...gates.map((gate) => `- ${gate.passed ? "PASS" : "FAIL"} ${gate.name}${gate.flags.length ? ` — ${gate.flags.join(", ")}` : ""}`),
    ""
  ].join("\n");
  await writeText(file, `${previous.trim()}\n\n${section}`);
}
