import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exists, readText } from "./util/fs.js";

export async function readPromptTemplate(cwd: string, promptFile: string, moduleUrl = import.meta.url): Promise<string> {
  const canonical = await canonicalPromptPath(promptFile, moduleUrl);
  const template = canonical ? await readText(canonical) : await readText(join(cwd, promptFile));
  return applyRuntimePromptGuards(promptFile, template);
}

function applyRuntimePromptGuards(promptFile: string, template: string): string {
  if (!promptFile.replace(/\\/g, "/").endsWith(".agent/agents/yolo/yolo-subagent-implement.md")) return template;
  if (template.includes("Support/refactor/modularity/audit sweeps MUST NOT edit, recreate, delete, or list template-managed protected coordination files as deliverables")) return template;
  return `${template}\n\n${PROTECTED_COORDINATION_DELIVERABLE_GUARD}\n`;
}

const PROTECTED_COORDINATION_DELIVERABLE_GUARD = "Support/refactor/modularity/audit sweeps MUST NOT edit, recreate, delete, or list template-managed protected coordination files as deliverables: .agent/rules/**, .agent/workflows/**, .agent/guides/**, .agent/agents/**, AGENTS.md, CLAUDE.md, .cursorrules, .yolo/runtime.config.json, .yolo/runtime-state.json, runtime logs/events/worktrees, or secret files (.env*, *.pem, *.key). Report a blocker requiring tooling/human decision instead.";

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
