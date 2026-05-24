# CODEBASE_CONTEXT — Trade Compliance Classification Engine

Last updated: 2026-05-24
Template synced: 2026-05-24

## Project Summary

Multi-tenant Rust/Axum system that turns importer product catalogs into explainable HS/HTS recommendations, duty estimates, risk bands, reviewer queues, and immutable audit packs. Core classification/review/export must work locally with CSV/JSON imports and uploaded rule packs; RAG, Notification Hub, and Workflow Engine adapters are optional and feature-flagged.

## Tech Stack

| Layer | Technology |
|---|---|
| Language | Rust 1.78+ |
| Web | Axum, Askama templates, HTMX, Tailwind |
| Database | PostgreSQL 16 via sqlx |
| Search | Tantivy |
| Rule runtime | wasmtime |
| Jobs | Tokio workers + PostgreSQL job leasing tables |
| Testing | cargo test, proptest, insta snapshots, Testcontainers, Playwright |
| Observability | tracing JSON logs, Prometheus metrics, optional Sentry |
| Deployment | Docker Compose locally, GHCR image for VPS/NAS |

## Commands

| Task | Command |
|---|---|
| Start infra | `docker compose up -d` |
| Stop infra | `docker compose down` |
| Check infra | `docker compose ps` |
| Dev server | `cargo run` |
| First setup | `cargo run --bin setup` |
| Run tests | `cargo test` |
| Run tests (unit only) | `cargo test --lib` |
| Run tests (integration only) | `cargo test --test '*'` |
| Business logic tests | `cargo test business` |
| E2E tests | `npx playwright test` |
| Backtest | `cargo run --bin backtest -- --jurisdiction all --dataset tests/fixtures/golden` |
| Lint | `cargo clippy --all-targets --all-features -- -D warnings` |
| Format | `cargo fmt --all -- --check` |
| Build | `cargo build --release` |
| Migrate | `sqlx migrate run` |

## Project Structure

```text
trade-compliance-classification-engine/
├── Cargo.toml
├── Dockerfile
├── docker-compose.yml
├── migrations/
├── src/
│   ├── main.rs
│   ├── api/
│   ├── auth/{mod.rs,policies.rs}
│   ├── db/{mod.rs,pool.rs}
│   ├── imports/
│   ├── products/
│   ├── rules/{compiler.rs,wasm_runtime.rs,validator.rs}
│   ├── classification/{engine.rs,ranking.rs,explain.rs}
│   ├── reviews/
│   ├── outputs/{registry.rs,json.rs,csv.rs,pdf.rs}
│   ├── search/index.rs
│   ├── jobs/{lease.rs,workers.rs}
│   ├── integrations/{rag.rs,notification_hub.rs,workflow.rs}
│   ├── events/outbox.rs
│   ├── templates/audit_renderer.rs
│   └── ui/
├── templates/
├── tests/{fixtures,e2e,snapshots}
└── docs/
```

## Shared Foundation

| Foundation | Planned path | Establishes |
|---|---|---|
| Config | `src/config.rs` | Env loading, feature flags, adapter URLs, thresholds |
| DB pool | `src/db/pool.rs` | sqlx Postgres pool and health checks |
| Tenant auth | `src/auth/mod.rs` | API key/JWT extraction and tenant context |
| Policy functions | `src/auth/policies.rs` | Role-scope matrix enforcement and denial tests |
| Error format | `src/errors.rs` | `{ error: { code, message, details } }` responses |
| Telemetry | `src/telemetry.rs` | tracing JSON logs, request IDs, Prometheus metrics |
| Job leasing | `src/jobs/lease.rs` | PostgreSQL-backed idempotent leasing |
| WASM runtime | `src/rules/wasm_runtime.rs` | bounded wasmtime execution with fuel/timeouts |
| Search | `src/search/index.rs` | Tantivy local search fallback |
| Audit snapshot | `src/templates/audit_renderer.rs` | frozen export context and strict templates |
| Events | `src/events/outbox.rs` | non-blocking optional integration events |

## Key Modules / Deep References

| Module | Paths |
|---|---|
| Product ingestion | `src/imports/`, `src/products/`, `src/api/products.rs` |
| Rule packs | `src/rules/`, `src/api/rule_packs.rs` |
| Classification | `src/classification/`, `src/api/classifications.rs` |
| Reviews | `src/reviews/`, `src/api/reviews.rs` |
| Outputs and audit export | `src/outputs/`, `templates/audit/`, `src/api/audit_exports.rs` |
| Backtest | `src/bin/backtest.rs`, `tests/fixtures/golden/` |
| Optional integrations | `src/integrations/{rag.rs,notification_hub.rs,workflow.rs}` |
| UI | `src/ui/`, `templates/` |

## Database Schema Overview

Tables: `tenants`, `users`, `products`, `rule_packs`, `classification_runs`, `reviewer_overrides`, `audit_exports`, `classification_jobs`, and `integration_settings`. Every data-bearing table is tenant-owned. Classification runs pin product snapshots and rule-pack versions. Audit exports pin `payload_snapshot` and never re-read mutable tenant/product/rule-pack state.

Tenant identity columns: `legal_name`, `full_legal_name`, `display_name`, `address`, `registration`, `contact`, `wordmark`, `regulator_ids`. Fixtures must include at least two tenants with distinct values.

## Tenant Model

Tenant context comes from tenant-scoped API key or JWT claim. All API handlers and background jobs must carry tenant context. All queries for tenant-owned entities include `tenant_id`; tests must prove cross-tenant denial or invisibility.

## Environment Variables

`DATABASE_URL`, `APP_BASE_URL`, `SELF_REGISTRATION_ENABLED`, `JWT_SECRET`, `API_KEY_PEPPER`, `RUST_LOG`, `SENTRY_DSN`, `RAG_PLATFORM_ENABLED`, `RAG_PLATFORM_URL`, `RAG_PLATFORM_API_KEY`, `NOTIFICATION_HUB_ENABLED`, `NOTIFICATION_HUB_URL`, `NOTIFICATION_HUB_API_KEY`, `WORKFLOW_ENGINE_ENABLED`, `WORKFLOW_ENGINE_URL`, `WORKFLOW_ENGINE_API_KEY`, `WORKFLOW_HIGH_RISK_REVIEW_ID`.

## External Integrations

| Integration | Required | Notes |
|---|---|---|
| Product Catalog CSV/JSON | Yes | Local/offline import via `POST /api/products/import` |
| Multi-Agent RAG Platform | Optional | Evidence enrichment; failure does not block classification |
| Event-Driven Notification Hub | Optional | Fire-and-forget events to `/api/events`; failure logged/counted only |
| Workflow Automation Engine | Optional | High-risk review trigger; execution id logged only |

## Key Patterns & Conventions

- Rule-pack activation creates immutable versions; historical runs/export snapshots never use mutable current state.
- Corrections append to `reviewer_overrides`; original machine decision stays visible.
- Optional adapters are feature-flagged and non-blocking.
- UI controls mirror policies but never substitute for server-side authorization.
- Business-logic correctness tests must verify API, UI, export, and job paths agree for shared invariants.
- Output registry symbols must match PRD §2b matrix naming: `classification_output_{jurisdiction}_{artifact}`.
- Policy symbols must match PRD §2b role/action naming: `can_{scope}_{resource}_{action}`.

## Gotchas

| Gotcha | Mitigation |
|---|---|
| sqlx compile-time checks require DB or offline metadata | Use Docker Postgres in dev and commit `.sqlx/` metadata once queries exist. |
| Testcontainers can be slower on first run | Keep unit/business tests isolated from container-heavy integration tests where possible. |
| wasmtime fuel/timeouts must be deterministic | Centralize runtime construction in `src/rules/wasm_runtime.rs` and test exhaustion paths. |
| Askama templates can accidentally read fresh DB values | Render only from `AuditSnapshot`; no DB calls in renderers. |
