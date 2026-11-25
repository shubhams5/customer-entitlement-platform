# Security Notes

This describes implemented controls and known boundaries, not a penetration-test certification.

## Implemented controls

- REST routes require bearer authentication and route scopes. Customer ARR has separate `customers:arr:read` and `customers:arr:write` authorization.
- Conditional updates use version ETags and `If-Match`; stale writes fail rather than overwrite newer data.
- Idempotency keys and request hashes are stored persistently and scoped by actor, method, and route. Case comments also have a database uniqueness constraint per case and idempotency key.
- Webhook outbox events are written in the state-change transaction. Delivery records use leases, bounded retries, and HMAC-SHA256 signatures over the timestamp and exact JSON body.
- An already-delivered webhook row is terminal for manual dispatch: it is returned without another network send. Dispatch claims exclude delivered rows, including in the concurrent path.
- MCP forwards the delegated bearer token to NestJS and performs local scope checks before tool actions. NestJS remains the authorization authority.
- MCP outputs are schema-validated and allowlisted. Case text, requester PII, customer names/emails, and ARR are omitted from tool responses. Comment bodies are not included in MCP audit events or returned outputs.
- MCP API responses are capped at 1 MB and serialized tool outputs at 32 KiB. MCP API GETs and idempotent comment POSTs may retry once; optimistic PATCH requests do not retry.
- MCP audit events are written to stderr by default. REST audit events are persisted in the database.

## Escalation approval

Escalation requires explicit MCP elicitation. Approval grants use 32 random bytes, are stored by token hash in process memory, expire after 60 seconds, and are bound to actor identity, token fingerprint, case ID, and expected version. Consumption is single-use. The resulting REST update still requires the delegated write scope and matching `If-Match`.

Approval grants are intentionally not persistent: restarting the MCP process invalidates them. A multi-instance MCP deployment would need shared approval state or session affinity.

## Webhook boundaries

- This application sends outbound webhooks; it does not expose an inbound webhook receiver or maintain an inbound replay cache.
- Outbound delivery is at-least-once. A subscriber must verify `HMAC_SHA256(secret, "<timestamp>.<raw JSON body>")`, enforce an acceptable timestamp window, and persistently deduplicate `X-Webhook-Id` before applying side effects.
- Preventing a manual resend after a recorded successful delivery does not eliminate duplicates possible when a remote subscriber processes a request but the sender fails to receive its acknowledgement.
- Webhook endpoint URLs are validated as HTTP(S), but this code does not block loopback, private, or link-local destinations. Restrict `webhooks:write` to trusted operators and apply network egress controls.
- Signing secrets are persisted in the database and returned in the endpoint creation response. Protect database access and handle the creation response as secret material.

## Identity and deployment boundaries

- The MCP process decodes the delegated JWT claims for actor/scope context; it does not independently verify the JWT signature. It forwards the bearer token unchanged, and the NestJS API performs authoritative authentication and authorization.
- Configure the MCP process with a least-privilege delegated token through `NEST_API_TOKEN`; do not place tokens or webhook secrets in source control or logs.
- Use TLS between separately deployed MCP and API services. The client supports HTTP for local development.

## Known dependency concern

`npm audit --omit=dev` reported 12 production advisories (1 critical, 7 high, 4 moderate), including a critical transitive `@fastify/middie` advisory. `npm ci` reported 26 advisories across the full dependency tree. Broad fixes involve major NestJS/Fastify upgrades and were not applied here. Re-run the audit before release and evaluate compatible upgrades.
