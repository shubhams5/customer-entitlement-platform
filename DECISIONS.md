# Implementation Decisions

- `openapi.yaml` remains the REST contract. New escalation, webhook event, Platinum tier, and assignment account formats are represented there and covered by the contract test.
- Controllers remain transport-focused; business rules and persistence stay in existing domain services.
- Prisma/SQLite stores customer, entitlement, usage, case, audit, persistent idempotency, and transactional webhook outbox/delivery data.
- Case escalation has a dedicated `POST /v1/cases/{caseId}/escalate` route. It reuses the case service transition rules, requires `cases:write`, `If-Match`, and an idempotency key, and writes `case.escalated` to the outbox in the same transaction.
- Dependency upgrades use compatible NestJS/Fastify and Prisma versions to clear critical/high production findings. A moderate `csv-parse` advisory remains because the suggested fix is a major upgrade.
- Outbound webhook delivery rejects non-public IP destinations, checks all DNS answers, pins the selected checked address, and does not follow redirects. An exact URL allowlist is retained for explicitly trusted local test receivers.
- `webhook-receiver/` is separate demonstration code with exact-body HMAC verification, timestamp freshness checks, and durable event-ID deduplication. It is not part of the production API ingress path.
- The assignment demo uses a dedicated `ACC-007` fixture: Platinum tier, a 2026-10-24 08:12Z open P1 case, and a 2027-01-15 renewal. The sample as-of date is 2026-11-25. Extra required case fields are explicitly marked fixture scaffolding.
- No usage quantity was provided for the assignment account, so its CSV has only a header and the summary returns no usage metrics rather than invented values.
- MCP remains a separate stdio server built with the official TypeScript SDK and calls only the REST API. It returns renewal dates and compact usage metrics under existing scope authorization while omitting ARR, PII, and case text.
- The optional MCP+LLM demonstration sends only allowlisted fixture metadata to an OpenAI-compatible endpoint, checks strict assignment filters, computes results deterministically, and includes a missing-customer tool failure. The code is present, but a live LLM run was not possible without credentials.
- Human approval for MCP escalation is explicit and bound to the actor, case, and expected version. The short-lived approval store remains in-memory to keep approval grants single-process and short-lived.
- Compose keeps migration/seed initialization before API health and the test runner behind an opt-in profile. The configuration was not runtime-validated because Docker was unavailable.
