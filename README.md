# Customer Entitlement & Support Case Platform

NestJS/Fastify REST API with Prisma/SQLite persistence and a separate MCP stdio server. The Compose stack starts the API, runs migrations and fixture seeding first, then starts MCP. Demo OAuth credentials are hard-coded for local evaluation only; replace them before any non-demo deployment.

## Under-five-minute demo

The interactive walkthrough is designed to take under five minutes after the stack is ready; the first image build may take longer.

Prerequisites: Docker Engine and Docker Compose v2.

1. Start everything (first build may take a few minutes):

   ```powershell
   docker compose up --build
   ```

   The one-shot `db-init` container applies migrations, upserts the standard JSON/XML/CSV fixtures, then loads `fixtures/assignment-demo/` and its fixed P1 case before the API becomes healthy. MCP starts after API health succeeds.

2. In a second PowerShell window, check health and obtain a local demo token:

   ```powershell
   Invoke-RestMethod http://localhost:3000/health

   $token = Invoke-RestMethod http://localhost:3000/oauth/token `
     -Method Post -ContentType 'application/json' `
     -Body '{"grant_type":"client_credentials","client_id":"platform-admin-client","client_secret":"dev-secret-platform-admin"}'
   $headers = @{ Authorization = "Bearer $($token.access_token)" }
   ```

3. Read the seeded Acme customer and verify ARR is visible to this all-scope demo client:

   ```powershell
   Invoke-RestMethod http://localhost:3000/v1/customers/acct_01J9X8K2M4N6P8Q0R2S4 `
     -Headers $headers | ConvertTo-Json -Depth 8
   ```

4. Import `postman/customer-entitlement-platform.postman_collection.json` and `postman/local.postman_environment.json` into Postman, select the local environment, then run the collection for authorization, ARR redaction, idempotency, case search, escalation, and assignment-fixture checks.

5. Optional real-LLM/MCP assignment demo. This sends only local fixture-derived case metadata and customer tier/renewal data to the configured LLM provider. Do not run it against real customer data:

   ```powershell
   $token = Invoke-RestMethod http://localhost:3000/oauth/token `
     -Method Post -ContentType 'application/json' `
     -Body '{"grant_type":"client_credentials","client_id":"support-agent-client","client_secret":"dev-secret-support-agent","scope":"cases:read customers:read entitlements:read usage:read"}'
   $env:NEST_API_BASE_URL = 'http://localhost:3000'
   $env:NEST_API_TOKEN = $token.access_token
   $env:OPENAI_API_KEY = Read-Host 'OpenAI API key'
   npm run mcp:assignment-demo
   ```

   The demo uses an as-of date of `2026-11-25T00:00:00.000Z` unless `MCP_DEMO_AS_OF` is set. It reports actual MCP tool calls, the deterministic result, the LLM answer, and a deliberate `ACC-999` not-found tool failure. Configure `MCP_DEMO_LLM_URL` and `MCP_DEMO_LLM_MODEL` for a compatible chat-completions provider.

Stop with `docker compose down`. The named SQLite volume persists. `docker compose down -v` deletes the database and is destructive.

## Setup

### Docker Compose

```powershell
docker compose up --build
```

Services:

- `api`: REST API at `http://localhost:3000`.
- `db-init`: runs `prisma migrate deploy` and fixture seeding; exits after success.
- `mcp`: separate MCP server using stdio and a delegated support-agent token.
- `test`: opt-in profile, not started by normal `up`.

Run the independent test suite in its own container:

```powershell
docker compose --profile test run --rm test
```

Connect an MCP client using Docker stdio:

```powershell
docker compose run --rm -T mcp
```

`docker compose run` starts a dedicated MCP process and obtains its short-lived bearer token from the API. The Compose default client receives only `customers:read`, `entitlements:read`, `usage:read`, `cases:read`, and `cases:write`.

### Local Node.js

Requires Node.js 22.9+ and npm. From the repository root:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm ci
npm run prisma:generate
npm run prisma:deploy
npm run db:seed
npm run start:dev
```

Replace `OAUTH_JWT_SECRET` in `.env` before non-demo use. Fixture sync is safe to repeat and updates existing fixture-backed rows. `npm run db:seed` also loads the assignment-specific customer, renewal, and case. Its assignment usage CSV is intentionally header-only because no usage quantities were provided; the API/MCP return an empty metric list rather than fabricated values.

In another terminal, run tests independently of the API process:

```powershell
npm run test:all
```

Or run focused commands:

```powershell
npm run lint:types
npm run build
npm test -- --testPathIgnorePatterns=test/
npm run test:e2e
```

The E2E suite uses and removes `prisma/test-e2e.db`; do not point its test configuration at a production database.

## Architecture

- **REST API**: NestJS modules on Fastify. Controllers handle HTTP input/output; services own business logic.
- **Persistence**: Prisma + SQLite. Migrations live in `prisma/migrations`; `prisma/seed.ts` loads the fixture adapters.
- **Domain modules**: customer aggregation/ARR policy, entitlements, usage, cases, integrations, audit, idempotency, and outbound webhooks.
- **Resilience**: upstream HTTP adapters use bounded timeouts, safe GET retries, and per-upstream circuit breakers. Customer overview sections can fail independently.
- **Concurrency and delivery**: version ETags protect updates; persistent idempotency records protect retried writes; webhook outbox events and delivery rows are committed transactionally.
- **MCP**: `mcp/` uses the official TypeScript MCP SDK. It delegates requests to the REST API, enforces compact schemas/redaction, and requires elicited human approval before escalation.
- **Contract**: `openapi.yaml` is the API contract; contract and fixture validation runs in the unit test suite.

## API examples

### Obtain a token

The bundled clients/secrets are local demo credentials:

```powershell
$token = Invoke-RestMethod http://localhost:3000/oauth/token `
  -Method Post -ContentType 'application/json' `
  -Body '{"grant_type":"client_credentials","client_id":"platform-admin-client","client_secret":"dev-secret-platform-admin"}'
$headers = @{ Authorization = "Bearer $($token.access_token)" }
```

### Search cases

```powershell
Invoke-RestMethod 'http://localhost:3000/v1/cases?accountId=acct_01J9X8K2M4N6P8Q0R2S4&status=OPEN&sort=-createdAt&limit=10' `
  -Headers $headers
```

Supported filters include account, status, severity, assignee, text, and created-date bounds. `sort`, `limit`, and opaque `cursor` control stable keyset pagination.

### Create an idempotent case comment

```powershell
$commentHeaders = $headers.Clone()
$commentHeaders['Idempotency-Key'] = [guid]::NewGuid().ToString()
$comment = @{
  authorId = 'demo-agent'
  authorRole = 'AGENT'
  body = 'Investigating the reported issue.'
  isInternal = $false
} | ConvertTo-Json

Invoke-RestMethod 'http://localhost:3000/v1/cases/{caseId}/comments' `
  -Method Post -Headers $commentHeaders -ContentType 'application/json' -Body $comment
```

Repeat the same request with the same key and payload to replay the original result. Reusing the key with a different payload returns a conflict.

### Update with optimistic concurrency

Read a customer or case first and retain its `ETag` response header. Then send that value as `If-Match`:

```powershell
$updateHeaders = $headers.Clone()
$updateHeaders['If-Match'] = '"v1"'
Invoke-RestMethod 'http://localhost:3000/v1/cases/{caseId}' `
  -Method Patch -Headers $updateHeaders -ContentType 'application/json' `
  -Body '{"status":"IN_PROGRESS"}'
```

A stale ETag returns `412 Precondition Failed`; a missing required ETag returns `428 Precondition Required`.

### Explicit case escalation

Escalation is a dedicated idempotent write and requires both `cases:write` and the current `If-Match` ETag:

```powershell
$escalationHeaders = $headers.Clone()
$escalationHeaders['If-Match'] = '"v1"'
$escalationHeaders['Idempotency-Key'] = [guid]::NewGuid().ToString()
Invoke-RestMethod 'http://localhost:3000/v1/cases/{caseId}/escalate' `
  -Method Post -Headers $escalationHeaders
```

The case transition and `case.escalated` outbox event commit together. MCP escalation additionally requires a separate, explicit user approval.

## Assignment demo fixture

`fixtures/assignment-demo/` holds the dedicated `ACC-007` Platinum customer, ERP renewal date (`2027-01-15`), usage CSV header, and the open P1 case opened at `2026-10-24T08:12:00Z`. These inputs produce a `31d 15h 48m` case age at the fixed as-of time. Non-question case fields are fixture scaffolding marked in `case.json`; they are not inferred from customer tier. The reported age and renewal date are calculated from the fixture values.

`npm run mcp:assignment-demo` uses the official MCP TypeScript SDK over stdio, makes real `search_cases` and `get_customer_summary` MCP calls, and uses an OpenAI-compatible chat-completions endpoint for tool selection and the final wording. The script restricts the API URL to localhost, omits PII/ARR/case text from model inputs, checks the exact 48-hour filters, and includes a not-found call for `ACC-999`. A live LLM run requires credentials and is not implied by the local unit tests.

## Local signed webhook receiver

The receiver verifies the HMAC over the exact raw body, rejects timestamps more than five minutes from current time, and stores event IDs in SQLite with a unique key. For a local end-to-end escalation demo:

1. Start the receiver in one PowerShell window:

   ```powershell
   $env:WEBHOOK_RECEIVER_SECRET = 'whsec_local_receiver_secret_2026'
   $env:WEBHOOK_RECEIVER_DATABASE_URL = 'file:./webhook-receiver-demo.db'
   npm run webhook:receiver
   ```

2. Start the API with the exact local callback URL allowlisted:

   ```powershell
   $env:WEBHOOK_ALLOWED_PRIVATE_TARGETS = 'http://127.0.0.1:4100/events'
   npm run start:dev
   ```

3. In a third window, register the receiver, escalate the seeded case, and dispatch its outbox delivery:

   ```powershell
   $secret = 'whsec_local_receiver_secret_2026'
   $token = Invoke-RestMethod http://localhost:3000/oauth/token `
     -Method Post -ContentType 'application/json' `
     -Body '{"grant_type":"client_credentials","client_id":"platform-admin-client","client_secret":"dev-secret-platform-admin"}'
   $headers = @{ Authorization = "Bearer $($token.access_token)" }
   $endpointHeaders = $headers.Clone()
   $endpointHeaders['Idempotency-Key'] = [guid]::NewGuid().ToString()
   $endpointBody = @{
     url = 'http://127.0.0.1:4100/events'
     subscribedEvents = @('case.escalated')
     signingSecret = $secret
   } | ConvertTo-Json
   Invoke-RestMethod http://localhost:3000/v1/webhooks/endpoints `
     -Method Post -Headers $endpointHeaders -ContentType 'application/json' -Body $endpointBody

   $case = Invoke-WebRequest http://localhost:3000/v1/cases/case_assignment_acc007_p1 -Headers $headers
   $escalationHeaders = $headers.Clone()
   $escalationHeaders['If-Match'] = $case.Headers.ETag
   $escalationHeaders['Idempotency-Key'] = [guid]::NewGuid().ToString()
   Invoke-RestMethod http://localhost:3000/v1/cases/case_assignment_acc007_p1/escalate `
     -Method Post -Headers $escalationHeaders

   $deliveries = Invoke-RestMethod http://localhost:3000/v1/webhooks/deliveries -Headers $headers
   $delivery = $deliveries.data | Where-Object eventType -eq 'case.escalated' | Select-Object -First 1
   Invoke-RestMethod "http://localhost:3000/v1/webhooks/deliveries/$($delivery.id)/dispatch" `
     -Method Post -Headers $headers
   ```

   The receiver returns `duplicate: false` for first delivery and `duplicate: true` for a repeated event ID.

The private-target exception is exact-URL scoped and intended only for local demonstrations. Do not configure broad private-network allowlists.

## Postman checks

The exported collection runs sequentially, syncs the assignment fixture, creates a P1 case plus a comment, updates it, then escalates it in the selected database. It checks:

- Public health and OAuth token issuance.
- Fixture sync and customer aggregation.
- ARR read/write scope enforcement.
- Filtered case search.
- Platinum renewal and assignment case search.
- Comment idempotency replay.
- Successful and stale ETag updates and explicit escalation.
- Rejection of a write from a read-only token.

Use a disposable local/demo database. The collection does not dispatch outbound webhooks because it does not provision a callback receiver.

## Configuration and security

See `.env.example` for local runtime settings and [SECURITY.md](./SECURITY.md) for implemented controls and operational limits. In particular, demo OAuth credentials and the Compose fallback signing secret are not production secrets. Outbound webhook URLs require trusted configuration and network egress controls.

## Evaluation records

- [TESTEVALS.md](./TESTEVALS.md): command results and test coverage.
- [SECURITY.md](./SECURITY.md): security controls and known risks.
- [DECISIONS.md](./DECISIONS.md): implementation choices.
- [AI_USAGE.md](./AI_USAGE.md): AI assistance and verification disclosure.
- [REQUIREMENT_TRACEABILITY.md](./REQUIREMENT_TRACEABILITY.md): status for requested deliverables and known gaps.
