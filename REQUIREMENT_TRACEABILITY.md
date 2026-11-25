# Requirement Traceability

Statuses reflect repository code and checks actually run in this workspace. They do not imply production certification.

## REST platform and security

| Requirement | Status | Evidence / limit |
|---|---|---|
| Customer aggregation, independent partial failures, and ARR field authorization | Implemented | API E2E and customer aggregation unit tests cover section availability and ARR scopes. |
| Case search filtering, sorting, and cursor pagination | Implemented | Case search tests and API E2E cover filters, invalid input, and cursor traversal. |
| Idempotent comments and concurrent replay handling | Implemented | Persistent idempotency and comment uniqueness; E2E covers replay, mismatch, and concurrent same-key requests. |
| Optimistic concurrency | Implemented | E2E covers missing/stale ETags and concurrent updates; only one write with the same version succeeds. |
| Authentication, scopes, upstream resilience, structured audit, correlation IDs | Implemented | API E2E and unit suites cover authorization, retries, circuit breaker, partial failures, and audit behavior; external providers were not contacted. |
| Dedicated `POST /v1/cases/{caseId}/escalate` | Implemented | OpenAPI contract and E2E cover scope, idempotency, stale/missing ETag, repeat escalation, and business transition. |
| `case.escalated` webhook event and transactional outbox | Implemented | OpenAPI event enum and E2E delivery checks include the event; event/outbox persistence shares the transition transaction. |
| High/critical production dependency findings | Implemented | Compatible NestJS/Fastify and Prisma upgrades applied; current production audit has no critical/high findings. |
| Remaining dependency findings | Partially implemented | One moderate `csv-parse` advisory remains because the suggested fix requires a major version upgrade. |
| Webhook SSRF protection, including IPv4/IPv6 internal destinations and DNS rebinding | Implemented | Unit tests cover blocked address classes, mixed DNS answers, exact local allowlisting, and validated-address pinning. Network egress controls remain operationally required. |
| Local signed webhook receiver with freshness and durable deduplication | Implemented | Receiver unit test verifies exact body, rejects tampering/stale timestamps, and confirms event-ID dedup persists across receiver restart. |

## MCP and assignment demonstration

| Requirement | Status | Evidence / limit |
|---|---|---|
| Official TypeScript MCP SDK, API-only access, delegated identity/scopes | Implemented | MCP tools use `NestApiClient`; tests assert bearer and correlation propagation and denial before API access when scope is missing. |
| Strict schemas, compact output, ARR/PII redaction, audit, untrusted text handling | Implemented | MCP tests cover strict inputs/outputs, sensitive field omission, bounded responses, audit redaction, and prompt-injection-like text omitted from tool responses. |
| Human approval for MCP escalation | Implemented | Tests cover no elicitation, refusal, user/case/version binding, expiry, and one-time use. |
| Dedicated assignment sample (`ACC-007`, Platinum, P1/open, case timestamp, renewal date) | Implemented | Dedicated CRM/ERP/case fixtures, idempotent seed, API E2E, and contract tests. Assignment usage CSV intentionally has no rows because no usage values were supplied. |
| Deterministic 48-hour/90-day assignment evaluation | Implemented | Unit tests verify strict “older than 48 hours”, inclusive 90-day boundary, case age, and renewal date. |
| Reproducible MCP + real-LLM demo with tool calls and failure case | Partially implemented / live run unverified | Script uses MCP stdio tools, an OpenAI-compatible chat-completions endpoint, and an `ACC-999` not-found case. No provider key was available, so no live LLM output/tool-call transcript is claimed. |

## Submission and operations

| Requirement | Status | Evidence / limit |
|---|---|---|
| Compose starts API, migrations, seed, and MCP | Partially implemented / runtime unverified | Compose wiring exists. Docker is unavailable, so no image build or startup was run. |
| Compose test profile | Partially implemented / runtime unverified | Profile command is documented but Docker is unavailable. Local `npm run test:all` passed independently. |
| Postman functional/regression collection and environment | Implemented / current collection execution unverified | Updated 19-request JSON parsed. Newman is not installed, so the updated export was not run; an earlier 15-request result does not apply. |
| README, SECURITY, DECISIONS, TESTEVALS, AI_USAGE, and this traceability report | Implemented | Docs state current behavior, verified results, and blocked checks. |

## Explicitly not verified or not supplied

- Docker Compose image build/start, initialization ordering, and profile test run.
- Live OpenAI-compatible LLM run and actual model-generated transcript.
- Newman execution of the current collection and Postman desktop import.
- Live upstream providers or production webhook subscribers.
- Assignment usage quantities: none were supplied, so none were fabricated.
- No separate assignment rubric file was present in the workspace; this report maps the requirements supplied in the conversation.
