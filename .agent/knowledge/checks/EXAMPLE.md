# Example Check — Delete Me

> Template shape for a project-local check file. Delete this file once a real check is added by `yolo-subagent-reinforce`.
>
> Filename convention: `{failure_type}-{slug}.md` (lowercase, hyphenated). The `{failure_type}` matches the implement sub-agent's `failure_type` enum (`tests-wont-green`, `silent-workaround`, `regression-failure`, etc.). The `{slug}` is a 2-4 word descriptor of the specific pattern.

**Trigger pattern:** A precise description of when this check fires. Be specific enough that the implement sub-agent's Step 4 (Plan) can pattern-match against it. Examples:
- "Plan touches `tests/integration/**` AND uses any of: `vi.mock('pg')`, `jest.mock('postgres')`, `MockDB`."
- "Plan creates a route handler under `src/api/payments/` AND does NOT import from `src/payments/registry.ts`."
- "Plan modifies a Drizzle migration AND adds a column to `tenants` table without a backfill."

**Verdict:** REJECT (always — Option A enforcement). The implement sub-agent must NOT proceed with the planned approach.

**Recovery procedure:** What the sub-agent should do instead. Be concrete — name the file / function / pattern that should be used.
- Example: "Use the real Postgres test container per `.agent/knowledge/foundation/db-test-container.md`. Mocks in integration tests are banned by check-induced rule (see provenance below)."
- Example: "Register the new payment processor in `src/payments/registry.ts` instead of importing it directly. See `.agent/knowledge/foundation/feature-payments.md` for the registry pattern."

**Provenance:**
- **Failure type:** `{failure_type}` (matches implement sub-agent enum)
- **First seen:** batch {NNN} ({YYYY-MM-DD})
- **Reinforced after:** {N} recurrences (per `.yolo/config.md` `reinforce_threshold`)
- **Source result files:**
  - `.yolo/batch-results/batch-{NNN1}-implement.md`
  - `.yolo/batch-results/batch-{NNN2}-implement.md`
  - `.yolo/batch-results/batch-{NNN3}-implement.md`
- **Reinforcement commit:** {short hash} `chore(yolo): reinforce rule against {failure_type} (3rd recurrence)`
- **Stack-class candidate:** [yes / no] — if yes, queued in `.yolo/harvest-candidates.md` for `/harvest-gotchas` review. Stack tags detected: [list, e.g. Postgres, Drizzle].

**Retirement criteria** (read by `/audit-reinforcements`):
- Has not fired in last 10 batches AND
- The trigger pattern's referenced files / code patterns no longer exist in the codebase (e.g., the module was refactored away, the dependency removed)

If both conditions hold, `/audit-reinforcements` will propose retirement; user confirms; check file deletes + `_index.md` row removes.
