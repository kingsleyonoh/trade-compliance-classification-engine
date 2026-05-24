import path from "node:path";
import { readFile } from "node:fs/promises";
import { ensureDir, exists, writeText } from "./util/fs.js";
import { notifyRuntimeFinish } from "./notifications.js";
import type { GateResult } from "./types.js";

export type RuntimePhase = "idle" | "select" | "worktree" | "knowledge" | "implement" | "validate" | "bugfix" | "journal" | "merge" | "commit" | "failed" | "complete";

export interface RuntimeState {
  schemaVersion: 1;
  status: "idle" | "running" | "failed" | "complete";
  batch?: number;
  phase: RuntimePhase;
  currentAgent?: string | null;
  worktree?: string | null;
  startedAt?: string;
  updatedAt: string;
  lastEvent?: string;
  gates: Record<string, "pending" | "running" | "passed" | "failed" | "skipped">;
  timings: Record<string, number | null>;
  inspect: Record<string, string>;
  checkpoints?: Record<string, "pending" | "running" | "passed" | "failed" | "skipped">;
}

export async function resetRuntimeState(cwd: string, batch: number, requestedScope = "unknown", support?: { kind?: string; scope?: string }): Promise<void> {
  await writeState(cwd, {
    schemaVersion: 1,
    status: "running",
    batch,
    phase: "select",
    currentAgent: null,
    worktree: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastEvent: "Batch selected",
    gates: defaultGates(),
    timings: {},
    inspect: { requestedScope, ...(support?.kind ? { supportKind: support.kind } : {}), ...(support?.scope ? { supportScope: support.scope } : {}) },
    checkpoints: defaultCheckpoints()
  });
  await appendEvent(cwd, { type: "batch_selected", batch });
}

export async function setPhase(cwd: string, phase: RuntimePhase, message: string, extra: Partial<RuntimeState> = {}): Promise<void> {
  const runningPhases: RuntimePhase[] = ["select", "worktree", "knowledge", "implement", "validate", "bugfix", "journal", "merge", "commit"];
  const status = runningPhases.includes(phase) ? "running" : phase === "complete" ? "complete" : phase === "failed" ? "failed" : undefined;
  const state = await readState(cwd);
  const checkpoint = checkpointForPhase(phase);
  const checkpointStatus: "failed" | "running" | "passed" = phase === "failed" ? "failed" : phase === "complete" ? "passed" : "running";
  const checkpoints = checkpoint ? { ...defaultCheckpoints(), ...(state.checkpoints ?? {}), [checkpoint]: checkpointStatus } : state.checkpoints;
  await patchState(cwd, { ...(status ? { status } : {}), ...(checkpoints ? { checkpoints } : {}), phase, lastEvent: message, ...extra });
  await appendEvent(cwd, { type: "phase", phase, message });
}

export async function setCheckpoint(cwd: string, name: string, status: "pending" | "running" | "passed" | "failed" | "skipped"): Promise<void> {
  const state = await readState(cwd);
  await patchState(cwd, { checkpoints: { ...defaultCheckpoints(), ...(state.checkpoints ?? {}), [name]: status } });
  await appendEvent(cwd, { type: "checkpoint", checkpoint: name, status });
}

export async function setAgent(cwd: string, role: string, id: string): Promise<void> {
  await patchState(cwd, { currentAgent: role, lastEvent: `${role} agent started`, inspect: { ...(await readState(cwd)).inspect, currentPrompt: `.yolo/subagent-prompts/${id}.prompt.md`, currentSession: `.yolo/pi-sessions/${id}.jsonl` } });
  await appendEvent(cwd, { type: "agent_started", role, id });
}

export async function setGates(cwd: string, gates: GateResult[]): Promise<void> {
  const state = await readState(cwd);
  const next = { ...state.gates };
  for (const gate of gates) next[gate.name] = gate.passed ? "passed" : "failed";
  await patchState(cwd, { gates: next, lastEvent: "Runtime gates evaluated" });
  for (const gate of gates) await appendEvent(cwd, { type: gate.passed ? "gate_passed" : "gate_failed", gate: gate.name, flags: gate.flags });
}

export async function markHeartbeat(cwd: string, message: string): Promise<void> {
  const state = await readState(cwd);
  const repairedPhase = state.phase === "failed" ? phaseFromHeartbeat(message) : undefined;
  await patchState(cwd, { status: "running", ...(repairedPhase ? { phase: repairedPhase } : {}), lastEvent: message });
}

export async function markCommand(cwd: string, phase: string, command: string, status: "started" | "passed" | "failed", durationMs?: number): Promise<void> {
  const label = `${phase}: ${command}`;
  await patchState(cwd, { lastEvent: `${status.toUpperCase()} ${label}` });
  await appendEvent(cwd, { type: `command_${status}`, phase, command, durationMs });
}

export async function markTiming(cwd: string, key: string, durationMs: number): Promise<void> {
  const state = await readState(cwd);
  await patchState(cwd, { timings: { ...state.timings, [key]: durationMs } });
}

export async function finishRuntime(cwd: string, status: "failed" | "complete", message: string): Promise<void> {
  const state = await readState(cwd);
  const checkpoints = status === "complete" ? { ...defaultCheckpoints(), ...(state.checkpoints ?? {}), commit: "passed" as const } : state.checkpoints;
  await patchState(cwd, { status, phase: status === "failed" ? "failed" : "complete", ...(checkpoints ? { checkpoints } : {}), currentAgent: null, lastEvent: message });
  await appendEvent(cwd, { type: status, message });
  await notifyRuntimeFinish({ cwd, status, batch: state.batch, phase: status === "failed" ? "failed" : "complete", message }).catch((error) => {
    console.warn(`Klevar Telegram notification skipped: ${error instanceof Error ? error.message : String(error)}`);
  });
}

export async function failRuntimeFromError(cwd: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  await finishRuntime(cwd, "failed", `Runtime crashed: ${message.split(/\r?\n/)[0]}`);
}

async function readState(cwd: string): Promise<RuntimeState> {
  const file = path.join(cwd, ".yolo/runtime-state.json");
  if (!(await exists(file))) return emptyState();
  try {
    return JSON.parse(await readFile(file, "utf8")) as RuntimeState;
  } catch {
    return emptyState();
  }
}

async function patchState(cwd: string, patch: Partial<RuntimeState>): Promise<void> {
  const current = await readState(cwd);
  await writeState(cwd, { ...current, ...patch, updatedAt: new Date().toISOString() });
}

async function writeState(cwd: string, state: RuntimeState): Promise<void> {
  await writeText(path.join(cwd, ".yolo/runtime-state.json"), JSON.stringify(state, null, 2) + "\n");
}

async function appendEvent(cwd: string, event: Record<string, unknown>): Promise<void> {
  const dir = path.join(cwd, ".yolo/events");
  await ensureDir(dir);
  const state = await readState(cwd);
  const batch = String(state.batch ?? 0).padStart(3, "0");
  const file = path.join(dir, `batch-${batch}.jsonl`);
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + "\n";
  const previous = (await exists(file)) ? await readFile(file, "utf8") : "";
  await writeText(file, previous + line);
}

function emptyState(): RuntimeState {
  return { schemaVersion: 1, status: "idle", phase: "idle", updatedAt: new Date().toISOString(), gates: defaultGates(), timings: {}, inspect: {}, checkpoints: defaultCheckpoints() };
}

function defaultCheckpoints(): Record<string, "pending" | "running" | "passed" | "failed" | "skipped"> {
  return { select: "pending", worktree: "pending", knowledge: "pending", implement: "pending", runtimeGates: "pending", validate: "pending", journal: "pending", merge: "pending", commit: "pending" };
}

function phaseFromHeartbeat(message: string): RuntimePhase | undefined {
  if (/\bimplement agent running\b/i.test(message)) return "implement";
  if (/\bvalidate agent running\b/i.test(message)) return "validate";
  if (/\bbugfix agent running\b/i.test(message)) return "bugfix";
  if (/\bjournal agent running\b/i.test(message)) return "journal";
  return undefined;
}

function checkpointForPhase(phase: RuntimePhase): string | null {
  if (phase === "select") return "select";
  if (phase === "worktree") return "worktree";
  if (phase === "knowledge") return "knowledge";
  if (phase === "implement" || phase === "bugfix") return "implement";
  if (phase === "validate") return "validate";
  if (phase === "journal") return "journal";
  if (phase === "merge") return "merge";
  if (phase === "commit" || phase === "complete") return "commit";
  return null;
}

function defaultGates(): Record<string, "pending"> {
  return { "progress-contract": "pending", "claims-contract": "pending", knowledge: "pending", contract: "pending", tdd: "pending", e2e: "pending", wiring: "pending", paths: "pending", "local-only": "pending", secrets: "pending", "command-rerun": "pending", "project-local-checks": "pending", "business-logic": "pending", frontend: "pending", quality: "pending", artifacts: "pending", parallel: "pending", journal: "pending", closeout: "pending" };
}
