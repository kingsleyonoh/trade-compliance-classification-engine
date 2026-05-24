import path from "node:path";
import { readdir } from "node:fs/promises";
import { exists, readText } from "./util/fs.js";

export interface ProjectCheck {
  path: string;
  content: string;
}

export async function loadProjectChecks(cwd: string): Promise<ProjectCheck[]> {
  const dir = path.join(cwd, ".agent/knowledge/checks");
  if (!(await exists(dir))) return [];
  const names = (await readdir(dir)).filter((name) => name.endsWith(".md") && !["_index.md", "EXAMPLE.md"].includes(name));
  const checks: ProjectCheck[] = [];
  for (const name of names.sort()) {
    const rel = `.agent/knowledge/checks/${name}`;
    checks.push({ path: rel, content: await readText(path.join(cwd, rel)) });
  }
  return checks;
}

export function formatProjectChecks(checks: ProjectCheck[]): string {
  if (checks.length === 0) return "No active project-local checks.";
  return checks.map((check) => `### ${check.path}\n${check.content}`).join("\n\n");
}
