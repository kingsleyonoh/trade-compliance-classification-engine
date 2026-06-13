import path from "node:path";
import { exists, readText } from "../util/fs.js";
import type { Batch, BatchResult, GateResult } from "../types.js";

const FRONTEND_TAGS = new Set(["[UI]", "[UX]", "[FRONTEND]", "[PAGE]", "[COMPONENT]"]);
const FRONTEND_FILE = /\.(tsx|jsx|vue|svelte|astro|css|scss|html|hbs|handlebars|twig|njk|ejs)$/i;
const NON_FRONTEND_SOURCE_FILE = /\.(java|kt|kts|cs|fs|fsx|vb|go|rs|py|rb|php|scala|clj|cljs|ex|exs|erl|hrl|swift|m|mm|c|cc|cxx|cpp|h|hpp|sql|r|jl|lua|dart)$/i;
const FRONTEND_PATH = /(^|\/)(templates|static|frontend|components|pages|app|ui)(\/|$)/i;

const QUALITY_RULES = [
  { flag: "MOBILE_VIEWPORT_PASS", missing: "MOBILE_VIEWPORT_EVIDENCE_MISSING", trigger: /mobile-first|mobile|touch|responsive|small screen/i, evidence: /mobile|viewport|iphone|pixel|touch|responsive/i },
  { flag: "OFFLINE_PWA_PASS", missing: "OFFLINE_PWA_EVIDENCE_MISSING", trigger: /offline|pwa|local-first|service worker|workbox/i, evidence: /offline|pwa|service worker|workbox|network disabled|indexeddb|dexie/i },
  { flag: "PRIVACY_MATRIX_PASS", missing: "PRIVACY_MATRIX_EVIDENCE_MISSING", trigger: /privacy|consent|raw coordinates|client details|does not leave|data policy/i, evidence: /privacy|consent|tenant|data policy|does not leave|no upload|local only/i },
  { flag: "BUNDLE_DYNAMIC_IMPORT_AUDIT_PASS", missing: "BUNDLE_DYNAMIC_IMPORT_EVIDENCE_MISSING", trigger: /bundle|first-load|dynamic import|lazy load|heavy libraries/i, evidence: /bundle|dynamic import|lazy|first-load|chunk/i }
] as const;

export async function validateProductQuality(cwd: string, batch: Batch, result: BatchResult, required: boolean): Promise<GateResult> {
  if (!required) return { name: "quality", passed: true, flags: [] };
  if (!touchesFrontend(batch, result)) return { name: "quality", passed: true, flags: [] };

  const prd = await readProductSpec(cwd);
  const contract = extractFrontendQualityContract(prd);
  const flags: string[] = [];
  const warnings: string[] = [];
  const evidence = evidenceText(result);

  const design = await validateDesignBrief(cwd);
  flags.push(...design.failures);
  warnings.push(...design.warnings);

  for (const rule of QUALITY_RULES) {
    const requiredByContract = contractRequires(contract, rule.flag, rule.trigger);
    const has = hasEvidence(result, evidence, rule.flag, rule.evidence);
    if (has || (!requiredByContract && hasNotApplicableFlag(result, rule.flag))) continue;
    if (requiredByContract) flags.push(rule.missing);
    else if (!contract && frontendRelevantSentence(prd, rule.trigger)) warnings.push(`QUALITY_WARNING:${rule.missing}`);
  }

  return { name: "quality", passed: flags.length === 0, flags: [...flags, ...warnings] };
}

async function validateDesignBrief(cwd: string): Promise<{ failures: string[]; warnings: string[] }> {
  const file = path.join(cwd, "DESIGN.md");
  if (!(await exists(file))) return { failures: ["MISSING_DESIGN_CONTEXT"], warnings: [] };
  const text = await readText(file);
  if (isGenericDesignBrief(text)) return { failures: ["GENERIC_DESIGN_BRIEF"], warnings: [] };
  const sections: Array<[string, RegExp]> = [
    ["mobile-responsive", sectionPattern(["mobile", "responsive", "breakpoints", "small screen", "touch", "layout adaptation"], /mobile|responsive|breakpoint|small screen|touch/i)],
    ["accessibility", sectionPattern(["accessibility", "a11y", "keyboard", "focus", "contrast", "screen reader"], /accessib|keyboard|focus|aria|contrast|touch target|screen reader/i)],
    ["state-hierarchy", sectionPattern(["states", "state hierarchy", "ui states", "feedback states", "loading empty error"], /loading|empty|error|offline|warning|success|state/i)],
    ["visual-system", sectionPattern(["visual system", "visual-system", "visual language", "design system", "brand system", "style system"], /spacing|typography|density|hierarchy|color|component/i)]
  ];
  return { failures: [], warnings: sections.filter(([, pattern]) => !pattern.test(text)).map(([name]) => `QUALITY_WARNING:DESIGN_BRIEF_SECTION_MISSING:${name}`) };
}

function isGenericDesignBrief(text: string): boolean {
  const compact = text.replace(/\s+/g, " ").trim().toLowerCase();
  return compact.length < 80 || /^(#\s*)?design\s*(notes|brief)?\s*(modern|clean|simple|professional|nice|good)?\s*$/i.test(compact) || /modern clean (saas )?(ui|interface|design)/i.test(compact);
}

function hasEvidence(result: BatchResult, text: string, flag: string, pattern: RegExp): boolean {
  return result.flags.some((item) => item === flag || item.startsWith(`${flag}:`) || evidenceVariantFlags(flag).some((variant) => item === variant || item.startsWith(`${variant}:`))) || positiveEvidencePattern(pattern).test(text);
}

function hasNotApplicableFlag(result: BatchResult, flag: string): boolean {
  const variant = flag.replace(/_PASS$/, "_NOT_APPLICABLE");
  return result.flags.some((item) => item === variant || item.startsWith(`${variant}:`));
}

function positiveEvidencePattern(pattern: RegExp): RegExp {
  return new RegExp(`(?<!\\bno\\s)(?<!\\bnot\\s)(?<!\\bmissing\\s)(?:${pattern.source})`, pattern.flags.includes("i") ? "i" : undefined);
}

function evidenceVariantFlags(flag: string): string[] {
  return [flag.replace(/_PASS$/, "_EVIDENCE_RECORDED")];
}

function contractRequires(contract: string, flag: string, trigger: RegExp): boolean {
  if (!contract) return false;
  if (new RegExp(`\\b${flag}\\b`).test(contract)) return true;
  return contract.split(/[\r\n]+/).some((line) => /\b(required|must|evidence)\b/i.test(line) && trigger.test(line) && !/\bN\/A\b|not applicable|out of scope/i.test(line));
}

function sectionPattern(headings: string[], fallback: RegExp): RegExp {
  const escaped = headings.map((heading) => heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`(^|\\n)#{1,4}\\s*(${escaped})\\b|${fallback.source}`, fallback.flags.includes("i") ? "i" : undefined);
}

function frontendRelevantSentence(prd: string, trigger: RegExp): boolean {
  const frontendContext = /ui|frontend|browser|client|route|page|component|screen|viewport|form|dashboard|landing|mobile|touch|responsive|pwa|offline|service worker|workbox|bundle|chunk|consent|privacy|upload|share|display/i;
  return prd.split(/[\r\n.!?]+/).some((sentence) => trigger.test(sentence) && frontendContext.test(sentence));
}

function extractFrontendQualityContract(prd: string): string {
  const lines = prd.split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{2,4}\s+.*Frontend Product Quality Contract/i.test(line));
  if (start < 0) return "";
  const level = headingLevel(lines[start]);
  const end = lines.findIndex((line, index) => index > start && headingLevel(line) > 0 && headingLevel(line) <= level);
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

function headingLevel(line: string): number {
  return /^(#{1,6})\s+/.exec(line)?.[1].length ?? 0;
}

function evidenceText(result: BatchResult): string {
  return [
    result.businessLogic?.rule,
    result.businessLogic?.sourceOfTruth,
    result.businessLogic?.test,
    result.tests?.red?.evidence,
    result.tests?.green?.evidence,
    result.tests?.regression?.evidence,
    result.tests?.e2e?.evidence
  ].filter(Boolean).join("\n");
}

function touchesFrontend(batch: Batch, result: BatchResult): boolean {
  return batch.items.some((item) => FRONTEND_TAGS.has(item.tag)) || result.filesChanged.some(isFrontendProductionFile);
}

function isFrontendProductionFile(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  if (isTestOrDocPath(normalized)) return false;
  if (FRONTEND_FILE.test(normalized)) return true;
  if (NON_FRONTEND_SOURCE_FILE.test(normalized)) return false;
  return FRONTEND_PATH.test(normalized);
}

function isTestOrDocPath(file: string): boolean {
  return /(^|\/)(tests?|__tests__|spec|docs|\.yolo)(\/|$)/i.test(file) || /(?:\.test|\.spec)\.[A-Za-z0-9]+$/i.test(file);
}

async function readProductSpec(cwd: string): Promise<string> {
  const docsDir = path.join(cwd, "docs");
  const candidates = ["docs/PRD.md", "docs/prd.md", "PRD.md"];
  try {
    const { readdir } = await import("node:fs/promises");
    if (await exists(docsDir)) candidates.push(...(await readdir(docsDir)).filter((name) => /prd.*\.md$|.*_prd\.md$/i.test(name) && name !== "PRD_TEMPLATE.md").map((name) => `docs/${name}`));
    candidates.push("docs/PRD_TEMPLATE.md");
  } catch {
    // ignore dynamic discovery failures
  }
  for (const rel of [...new Set(candidates)]) {
    const file = path.join(cwd, rel);
    if (await exists(file)) return readText(file);
  }
  return "";
}
