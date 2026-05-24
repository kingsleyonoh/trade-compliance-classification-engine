# API Error Envelope

## What it establishes

HTTP errors use the PRD-mandated JSON envelope `{ "error": { "code", "message", "details" } }` through a shared `ApiError` type.

## Files

- `src/errors.rs` — `ApiError` and Axum `IntoResponse` implementation.
- `tests/foundation_shared.rs` — error response status and JSON shape coverage.

## When to read this

Before writing any code that:
- Returns an API error response.
- Adds validation, auth, not-found, or conflict errors.
- Serializes errors for HTMX/API consumers.

## Contract

- Return `ApiError` or convert domain errors into `ApiError` at entrypoints.
- Keep stable machine-readable error codes; do not expose stack traces to clients.
- Include details only when they are safe for tenant-scoped consumers.
- Preserve the envelope shape across API and HTMX responses.

## Cross-references

- Related modules: `src/errors.rs`
- Related PRD sections: §8b API Endpoints, §10b Performance & Observability
