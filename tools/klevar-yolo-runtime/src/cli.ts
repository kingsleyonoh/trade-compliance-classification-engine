#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { cleanBatch, rollbackLast, undoLast } from "./recovery.js";
import { replayRun } from "./replay.js";
import { runYolo } from "./runtime.js";
import { failRuntimeFromError } from "./telemetry.js";
import { pruneSuccessfulWorktrees } from "./worktree-retention.js";
import type { YoloScope } from "./types.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(helpText());
    return;
  }
  if (args[0] === "replay" && args[1]) {
    const config = await loadConfig(process.cwd());
    await replayRun(process.cwd(), args[1], config.models.implement);
    return;
  }
  if (args[0] === "clean" && args[1]) {
    const result = await cleanBatch(process.cwd(), args[1], { logs: args.includes("--logs") });
    console.log(formatRecoveryResult(result));
    return;
  }
  if (args[0] === "rollback") {
    const result = await rollbackLast(process.cwd(), { yes: args.includes("--yes"), push: args.includes("--push"), revert: args.includes("--revert") });
    console.log(formatRecoveryResult(result));
    if (!result.ok) process.exitCode = 2;
    return;
  }
  if (args[0] === "undo-last") {
    const result = await undoLast(process.cwd(), { yes: args.includes("--yes"), push: args.includes("--push"), revert: args.includes("--revert") });
    console.log(formatRecoveryResult(result));
    if (!result.ok) process.exitCode = 2;
    return;
  }
  if (args[0] === "prune") {
    const config = await loadConfig(process.cwd());
    const result = await pruneSuccessfulWorktrees(process.cwd(), { ...config.retention, allSuccess: args.includes("--all-success") });
    console.log(["OK", `Pruned: ${result.pruned.join(", ") || "none"}`, `Kept: ${result.kept.join(", ") || "none"}`, `Skipped: ${result.skipped.join(", ") || "none"}`].join("\n"));
    return;
  }
  const dryRun = args[0] === "dry-run" || args.includes("--dry-run");
  const filtered = args.filter((arg) => arg !== "dry-run" && arg !== "--dry-run");
  const scope = parseScope(filtered);
  await runYolo(process.cwd(), scope, dryRun);
}

function helpText(): string {
  return [
    "Klevar YOLO Runtime",
    "",
    "Usage:",
    "  cli.js dry-run next 1",
    "  cli.js next 1",
    "  cli.js phase 1",
    "  cli.js full",
    "  cli.js continue",
    "  cli.js replay batch-001-implement",
    "  cli.js clean batch-002 [--logs]",
    "  cli.js rollback [--yes] [--push] [--revert]",
    "  cli.js undo-last [--yes] [--push] [--revert]",
    "  cli.js prune [--all-success]"
  ].join("\n");
}

function formatRecoveryResult(result: { ok: boolean; message: string; actions: string[]; dryRun?: boolean }): string {
  return [result.dryRun ? "DRY-RUN" : result.ok ? "OK" : "ERROR", result.message, ...result.actions.map((action) => `- ${action}`)].join("\n");
}

function parseScope(args: string[]): YoloScope {
  if (args.length === 0 || args[0] === "full") return { mode: "full" };
  if (args[0] === "resume" || args[0] === "continue") return { mode: "resume" };
  if (args[0] === "phase" && args[1]) return { mode: "phase", target: args.slice(1).join(" ") };
  if (args[0] === "parallel" && args[1] === "next" && args[2]) return { mode: "parallel", target: args[2] };
  if (args[0] === "next" && args[1]) return { mode: "count", target: args[1] };
  if (args[0] === "items") return { mode: "items", target: args.slice(1).join(" ") };
  throw new Error(`Unknown scope: ${args.join(" ")}`);
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  if (!(error instanceof Error && error.message.startsWith("Unknown scope:"))) {
    await failRuntimeFromError(process.cwd(), error).catch(() => undefined);
  }
  process.exitCode = error instanceof Error && error.message.startsWith("Unknown scope:") ? 2 : 1;
});
