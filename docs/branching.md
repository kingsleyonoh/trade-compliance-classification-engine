# Branching Protocol

- `main`: production only.
- `dev`: integration branch and default PR target.
- `feature/<slug>`: contributor work branches.
- `yolo/batch-*`: Klevar YOLO runtime-owned branches/worktrees.
- `hotfix/<slug>`: emergency fixes from production.

## Rules

- Contributors open PRs into `dev`.
- YOLO commits to `dev` only after runtime gates pass.
- Use `--revert --push` for collaboration-safe remote undo.
- Use force-push only with explicit operator approval and only when no other contributor depends on the rewritten branch.
