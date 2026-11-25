# AI Usage Disclosure

AI assistance was used to inspect and modify the existing API, MCP server, webhook delivery, fixtures, tests, and submission documentation. Changes were kept within the requested assignment work; no independent human review is claimed.

## Verification actually performed

- `npm.cmd run test:all` passed after the latest code changes: type-check, 11 unit suites / 37 tests, and 8 E2E tests.
- `npm.cmd run build` passed.
- Prisma migrations and seed ran against a disposable SQLite database. Standard fixture counts and the assignment fixture/case ID are recorded in `TESTEVALS.md`.
- The current production dependency audit found one moderate `csv-parse` advisory and no critical/high findings.
- The updated Postman collection/environment parse as JSON; the current collection was not run because Newman is unavailable.

The test outputs, exact limits, and blocked validation are recorded in `TESTEVALS.md` and `REQUIREMENT_TRACEABILITY.md`. No results were inferred from static inspection.

## Not executed

- Docker/Compose build, startup, migration/seed orchestration, and test profile; Docker is unavailable.
- Live MCP + LLM assignment demo; no `OPENAI_API_KEY` is present. The runnable script is implemented but has no live tool-call transcript or model result to report.
- Newman execution of the current 19-request collection or Postman desktop import.
- Live CRM, ERP, usage, or external webhook subscriber integration.

The local demo OAuth credentials and signing secrets are evaluation-only. Do not use them in a deployed environment.
