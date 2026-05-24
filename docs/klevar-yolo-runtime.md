# Klevar YOLO Runtime on Pi

The Klevar YOLO Runtime is the Pi SDK execution layer for template YOLO mode. It keeps the existing markdown prompts as policy/source material, but moves orchestration and verification into code.

## Easiest Usage

### Inside Pi

```text
/yolo-dry
/klevar-yolo dry-run next 1
/klevar-yolo next 1
/klevar-yolo phase 1
/klevar-yolo parallel next 2
/klevar-yolo continue
/yolo-replay batch-001-implement
/yolo-status
/yolo-dashboard
/yolo-watch
/yolo-hide
```

The Pi extension auto-installs runtime dependencies with `npm ci` and builds the runtime if `dist/cli.js` is missing.

### PowerShell

```powershell
.\scripts\klevar-yolo.ps1 dry-run next 1
.\scripts\klevar-yolo.ps1 next 1
.\scripts\klevar-yolo.ps1 phase 1
```

### Bash / Git Bash / WSL

```bash
bash scripts/klevar-yolo.sh dry-run next 1
bash scripts/klevar-yolo.sh next 1
bash scripts/klevar-yolo.sh phase 1
```

The wrapper scripts auto-run `npm ci` and `npm run build` on first use.

## Direct Runtime Command

```bash
cd tools/klevar-yolo-runtime
npm ci
npm run build
cd ../..
node tools/klevar-yolo-runtime/dist/cli.js dry-run next 1
node tools/klevar-yolo-runtime/dist/cli.js next 1
node tools/klevar-yolo-runtime/dist/cli.js replay batch-001-implement
```

## Guarantees

The runtime is designed to enforce:

1. Fresh Pi `AgentSession` per sub-agent.
2. No master conversation carry-over into sub-agents.
3. Worktree isolation for writable implementation batches.
4. Dual output: human markdown + machine JSON.
5. Runtime-owned validation for result contract, TDD, E2E, wiring, path policy, secrets, command re-runs for GREEN/REGRESSION/E2E evidence, active project-local checks, business-logic evidence, and duplicate artifact detection.
6. Separate validation sub-agent after machine gates, with validator JSON verdict enforcement.
7. Dedicated audit dispatch for `[AUDIT]` batches and journal sub-agent dispatch for build-journal/gate evidence.
8. Runtime-owned commits, progress ticking, closeout gates, and inbox reconciliation.
9. Failure-pattern tracking in `.yolo/failure-patterns.json` with reinforcement dispatch after the configured recurrence threshold.
10. Replayable prompts, manifests, sessions, and journal entries under `.yolo/`.
11. Explicit local parallel mode for independent shards, with claim/file-conflict checks before merge.
12. Optional Telegram failure notifications via local environment variables; secrets are never stored in project files.

## Accuracy-First Speed Roadmap

The runtime should improve development speed without trading away correctness. The rule is: **reuse only runtime-owned evidence, never agent claims, and invalidate on any relevant worktree change.**

Implemented baseline:

1. **Runtime-owned command rerun cache** — `.yolo/command-cache.json` stores successful GREEN/REGRESSION/E2E reruns keyed by exact command, phase, and deterministic non-`.yolo` worktree snapshot. Unchanged retries can reuse the pass; changed trees rerun normally.

Planned follow-ups, in safe order:

1. **Cache telemetry visibility** — dashboard/explain should show when a command was reused from runtime-owned cache, with snapshot ID and original duration saved.
2. **Risk-classified rerun policy** — runtime classifies changed files before deciding the minimum required checks. Schema, migration, auth, tenant/security, shared foundation, test setup, build config, and dependency changes still force full regression. Narrow leaf changes can run targeted + affected tests first.
3. **Affected-test discovery** — derive candidate tests from changed source paths, imports, route/CLI/job wiring, and explicit `verifiedBy` evidence. This supplements, not replaces, mandatory gates.
4. **Full-regression cadence for long scopes** — for `full`/phase-range runs, require full regression at phase closeout, final support validation, and every configured N successful low-risk batches, while still forcing full regression on high-risk changes.
5. **Suite partitioning** — allow projects to declare named suites (`unit`, `integration`, `e2e`, `security`, `migration`) with risk triggers so runtime can run the smallest sufficient set before final/full checks.
6. **Failure-local retry** — when one suite fails, first rerun the failing test files with verbose output before rerunning the whole suite, preserving full evidence but reducing diagnosis time.
7. **Post-commit audit sampling** — after successful low-risk batches, optionally run slower broad checks asynchronously or at the next boundary, never marking a batch complete without the gates required by its risk class.

Non-negotiables:

- Do not accept sub-agent-reported passes without runtime-owned verification or a valid runtime cache hit.
- Do not skip full regression for migrations, shared auth/tenant/security surfaces, test setup, dependency/build tooling, public contract changes, or phase/final closeouts.
- Do not let speed policy hide failures; reused evidence must be visible in telemetry and explain output.

## Telegram Failure Notifications

Set these environment variables on the machine running Pi/Klevar:

```powershell
[Environment]::SetEnvironmentVariable("KLEVAR_TELEGRAM_BOT_TOKEN", "<bot-token>", "User")
[Environment]::SetEnvironmentVariable("KLEVAR_TELEGRAM_CHAT_ID", "<chat-id>", "User")
```

With both variables present, the runtime sends a Telegram alert when a batch fails or stops for recovery/human attention. Successful batch notifications are opt-in:

```powershell
[Environment]::SetEnvironmentVariable("KLEVAR_TELEGRAM_NOTIFY_COMPLETE", "1", "User")
```

Disable all Telegram runtime notifications without removing the token:

```powershell
[Environment]::SetEnvironmentVariable("KLEVAR_TELEGRAM_NOTIFY", "0", "User")
```

Never commit bot tokens, chat IDs, or notification secrets to project files.

## Public Release Posture

`tools/klevar-yolo-runtime/`, `.pi/`, wrapper scripts, and this documentation are intended to remain with projects that want public Pi runtime support. Runtime audit state under `.yolo/` is tracked during development but stripped by `/prepare-public`; if `.yolo/runtime.config.json` is removed during public prep, the runtime recreates default config on first run. Ephemeral/runtime-generated paths are always gitignored: `.yolo/worktrees/`, `.yolo/pi-sessions/`, `.yolo/subagent-prompts/`, `.yolo/subagent-runs/`, `.yolo/events/`, `.yolo/runtime-state.json`, `tools/klevar-yolo-runtime/node_modules/`, and `tools/klevar-yolo-runtime/dist/`.

## Runtime Files

| Path | Purpose |
|------|---------|
| `.yolo/runtime.config.json` | Model routing, gate policy, path policy |
| `.yolo/pi-sessions/` | One Pi session per master/sub-agent run |
| `.yolo/subagent-prompts/` | Exact materialized prompts for replay |
| `.yolo/subagent-runs/` | JSON manifests for every sub-agent invocation |
| `.yolo/batch-results/` | Human + JSON batch outputs |
| `.yolo/worktrees/` | Isolated implementation worktrees |
| `.yolo/journal.md` | Runtime journal |
| `.yolo/runtime-state.json` | Live runtime state for dashboard/watch UI; gitignored generated state |
| `.yolo/events/batch-###.jsonl` | Runtime event stream for current/previous batches; gitignored generated state |
| `.yolo/gates/` | Runtime and sub-agent proof-on-disk gates |
| `.yolo/failure-patterns.json` | Recurring failure signatures and reinforcement state |

## Wired-or-Fail

Entrypoint work (`[API]`, `[UI]`, `[JOB]`, `[INTEGRATION]`) must prove reachability. A handler, component, job, or command existing on disk is not enough. Result JSON must include `wiring.entrypoints[]` with `verifiedBy` evidence.

If no reachable path exists, the result must fail with:

```json
{
  "status": "FAILURE",
  "failureType": "UNWIRED_CODE"
}
```

## Hardened Honesty Gates

The runtime now ports the load-bearing YOLO safeguards into code:

- Active `.agent/knowledge/checks/*.md` files are injected into sub-agent context; result JSON must report how many checks were evaluated and whether any triggered.
- Repeated failure signatures are recorded in `.yolo/failure-patterns.json`; after `reinforcementThreshold` recurrences, the runtime dispatches `yolo-subagent-reinforce.md`.
- Runtime gate files are written under `.yolo/gates/` for machine gates, E2E, journal, and closeout; the next batch refuses to start if the previous batch is missing core gates.
- `[AUDIT]` progress items dispatch `yolo-subagent-audit-coverage.md` instead of the implementation agent.
- Journal closeout dispatches `yolo-subagent-journal.md` and writes a journal gate.
- `docs/yolo-inbox.md` pending entries are included in context and entries listed in `inbox.handledTitles` are moved to Handled after a successful batch.
- Generated artifacts listed in result JSON are checked for duplicate content to catch placeholder-stuffing.
- Business-bearing batches must include `businessLogic` evidence tying the behavior to a source-of-truth rule, observable paths, and a proving test.
