# Cached Helper

## What it establishes

Reusable per-process or per-request helper results can be cached behind a small shared primitive instead of recomputed in every caller.

## Files

- `src/cache.rs` — `CachedValue<T>` cloneable lazy cache.
- `tests/foundation_shared.rs` — cache computes once and returns the stored value thereafter.

## When to read this

Before writing any code that:
- Caches compiled rule packs, parsed configuration, search handles, or other expensive helper outputs.
- Would otherwise duplicate a lazy `Mutex<Option<T>>` pattern.
- Needs a deterministic in-process cache for setup or request-scoped helpers.

## Contract

- Use `CachedValue<T>` for simple lazy helper results before introducing a bespoke cache.
- The compute closure runs only on the first successful initialization.
- Do not use this primitive for cross-process consistency, tenant data authorization, or eviction-heavy caches.
- Cached tenant-owned values must still be keyed or scoped by tenant before being stored.

## Cross-references

- Related modules: `src/cache.rs`
- Related PRD sections: §10b Performance & Observability
