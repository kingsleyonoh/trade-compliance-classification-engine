import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exists, readText } from "./util/fs.js";

export async function readPromptTemplate(cwd: string, promptFile: string, moduleUrl = import.meta.url): Promise<string> {
  const canonical = await canonicalPromptPath(promptFile, moduleUrl);
  if (canonical) return readText(canonical);
  return readText(join(cwd, promptFile));
}

export async function canonicalPromptPath(promptFile: string, moduleUrl = import.meta.url): Promise<string | null> {
  const here = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    process.env.KLEVAR_TEMPLATE_ROOT ? join(process.env.KLEVAR_TEMPLATE_ROOT, promptFile) : "",
    resolve(here, "../../..", promptFile),
    resolve(here, "../..", promptFile),
    resolve(here, "..", "assets/project-template", promptFile)
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}
