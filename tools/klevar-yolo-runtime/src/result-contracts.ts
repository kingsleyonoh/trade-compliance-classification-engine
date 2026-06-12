import { readText, writeText } from "./util/fs.js";
import type { BatchResult, GateResult } from "./types.js";

export function emptyResult(batch: number): BatchResult {
  return { schemaVersion: 1, agent: "implement", batch, status: "INVALID_RESULT", itemsCompleted: [], filesChanged: [], flags: [] };
}

export async function readBatchResult(file: string): Promise<BatchResult> {
  try {
    return normalizeBatchResult(JSON.parse(await readText(file)), extractBatch(file));
  } catch {
    return emptyResult(extractBatch(file));
  }
}

export async function readCanonicalBatchResult(file: string): Promise<BatchResult> {
  const result = await readBatchResult(file);
  if (result.status !== "INVALID_RESULT") await writeBatchResult(file, result);
  return result;
}

export function normalizeBatchResult(raw: unknown, fallbackBatch = 0): BatchResult {
  const data = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const flags = normalizeFlags(data.flags);
  const shapeFlags = malformedShapeFlags(data);
  const status = typeof data.status === "string" && isBatchStatus(data.status) ? data.status : "INVALID_RESULT";
  return {
    ...preserveExtraContractFields(data),
    schemaVersion: typeof data.schemaVersion === "number" ? data.schemaVersion : 0,
    agent: isAgent(data.agent) ? data.agent : "implement",
    batch: normalizeBatch(data.batch, fallbackBatch),
    status,
    itemsCompleted: normalizeStringList(data.itemsCompleted, itemText),
    filesChanged: normalizeStringList(data.filesChanged, pathText),
    tests: normalizeTests(data.tests),
    wiring: objectOrUndefined(data.wiring) as BatchResult["wiring"],
    projectLocalChecks: normalizeProjectLocalChecks(data.projectLocalChecks),
    businessLogic: objectOrUndefined(data.businessLogic) as BatchResult["businessLogic"],
    artifacts: normalizeArtifacts(data.artifacts),
    localOnlyFiles: normalizeLocalOnlyFiles(data.localOnlyFiles),
    inbox: normalizeInbox(data.inbox),
    failureType: typeof data.failureType === "string" ? data.failureType : typeof data.failure_type === "string" ? data.failure_type : undefined,
    flags: [...new Set([...shapeFlags, ...flags])],
    commit: typeof data.commit === "string" ? data.commit : data.commit === null ? null : undefined
  };
}

export async function writeBatchResult(file: string, result: BatchResult): Promise<void> {
  await writeText(file, JSON.stringify(result, null, 2) + "\n");
}

export function validateContract(result: BatchResult): GateResult {
  const flags = [];
  if (result.schemaVersion !== 1) flags.push("INVALID_SCHEMA_VERSION");
  if (!result.status) flags.push("MISSING_STATUS");
  if (!isBatchStatus(result.status)) flags.push("INVALID_STATUS");
  if (!Array.isArray(result.itemsCompleted)) flags.push("MISSING_ITEMS_COMPLETED");
  if (!Array.isArray(result.filesChanged)) flags.push("MISSING_FILES_CHANGED");
  if (!Array.isArray(result.flags)) flags.push("MISSING_FLAGS_ARRAY");
  for (const flag of result.flags ?? []) if (/^INVALID_(?:STATUS|.*_SHAPE)$/.test(flag)) flags.push(flag);
  if (result.status === "FAILURE" && !result.failureType) flags.push("FAILURE_WITHOUT_FAILURE_TYPE");
  if (result.status !== "FAILURE" && result.failureType) flags.push(`FAILURE_TYPE_WITH_${result.status}`);
  if (result.status === "FAILURE" && result.failureType) flags.push(`RESULT_STATUS_FAILURE:${result.failureType}`);
  if (result.commit !== null && result.commit !== undefined) flags.push("COMMIT_CLAIMED_BY_AGENT");
  if (result.projectLocalChecks && "triggered" in result.projectLocalChecks && !Array.isArray(result.projectLocalChecks.triggered)) flags.push("INVALID_PROJECT_LOCAL_CHECKS_SHAPE");
  if (result.artifacts && !Array.isArray(result.artifacts)) flags.push("INVALID_ARTIFACTS_SHAPE");
  return { name: "contract", passed: flags.length === 0, flags };
}

function isBatchStatus(value: string): value is BatchResult["status"] {
  return value === "SUCCESS" || value === "FAILURE" || value === "PARTIAL_SUCCESS" || value === "BUG_FOUND" || value === "INVALID_RESULT";
}

function preserveExtraContractFields(data: Record<string, unknown>): Record<string, unknown> {
  const normalized = new Set(["schemaVersion", "agent", "batch", "status", "itemsCompleted", "filesChanged", "tests", "wiring", "projectLocalChecks", "businessLogic", "artifacts", "localOnlyFiles", "inbox", "failureType", "failure_type", "flags", "commit"]);
  return Object.fromEntries(Object.entries(data).filter(([key, value]) => !normalized.has(key) && isJsonValue(value)));
}

function isJsonValue(value: unknown): boolean {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).every(isJsonValue);
  return false;
}

function malformedShapeFlags(data: Record<string, unknown>): string[] {
  const flags: string[] = [];
  if (typeof data.status === "string" && !isBatchStatus(data.status)) flags.push("INVALID_STATUS");
  if (data.flags !== undefined && !normalizableFlags(data.flags)) flags.push("INVALID_FLAGS_SHAPE");
  if (data.itemsCompleted !== undefined && !normalizableStringList(data.itemsCompleted, itemText)) flags.push("INVALID_ITEMS_COMPLETED_SHAPE");
  if (data.filesChanged !== undefined && !normalizableStringList(data.filesChanged, pathText)) flags.push("INVALID_FILES_CHANGED_SHAPE");
  if (data.localOnlyFiles !== undefined && !normalizableStringList(data.localOnlyFiles, localOnlyPath)) flags.push("INVALID_LOCAL_ONLY_FILES_SHAPE");
  if (data.artifacts !== undefined && !normalizableArtifacts(data.artifacts)) flags.push("INVALID_ARTIFACTS_SHAPE");
  if (data.flags !== undefined && !Array.isArray(data.flags)) flags.push("FLAGS_OBJECT_NORMALIZED");
  if (Array.isArray(data.itemsCompleted) && data.itemsCompleted.some((item) => typeof item !== "string")) flags.push("ITEMS_COMPLETED_OBJECTS_NORMALIZED");
  if (Array.isArray(data.filesChanged) && data.filesChanged.some((item) => typeof item !== "string")) flags.push("FILES_CHANGED_OBJECTS_NORMALIZED");
  if (data.tests !== undefined && !normalizableTests(data.tests)) flags.push("INVALID_TESTS_SHAPE");
  if (Array.isArray(data.tests)) flags.push("TEST_EVIDENCE_ARRAY_NORMALIZED");
  if (objectOrUndefined(data.tests) && usesTestAliases(data.tests as Record<string, unknown>)) flags.push("TEST_EVIDENCE_ALIASES_NORMALIZED");
  return flags;
}

function stringArray(value: unknown): string[] {
  return normalizeStringList(value, (item) => typeof item === "string" ? item : null);
}

function normalizeStringList(value: unknown, extractor: (item: unknown) => string | null): string[] {
  if (value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => typeof item === "string" ? item : extractor(item)).filter((item): item is string => Boolean(item));
}

function normalizableStringList(value: unknown, extractor: (item: unknown) => string | null): boolean {
  const items = Array.isArray(value) ? value : [value];
  return items.every((item) => typeof item === "string" || Boolean(extractor(item)));
}

function itemText(value: unknown): string | null {
  const data = objectOrUndefined(value);
  if (!data) return null;
  const text = data.title ?? data.task ?? data.item ?? data.name ?? data.description;
  return typeof text === "string" ? text : null;
}

function pathText(value: unknown): string | null {
  const data = objectOrUndefined(value);
  if (!data) return null;
  const text = data.path ?? data.file ?? data.filename ?? data.name;
  return typeof text === "string" ? text : null;
}

function normalizeBatch(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return fallback;
}

function isAgent(value: unknown): value is BatchResult["agent"] {
  return value === "implement" || value === "validate" || value === "bugfix" || value === "journal" || value === "audit" || value === "adjudicate";
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function normalizeTests(value: unknown): BatchResult["tests"] {
  const data = testsObject(value);
  if (!data) return undefined;
  const aliases = {
    red: firstTest(data, ["red", "redReproducer", "failingReproducer", "redEvidence", "failingTest", "repro", "reproducer"]),
    green: firstTest(data, ["green", "greenReproducer", "fixedReproducer", "greenEvidence", "targeted", "targetedRegression", "targetedTest", "fixVerification"]),
    regression: firstTest(data, ["regression", "fullRegression", "fullSuite", "fullTestSuite", "testSuite", "allTests", "unitRegression", "integrationRegression", "systemRegression", "buildCheck", "ciCheck", "gradleCheck", "mavenCheck", "jvmRegression", "dotnetTest", "goTest", "pytest", "cargoTest"]),
    e2e: normalizeE2eEvidence(firstRawTest(data, ["e2e", "e2eRegression", "browser", "browserRegression", "playwright", "playwrightRegression", "cypress", "cypressRegression", "selenium", "webdriver", "integrationE2e"]))
  };
  const passthrough = Object.fromEntries(Object.entries(data).filter(([, item]) => objectOrUndefined(item))) as Record<string, unknown>;
  return { ...passthrough, ...Object.fromEntries(Object.entries(aliases).filter(([, item]) => item)) } as BatchResult["tests"];
}

function firstTest(data: Record<string, unknown>, keys: string[]): NonNullable<BatchResult["tests"]>["red"] | undefined {
  return normalizeTestEvidence(firstRawTest(data, keys));
}

function firstRawTest(data: Record<string, unknown>, keys: string[]): unknown {
  return keys.map((key) => data[key]).find((value) => value !== undefined);
}

function normalizeTestEvidence(value: unknown): NonNullable<BatchResult["tests"]>["red"] | undefined {
  const data = objectOrUndefined(value);
  if (!data) return undefined;
  return {
    command: typeof data.command === "string" ? data.command : typeof data.cmd === "string" ? data.cmd : typeof data.commandLine === "string" ? data.commandLine : "unknown",
    exitCode: normalizeExitCode(data),
    evidence: typeof data.evidence === "string" ? data.evidence : typeof data.summary === "string" ? data.summary : typeof data.output === "string" ? data.output : "normalized test evidence"
  };
}

function normalizeE2eEvidence(value: unknown): NonNullable<BatchResult["tests"]>["e2e"] | undefined {
  const evidence = normalizeTestEvidence(value);
  const data = objectOrUndefined(value);
  if (!evidence || !data) return undefined;
  return { ...evidence, required: typeof data.required === "boolean" ? data.required : true };
}

function usesTestAliases(data: Record<string, unknown>): boolean {
  return ["redReproducer", "failingReproducer", "redEvidence", "failingTest", "repro", "reproducer", "greenReproducer", "fixedReproducer", "greenEvidence", "targeted", "targetedRegression", "targetedTest", "fixVerification", "fullRegression", "fullSuite", "fullTestSuite", "testSuite", "allTests", "unitRegression", "integrationRegression", "systemRegression", "buildCheck", "ciCheck", "gradleCheck", "mavenCheck", "jvmRegression", "dotnetTest", "goTest", "pytest", "cargoTest", "e2eRegression", "browser", "browserRegression", "playwright", "playwrightRegression", "cypress", "cypressRegression", "selenium", "webdriver", "integrationE2e"].some((key) => key in data);
}

function normalizableTests(value: unknown): boolean {
  if (Array.isArray(value)) return value.every((item) => objectOrUndefined(item));
  const data = objectOrUndefined(value);
  return data !== undefined && Object.entries(data).every(([key, item]) => {
    if (item === null || ["string", "number", "boolean"].includes(typeof item)) return isTestMetadataKey(key);
    if (Array.isArray(item)) return item.every((entry) => objectOrUndefined(entry));
    return Boolean(objectOrUndefined(item));
  });
}

function isTestMetadataKey(key: string): boolean {
  return /^(testsAdded|testFiles|tests|filesScanned|durationMs|notes|summary)$/i.test(key);
}

function testsObject(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) return testsArrayToObject(value);
  const data = objectOrUndefined(value);
  if (!data) return undefined;
  const commandArray = Array.isArray(data.commands) ? testsArrayToObject(data.commands) : undefined;
  return commandArray ? { ...data, ...commandArray } : data;
}

function testsArrayToObject(value: unknown[]): Record<string, unknown> | undefined {
  const entries = value.map((item) => objectOrUndefined(item)).filter((item): item is Record<string, unknown> => Boolean(item));
  if (entries.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const [index, entry] of entries.entries()) {
    const key = inferTestEvidenceKey(entry, index);
    if (!(key in out)) out[key] = entry;
  }
  return out;
}

function inferTestEvidenceKey(entry: Record<string, unknown>, index: number): string {
  const text = ["kind", "type", "phase", "name", "check", "category", "command", "cmd", "commandLine", "summary", "evidence"]
    .map((key) => entry[key])
    .filter((item): item is string => typeof item === "string")
    .join(" ")
    .toLowerCase();
  if (/\b(red|failing|reproducer)\b/.test(text)) return "red";
  if (/\b(green|targeted|fixed)\b/.test(text)) return "green";
  if (/\b(e2e|playwright|browser)\b/.test(text)) return "e2e";
  if (/\b(regression|full|suite|gradle|test|jvm)\b/.test(text)) return "regression";
  return `evidence${index + 1}`;
}

function normalizeExitCode(data: Record<string, unknown>): number {
  if (typeof data.exitCode === "number") return data.exitCode;
  if (typeof data.exit_code === "number") return data.exit_code;
  if (typeof data.code === "number") return data.code;
  if (typeof data.status === "string" && /^(pass|passed|success)$/i.test(data.status)) return 0;
  if (typeof data.status === "string" && /^(fail|failed|failure)$/i.test(data.status)) return 1;
  return 0;
}

function normalizeProjectLocalChecks(value: unknown): BatchResult["projectLocalChecks"] {
  const data = objectOrUndefined(value);
  if (!data) return undefined;
  return {
    evaluated: typeof data.evaluated === "number" ? data.evaluated : typeof data.evaluatedCount === "number" ? data.evaluatedCount : 0,
    triggered: stringArray(data.triggered),
    notes: typeof data.notes === "string" ? data.notes : undefined
  };
}

function normalizeLocalOnlyFiles(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const blockedGeneratedDirs = new Set(["node_modules", "node_modules/", "var/storage", "var/storage/"]);
  return normalizeStringList(value, localOnlyPath).map((item) => item.replace(/\\/g, "/")).filter((item) => !blockedGeneratedDirs.has(item));
}

function localOnlyPath(value: unknown): string | null {
  const data = objectOrUndefined(value);
  if (!data) return null;
  return typeof data.path === "string" ? data.path : typeof data.file === "string" ? data.file : null;
}

function normalizeArtifacts(value: unknown): BatchResult["artifacts"] {
  if (value === undefined) return undefined;
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (typeof item === "string") return { path: item };
    const data = objectOrUndefined(item);
    if (!data) return { path: JSON.stringify(item) };
    return { path: String(data.path ?? data.file ?? "unknown"), description: typeof data.description === "string" ? data.description : typeof data.type === "string" ? data.type : undefined };
  });
}

function normalizableArtifacts(value: unknown): boolean {
  const items = Array.isArray(value) ? value : [value];
  return items.every((item) => typeof item === "string" || Boolean(objectOrUndefined(item)));
}

function normalizeFlags(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  const data = objectOrUndefined(value);
  if (!data) return [];
  return Object.entries(data)
    .filter(([, enabled]) => enabled === true || typeof enabled === "string" || typeof enabled === "number")
    .map(([key, enabled]) => enabled === true ? key : `${key}:${String(enabled)}`);
}

function normalizableFlags(value: unknown): boolean {
  if (Array.isArray(value)) return value.every((item) => typeof item === "string");
  const data = objectOrUndefined(value);
  return data !== undefined && Object.values(data).every((item) => item === true || typeof item === "string" || typeof item === "number" || item === false || item === null || item === undefined);
}

function normalizeInbox(value: unknown): BatchResult["inbox"] {
  const data = objectOrUndefined(value);
  if (!data) return undefined;
  return { handledTitles: stringArray(data.handledTitles) };
}

function extractBatch(file: string): number {
  const match = /batch-(\d+)/.exec(file);
  return match ? Number(match[1]) : 0;
}
