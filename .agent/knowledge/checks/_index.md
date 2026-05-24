# Project-Local Checks (catalog)

> **One file per check.** Each check is a project-local enforcement rule written by `yolo-subagent-reinforce` after a recurring failure pattern was detected (default: 3 occurrences of the same `failure_type::signature`). The implement sub-agent reads matching checks at Step 4 (Plan) and **rejects the plan** if it triggers one — preventing the recurrence at plan time, not test time.
>
> Checks are project-local by design. Stack-class candidates get queued in `.yolo/harvest-candidates.md` for `/harvest-gotchas` review and possible promotion to template knowledge.
>
> Checks are retire-able via `/audit-reinforcements` when their target pattern no longer exists in the codebase. Unlike `yolo-honesty-checks.md` (template-class, only humans edit), checks here have a lifecycle tied to the project's evolution.
>
> Filename convention: `{failure_type}-{slug}.md` (lowercase, hyphenated). Example: `tests-wont-green-mock-database-in-integration.md`.

## Catalog

| Filename | Failure type | Slug | Created (batch / date) | Last fired (batch) | Times fired | Status |
|----------|--------------|------|------------------------|---------------------|-------------|--------|
| EXAMPLE.md | (template) | (template) | (template) | — | — | template — delete me |

> Add one row per check file. `yolo-subagent-reinforce` writes both the file and the row when it lands a new check. `/audit-reinforcements` updates `Last fired` and `Times fired` from `.yolo/failure-patterns.json`, and proposes retirement (which removes the row + deletes the file) when the pattern is dead.
