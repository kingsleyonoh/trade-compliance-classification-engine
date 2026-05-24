# DB Pool Bootstrap

## What it establishes

Database pool configuration is derived from `AppConfig` and validated before any PostgreSQL connection is opened.

## Files

- `src/db/mod.rs` — public DB foundation exports.
- `src/db/pool.rs` — `DatabaseConfig`, pool option construction, and pool-bound validation.
- `tests/foundation_shared.rs` — pool-bound parsing and invalid configuration coverage.

## When to read this

Before writing any code that:
- Opens a PostgreSQL pool.
- Adds database pool tuning configuration.
- Performs database health checks or startup wiring.

## Contract

- Use `DatabaseConfig::from_app_config(&config)` before building a `PgPoolOptions`.
- Validate pool limits without opening a network connection when possible.
- Keep database URL ownership in `AppConfig`; feature modules must not read `DATABASE_URL` directly.
- Health endpoints should use the shared pool once they are introduced, not create ad-hoc pools.

## Cross-references

- Related modules: `src/config.rs`, `src/db/pool.rs`
- Related PRD sections: §3 Tech Stack, §9 Project Structure, §10 Deployment, §10b Performance & Observability
