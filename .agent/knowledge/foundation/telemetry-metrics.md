# Telemetry and Metrics

## What it establishes

Request IDs and tenant-scoped counters are centralized so future API, job, and adapter surfaces can emit consistent observability data.

## Files

- `src/telemetry.rs` — tracing initialization, `RequestId`, and `MetricsRegistry`.
- `src/main.rs` — runtime tracing initialization uses the shared telemetry module.
- `tests/foundation_shared.rs` — request-id extraction and tenant-scoped counter coverage.

## When to read this

Before writing any code that:
- Initializes tracing or logging.
- Adds request IDs, structured logs, counters, or histograms.
- Emits observability for imports, classifications, jobs, exports, or integrations.

## Contract

- Initialize tracing through `telemetry::init_tracing`.
- Prefer an incoming `x-request-id`; generate one when absent.
- Metrics that describe tenant-owned work must include tenant identity in their key/labels.
- Never log secrets, API keys, or sensitive tenant payloads.

## Cross-references

- Related modules: `src/telemetry.rs`, `src/main.rs`
- Related PRD sections: §10b Performance & Observability
