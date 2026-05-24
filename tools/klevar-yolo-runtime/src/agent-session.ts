import { getModel } from "@earendil-works/pi-ai";
import { AuthStorage, createAgentSession, DefaultResourceLoader, getAgentDir, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ModelRoute, ThinkingLevel } from "./types.js";

export interface RunAgentOptions {
  cwd: string;
  sessionFile: string;
  prompt: string;
  route: ModelRoute;
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
    thinkingLevel: (options.route.thinking ?? "high") as ThinkingLevel,
    tools: options.route.tools,
    authStorage,
    modelRegistry,
    resourceLoader: loader,
    sessionManager: SessionManager.open(options.sessionFile)
  });
  try {
    await promptWithTimeout(session, options.prompt, options.route.timeoutSeconds ? options.route.timeoutSeconds * 1000 : undefined);
  } finally {
    session.dispose();
  }
}

async function promptWithTimeout(session: { prompt(prompt: string): Promise<unknown>; dispose(): void }, prompt: string, timeoutMs?: number): Promise<void> {
  if (!timeoutMs) {
    await session.prompt(prompt);
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      session.prompt(prompt),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          session.dispose();
          reject(new Error(`AGENT_TIMEOUT:${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolveModel(modelId: string | undefined, registry: ModelRegistry): any {
  if (!modelId) return undefined;
  const [provider, id] = modelId.includes("/") ? modelId.split("/", 2) : [undefined, modelId];
  if (provider) return registry.find(provider as never, id) ?? getModel(provider as never, id);
  return undefined;
}
