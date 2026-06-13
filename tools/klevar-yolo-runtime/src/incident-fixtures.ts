import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { exists, ensureDir, copyPath } from "./util/fs.js";
import { execCommand } from "./util/process.js";
import type { Batch, BatchResult } from "./types.js";

export interface CapturedIncidentFixture {
  dir: string;
  manifestPath: string;
  copied: string[];
  missing: string[];
  worktreeStatusPath?: string;
}

interface IncidentManifest {
  schemaVersion: 1;
  kind: "poisoned-batch-exit";
  batch: number;
  capturedAt: string;
  flags: string[];
  sourcePaths: Record<string, string[]>;
  copied: string[];
  missing: string[];
  resultSummary: {
    status?: string;
    agent?: string;
    failureType?: string;
    flags?: string[];
  };
}

export async function capturePoisonedBatchIncidentFixture(rootCwd: string, batch: Batch, result: BatchResult, flags: string[]): Promise<CapturedIncidentFixture> {
  const padded = String(batch.number).padStart(3, "0");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(rootCwd, ".yolo/incidents", `batch-${padded}-${stamp}-poisoned-exit`);
  await ensureDir(dir);
  const runtimeState = path.join(rootCwd, ".yolo/runtime-state.json");
  const state = await readJsonIfExists(runtimeState) as { worktree?: string } | null;
  const sources = {
    state: [runtimeState],
    logs: await latestRuntimeLogs(rootCwd),
    results: await matchingBatchFiles(rootCwd, ".yolo/batch-results", `batch-${padded}-`),
    gates: await matchingBatchFiles(rootCwd, ".yolo/gates", `batch-${padded}`),
    worktreeResults: state?.worktree ? await matchingBatchFiles(String(state.worktree), ".yolo/batch-results", `batch-${padded}-`) : [],
    worktreeGates: state?.worktree ? await matchingBatchFiles(String(state.worktree), ".yolo/gates", `batch-${padded}`) : []
  };
  const copied: string[] = [];
  const missing: string[] = [];
  for (const [kind, paths] of Object.entries(sources)) {
    for (const sourcePath of paths) {
      const rel = path.isAbsolute(sourcePath) ? path.relative(rootCwd, sourcePath) : sourcePath;
      const destRel = path.join(kind, flattenIncidentEvidencePath(rel));
      if (await exists(sourcePath)) {
        await copyPath(sourcePath, path.join(dir, destRel));
        copied.push(destRel.split(path.sep).join("/"));
      } else {
        missing.push(sourcePath);
      }
    }
  }
  let worktreeStatusPath: string | undefined;
  if (state?.worktree && await exists(String(state.worktree))) {
    const status = await execCommand("git status --short", String(state.worktree));
    worktreeStatusPath = "worktree-status.txt";
    await writeFile(path.join(dir, worktreeStatusPath), status.stdout + status.stderr, "utf8");
    copied.push(worktreeStatusPath);
  } else {
    missing.push("worktree-status");
  }
  const manifest: IncidentManifest = {
    schemaVersion: 1,
    kind: "poisoned-batch-exit",
    batch: batch.number,
    capturedAt: new Date().toISOString(),
    flags,
    sourcePaths: Object.fromEntries(Object.entries(sources).map(([key, value]) => [key, value.map((item) => path.isAbsolute(item) ? path.relative(rootCwd, item).split(path.sep).join("/") : item)])),
    copied,
    missing,
    resultSummary: { status: result.status, agent: result.agent, failureType: result.failureType, flags: result.flags }
  };
  const manifestPath = path.join(dir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { dir, manifestPath, copied, missing, worktreeStatusPath };
}

function flattenIncidentEvidencePath(rel: string): string {
  const normalized = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  const scoped = normalized.startsWith("../") || normalized === ".." ? `external/${normalized.replace(/^(\.\.\/)+/, "")}` : normalized;
  const flattened = scoped
    .replace(/[:]/g, "_")
    .replace(/\/+/g, "/")
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[^A-Za-z0-9._-]/g, "_"))
    .join("__");
  return flattened || "artifact";
}

async function readJsonIfExists(file: string): Promise<unknown | null> {
  try {
    if (!await exists(file)) return null;
    return JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(file, "utf8")));
  } catch {
    return null;
  }
}

async function latestRuntimeLogs(rootCwd: string): Promise<string[]> {
  const dir = path.join(rootCwd, ".yolo/logs");
  try {
    return (await readdir(dir))
      .filter((file) => file.startsWith("runtime-") && file.endsWith(".log"))
      .sort()
      .reverse()
      .slice(0, 3)
      .map((file) => path.join(dir, file));
  } catch {
    return [];
  }
}

async function matchingBatchFiles(root: string, relDir: string, prefix: string): Promise<string[]> {
  const dir = path.join(root, relDir);
  try {
    const entries = await readdir(dir);
    const matches: string[] = [];
    for (const entry of entries) {
      if (!(entry.startsWith(prefix) || entry.includes(prefix))) continue;
      const absolute = path.join(dir, entry);
      if ((await stat(absolute)).isFile()) matches.push(absolute);
    }
    return matches.sort();
  } catch {
    return [];
  }
}
