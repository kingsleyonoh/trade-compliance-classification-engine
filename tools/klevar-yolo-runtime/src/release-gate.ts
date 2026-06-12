import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { replayIncidentFixture } from "./incident-replay.js";

export interface ReleaseGateOptions {
  root?: string;
  skipSandbox?: boolean;
  skipBuild?: boolean;
}

export interface ReleaseGateStep {
  name: string;
  status: "pass" | "fail";
  detail: string;
}

export interface ReleaseGateResult {
  passed: boolean;
  root: string;
  steps: ReleaseGateStep[];
}

export async function runReleaseGate(options: ReleaseGateOptions = {}): Promise<ReleaseGateResult> {
  const root = findTemplateRoot(resolve(options.root ?? process.cwd()));
  const steps: ReleaseGateStep[] = [];
  const runtimeDir = join(root, "tools", "klevar-yolo-runtime");
  const piPackageDir = join(root, "tools", "klevar-pi-package");

  await pushCommandStep(steps, "runtime npm test", runtimeDir, "npm", ["test"]);
  await pushCommandStep(steps, "pi package npm test", piPackageDir, "npm", ["test"]);
  await pushIncidentReplayStep(steps, root);

  if (options.skipSandbox) {
    steps.push({ name: "sandbox dry-run smoke", status: "pass", detail: "skipped by --skip-sandbox" });
  } else {
    if (!options.skipBuild) await pushCommandStep(steps, "runtime build for dry-run", runtimeDir, "npm", ["run", "build"]);
    await pushCommandStep(steps, "sandbox dry-run smoke", root, "node", [join(runtimeDir, "dist", "cli.js"), "dry-run", "next", "1"], { KLEVAR_RELEASE_GATE_SANDBOX: "1" });
  }

  return { passed: steps.every((step) => step.status === "pass"), root, steps };
}

async function pushCommandStep(steps: ReleaseGateStep[], name: string, cwd: string, command: string, args: string[], env: Record<string, string> = {}): Promise<void> {
  if (!existsSync(cwd)) {
    steps.push({ name, status: "fail", detail: `missing directory: ${cwd}` });
    return;
  }
  const result = await runCommand(cwd, command, args, env);
  steps.push({ name, status: result.code === 0 ? "pass" : "fail", detail: `${command} ${args.join(" ")} exited ${result.code}\n${tail(result.output)}`.trim() });
}

async function pushIncidentReplayStep(steps: ReleaseGateStep[], root: string): Promise<void> {
  const fixtureRoots = [
    join(root, "tools", "klevar-yolo-runtime", "test-fixtures", "incidents"),
    join(root, "tools", "klevar-yolo-runtime", "src", "__fixtures__", "incidents")
  ];
  const fixtures: Array<{ name: string; path: string }> = [];
  const missing: string[] = [];
  for (const fixturesRoot of fixtureRoots) {
    if (!existsSync(fixturesRoot)) {
      missing.push(fixturesRoot);
      continue;
    }
    const entries = (await readdir(fixturesRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    fixtures.push(...entries.map((entry) => ({ name: entry.name, path: join(fixturesRoot, entry.name) })));
  }
  if (fixtures.length === 0) {
    steps.push({ name: "incident replay suite", status: "fail", detail: `no incident fixtures found; checked ${fixtureRoots.join(", ")}; missing ${missing.join(", ") || "none"}` });
    return;
  }
  const failures: string[] = [];
  const passed: string[] = [];
  for (const fixture of fixtures) {
    try {
      const result = await replayIncidentFixture(fixture.path);
      if (result.passed) passed.push(fixture.name);
      else failures.push(`${fixture.name}: ${result.details.join("; ")}`);
    } catch (error) {
      failures.push(`${fixture.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  steps.push({ name: "incident replay suite", status: failures.length === 0 ? "pass" : "fail", detail: failures.length ? failures.join("\n") : `passed fixtures: ${passed.join(", ")}` });
}

function findTemplateRoot(start: string): string {
  let current = start;
  for (;;) {
    if (existsSync(join(current, "tools", "klevar-yolo-runtime", "package.json")) && existsSync(join(current, "tools", "klevar-pi-package", "package.json"))) return current;
    const parent = resolve(current, "..");
    if (parent === current) return start;
    current = parent;
  }
}

function runCommand(cwd: string, command: string, args: string[], env: Record<string, string>): Promise<{ code: number; output: string }> {
  return new Promise((resolveCommand) => {
    const useShell = process.platform === "win32" && command === "npm";
    const child = spawn(command, args, { cwd, shell: useShell, env: { ...process.env, ...env } });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", (error) => resolveCommand({ code: 127, output: error.message }));
    child.on("close", (code) => resolveCommand({ code: code ?? 1, output }));
  });
}

function tail(value: string, max = 4000): string {
  return value.length <= max ? value : value.slice(value.length - max);
}

export function formatReleaseGateResult(result: ReleaseGateResult): string {
  const lines = [result.passed ? "PASS release/stabilization gate" : "FAIL release/stabilization gate", `root=${result.root}`];
  for (const step of result.steps) {
    lines.push(`${step.status === "pass" ? "PASS" : "FAIL"} ${step.name}`);
    if (step.detail) lines.push(...step.detail.split("\n").map((line) => `  ${line}`));
  }
  if (!result.passed) lines.push("Release gate failed closed. Fix failing steps before refreshing or continuing live projects.");
  return lines.join("\n");
}
