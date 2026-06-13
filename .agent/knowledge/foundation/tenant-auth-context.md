# Tenant Auth Context

## What it establishes

Tenant-scoped request context is extracted once at the HTTP boundary from authenticated identity headers and then passed to handlers/services instead of re-parsing identity in feature modules.

## Files

- `src/auth/mod.rs` — `TenantContext` and `UserScope` header parsing.
- `src/auth/policies.rs` — role/action policy symbols and matrix helper.
- `tests/foundation_shared.rs` — tenant header parsing and policy allow/deny coverage.

## When to read this

Before writing any code that:
- Authenticates API requests or UI actions.
- Needs `tenant_id`, `user_id`, or role scope.
- Adds a policy for a protected resource action.

## Contract

- Every protected handler must carry a `TenantContext`; do not accept tenant ids from request bodies as authority.
- Use `UserScope` and `ResourceAction` instead of stringly-typed role checks.
- UI may hide disabled actions, but server-side code must call policy helpers for authorization.
- Cross-tenant data access must use `TenantContext.tenant_id` as the query scope.

## Cross-references

- Related modules: `src/auth/mod.rs`, `src/auth/policies.rs`
- Related PRD sections: §2 Architecture Principles, §2b Role Scopes × Resource Actions, §8 Admin / UI, §8b API Endpoints
