# Collaboration Rules

These rules apply when a Klevar project has external contributors, feature branches, `docs/claims/*.json`, or `/klevar-yolo parallel ...` usage.

## Operator Model

A contributor may be a human using an AI coding tool. Treat these as operators:

- `operator:pi-yolo:*`
- `contributor:<name>` using Claude Code, Codex, Cursor, Pi, or manual edits
- `human-manual:<name>`

## Branch Protocol

- `main` is production.
- `dev` is the integration branch.
- `feature/<slug>` is contributor work.
- `yolo/batch-*` is runtime-owned work.
- `hotfix/<slug>` is emergency production repair.

Do not work directly on another operator's branch without explicit approval.

## Claims Protocol

When multiple operators may work at once, claim work before editing. Claims live in `docs/claims/*.json`:

```json
{
  "schemaVersion": 1,
  "task": "[API] Add survey export — PRD §8b",
  "operator": "contributor:alice",
  "tool": "claude-code",
  "branch": "feature/survey-export",
  "status": "active",
  "startedAt": "2026-05-18T15:30:00Z",
  "expectedFiles": ["src/api/survey-export.ts"]
}
```

Rules:

- Do not claim a task already actively claimed by another operator.
- Do not edit files listed in another active claim's `expectedFiles`.
- Keep `expectedFiles` honest and update the claim if scope changes.
- Mark claims `done` or `released` when finished or abandoned.
- If no claims exist, solo Klevar flow remains unchanged.

## AI Contributor Workflow

1. Read `docs/progress.md`, this file, and project rules.
2. Create/use a feature branch.
3. Add a claim before editing.
4. Use TDD and run the project regression command.
5. Run secret scan before PR/commit.
6. Open PR into `dev` with evidence.

## Pi YOLO Behavior

Pi YOLO must skip externally claimed tasks and avoid expected-file conflicts. Local parallel mode is allowed only when independence can be proven. If there is doubt, fall back to serial work or stop for operator decision.

## Main-Agent Safety While YOLO Is Active

When `.yolo/runtime-state.json` reports `running`, `failed`, or `paused` with a worktree, the chat/main agent is a read-only observer by default.

Allowed without takeover:

- Explain status, gates, logs, claims, changed files, and likely next actions.
- Use `/yolo-explain`, `/yolo-status`, fleet inspect/log tools, and read-only file inspection.
- Recommend `/klevar-yolo continue`, `/yolo-pause`, or `/yolo-clean batch-NNN` when appropriate.

Blocked unless the user explicitly asks to pause/take over/intervene:

- Editing files inside the active YOLO worktree.
- Editing files listed in active `docs/claims/*.json` claims.
- Editing root-project files that overlap the active batch's changed/claimed files.
- Cleaning/removing worktrees by hand instead of using runtime recovery commands.

If the user wants manual intervention, first recommend `/yolo-pause` to preserve the worktree, then confirm whether edits should target the preserved worktree or the root project.
