import { isPhaseCloseout } from "../progress-parser.js";
import { exists, readText } from "../util/fs.js";
import type { GateResult, ProgressItem } from "../types.js";

const KNOWN_TAGS = new Set(["[SETUP]", "[DATA]", "[API]", "[JOB]", "[INTEGRATION]", "[UI]", "[MATRIX]", "[AUDIT]", "[FEATURE]", "[BUG]", "[FIX]"]);
const PRD_REQUIRED_TAGS = new Set(["[SETUP]", "[DATA]", "[API]", "[JOB]", "[INTEGRATION]", "[UI]", "[MATRIX]", "[AUDIT]"]);
const TASK_LINE = /^- \[( |x|\/)\]\s+(.*)$/;
const STRUCTURED_TASK = /^- \[( |x|\/)\]\s+(\[[A-Z-]+\])\s+(.+)$/;

export async function validateProgressContract(cwd: string): Promise<GateResult> {
  const progressPath = `${cwd}/docs/progress.md`;
  if (!(await exists(progressPath))) return { name: "progress-contract", passed: false, flags: ["MISSING_PROGRESS_MD"] };
  const text = await readText(progressPath);
  const flags: string[] = [];
  let inFence = false;
  let currentPhase = "Unphased";
  const phaseItems = new Map<string, Array<{ line: number; tag: string; raw: string; title: string }>>();

  text.split(/\r?\n/).forEach((line, index) => {
    const lineNo = index + 1;
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const phaseMatch = /^##\s+(Phase[^\n]+)/.exec(line);
    if (phaseMatch) currentPhase = phaseMatch[1].trim();
    const task = TASK_LINE.exec(line);
    if (!task) return;
    const structured = STRUCTURED_TASK.exec(line);
    if (!structured) {
      flags.push(`PROGRESS_ITEM_MALFORMED:L${lineNo}`);
      return;
    }
    const tag = structured[2];
    const title = structured[3];
    if (!KNOWN_TAGS.has(tag)) flags.push(`UNKNOWN_PROGRESS_TAG:L${lineNo}:${tag}`);
    if (PRD_REQUIRED_TAGS.has(tag) && !hasPrdReference(title)) flags.push(`MISSING_PRD_REFERENCE:L${lineNo}:${tag}`);
    if (!phaseItems.has(currentPhase)) phaseItems.set(currentPhase, []);
    phaseItems.get(currentPhase)!.push({ line: lineNo, tag, raw: line, title });
  });

  for (const [phase, items] of phaseItems) {
    const closeoutIndexes = items.map((item, index) => (isPhaseCloseout(progressLike(item, phase)) ? index : -1)).filter((index) => index >= 0);
    if (closeoutIndexes.length > 1) flags.push(`MULTIPLE_AUDIT_CLOSEOUTS:${phase}`);
    if (closeoutIndexes.length === 1 && closeoutIndexes[0] !== items.length - 1) flags.push(`AUDIT_CLOSEOUT_NOT_LAST:${phase}`);
  }

  return { name: "progress-contract", passed: flags.length === 0, flags };
}

function hasPrdReference(value: string): boolean {
  return /(?:—|-|\()\s*PRD\s+(?:§\s*[\w.]+|N\/A)/i.test(value);
}

function progressLike(item: { tag: string; raw: string; title: string }, phase: string): ProgressItem {
  return { raw: item.raw, tag: item.tag, title: item.title, phase, checked: false };
}
