import { readFile } from "node:fs/promises";
import { getModel } from "@earendil-works/pi-ai";
import { AuthStorage, createAgentSession, DefaultResourceLoader, getAgentDir, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ModelRoute, ThinkingLevel } from "./types.js";

export interface RunAgentOptions {
  cwd: string;
  sessionFile: string;
  prompt: string;
  route: ModelRoute;
  staleToolTimeoutMs?: number;
}

export async function runAgent(options: RunAgentOptions): Promise<void> {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const loader = new DefaultResourceLoader({ cwd: options.cwd, agentDir: getAgentDir() });
  await loader.reload();
  const model = resolveModel(options.route.model, modelRegistry);
  const { session } = await createAgentSession({
    cwd: options.cwd,
    model,
    thinkingLevel: (options.route.thinking ?? "medium") as ThinkingLevel,
    tools: options.route.tools,
    authStorage,
    modelRegistry,
    resourceLoader: loader,
    sessionManager: SessionManager.open(options.sessionFile)
  });
  try {
    await promptWithTimeout(session, options.prompt, {
      timeoutMs: options.route.timeoutSeconds ? options.route.timeoutSeconds * 1000 : undefined,
      staleToolTimeoutMs: options.staleToolTimeoutMs,
      sessionFile: options.sessionFile
    });
  } finally {
    session.dispose();
  }
}

interface PromptTimeoutOptions {
  timeoutMs?: number;
  staleToolTimeoutMs?: number;
  sessionFile: string;
}

async function promptWithTimeout(session: { prompt(prompt: string): Promise<unknown>; dispose(): void }, prompt: string, options: PromptTimeoutOptions): Promise<void> {
  if (!options.timeoutMs && !options.staleToolTimeoutMs) {
    await session.prompt(prompt);
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  let staleTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      session.prompt(prompt),
      new Promise((_resolve, reject) => {
        if (options.timeoutMs) {
          timer = setTimeout(() => {
            session.dispose();
            reject(new Error(`AGENT_TIMEOUT:${options.timeoutMs}ms`));
          }, options.timeoutMs);
        }
        if (options.staleToolTimeoutMs) {
          staleTimer = setInterval(async () => {
            const reason = await sessionStaleUnansweredToolReason(options.sessionFile, Date.now(), options.staleToolTimeoutMs!);
            if (!reason) return;
            session.dispose();
            reject(new Error(reason));
          }, Math.min(60_000, Math.max(5_000, Math.floor(options.staleToolTimeoutMs / 3))));
        }
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (staleTimer) clearInterval(staleTimer);
  }
}

async function sessionStaleUnansweredToolReason(sessionFile: string, nowMs: number, staleMs: number): Promise<string | undefined> {
  try {
    return staleUnansweredToolReason(await readFile(sessionFile, "utf8"), nowMs, staleMs);
  } catch {
    return undefined;
  }
}

export function staleUnansweredToolReason(sessionText: string, nowMs: number, staleMs: number): string | undefined {
  let toolCalls = 0;
  let toolResults = 0;
  let lastActivityMs: number | undefined;
  let lastCommand = "tool call";
  for (const line of sessionText.split(/\r?\n/).filter(Boolean).slice(-300)) {
    try {
      const entry = JSON.parse(line) as Record<string, any>;
      const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
      if (Number.isFinite(timestamp)) lastActivityMs = timestamp;
      const message = entry.message;
      if (message?.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type !== "toolCall") continue;
          toolCalls += 1;
          const args = block.arguments ?? {};
          lastCommand = String(args.command ?? block.name ?? "tool call").slice(0, 160);
        }
      }
      if (message?.role === "toolResult") toolResults += 1;
    } catch {
      // Ignore partial JSONL writes.
    }
  }
  if (toolCalls <= toolResults || !lastActivityMs || nowMs - lastActivityMs <= staleMs) return undefined;
  return `AGENT_STALE_TOOL_TIMEOUT:${staleMs}ms:${lastCommand}`;
}

function resolveModel(modelId: string | undefined, registry: ModelRegistry): any {
  if (!modelId) return undefined;
  const [provider, id] = modelId.includes("/") ? modelId.split("/", 2) : [undefined, modelId];
  if (provider) return registry.find(provider as never, id) ?? getModel(provider as never, id);
  return undefined;
}
