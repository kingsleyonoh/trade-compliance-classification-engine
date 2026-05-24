import path from "node:path";
import { readdir } from "node:fs/promises";
import { runAgent } from "./agent-session.js";
import type { Batch, RuntimeConfig } from "./types.js";
import { ensureDir, exists, readText, toPosix, writeText } from "./util/fs.js";

const KNOWLEDGE_DIRS = [
  ".agent/knowledge/foundation",
  ".agent/knowledge/gotchas",
  ".agent/knowledge/modules",
  ".agent/knowledge/checks",
  "docs/build-journal"
];

const MAX_SELECTED_FILES = 26;
const MAX_FILE_CHARS = 6000;
const MAX_PACK_CHARS = 65000;
const MAX_CATALOG_CHARS = 45000;
const MAX_ADDITIONAL_CANDIDATES = 30;

export interface KnowledgePack {
  selectedFiles: string[];
  prdSections: string[];
  reasons: Array<{ path: string; reason: string }>;
  mode: "ai" | "fallback";
  warnings: string[];
  markdown: string;
}

interface CandidateFile {
  path: string;
  score: number;
  summary: string;
}

interface KnowledgeSelectorOutput {
  selectedFiles: string[];
  additionalRequests: Array<{ type: "keyword" | "glob"; query?: string; pattern?: string }>;
}

export async function buildRelevantKnowledgePack(cwd: string, batch: Batch, config?: RuntimeConfig, artifactCwd = cwd): Promise<KnowledgePack> {
  const candidates = await discoverCandidates(cwd, batch);
  const fallback = selectFallback(candidates);
  let selected = fallback;
  let mode: KnowledgePack["mode"] = "fallback";
  const warnings: string[] = [];
  if (config?.models?.knowledge) {
    try {
      let selector = await runKnowledgeSelector(cwd, batch, candidates, config, "selector");
      let finalCandidates = candidates;
      if (selector.additionalRequests.length) {
        const expanded = await expandCandidateRequests(cwd, selector.additionalRequests, candidates);
        if (expanded.length) {
          finalCandidates = mergeCandidates(candidates, expanded);
          warnings.push(`KNOWLEDGE_SECOND_PASS:${expanded.length}`);
          selector = await runKnowledgeSelector(cwd, batch, finalCandidates, config, "selector-final");
        }
      }
      if (selector.selectedFiles.length) {
        selected = selector.selectedFiles;
        mode = "ai";
      } else {
        warnings.push("KNOWLEDGE_SELECTOR_EMPTY_FALLBACK_USED");
      }
      candidates.splice(0, candidates.length, ...finalCandidates);
    } catch (error) {
      warnings.push(`KNOWLEDGE_SELECTOR_FAILED:${String(error instanceof Error ? error.message : error).slice(0, 160)}`);
    }
  }
  const validSelected = sanitizeSelected(selected, candidates).slice(0, MAX_SELECTED_FILES);
  const markdown = await renderKnowledgePack(cwd, validSelected, mode, warnings);
  const pack: KnowledgePack = {
    selectedFiles: validSelected,
    prdSections: extractPrdRefs(batch),
    reasons: validSelected.map((file) => ({ path: file, reason: candidates.find((candidate) => candidate.path === file)?.summary || "Selected for batch relevance." })),
    mode,
    warnings,
    markdown
  };
  await persistKnowledgePack(cwd, batch, pack);
  if (artifactCwd !== cwd) await persistKnowledgePack(artifactCwd, batch, pack);
  return pack;
}

async function discoverCandidates(cwd: string, batch: Batch): Promise<CandidateFile[]> {
  const keywords = batchKeywords(batch);
  const candidates: CandidateFile[] = [];
  for (const dir of KNOWLEDGE_DIRS) {
    const abs = path.join(cwd, dir);
    if (!(await exists(abs))) continue;
    for (const file of await listMarkdownFiles(abs, dir)) {
      const text = await safeRead(path.join(cwd, file));
      const haystack = `${file}\n${firstHeadings(text)}\n${text.slice(0, 1200)}`.toLowerCase();
      let score = file.endsWith("/_index.md") ? 4 : 0;
      for (const keyword of keywords) {
        if (keyword.length < 3) continue;
        if (file.toLowerCase().includes(keyword)) score += 6;
        if (haystack.includes(keyword)) score += 2;
      }
      if (dir.includes("foundation") && score > 0) score += 2;
      if (dir.includes("checks") && file.endsWith("/_index.md")) score += 5;
      if (dir.includes("build-journal")) score += journalRecencyBoost(file);
      if (score > 0) candidates.push({ path: file, score, summary: firstHeadings(text) || "Knowledge candidate" });
    }
  }
  return candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 80);
}

async function runKnowledgeSelector(cwd: string, batch: Batch, candidates: CandidateFile[], config: RuntimeConfig, suffix: string): Promise<KnowledgeSelectorOutput> {
  const outBase = `.yolo/knowledge-packs/batch-${String(batch.number).padStart(3, "0")}-${suffix}`;
  const outputFile = path.join(cwd, `${outBase}.json`);
  await ensureDir(path.dirname(outputFile));
  const prompt = await knowledgePrompt(cwd, batch, candidates, outBase);
  await runAgent({
    cwd,
    sessionFile: path.join(cwd, `.yolo/pi-sessions/batch-${String(batch.number).padStart(3, "0")}-knowledge.jsonl`),
    prompt,
    route: config.models.knowledge
  });
  if (!(await exists(outputFile))) return { selectedFiles: [], additionalRequests: [] };
  const parsed = JSON.parse(await readText(outputFile)) as { selectedFiles?: unknown; additionalRequests?: unknown };
  return {
    selectedFiles: Array.isArray(parsed.selectedFiles) ? parsed.selectedFiles.filter((value): value is string => typeof value === "string") : [],
    additionalRequests: normalizeAdditionalRequests(parsed.additionalRequests)
  };
}

async function knowledgePrompt(cwd: string, batch: Batch, candidates: CandidateFile[], outBase: string): Promise<string> {
  const template = await readIfPresent(cwd, ".agent/agents/yolo/yolo-subagent-knowledge-retrieve.md");
  const catalog = candidates.map((candidate) => `- ${candidate.path} (score ${candidate.score}): ${candidate.summary}`).join("\n").slice(0, MAX_CATALOG_CHARS);
  const body = `# Knowledge retrieval request\n\nBatch ${batch.number}\n\n## Batch items\n${batch.items.map((item) => item.raw).join("\n")}\n\n## Candidate catalog\n${catalog || "No candidates discovered."}\n\n## Output\nWrite strict JSON to ${outBase}.json with this shape only:\n{\n  \"selectedFiles\": [\"relative/path.md\"],\n  \"reasons\": [{\"path\": \"relative/path.md\", \"reason\": \"why relevant\"}],\n  \"additionalRequests\": [\n    {\"type\": \"keyword\", \"query\": \"excel import parser column mapping\"},\n    {\"type\": \"glob\", \"pattern\": \".agent/knowledge/**/*import*.md\"}\n  ]\n}\n\nRules:\n- Select only files listed in Candidate catalog.\n- If the catalog appears to miss an important knowledge area, add compact additionalRequests. Runtime will safely expand only .agent/knowledge/ and docs/build-journal/.\n- Prefer files the implement agent must read before coding.\n- Keep the list compact: max ${MAX_SELECTED_FILES} files.\n- Include foundation _index.md and checks _index.md when present.\n- Do not edit source code or project docs except the required JSON output file.\n`;
  return template.trim() ? `${template}\n\n---\n\n${body}` : body;
}

export async function expandCandidateRequests(cwd: string, requests: KnowledgeSelectorOutput["additionalRequests"], existing: CandidateFile[] = []): Promise<CandidateFile[]> {
  const existingPaths = new Set(existing.map((candidate) => candidate.path));
  const allFiles = [] as string[];
  for (const dir of KNOWLEDGE_DIRS) {
    const abs = path.join(cwd, dir);
    if (await exists(abs)) allFiles.push(...await listMarkdownFiles(abs, dir));
  }
  const out: CandidateFile[] = [];
  for (const request of requests.slice(0, 8)) {
    const query = (request.query ?? request.pattern ?? "").toLowerCase();
    const terms = query.split(/[^a-z0-9_./-]+/).filter((term) => term.length >= 3);
    for (const file of allFiles) {
      if (existingPaths.has(file) || out.some((candidate) => candidate.path === file)) continue;
      if (!requestMatches(file, terms, request)) continue;
      const text = await safeRead(path.join(cwd, file));
      out.push({ path: file, score: 20 + terms.length, summary: firstHeadings(text) || "Additional requested knowledge candidate" });
      if (out.length >= MAX_ADDITIONAL_CANDIDATES) return out;
    }
  }
  return out;
}

function normalizeAdditionalRequests(value: unknown): KnowledgeSelectorOutput["additionalRequests"] {
  if (!Array.isArray(value)) return [];
  const out: KnowledgeSelectorOutput["additionalRequests"] = [];
  for (const item of value) {
    const data = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const type: "keyword" | "glob" | null = data.type === "glob" ? "glob" : data.type === "keyword" ? "keyword" : null;
    if (!type) continue;
    const query = typeof data.query === "string" ? data.query.slice(0, 160) : undefined;
    const pattern = typeof data.pattern === "string" ? sanitizeRequestPattern(data.pattern) : undefined;
    if (!query && !pattern) continue;
    out.push({ type, query, pattern });
    if (out.length >= 8) break;
  }
  return out;
}

function sanitizeRequestPattern(pattern: string): string | undefined {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "").slice(0, 180);
  return KNOWLEDGE_DIRS.some((dir) => normalized.startsWith(`${dir}/`) || normalized === dir) ? normalized : undefined;
}

function requestMatches(file: string, terms: string[], request: { type: "keyword" | "glob"; query?: string; pattern?: string }): boolean {
  const lower = file.toLowerCase();
  if (request.type === "glob" && request.pattern) {
    const regex = globToRegex(request.pattern.toLowerCase());
    if (regex.test(lower)) return true;
  }
  return terms.some((term) => lower.includes(term));
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

function mergeCandidates(base: CandidateFile[], extra: CandidateFile[]): CandidateFile[] {
  const byPath = new Map<string, CandidateFile>();
  for (const candidate of [...base, ...extra]) byPath.set(candidate.path, candidate);
  return [...byPath.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 100);
}

function selectFallback(candidates: CandidateFile[]): string[] {
  const selected: string[] = [];
  for (const candidate of candidates) {
    if (candidate.path.endsWith("/_index.md") && selected.length < 8) selected.push(candidate.path);
  }
  for (const candidate of candidates) {
    if (!selected.includes(candidate.path)) selected.push(candidate.path);
    if (selected.length >= MAX_SELECTED_FILES) break;
  }
  return selected;
}

function sanitizeSelected(selected: string[], candidates: CandidateFile[]): string[] {
  const allowed = new Set(candidates.map((candidate) => candidate.path));
  const out: string[] = [];
  for (const raw of selected) {
    const rel = toPosix(path.normalize(raw)).replace(/^\.\//, "");
    if (!allowed.has(rel)) continue;
    if (!KNOWLEDGE_DIRS.some((dir) => rel.startsWith(`${dir}/`))) continue;
    if (!rel.endsWith(".md")) continue;
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

async function renderKnowledgePack(cwd: string, files: string[], mode: KnowledgePack["mode"], warnings: string[]): Promise<string> {
  const parts = [`# Relevant Knowledge Pack`, `Mode: ${mode}`, warnings.length ? `Warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}` : "Warnings: None.", "## Selected files"];
  for (const file of files) {
    const text = await safeRead(path.join(cwd, file));
    parts.push(`### ${file}\n${text.slice(0, MAX_FILE_CHARS)}${text.length > MAX_FILE_CHARS ? "\n\n[truncated by runtime knowledge budget]" : ""}`);
    if (parts.join("\n\n").length > MAX_PACK_CHARS) {
      parts.push("[knowledge pack truncated by runtime budget]");
      break;
    }
  }
  return parts.join("\n\n");
}

async function persistKnowledgePack(cwd: string, batch: Batch, pack: KnowledgePack): Promise<void> {
  const base = path.join(cwd, `.yolo/knowledge-packs/batch-${String(batch.number).padStart(3, "0")}`);
  await writeText(`${base}.json`, JSON.stringify({ selectedFiles: pack.selectedFiles, prdSections: pack.prdSections, reasons: pack.reasons, mode: pack.mode, warnings: pack.warnings }, null, 2) + "\n");
  await writeText(`${base}.md`, pack.markdown + "\n");
}

async function listMarkdownFiles(absDir: string, relDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(absDir, { withFileTypes: true })) {
    const abs = path.join(absDir, entry.name);
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await listMarkdownFiles(abs, rel));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

function batchKeywords(batch: Batch): string[] {
  const text = batch.items.flatMap((item) => [item.raw, item.title, item.tag, ...(item.details ?? []), ...(item.affectedFiles ?? [])]).join("\n").toLowerCase();
  return [...new Set(text.split(/[^a-z0-9_./-]+/).map((token) => token.replace(/^src\//, "")).filter((token) => token.length >= 3 && !["the", "and", "with", "from", "prd", "phase", "batch", "implement", "feature"].includes(token)))];
}

function extractPrdRefs(batch: Batch): string[] {
  const refs = new Set<string>();
  for (const item of batch.items) for (const match of item.raw.matchAll(/PRD\s*§\s*([0-9]+[a-z]?(?:\.[0-9]+)?)/gi)) refs.add(match[1]);
  return [...refs];
}

function firstHeadings(text: string): string {
  return text.split(/\r?\n/).filter((line) => /^#{1,3}\s+/.test(line.trim()) || /^\|/.test(line.trim())).slice(0, 6).join(" | ").slice(0, 500);
}

function journalRecencyBoost(file: string): number {
  const match = file.match(/(\d+)-batch\.md$/);
  return match ? Math.min(8, Math.max(0, Number(match[1]) / 10)) : 0;
}

async function safeRead(file: string): Promise<string> {
  try {
    return await readText(file);
  } catch {
    return "";
  }
}

async function readIfPresent(cwd: string, rel: string): Promise<string> {
  const file = path.join(cwd, rel);
  return (await exists(file)) ? readText(file) : "";
}
