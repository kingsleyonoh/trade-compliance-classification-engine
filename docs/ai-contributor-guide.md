# AI Contributor Guide

Use this guide when contributing with Claude Code, Codex, Cursor, Pi, or another AI coding tool.

## Start Here

1. Work from `dev` and create a feature branch: `feature/<short-slug>`.
2. Read `docs/progress.md` and choose one unchecked task.
3. Create a claim in `docs/claims/<slug>.json` before editing.
4. Read `.agent/rules/_index.md` and the core rules it lists.
5. Use TDD: RED, GREEN, regression.
6. Run secret scan before opening a PR.

## Claim Shape

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

## Do Not

- Do not edit another active claim's expected files.
- Do not work directly on `main`.
- Do not bypass tests or secret scanning.
- Do not rewrite shared remote history.
- Do not change `.agent/rules/`, `.agent/agents/`, `.agent/workflows/`, or `.agent/guides/` unless the task is explicitly about governance.

## PR Evidence

Include:

- task/progress item
- claim file path
- tests run and output summary
- E2E evidence if API/UI/JOB/INTEGRATION changed
- secret scan result
- notes on any scope changes
