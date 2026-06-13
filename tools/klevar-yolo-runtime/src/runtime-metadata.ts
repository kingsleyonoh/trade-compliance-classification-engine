import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";

export const STATE_HYGIENE_REVISION = "2026-06-07-trusted-state-hygiene";

export interface RuntimeVersionProof {
  runtimeVersion: string;
  stateHygieneRevision: string;
  templateRuntimeSyncedAt?: string;
  runtimeSourceVersion?: string;
  piPackageVersion?: string;
  piPackageSourceVersion?: string;
}

export async function runtimeVersionProof(cwd: string): Promise<RuntimeVersionProof> {
  const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const templateRuntimeSyncedAt = await readSyncTimestamp(cwd);
  const runtimeVersion = await packageVersion(path.join(runtimeRoot, "package.json"));
  const piPackageRoot = path.resolve(runtimeRoot, "../klevar-pi-package");
  const piPackageVersion = await packageVersion(path.join(piPackageRoot, "package.json"));
  return {
    runtimeVersion,
    stateHygieneRevision: STATE_HYGIENE_REVISION,
    ...(templateRuntimeSyncedAt ? { templateRuntimeSyncedAt } : {}),
    runtimeSourceVersion: await sourceVersion(runtimeRoot),
    piPackageVersion: piPackageVersion === "unknown" ? runtimeVersion : piPackageVersion,
    piPackageSourceVersion: await sourceVersion(piPackageRoot)
  };
}

async function packageVersion(file: string): Promise<string> {
  try {
    const json = JSON.parse(await readFile(file, "utf8")) as { version?: string };
    return json.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function sourceVersion(root: string): Promise<string> {
  const pkg = path.join(root, "package.json");
  const src = path.join(root, "src");
  const times = [await mtimeIso(pkg), await newestMtimeIso(src)].filter(Boolean) as string[];
  return times.sort().at(-1) ?? "unknown";
}

async function newestMtimeIso(target: string): Promise<string | null> {
  if (!existsSync(target)) return null;
  const info = await stat(target);
  if (!info.isDirectory()) return info.mtime.toISOString();
  const { readdir } = await import("node:fs/promises");
  let newest = info.mtime.toISOString();
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git", ".yolo", "coverage"].includes(entry.name)) continue;
    const child = await newestMtimeIso(path.join(target, entry.name));
    if (child && child > newest) newest = child;
  }
  return newest;
}

async function mtimeIso(file: string): Promise<string | null> {
  try { return (await stat(file)).mtime.toISOString(); } catch { return null; }
}

async function readSyncTimestamp(cwd: string): Promise<string | undefined> {
  const candidates = [path.join(cwd, ".klevar/project.json"), path.join(cwd, ".last-sync")];
  for (const file of candidates) {
    try {
      const text = await readFile(file, "utf8");
      const json = JSON.parse(text) as Record<string, unknown>;
      const value = json.templateRuntimeSyncedAt ?? json.runtimeSyncedAt ?? json.lastSyncAt ?? json.syncedAt ?? json.updatedAt;
      if (typeof value === "string" && value.trim()) return value;
    } catch {
      // .last-sync may be line-oriented in older projects; fall through to mtime proof.
    }
    const mtime = await mtimeIso(file);
    if (mtime) return mtime;
  }
  return undefined;
}
