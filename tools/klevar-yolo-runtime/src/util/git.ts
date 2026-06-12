import { rmSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { execCommand } from "./process.js";

export async function git(cwd: string, args: string): Promise<string> {
  const result = await execCommand(`git ${args}`, cwd, 120000);
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `git ${args} failed`);
  return result.stdout.trim();
}

export async function gitStatus(cwd: string): Promise<string[]> {
  const result = await execCommand("git status --short", cwd, 120000);
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || "git status --short failed");
  const output = result.stdout.replace(/\r?\n$/, "");
  return output ? output.split(/\r?\n/) : [];
}

export async function gitDiffNames(cwd: string): Promise<string[]> {
  const output = await git(cwd, "diff --name-only");
  return output ? output.split(/\r?\n/) : [];
}

export async function nextBatchNumber(cwd: string): Promise<number> {
  try {
    const dir = join(cwd, ".yolo/batch-results");
    const numbers = (await readdir(dir))
      .map((name) => /^batch-(\d+)-.+\.json$/.exec(name)?.[1])
      .filter((value): value is string => Boolean(value))
      .map(Number)
      .filter((value) => Number.isFinite(value));
    return numbers.length ? Math.max(...numbers) + 1 : 1;
  } catch {
    return 1;
  }
}

export async function createCommit(cwd: string, message: string): Promise<string> {
  await removeWindowsReservedDeviceFiles(cwd);
  await git(cwd, "add .");
  await git(cwd, `commit -m ${JSON.stringify(message)}`);
  return git(cwd, "rev-parse --short HEAD");
}

export async function removeWindowsReservedDeviceFiles(cwd: string): Promise<string[]> {
  const removed: string[] = [];
  await walk(cwd, "", removed);
  return removed;
}

async function walk(root: string, rel: string, removed: string[]): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(join(root, rel));
  } catch {
    return;
  }
  for (const entry of entries) {
    if ([".git", "node_modules", "dist", "build", "coverage"].includes(entry)) continue;
    const childRel = rel ? join(rel, entry) : entry;
    const base = basename(entry).split(".")[0]?.toUpperCase();
    if (base && /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base)) {
      try {
        rmSync(join(root, childRel), { recursive: true, force: true });
        removed.push(childRel.replace(/\\/g, "/"));
      } catch {
        // If the platform refuses the device name, leave it for git to report.
      }
      continue;
    }
    try {
      if (statSync(join(root, childRel)).isDirectory()) await walk(root, childRel, removed);
    } catch {
      // Ignore races with files removed during cleanup.
    }
  }
}
