import { exists } from "../util/fs.js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Batch, BatchResult, GateResult } from "../types.js";

const COMMON_VERIFIER_EXTENSIONS = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "jl", "go", "rs", "java", "kt", "kts", "cs", "rb", "php", "scala", "clj", "cljs", "swift", "m", "mm", "cpp", "cc", "cxx", "c", "h", "hpp", "md", "sh", "ps1"];
const TEXT_VERIFIER_EXTENSIONS = new Set([...COMMON_VERIFIER_EXTENSIONS, "r", "lua", "dart", "ex", "exs", "erl", "hrl", "fs", "fsx", "fsi", "vb", "pl", "pm", "groovy", "zig", "nim", "d", "hs", "ml", "mli", "sql", "graphql", "gql", "yaml", "yml", "json", "toml", "bats", "fish", "zsh"]);
const NON_VERIFIER_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "ico", "svg", "pdf", "zip", "gz", "tgz", "rar", "7z", "exe", "dll", "so", "dylib", "bin", "lock", "map"]);
const GENERATED_DIRS = new Set(["node_modules", "dist", "build", "coverage", "target", ".git", ".yolo", ".next", ".nuxt", ".venv", "venv", "vendor"]);
const VERIFIER_PATH = /[A-Za-z0-9_.\/-]+\.[A-Za-z0-9]{1,12}/gi;

export async function validateWiring(cwd: string, batch: Batch, result: BatchResult, required: boolean): Promise<GateResult> {
  if (!required) return { name: "wiring", passed: true, flags: [] };
  const requiresEntrypoint = batch.items.some((item) => ["[API]", "[UI]", "[JOB]", "[INTEGRATION]"].includes(item.tag));
  if (!requiresEntrypoint) return { name: "wiring", passed: true, flags: [] };
  const flags = [];
  if (!result.wiring?.required) flags.push("MISSING_WIRING_DECLARATION");
  if (!result.wiring?.entrypoints?.length) flags.push("NO_REACHABLE_ENTRYPOINTS");
  for (const rawEntry of result.wiring?.entrypoints ?? []) {
    const entry = normalizeEntrypoint(rawEntry);
    const verifiedBy = entry.verifiedBy || inferVerifierEvidence(cwd, entry.path);
    if (!verifiedBy) {
      flags.push(`ENTRYPOINT_UNVERIFIED:${entry.path}`);
      continue;
    }
    for (const verifier of extractVerifierFiles(verifiedBy)) {
      if (!(await verifierExists(cwd, verifier))) flags.push(`WIRING_VERIFIER_FILE_MISSING:${verifier}`);
    }
  }
  return { name: "wiring", passed: flags.length === 0, flags };
}

export function extractVerifierFiles(value: string): string[] {
  const matches = value.match(VERIFIER_PATH) ?? [];
  return [...new Set(matches.map((match) => match.replace(/^[\'"`(]+|[\'"`),.;:]+$/g, "")).filter((match) => /[\\/]/.test(match)))];
}

async function verifierExists(cwd: string, verifier: string): Promise<boolean> {
  if (await exists(`${cwd}/${verifier}`)) return true;
  for (const candidate of verifierExtensionCandidates(cwd, verifier)) if (await exists(`${cwd}/${candidate}`)) return true;
  return false;
}

function normalizeEntrypoint(entry: { type?: string; path?: string; verifiedBy?: string } | string): { path: string; verifiedBy: string } {
  if (typeof entry === "string") return { path: entry, verifiedBy: "" };
  return { path: String(entry.path ?? entry.type ?? "unknown"), verifiedBy: String(entry.verifiedBy ?? "") };
}

function inferVerifierEvidence(cwd: string, entrypoint: string): string {
  const needles = verifierNeedles(entrypoint);
  if (!needles.length) return "";
  const matches: string[] = [];
  for (const file of collectVerifierCandidates(cwd)) {
    let text = "";
    try {
      text = readFileSync(join(cwd, file), "utf8");
    } catch {
      continue;
    }
    if (needles.some((needle) => typeof needle === "string" ? text.includes(needle) : needle.test(text))) matches.push(file);
    if (matches.length >= 3) break;
  }
  return matches.join(", ");
}

function verifierNeedles(entrypoint: string): Array<string | RegExp> {
  const value = entrypoint.trim();
  const withoutMethod = value.replace(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i, "");
  const needles: Array<string | RegExp> = [];
  if (withoutMethod.startsWith("/")) {
    needles.push(withoutMethod);
    const [pathOnly, query] = withoutMethod.split("?", 2);
    if (query) {
      needles.push(new RegExp(`${escapeRegex(pathOnly)}[\\s\\S]{0,160}${queryNeedle(query)}`, "i"));
    }
    if (withoutMethod.includes(":")) needles.push(new RegExp(escapeRegex(withoutMethod).replace(/:[A-Za-z0-9_]+/g, "[^/'\"`]+")));
  }
  if (isCliEntrypoint(value)) {
    for (const group of cliTokenGroups(value)) {
      if (group.length) needles.push(new RegExp(group.map(escapeRegex).join("[\\s\\S]{0,160}"), "i"));
    }
  }
  const normalized = withoutMethod.replace(/\\/g, "/");
  if (!withoutMethod.startsWith("/") && !isCliEntrypoint(value)) {
    const symbolGroups = symbolTokenGroups(normalized);
    for (const group of symbolGroups) if (group.length) needles.push(new RegExp(group.map(escapeRegex).join("[\\s\\S]{0,160}"), "i"));
  }
  if (/\.[A-Za-z0-9]+$/.test(normalized)) {
    needles.push(normalized);
    needles.push(normalized.replace(/^src\//, "").replace(/\.[A-Za-z0-9]+$/, ""));
    needles.push((normalized.split("/").pop() ?? normalized).replace(/\.[A-Za-z0-9]+$/, ""));
  }
  const seen = new Set<string>();
  return needles.filter((needle) => {
    const key = typeof needle === "string" ? `s:${needle}` : `r:${needle.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function symbolTokenGroups(value: string): string[][] {
  return value
    .split("/")
    .map((part) => part.split(/[^A-Za-z0-9_!]+/).map((token) => token.trim()).filter((token) => token.length >= 3));
}

function isCliEntrypoint(value: string): boolean {
  return /^CLI\s+/i.test(value) || /(?:^|\s)(?:[\w.-]+-)?(?:cli|portal|cmd|command)(?:\s|$)/i.test(value) || /(?:^|\s)--[A-Za-z0-9-]+/.test(value);
}

function cliTokenGroups(value: string): string[][] {
  const cleaned = value.replace(/^CLI\s+/i, "");
  return cleaned.split("|").map((part) => part.split(/\s+/).map((token) => token.trim()).filter(Boolean).filter((token) => !/^<.+>$/.test(token) && !/^(?:[\w.-]+-)?(?:cli|portal|cmd|command)$/i.test(token)));
}

function queryNeedle(query: string): string {
  return query.split("&").filter(Boolean).map((part) => {
    const [key, value = ""] = part.split("=", 2);
    return `${escapeRegex(key)}[\\s\\S]{0,40}${escapeRegex(value)}`;
  }).join("[\\s\\S]{0,80}");
}

function collectVerifierCandidates(cwd: string): string[] {
  const roots = ["tests", "test", "spec", "src", "scripts", "tools"];
  const files: string[] = [];
  for (const root of roots) collectFiles(cwd, root, files);
  return files.filter((file) => /(?:test|spec|__tests__|tests[\/])|src[\/]|scripts[\/]|tools[\/]/i.test(file));
}

function collectFiles(cwd: string, relDir: string, files: string[]): void {
  const dir = join(cwd, relDir);
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (GENERATED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      const rel = relative(cwd, full).replace(/\\/g, "/");
      if (entry.isDirectory()) collectFiles(cwd, rel, files);
      else if (entry.isFile() && isVerifierSourceFile(rel) && statSync(full).size <= 250_000) files.push(rel);
      if (files.length >= 500) return;
    }
  } catch {
    // Missing verifier roots are common in small projects.
  }
}

function isVerifierSourceFile(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  const name = normalized.split("/").pop() ?? normalized;
  if (/^(?:Dockerfile|Makefile|Rakefile|Gemfile|Procfile)$/i.test(name)) return true;
  const ext = fileExtension(normalized);
  if (!ext || NON_VERIFIER_EXTENSIONS.has(ext)) return false;
  if (TEXT_VERIFIER_EXTENSIONS.has(ext)) return true;
  return isTestLikePath(normalized) || /(?:^|\/)(?:src|tests?|spec|scripts|tools)\//i.test(normalized);
}

function verifierExtensionCandidates(cwd: string, verifier: string): string[] {
  const normalized = verifier.replace(/\\/g, "/");
  const match = /^(.*)\.([A-Za-z0-9]+)$/.exec(normalized);
  if (!match || !isTestLikePath(normalized)) return [];
  const [, base, ext] = match;
  return projectVerifierExtensions(cwd).filter((candidate) => candidate !== ext.toLowerCase()).map((candidate) => `${base}.${candidate}`);
}

function projectVerifierExtensions(cwd: string): string[] {
  const extensions = new Set(COMMON_VERIFIER_EXTENSIONS);
  for (const file of collectVerifierCandidates(cwd)) {
    const ext = fileExtension(file);
    if (ext) extensions.add(ext);
  }
  return [...extensions];
}

function fileExtension(file: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(file);
  return match?.[1]?.toLowerCase() ?? "";
}

function isTestLikePath(file: string): boolean {
  const name = file.split("/").pop() ?? file;
  return /(?:^|[._-])(test|spec)(?:[._-]|$)/i.test(name) || /(?:Test|Spec)\.[A-Za-z0-9]+$/.test(name) || /_test\.[A-Za-z0-9]+$/i.test(name);
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$*+?.()|{}[\]]/g, "\\$&");
}
