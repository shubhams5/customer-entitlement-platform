# Customer Entitlement MCP server

The MCP server runs as a separate stdio process and forwards the user's unchanged bearer token to the NestJS API. The API remains authoritative for signature validation and scopes. MCP decodes only the JWT subject and scope claims for request context and early denial; it does not trust them instead of API authorization.

## Run the demo

Start the NestJS API, then set a delegated OAuth access token and run:

```powershell
$env:NEST_API_BASE_URL = "http://127.0.0.1:3000"
$env:NEST_API_TOKEN = "<user's OAuth access token>"
npm.cmd run mcp:demo
```

Configure your MCP client to launch `npm.cmd run mcp:demo`, with `NEST_API_BASE_URL` and `NEST_API_TOKEN` supplied through its secure environment-injection mechanism. The server uses stdout only for MCP stdio messages; structured audit events go to stderr. Do not commit access tokens to source control.

The tools are `search_cases`, `get_customer_summary`, `add_case_comment`, and `escalate_case`. Search and summary return allowlisted metadata/counts only. Comment bodies, case text, requester PII, and ARR are not returned. Escalation requires two calls: the first requests explicit MCP elicitation approval and returns a user-bound token valid for 60 seconds; the second consumes that single-use token and submits the version-checked PATCH. The MCP client must support form elicitation; unsupported or declined elicitation fails closed.
