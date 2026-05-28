import path from "node:path";
import { exists, writeText } from "../util/fs.js";
import { execCommand } from "../util/process.js";
import { git } from "../util/git.js";
import type { Batch, BatchResult, GateResult, RuntimeConfig } from "../types.js";

const FRONTEND_EXTENSIONS = /\.(tsx|jsx|vue|svelte|astro|css|scss|sass|less|html|hbs|handlebars|twig|njk|ejs)$/i;
const NON_FRONTEND_SOURCE_EXTENSIONS = /\.(java|kt|kts|cs|fs|fsx|vb|go|rs|py|rb|php|scala|clj|cljs|ex|exs|erl|hrl|swift|m|mm|c|cc|cxx|cpp|h|hpp|sql|r|jl|lua|dart)$/i;
const FRONTEND_PATHS = /(^|\/)(src\/app|src\/pages|src\/components|app|pages|components|frontend|templates|static|public|styles|ui)(\/|$)/i;
const BACKEND_SOURCE_PATHS = /(^|\/)src\/(api|routes|server|middleware|db|services|repositories|workers|jobs)(\/|\.|$)/i;
const FRONTEND_TAGS = new Set(["[UI]", "[UX]", "[FRONTEND]", "[PAGE]", "[COMPONENT]"]);

interface DetectorResult {
  flags: string[];
  clean: boolean;
}

export async function validateFrontendImpeccable(cwd: string, batch: Batch, result: BatchResult, config: RuntimeConfig): Promise<GateResult> {
  if (!config.gates.requireFrontendImpeccable || !touchesFrontend(batch, result)) return { name: "frontend", passed: true, flags: [] };
  const flags: string[] = [];
  if (!(await exists(path.join(cwd, "PRODUCT.md")))) flags.push("MISSING_PRODUCT_CONTEXT");
  if (!(await exists(path.join(cwd, "DESIGN.md")))) flags.push("MISSING_DESIGN_CONTEXT");
  if (result.flags.some((flag) => /^FRONTEND_IMPECCABLE_(?:P0|P1|FINDING|FAIL)/i.test(flag)) && !hasFlag(result, "FRONTEND_IMPECCABLE_AUDIT_PASS") && !hasFlag(result, "FRONTEND_IMPECCABLE_POLISH_PASS")) flags.push("FRONTEND_IMPECCABLE_BLOCKING_FINDINGS");
  const detector = await runImpeccableDetector(cwd, batch, result, config);
  flags.push(...detector.flags);
  if (!hasFrontendAuditEvidence(result, detector)) flags.push("MISSING_FRONTEND_IMPECCABLE_AUDIT_PASS");
  if (!hasFrontendPolishEvidence(result, detector)) flags.push("MISSING_FRONTEND_IMPECCABLE_POLISH_PASS");
  return { name: "frontend", passed: flags.length === 0, flags };
}

export function touchesFrontend(batch: Batch, result: BatchResult): boolean {
  if (batch.items.some((item) => FRONTEND_TAGS.has(item.tag.toUpperCase()))) return true;
  return frontendCandidates(batch, result).some(isFrontendPath);
}

async function runImpeccableDetector(cwd: string, batch: Batch, result: BatchResult, config: RuntimeConfig): Promise<DetectorResult> {
  const frontend = config.frontend;
  if (!frontend?.impeccableCommand) return { clean: false, flags: ["IMPECCABLE_DETECTOR_NOT_CONFIGURED"] };
  const targets = await frontendTargets(cwd, batch, result);
  const command = `${frontend.impeccableCommand} ${targets.map(shellQuote).join(" ")}`.trim();
  const detector = await execCommand(command, cwd, frontend.detectorTimeoutMs ?? 120000);
  const artifact = `.yolo/gates/impeccable-detect-batch-${String(batch.number).padStart(3, "0")}.json`;
  await writeText(path.join(cwd, artifact), JSON.stringify({ command: detector.command, exitCode: detector.exitCode, stdout: detector.stdout, stderr: detector.stderr }, null, 2) + "\n");
  if (detector.exitCode !== 0 && hasFlag(result, "FRONTEND_IMPECCABLE_AUDIT_PASS") && hasFlag(result, "FRONTEND_IMPECCABLE_POLISH_PASS")) return { clean: false, flags: [`IMPECCABLE_DETECTOR_UNAVAILABLE:${detector.exitCode}`] };
  if (detector.exitCode !== 0) return { clean: false, flags: [`IMPECCABLE_DETECTOR_FAILED:${detector.exitCode}`] };
  const findings = parseDetectorFindings(detector.stdout);
  if (findings.length && frontend.failOnDetectorFindings !== false) return { clean: false, flags: [`IMPECCABLE_DETECTOR_FINDINGS:${findings.length}`, `artifact:${artifact}`] };
  return { clean: true, flags: [] };
}

function parseDetectorFindings(stdout: string): unknown[] {
  try {
    const parsed = JSON.parse(stdout || "[]");
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.findings)) return parsed.findings;
    if (Array.isArray(parsed.results)) return parsed.results.flatMap((item: unknown) => {
      const data = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return Array.isArray(data.findings) ? data.findings : [];
    });
  } catch {
    return [{ parseError: true }];
  }
  return [];
}

function hasFrontendAuditEvidence(result: BatchResult, detector: DetectorResult): boolean {
  return hasFlag(result, "FRONTEND_IMPECCABLE_AUDIT_PASS") || detector.clean;
}

function hasFrontendPolishEvidence(result: BatchResult, detector: DetectorResult): boolean {
  return hasFlag(result, "FRONTEND_IMPECCABLE_POLISH_PASS") || (detector.clean && hasRunnableUiEvidence(result));
}

function hasRunnableUiEvidence(result: BatchResult): boolean {
  return Boolean([
    result.tests?.e2e,
    result.tests?.regression,
    result.tests?.green,
    ...(Object.values(result.tests ?? {}) as unknown[])
  ].some((item) => testEvidencePasses(item)) || result.flags.some((flag) => /^(E2E|BROWSER|MOBILE_VIEWPORT|OFFLINE_PWA|PRIVACY_MATRIX|TYPECHECK_LINT|FULL_TEST_SUITE|TARGETED_.*TEST)_PASS/i.test(flag)));
}

function testEvidencePasses(value: unknown): boolean {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : null;
  if (!data) return false;
  return typeof data.command === "string" && !/^(?:not applicable|not run|skipped|n\/a|:)$/i.test(data.command.trim()) && data.exitCode === 0;
}

async function frontendTargets(cwd: string, batch: Batch, result: BatchResult): Promise<string[]> {
  const candidates = [...frontendCandidates(batch, result), ...(await changedPathsFromGit(cwd))];
  const targets = candidates.map((file) => file.replace(/\\/g, "/")).filter(isFrontendPath).filter((file) => !file.startsWith(".yolo/"));
  const existing = [];
  for (const target of [...new Set(targets)]) {
    if (await exists(path.join(cwd, target))) existing.push(target);
  }
  return existing.length ? existing : ["."];
}

function frontendCandidates(batch: Batch, result: BatchResult): string[] {
  return [...(result.filesChanged ?? []), ...batch.items.flatMap((item) => item.affectedFiles ?? [])];
}

async function changedPathsFromGit(cwd: string): Promise<string[]> {
  try {
    const output = await git(cwd, "status --short --untracked-files=all");
    return output.split(/\r?\n/).filter(Boolean).map(parseStatusLine).filter((value): value is string => Boolean(value));
  } catch {
    return [];
  }
}

function parseStatusLine(line: string): string | null {
  if (line.length < 4) return null;
  const rawPath = line.slice(3).trim();
  return rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() ?? rawPath : rawPath;
}

function isFrontendPath(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  if (BACKEND_SOURCE_PATHS.test(normalized)) return false;
  if (FRONTEND_EXTENSIONS.test(normalized)) return true;
  if (NON_FRONTEND_SOURCE_EXTENSIONS.test(normalized)) return false;
  return FRONTEND_PATHS.test(normalized);
}

function hasFlag(result: BatchResult, expected: string): boolean {
  return result.flags.some((flag) => flag === expected || flag.startsWith(`${expected}:`));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
