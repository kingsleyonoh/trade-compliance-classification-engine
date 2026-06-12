# Trade Compliance Classification Engine

Rust/Axum multi-tenant trade-compliance classification engine for importing products, activating immutable rule packs, running evidence-backed classifications, managing reviewer overrides, and exporting frozen audit packs.

## Local development

```bash
docker compose up -d
cargo run --bin setup
cargo test -- --test-threads=1
cargo run
```

Required local environment is shown in `.env.example`. Optional RAG, Notification Hub, and Workflow Engine adapters are disabled by default and are designed to fail open/non-blocking for core flows.

## Key endpoints

- `POST /api/tenants/register`
- `POST /api/products/import`
- `POST /api/rule-packs/upload`
- `POST /api/classifications/run`
- `POST /api/classifications/:id/override`
- `POST /api/audit-exports`
- `/ui/dashboard`, `/ui/products`, `/ui/reviews`, `/ui/audit-exports`, `/ui/integrations`

## Release readiness

- Run `cargo fmt --all -- --check`.
- Run `cargo test -- --test-threads=1`.
- Run `bash scripts/scan-secrets.sh --mode all`.
- Run `cargo run --bin backtest`.
- Review `docs/traceability.md` and `docs/deployment.md`.
