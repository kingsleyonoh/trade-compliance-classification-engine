import path from "node:path";
import { exists, readText } from "./util/fs.js";
import { formatProjectChecks, loadProjectChecks } from "./project-checks.js";
import { formatInbox, readPendingInbox } from "./inbox-router.js";
import { buildRelevantKnowledgePack } from "./knowledge-retriever.js";
import type { Batch, RuntimeConfig } from "./types.js";

const CORE_RULES = [
  ".agent/rules/CODEBASE_CONTEXT.md",
  ".agent/rules/CODING_STANDARDS.md",
  ".agent/rules/CODING_STANDARDS_META.md",
  ".agent/rules/CODING_STANDARDS_TESTING.md",
  ".agent/rules/CODING_STANDARDS_TESTING_LOGIC.md",
  ".agent/rules/CODING_STANDARDS_TESTING_LIVE.md",
  ".agent/rules/CODING_STANDARDS_TESTING_E2E.md",
  ".agent/rules/CODING_STANDARDS_DOMAIN.md"
];

export async function buildBatchContext(cwd: string, batch: Batch, inboxCwd = cwd, config?: RuntimeConfig): Promise<string> {
  return (await buildBatchContextWithKnowledge(cwd, batch, inboxCwd, config)).context;
}

export async function buildBatchContextWithKnowledge(cwd: string, batch: Batch, inboxCwd = cwd, config?: RuntimeConfig): Promise<{ context: string; knowledgePack: Awaited<ReturnType<typeof buildRelevantKnowledgePack>> }> {
  const knowledgePack = await buildRelevantKnowledgePack(cwd, batch, config, inboxCwd);
  const sections = [`# Batch ${batch.number} Context`, section("Items", batch.items.map((i) => i.raw).join("\n"))];
  sections.push(section("Progress Snapshot", await readIfPresent(cwd, "docs/progress.md")));
  sections.push(section("PRD Excerpts", await findPrd(cwd, batch)));
  sections.push(section("Runtime Policy", await readIfPresent(cwd, ".yolo/runtime.config.json")));
  sections.push(section("Core Rules", await readMany(cwd, CORE_RULES)));
  sections.push(section("Relevant Knowledge Pack", knowledgePack.markdown));
  sections.push(section("Active Project-Local Checks", formatProjectChecks(await loadProjectChecks(cwd))));
  sections.push(section("Pending YOLO Inbox", formatInbox(await readPendingInbox(inboxCwd))));
  return { context: sections.join("\n\n---\n\n"), knowledgePack };
}

function section(title: string, body: string): string {
  return `## ${title}\n${body.trim() || "None."}`;
}

async function readIfPresent(cwd: string, rel: string): Promise<string> {
  const file = path.join(cwd, rel);
  return (await exists(file)) ? readText(file) : `Missing: ${rel}`;
}

async function readMany(cwd: string, rels: string[]): Promise<string> {
  const parts = [];
  for (const rel of rels) parts.push(`### ${rel}\n${await readIfPresent(cwd, rel)}`);
  return parts.join("\n\n");
}

async function findPrd(cwd: string, batch: Batch): Promise<string> {
  for (const rel of ["docs/PRD.md", "docs/prd.md", "PRD.md", "docs/PRD_TEMPLATE.md"]) {
    const file = path.join(cwd, rel);
    if (!(await exists(file))) continue;
    const prd = await readText(file);
    return `### ${rel}\n${extractPrdExcerpts(prd, batch)}`;
  }
  return "No PRD found.";
}

function extractPrdExcerpts(prd: string, batch: Batch): string {
  const refs = new Set<string>();
  for (const item of batch.items) for (const match of item.raw.matchAll(/PRD\s*§\s*([0-9]+[a-z]?(?:\.[0-9]+)?)/gi)) refs.add(match[1]);
  const sections = splitSections(prd);
  const wanted = sections.filter((entry) => {
    const heading = entry.heading.toLowerCase();
    if (/architecture principles|what not to build|non-goals|frontend product quality contract/.test(heading)) return true;
    for (const ref of refs) if (heading.includes(`§${ref}`) || heading.includes(`section ${ref}`) || heading.match(new RegExp(`^#+\\s*${escapeRegExp(ref)}(?:\\s|:|\\.)`))) return true;
    return false;
  });
  if (wanted.length) return wanted.map((entry) => entry.text).join("\n\n").slice(0, 50000);
  return `${prd.slice(0, 30000)}${prd.length > 30000 ? "\n\n[PRD truncated by runtime excerpt budget: add explicit PRD § refs to progress items for tighter context]" : ""}`;
}

function splitSections(text: string): Array<{ heading: string; text: string }> {
  const lines = text.split(/\r?\n/);
  const sections: Array<{ heading: string; text: string }> = [];
  let current: string[] = [];
  let heading = "# PRD Preamble";
  for (const line of lines) {
    if (/^#{1,3}\s+/.test(line) && current.length) {
      sections.push({ heading, text: current.join("\n") });
      current = [line];
      heading = line;
    } else {
      if (/^#{1,3}\s+/.test(line)) heading = line;
      current.push(line);
    }
  }
  if (current.length) sections.push({ heading, text: current.join("\n") });
  return sections;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

