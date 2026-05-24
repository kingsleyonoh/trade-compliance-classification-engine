import path from "node:path";
import { exists, readText } from "./util/fs.js";
import { runAgent } from "./agent-session.js";
import type { ModelRoute } from "./types.js";

export async function replayRun(cwd: string, runId: string, route: ModelRoute = {}): Promise<void> {
  const promptFile = path.join(cwd, `.yolo/subagent-prompts/${runId}.prompt.md`);
  if (!(await exists(promptFile))) throw new Error(`No materialized prompt found for ${runId}: ${promptFile}`);
  const replaySession = path.join(cwd, `.yolo/pi-sessions/${runId}-replay-${Date.now()}.jsonl`);
  await runAgent({ cwd, sessionFile: replaySession, prompt: await readText(promptFile), route });
}
