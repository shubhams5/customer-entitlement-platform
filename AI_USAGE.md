# AI Usage Disclosure

AI assistance was used throughout implementation and submission preparation.

## Assistance provided

- Implemented and modified REST API, upstream resilience, persistence, webhook delivery, and MCP server code in response to the user-provided requirements.
- Added and adjusted unit, contract, MCP, and end-to-end tests, including concurrency, authorization, timeout, circuit-breaker, and webhook replay cases.
- Prepared Docker/Compose configuration, Postman collection/environment, and project documentation in this session.
- Reviewed existing repository code and test output to document current behavior and limitations.

## Verification actually performed

After a clean `npm ci`, `npm run test:all` passed type-checking, 8 Jest suites / 22 tests, and 8 E2E tests. `npm run build`, Prisma client generation, migrations, fixture seeding, and local API health checks passed. Newman ran all 15 Postman requests with 15 assertions and no failures. The MCP OAuth bootstrap was smoke-tested against the local API. The final command results and limitations are recorded in `REQUIREMENT_TRACEABILITY.md` and `TESTEVALS.md`.

No human independent code review, external security assessment, or production deployment is claimed. No live external upstream systems were exercised.

## Validation limitations

The preparation environment did not have Docker, Docker Compose, Podman, or the Postman desktop app. Newman was run through `npx`. Therefore:

- `docker compose up --build` and the Compose migration/seed/test services could not be executed here.
- The Postman collection was executed with Newman, but not imported into the Postman desktop app.
- Any result for those items is marked unverified, not successful.

The Compose setup uses the repository's local demo OAuth clients. These are evaluation credentials only and must be replaced for deployment.
