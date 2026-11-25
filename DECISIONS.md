# Implementation Decisions

- `openapi.yaml` is the REST contract and is validated by the contract/fixture test.
- Controllers remain transport-focused; service classes own business rules, persistence, authorization checks tied to fields, and webhook/audit orchestration.
- Prisma with SQLite provides persistent application state, including idempotency records, audit events, and transactional outbox/delivery rows.
- Customer overview sections are independent. A failed section is reported in `partialFailures` while successful sections remain available.
- Case search uses validated filters, deterministic sort keys, and opaque cursor pagination.
- Write concurrency uses version-based ETags and conditional database updates rather than last-write-wins behavior.
- Idempotency is scoped by actor, HTTP method, and route, with payload hashes preventing reuse of a key for a different request. Comment rows also enforce per-case key uniqueness.
- Upstream GETs use bounded timeouts, safe retries, and per-upstream circuit breakers. Integration sync fetches sources independently and persists a failed run when an upstream is unavailable rather than persisting a partial sync.
- Webhook events are written transactionally with the state change that emitted them. Delivery uses signed requests, leases, bounded retry schedules, and terminal delivered state. A manual dispatch of a delivered row is a no-op; failed rows can be retried.
- Webhook delivery remains at-least-once across the sender/subscriber boundary. Subscribers are responsible for timestamp freshness and durable `X-Webhook-Id` deduplication; this API has no inbound webhook receiver.
- MCP is a separate stdio server built with the official TypeScript MCP SDK. It talks only to the existing NestJS API, not Prisma repositories or upstream adapters.
- MCP returns compact, allowlisted responses to limit PII/ARR exposure and to avoid passing case/comment text as model instructions. Tool inputs and outputs use strict Zod schemas and explicit byte limits.
- Escalation approval uses MCP elicitation followed by a short-lived, single-use, user/case/version-bound token. Approval state is in-memory because grants expire quickly; tokens do not survive MCP process restarts.
- MCP bearer claims provide delegated context, but NestJS remains the final authentication and authorization boundary.
- REST audit records are persisted; MCP tool audit events go to stderr by default so they do not contaminate the stdio protocol stream.
- Compose uses a one-shot migration/seed service and a named SQLite volume before API startup; MCP waits for API health and obtains a least-privilege demo token. The test service is isolated behind an opt-in profile so normal startup does not run tests.
