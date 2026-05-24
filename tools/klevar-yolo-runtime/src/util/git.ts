import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { execCommand } from "./process.js";

export async function git(cwd: string, args: string): Promise<string> {
  const result = await execCommand(`git ${args}`, cwd, 120000);
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `git ${args} failed`);
  return result.stdout.trim();
}

export async function gitStatus(cwd: string): Promise<string[]> {
  const output = await git(cwd, "status --short");
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
  await git(cwd, "add .");
  await git(cwd, `commit -m ${JSON.stringify(message)}`);
  return git(cwd, "rev-parse --short HEAD");
}
