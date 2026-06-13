# Trade Compliance Classification Engine — Coding Standards: Live & Integration Testing

> Part 4 of 5. Also loaded: `CODING_STANDARDS.md` (core AI discipline), `CODING_STANDARDS_META.md` (skills, env, branching), `CODING_STANDARDS_TESTING.md` (core TDD), `CODING_STANDARDS_TESTING_E2E.md` (E2E via real HTTP), `CODING_STANDARDS_DOMAIN.md` (deploy/security)
> This file covers the mock policy, component testing, and in-process backend integration testing. E2E testing lives in `CODING_STANDARDS_TESTING_E2E.md`.

## Live Integration Testing (Mock Policy)

### The Rule: Don't Mock What You Own
If you control the service and can run it locally → test against the real thing.

### Service Fallback Hierarchy
When deciding how to test a service, follow this order:
1. **Local instance** (best) — Docker, CLI, emulator on your machine
2. **Cloud dev instance** (good) — dedicated test project / staging environment
3. **Mock** (last resort) — only when options 1 and 2 are impossible

### Test LIVE (Never Mock)
- Your database (local PostgreSQL via Docker Compose) — validates schema, column names, constraints, query behavior
- Your own API endpoints — call the actual route, not a stub
- Your own server actions / business logic — test the real function
- File storage you control (local filesystem, local object storage)

### Mock ONLY These
- Third-party payment APIs (Stripe charges money)
- Email/SMS delivery (SendGrid/Twilio sends messages)
- Rate-limited external APIs you don't control
- Services with irreversible side effects
- Cloud-only services with no local emulator AND no dev tier

### No Services? No Problem
If the project has no external services (CLI tool, library, static site), this policy doesn't apply — just write standard unit tests.

### Why This Matters
A mock that returns `{ user_id: 1 }` will pass even when the real column is `userId`. A mock that returns success will pass even when the real constraint rejects your data. Mocks test your ASSUMPTIONS about the service. Live tests test REALITY.

### Common Mock Violations (DO NOT DO THESE)
- ❌ Mocking your database client to return fake rows — hit the real database
- ❌ Mocking your own API routes with `nock`/`msw` — call the real endpoint via test client
- ❌ Using an in-memory SQLite when production uses PostgreSQL — use the real PostgreSQL
- ❌ Mocking Redis/cache when it's running in Docker — connect to the real instance
- ✅ Mocking Stripe's charge API — you don't want to charge real money in tests
- ✅ Mocking SendGrid — you don't want to send real emails in tests
- ✅ Mocking an external API with rate limits — you don't control their uptime

### Test Cleanup
- Each test MUST clean up after itself (delete rows, reset state)
- Use transactions with rollback when possible for speed




## Backend API & Integration Testing

> This section applies to backend-only projects (APIs, workers, CLI tools). If the project has a React frontend, use the Component Testing section above instead.
> **Note:** This is in-process integration testing (test client like `inject()` or `supertest`). For real-HTTP testing over the network, see `CODING_STANDARDS_TESTING_E2E.md`.

### When to Write API Integration Tests
- Every **API endpoint**: test request → response cycle with real HTTP semantics
- Every **message consumer/handler**: test event processing with real or local message broker
- Every **background job/worker**: test job execution with actual service dependencies
- Every **middleware**: test request interception, auth guards, validation layers

### What to Test
| Priority | Test This | Example |
|----------|-----------|---------|
| 1 | Request/response cycle | POST /api/users → 201, returns created user |
| 2 | Input validation | Missing required field → 400 with specific error |
| 3 | Auth & authorization | No token → 401; wrong role → 403 |
| 4 | Error handling | Invalid ID → 404; DB constraint → 409 |
| 5 | Edge cases | Empty body, oversized payload, duplicate submission |

### API Testing Patterns
- Use the framework's built-in test client (e.g., Fastify `inject()`, Express `supertest`, FastAPI `TestClient`)
- Test full request lifecycle — serialization, middleware, handler, response
- Assert on status codes, response body structure, AND headers where relevant
- Test pagination, filtering, and sorting with real DB rows

### Message/Event Consumer Testing
- Publish test events to a local broker (Kafka/Redpanda, RabbitMQ, Redis Streams)
- Assert the consumer processes them correctly (DB writes, side effects)
- Test error handling: malformed events, duplicate events, consumer restart

### File Naming & Location
- Name: `module-name.test.ts` or `test_module_name.py` — co-located or in `tests/` mirror
- Group shared test helpers in `tests/helpers/` or `tests/factories/`

