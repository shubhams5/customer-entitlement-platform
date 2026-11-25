# Customer Entitlement & Support Case Platform

NestJS/Fastify REST API with Prisma/SQLite persistence and a separate MCP stdio server. The Compose stack starts the API, runs migrations and fixture seeding first, then starts MCP. Demo OAuth credentials are hard-coded for local evaluation only; replace them before any non-demo deployment.

## Under-five-minute demo

The interactive walkthrough is designed to take under five minutes after the stack is ready; the first image build may take longer.

Prerequisites: Docker Engine and Docker Compose v2.

1. Start everything (first build may take a few minutes):

   ```powershell
   docker compose up --build
   ```

   The one-shot `db-init` container applies migrations and upserts the checked-in JSON/XML/CSV fixtures before the API becomes healthy. MCP starts after API health succeeds.

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

4. Import `postman/customer-entitlement-platform.postman_collection.json` and `postman/local.postman_environment.json` into Postman, select the local environment, then run the collection for authorization, ARR-redaction, idempotency, case search, and ETag regression checks.

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

`docker compose run` starts a dedicated MCP process and obtains its short-lived bearer token from the API. The Compose default client is a demo account with only `customers:read`, `cases:read`, and `cases:write`.

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

Replace `OAUTH_JWT_SECRET` in `.env` before non-demo use. Fixture sync is safe to repeat and updates existing fixture-backed rows.

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

## Postman checks

The exported collection runs sequentially and creates a P1 case plus a comment in the selected database. It checks:

- Public health and OAuth token issuance.
- Fixture sync and customer aggregation.
- ARR read/write scope enforcement.
- Filtered case search.
- Comment idempotency replay.
- Successful and stale ETag updates.
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
