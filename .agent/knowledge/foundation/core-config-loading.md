# Core Config Loading

## What it establishes

Application configuration is loaded once from environment variables plus local `.env` / `.env.local` files, with optional ecosystem adapters disabled by default.

## Files

- `src/config.rs` — `AppConfig` and integration config structures.
- `tests/foundation_config.rs` — config defaults and missing-required-value coverage.
- `.env.example` — documented non-secret environment variable template.

## When to read this

Before writing any code that:
- Reads environment variables directly.
- Adds a required or optional configuration value.
- Enables RAG, Notification Hub, Workflow Engine, Sentry, database, or server bind settings.

## Contract

- Use `AppConfig::from_env()` at runtime instead of reading environment variables in feature modules.
- Add every new runtime variable to `.env.example` with placeholder values only.
- Optional integrations must default to disabled and must not block core local classification flows.
- Tests may use `AppConfig::from_env_overrides(...)` to avoid mutating process environment.

## Cross-references

- Related modules: `src/config.rs`, `src/bin/setup.rs`, `src/main.rs`
- Related PRD sections: §3 Tech Stack, §10 Deployment, §14 Environment Variables
