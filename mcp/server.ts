import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { NestApiClient } from './api-client';
import { ApprovalStore } from './approval-store';
import { delegatedIdentityFromToken } from './identity';
import { registerPlatformTools, type McpAuditEvent, type McpAuditSink } from './tools';

export function createPlatformMcpServer(options: {
  api: NestApiClient;
  identity: ReturnType<typeof delegatedIdentityFromToken>;
  audit?: McpAuditSink;
}) {
  const server = new McpServer(
    { name: 'customer-entitlement-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  registerPlatformTools(server, {
    api: options.api,
    identity: options.identity,
    approvals: new ApprovalStore(),
    audit: options.audit ?? writeAuditEvent,
  });
  return server;
}

export async function startMcpServer(): Promise<void> {
  const baseUrl = process.env.NEST_API_BASE_URL;
  const token = process.env.NEST_API_TOKEN;
  if (!baseUrl || !token) {
    throw new Error('Set NEST_API_BASE_URL and NEST_API_TOKEN to start the MCP server.');
  }
  const identity = delegatedIdentityFromToken(token);
  const server = createPlatformMcpServer({
    api: new NestApiClient(baseUrl, token),
    identity,
  });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    event: 'mcp.server.started',
    actorId: identity.actorId,
    actorFingerprint: identity.fingerprint,
  })}\n`);
}

function writeAuditEvent(event: McpAuditEvent): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}
