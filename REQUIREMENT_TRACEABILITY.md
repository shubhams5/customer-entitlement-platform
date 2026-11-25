# Requirement Traceability

Statuses are based on repository evidence and commands actually run. “Implemented” does not imply production certification.

## Earlier REST and MCP requirements

| Requirement | Status | Evidence / limit |
|---|---|---|
| Customer create/list/detail/update and aggregation | Implemented | Customer E2E, aggregation unit, and Postman regression checks. Aggregation reports failed sections independently. |
| ARR field-level read/write authorization | Implemented | E2E and Postman verify permitted read, redacted read, and denied write without ARR scopes. |
| Entitlement CRUD, evaluation, and support policy use | Implemented | E2E verifies entitlement evaluation and case severity/SLA rules. |
| Usage event ingestion, listing, and summary | Implemented | E2E verifies recording and quota summary. |
| Case create/read/update/comment and business rules | Implemented | E2E exercises create, comments, escalation, SLA rules, and authorization. |
| Case filters, sort validation, and cursor pagination | Implemented | Unit tests cover query construction/invalid sorts/date ranges; E2E and Postman exercise search and cursors. |
| Persistent idempotency, payload mismatch, concurrent comment replay | Implemented | Prisma uniqueness and idempotency records; E2E tests exact replay, mismatch, and same-key concurrency. |
| Optimistic concurrency for updates | Implemented | E2E and Postman verify ETags, concurrent writes, 412 stale, and 428 missing precondition. |
| Fixture sync, source reconciliation, and sync-run history | Implemented | E2E fixture sync plus local migration/seed validation. |
| Upstream adapters, timeout, safe retry, circuit breaker, and partial failure handling | Implemented | Mocked resilience tests, customer aggregation timeout test, failed-sync persistence test, and fixture E2E. No live upstream was contacted. |
| Audit listing and structured logs/correlation IDs | Implemented | E2E reads persisted audit events; API logs observed correlation IDs. No centralized log backend was tested. |
| Transactional webhook outbox, endpoint management, signed delivery | Implemented | Schema/service flow and local callback E2E; exact-body signature and tampering tested. |
| Webhook delivery retry/replay protection | Partially implemented | Sender prevents dispatch after `DELIVERED`; concurrent dispatch is lease-protected. Outbound is at-least-once, and no inbound receiver or subscriber replay cache exists. Subscribers must enforce timestamp freshness and durable event-ID deduplication. |
| OpenAPI contract | Implemented | OpenAPI/fixture contract test passes. |
| MCP tools use official SDK and existing REST API only | Implemented | Tool implementation calls `NestApiClient`; MCP tests use in-memory SDK transport. |
| MCP strict schemas, delegated identity/scopes, compact outputs, limits, redaction, and audit | Implemented | Tests cover strict inputs, forwarded bearer/request ID, omitted PII/ARR/untrusted text, output bounds, and audit events. No live model/client prompt-injection experiment was run. |
| MCP comment idempotency and unauthorized write denial | Implemented | MCP tests verify same-key safe retry and scope denial before API access. |
| Explicit human approval for MCP escalation | Implemented | Tests cover decline, missing elicitation, user/case/version binding, expiry, and one-time use. Approval state is in-memory and lost on restart. |
| Requirement-by-requirement audit records | Implemented | `TESTEVALS.md`, `SECURITY.md`, `DECISIONS.md`, and this report map evidence and limitations. No separate assignment rubric was found; scope is the conversation requirements and `openapi.yaml`. |

## Submission-preparation requirements

| Requirement | Status | Evidence / limit |
|---|---|---|
| One-command Compose startup of API, migration/seed bootstrap, and MCP | Partially implemented | `Dockerfile` and `docker-compose.yml` define dependencies/health checks and initialization. Docker/Compose were unavailable, so the stack was not built or started. |
| Automatic migrations and seed data | Partially implemented | `db-init` is configured to run migrations then fixture seeding before API startup. Both commands passed separately against a disposable SQLite database; Compose ordering was not runtime-tested. |
| Tests independent of normal service startup | Implemented locally; Compose profile unverified | `npm run test:all` passed; Compose has an opt-in `test` profile. The profile container was not run. |
| Postman functional/regression collection and environment | Implemented and Newman-verified | 15 requests / 15 assertions passed against the local API. The Postman desktop app was not used; webhook dispatch is omitted because the collection provisions no callback receiver. |
| README setup, architecture, examples, <5-minute demo | Implemented; demo timing unverified | Local dev and production server health checks passed. Docker first-build time and full Compose walkthrough were not measured. |
| AI assistance disclosure | Implemented | `AI_USAGE.md` describes assistance and explicitly identifies unverified checks. |
| Validate every command from a clean environment | Partially implemented / blocked | `npm ci`, generation, migration, seed, build, type-check, unit/E2E, local dev/prod startup, and Newman collection passed. Docker commands remain unverified because Docker is absent; YAML parsing is not equivalent to Compose validation. |

## Explicitly skipped / unresolved

- Docker image/Compose execution and Compose-profile test validation.
- Postman desktop import/UI validation; Newman is the executed equivalent.
- Postman webhook callback/replay flow, because no callback receiver is provisioned in this local collection.
- Live external upstreams, subscriber systems, production load, and multi-instance deployment.

## Submission validation record

Update this section after running the checks from a machine with Docker Compose and Postman/Newman. Do not mark the blocked checks as passed based on static inspection alone.
