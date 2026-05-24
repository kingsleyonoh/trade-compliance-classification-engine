import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../config.js";
import { validatePaths } from "../validators/path-validator.js";

export function runPolicyConsistencyTests(): void {
  const implementPrompt = readFileSync("../../.agent/agents/yolo/yolo-subagent-implement.md", "utf8");
  const reinforcePrompt = readFileSync("../../.agent/agents/yolo/yolo-subagent-reinforce.md", "utf8");
  const validatePrompt = readFileSync("../../.agent/agents/yolo/yolo-subagent-validate.md", "utf8");

  assertAllowedWhenMentioned(implementPrompt, ".agent/knowledge/foundation/example.md");
  assertAllowedWhenMentioned(implementPrompt, ".agent/knowledge/gotchas/example.md");
  assertAllowedWhenMentioned(implementPrompt, ".agent/knowledge/patterns/example.md");
  assertAllowedWhenMentioned(reinforcePrompt, ".agent/knowledge/checks/example.md");
  assertAllowedWhenMentioned(validatePrompt, ".env.example");
  assert.ok(implementPrompt.includes("localOnlyFiles"), "implement prompt must explain local-only env files");

  assertBlocked(".env.local");
  assertBlocked("secret.pem");
  assertProtected(".agent/rules/CODEBASE_CONTEXT.md");
  assertNoLiveProjectOverfitStrings();
  assertCrossLanguageRuntimeFixtures();
}

function assertAllowedWhenMentioned(prompt: string, path: string): void {
  const directory = path.split("/").slice(0, -1).join("/");
  assert.ok(prompt.includes(directory), `prompt does not mention expected directory ${directory}`);
  assert.deepEqual(validatePaths([path], defaultConfig), { name: "paths", passed: true, flags: [] }, `${path} should be allowed because prompts instruct agents to write it`);
}

function assertBlocked(path: string): void {
  const result = validatePaths([path], defaultConfig);
  assert.equal(result.passed, false, `${path} should be blocked`);
  assert.ok(result.flags.some((flag) => flag.startsWith("BLOCKED_PATH")), `${path} should produce BLOCKED_PATH`);
}

function assertProtected(path: string): void {
  const result = validatePaths([path], defaultConfig);
  assert.equal(result.passed, false, `${path} should be protected`);
  assert.ok(result.flags.some((flag) => flag.startsWith("PROTECTED_PATH")), `${path} should produce PROTECTED_PATH`);
}

function assertNoLiveProjectOverfitStrings(): void {
  const roots = ["src", "../klevar-pi-package/src", "../klevar-pi-package/extensions"];
  const forbidden = [
    /survplanner/i,
    /returns-claims/i,
    /ClaimDetail/,
    /DeliveryEvent/,
    /workspace-foundation/,
    /offlineReadiness/,
    /offlineExport/,
    /ShipmentDetail/,
    /ClaimQueue/
  ];
  const offenders: string[] = [];
  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      if (/__tests__|\.test\.|\.spec\./.test(file)) continue;
      const text = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(text)) offenders.push(`${file}:${pattern}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `generic runtime/Pi source contains live-project-specific strings: ${offenders.join(", ")}`);
}

function assertCrossLanguageRuntimeFixtures(): void {
  const tests = readFileSync("src/__tests__/run.ts", "utf8");
  const required = [
    "component-foundation.test.tsx",
    "OrderServiceTest.kt",
    "test_resource.py",
    "order_test.go",
    "Cargo.toml",
    "App.csproj",
    "pyproject.toml",
    "cargoTest",
    "cypressRegression"
  ];
  for (const needle of required) assert.ok(tests.includes(needle), `runtime regression fixtures must remain cross-language; missing ${needle}`);
}

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (["dist", "node_modules"].includes(name)) continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|js)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}
