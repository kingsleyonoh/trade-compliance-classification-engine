# PRD Traceability Review

## Core flows

- Tenant-scoped product import, rule-pack activation, classification runs, rejected candidates, and role-policy coverage are validated by `tests/core_api.rs`, `tests/batch008_core.rs`, and `tests/batch009_core.rs`.
- Reviewer override history, frozen audit snapshots, JSON/CSV/PDF export rendering, retryable audit export jobs, and jurisdiction/output matrix coverage are validated by `tests/phase2_review_audit.rs`.
- UI route/screen contracts, responsive evidence flags, and review/export/integration screen affordances are validated by `tests/phase2_ui_contract.rs`.
- Optional RAG, Notification Hub, Workflow Engine, adapter health, outbox retry state, and backtest release thresholds are validated by `tests/phase3_integrations_backtest.rs`.

## Success criteria evidence

- Import → classify → review → export works locally without optional services.
- Audit exports render from frozen snapshots and remain stable after source data changes.
- Optional adapters are disabled by default, non-blocking when misconfigured, and health-check visible.
- Backtest thresholds are encoded in `src/backtest.rs`: at least 85% exact-code accuracy, at most 20% review rate, and zero false-low-risk denied goods fixtures.
- Deployment readiness is documented in `docs/deployment.md`, `Dockerfile`, `docker-compose.prod.yml`, and `.github/workflows/ci.yml`.

## Known non-goals preserved

The implementation does not perform live customs filing, legal advice, real-time tariff scraping, full denied-party screening, or connector sprawl beyond named optional adapters.
