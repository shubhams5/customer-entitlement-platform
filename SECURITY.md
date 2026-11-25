# Security Notes

This records implemented controls and known boundaries; it is not a penetration-test certification.

## API and persistence

- Protected REST routes require bearer authentication and route scopes. NestJS verifies credentials and authorizes requests; MCP only derives delegated context and forwards the bearer token.
- ARR reads and writes require separate `customers:arr:read` and `customers:arr:write` scopes.
- Optimistic updates require version ETags. Persistent idempotency records scope replay by actor, method, and route; case comments also have a per-case key uniqueness constraint.
- Audit events, domain updates, and webhook outbox records are persisted transactionally where the domain operation requires it.
- Upstream HTTP adapters use bounded timeouts, safe GET retries, and circuit breakers. Customer overview sections fail independently and report partial failures.

## Outbound webhook SSRF controls

- Destinations must be HTTP(S), without URL credentials or fragments.
- Literal IPs and every DNS answer must be `unicast` according to `ipaddr.js`; loopback, private, link-local, IPv6 internal, mapped, and other non-unicast ranges are rejected.
- DNS answers are validated together, then the selected address is pinned for the outbound request. Redirects are not followed.
- `WEBHOOK_ALLOWED_PRIVATE_TARGETS` allows an exact canonical URL only, for local/testing receivers. Keep this setting narrow and operator-controlled; it is not a general private-network allowlist.
- These application checks complement, rather than replace, network egress filtering. SSRF rejection and DNS-pinning behavior are covered by `src/modules/webhook/webhook-network.spec.ts`.

Outbound deliveries are at-least-once. A subscriber must verify `HMAC_SHA256(secret, "<timestamp>.<raw JSON body>")`, enforce timestamp freshness, and durably deduplicate `X-Webhook-Id`. A sender cannot prevent duplicates if a subscriber processes an event but the sender fails to receive its acknowledgement.

## Local webhook receiver

`webhook-receiver/server.ts` is a local demonstration receiver bound to `127.0.0.1` by default. It caps request bodies at 1 MB, verifies the exact raw-body signature, rejects timestamps outside a default 300-second window, validates the event envelope, and inserts event IDs into a SQLite/libSQL table with a primary key. Repeated IDs are acknowledged as duplicates without reapplying effects. Tests cover tampering, stale timestamps, persistence across receiver restarts, and durable deduplication.

The receiver is demonstration code, not a production ingress service. Its SQLite database contains received payloads and must be protected accordingly.

## MCP and LLM demo

- MCP uses strict Zod tool schemas, delegated scopes, request correlation IDs, audit events, bounded API responses, and compact allowlisted outputs.
- Case text, comments, names, email addresses, and ARR are omitted from MCP output. Customer summary can include renewal dates and compact usage metrics when the delegated scopes permit them.
- MCP escalation requires user elicitation and a short-lived, single-use token bound to the user, case, and case version. The API still enforces the delegated write scope and ETag. Approval state is in-memory and does not survive process restart.
- The optional assignment LLM demo only accepts a localhost API URL. It does not send ARR, PII, comments, case descriptions, or usage metrics to the LLM; use an isolated database containing the checked-in demo fixtures. The model endpoint receives allowlisted case metadata, tier, and renewal dates. Do not run this demonstration against real customer data.
- MCP decodes delegated JWT claims for local scope context but does not independently verify the signature. The API verifies the bearer token authoritatively.

## Dependency audit and remaining risks

The latest `npm.cmd audit --omit=dev` reported no critical or high production advisories and one moderate advisory: `csv-parse` versions below 7.0.2. The audit suggests `csv-parse@7.0.3`, a breaking major upgrade; it was not applied because the requested fix scope was critical/high issues and the current adapter depends on the existing major version. Re-run the audit before release.

Demo OAuth credentials and the Compose fallback signing secret are for local evaluation only. Replace them, use TLS for separately deployed services, protect database files and webhook secrets, and configure network egress controls before deployment.

Docker Compose and the live LLM demo were not executed in this environment; see `TESTEVALS.md`.
