# Design Baseline — Trade Compliance Classification Engine

## Visual Tone
Dense, precise, audit-friendly. Prioritize legibility, hierarchy, and evidence comparison over decoration.

## Core Components
- Dense audit tables with sticky headers and compact row actions.
- Confidence/risk state chips: low/medium/high/blocked with accessible contrast.
- Rule trace cards for matched facts, matched rules, and rejected alternatives.
- Reviewer queue keyboard navigation with visible focus rings.
- Frozen audit snapshot panels that distinguish original vs override decision.
- Empty, loading, error, and degraded-integration states.

## Responsive Rules
Desktop-first. Below 768px, tables collapse to cards while preserving status, risk, confidence, selected code, and primary actions.

## Accessibility
WCAG 2.1 AA contrast; all HTMX actions reachable by keyboard; disabled buttons mirror server-side policy explanations but are never treated as security controls.

## Required Evidence Flags
`MOBILE_VIEWPORT_PASS`, `FRONTEND_IMPECCABLE_AUDIT_PASS`, `FRONTEND_IMPECCABLE_POLISH_PASS`.
