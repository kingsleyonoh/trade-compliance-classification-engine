# Design Baseline — Trade Compliance Classification Engine

## Visual Tone
Dense, precise, audit-friendly. Prioritize legibility, hierarchy, and evidence comparison over decoration.

## Design Tokens
- Color roles: neutral canvas, raised panel, border, muted text, evidence accent, warning, danger, success, blocked.
- Typography: compact sans-serif UI, tabular numerals for counts/confidence, clear section labels before dense tables.
- Spacing: 4px base rhythm; dense data rows may use compact padding but must keep tappable actions usable.
- Elevation: subtle borders over shadows; reserve stronger contrast for warnings and blocked risk states.

## Dense Audit Tables
Use sticky headers, compact row actions, visible status/risk/confidence columns, and keyboard-reachable controls. Tables must not hide tenant, rule-pack version, or classification state when space is constrained.

## Confidence and Risk Chips
State chips use words plus color, never color alone. Required states: low, medium, high, blocked, pending review, failed. Contrast must meet WCAG 2.1 AA.

## Rule Trace Cards
Trace cards group matched facts, matched rules, selected code, confidence drivers, and rule-pack version. Put uncertainty and missing facts near the recommendation, not in a distant sidebar.

## Rejected-Candidate Panels
Rejected alternatives are first-class evidence. Show candidate code, rejection reason, matched/missing facts, confidence delta, and link to reviewer override where applicable.

## Keyboard Navigation
Reviewer queue and primary actions require visible focus rings, predictable tab order, Enter/Space activation, and no hover-only actions. Disabled controls include the server-side policy reason when known.

## Empty Loading Error and Degraded States
- Empty: explain the next import/rule-pack action.
- Loading: preserve table/card layout to avoid layout jank.
- Error: show recoverable action and stable error code.
- Degraded integration: mark optional RAG/Hub/Workflow failures as non-blocking.

## Responsive Behavior
Desktop-first for dense compliance work. At and below 768px, tables collapse to cards while preserving status, risk, confidence, selected code, rule-pack version, and primary actions. Mobile supports read-only classification detail and queue triage.

## Accessibility and Contrast
WCAG 2.1 AA contrast is mandatory. Do not rely on color alone for risk. Respect reduced-motion preferences; use motion only for state change clarity, not decoration.

## Required Evidence Flags
`MOBILE_VIEWPORT_PASS`, `FRONTEND_IMPECCABLE_AUDIT_PASS`, `FRONTEND_IMPECCABLE_POLISH_PASS`.
