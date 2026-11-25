# Test Evaluation

## Scope

No separate Applied AI Engineer rubric was present in the workspace. This evaluation maps the requirements in the conversation and `openapi.yaml`; it does not claim coverage beyond them.

## Requirement evidence

| Requirement | Evidence | Result |
|---|---|---|
| Customer aggregation and partial section failures | `src/modules/customer/customer-aggregation.spec.ts` covers a timed-out section, available sections, and ARR redaction. | Passed |
| Case filtering, sorting, and cursor pagination | `src/modules/cases/case-search.spec.ts` and E2E cursor tests. | Passed |
| Persistent idempotency and concurrent comment creation | E2E tests cover exact replay, payload mismatch, concurrent same-key comment creation, and one persisted comment. | Passed |
| Authentication, scopes, and ARR authorization | E2E tests cover unauthenticated and insufficient-scope denials, ARR field permissions, and restricted writes. | Passed |
| Optimistic concurrency | E2E tests cover missing and stale `If-Match`, plus concurrent updates using one version; only one update succeeds. | Passed |
| Upstream adapters and resilience | Fixture sync is exercised against the test database. Resilience unit tests cover HTTP 503 retry, circuit open/half-open behavior, and timeout classification. An integration-service test verifies timeout-to-503 mapping and failed-run persistence. | Passed with mocked HTTP and adapters; no live upstream was contacted |
| Webhook signing and delivery | E2E sends to a local HTTP receiver and verifies the exact-body signature; signature tests reject changed bodies, wrong secrets, and malformed headers. | Passed |
| Webhook replay/duplicate dispatch | E2E issues two concurrent dispatch requests and then repeats dispatch after delivery; only one callback is received and `attemptCount` remains 1. | Passed for this API dispatch path |
| MCP schemas, delegation, redaction, and output bounds | `mcp/server.spec.ts` verifies strict inputs, forwarded bearer/request ID, compact outputs, PII/ARR and untrusted-text omission, response/output limits, and safe retry behavior. | Passed using the MCP SDK in-memory transport |
| MCP write authorization and human escalation approval | MCP tests cover missing scopes, no elicitation support, refusal, user/case/version binding, expiry, one-time consumption, and no API write before approval. | Passed |
| OpenAPI contract and fixture validation | `src/contract-and-fixtures.spec.ts`. | Passed |

## Commands and results

Verified in this workspace after `npm.cmd ci`:

- `npm.cmd run test:all` — type-check passed; 8 Jest suites / 22 tests passed; E2E 1 suite / 8 tests passed.
- `npm.cmd run build` — passed.
- `npm.cmd run prisma:generate` — passed.
- `npm.cmd run prisma:deploy` with `DATABASE_URL=file:./submission-check.db` — both migrations applied to a disposable SQLite database.
- `npm.cmd run db:seed` with that database — completed; 4 customers, 11 entitlements, and 8 usage events processed.
- `npm.cmd run start:prod` and `npm.cmd run start:dev` — both returned healthy `/health` responses against the disposable database.
- Newman ran the exported Postman collection against the local API — 15 requests, 15 assertions, 0 failures.
- A YAML/JSON syntax check parsed `docker-compose.yml`, the Postman collection, environment, and all Postman scripts.
- `npm.cmd audit --omit=dev` — 12 production advisories: 1 critical, 7 high, 4 moderate. `npm ci` reported 26 advisories across the full dependency tree.

## Limits

- Upstream HTTP behavior was tested with mocks; no external CRM, ERP, or usage service was contacted.
- The MCP suite uses in-memory MCP transports. The Compose OAuth bootstrap was smoke-tested against the local API; a Docker-attached stdio client session was not exercised.
- Docker and Docker Compose were unavailable, so no image build, `docker compose up --build`, or Compose test-profile run was performed. YAML parsing is not equivalent to Compose validation.
- Newman exercised the collection; the Postman desktop app itself was not used.
- No inbound webhook receiver exists in this API. Signature verification is a helper/tested contract, not an inbound request flow; timestamp freshness and durable event deduplication are subscriber responsibilities.
- Tests do not establish production load capacity, multi-instance behavior, database recovery across process restarts, or centralized log delivery.
