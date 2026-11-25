# Test Evaluation

Results below were produced in this workspace; they are not production certification.

## Verified

| Command/check | Result |
|---|---|
| `npm.cmd run test:all` | Passed type-check, 11 unit suites / 37 tests, and 1 E2E suite / 8 tests. |
| `npm.cmd run build` | Passed. |
| `npm.cmd run prisma:generate` | Passed with Prisma Client 6.19.3. |
| `npm.cmd run prisma:deploy` with `DATABASE_URL=file:./assignment-smoke.db` | Both migrations applied to a disposable database. Prisma emitted its existing Driver Adapter datasource-URL warning. |
| `npm.cmd run db:seed` with a disposable database | Passed twice against the same migrated database: standard fixtures processed 4 customers, 11 entitlements, 8 usage events; assignment fixture processed 1 customer, 1 entitlement, 0 usage events, and seeded `case_assignment_acc007_p1`. The disposable database and SQLite sidecars were removed. |
| `npm.cmd audit --omit=dev` | No critical/high production findings. One moderate `csv-parse` advisory remains (`<7.0.2`); the suggested fixed version is a breaking major upgrade. Command exits 1 because of that advisory. |
| Postman JSON parse | Collection and environment parsed; collection contains 19 sequential requests. |

The suite covers authorization and ARR policies, case filtering and cursor paging, ETags, idempotency including concurrent comments, upstream retry/circuit-breaker/partial-failure behavior, webhook signatures and delivery replay, SSRF destination checks, local receiver signature/timestamp/deduplication, MCP delegation/redaction/output bounds, escalation approval, assignment fixture consistency, and the deterministic 48-hour/90-day boundaries.

## Not verified here

- `newman` is not installed, so the modified 19-request Postman collection was not run. An earlier 15-request collection result does not verify this updated export.
- `docker` is unavailable. `docker compose up --build`, Compose migration/seed ordering, and the Compose test profile remain unverified. YAML or JSON parsing is not equivalent to running Compose.
- `OPENAI_API_KEY` is absent, so the real-LLM MCP assignment demo was not run. Its script and deterministic evaluation tests are present.
- No external CRM, ERP, usage provider, or production webhook subscriber was contacted.
- The Postman desktop app was not used.

## Manual commands for blocked checks

With Docker Engine and Compose v2:

```powershell
docker compose up --build
docker compose --profile test run --rm test
```

With the API and local assignment fixture running, a delegated read token, and an explicit provider key:

```powershell
$env:NEST_API_BASE_URL = 'http://localhost:3000'
$env:NEST_API_TOKEN = '<delegated bearer token with cases:read customers:read entitlements:read usage:read>'
$env:OPENAI_API_KEY = '<provider key>'
npm run mcp:assignment-demo
```

To run the current collection, install/use Newman separately and point it at `postman/local.postman_environment.json` against a disposable API database.
