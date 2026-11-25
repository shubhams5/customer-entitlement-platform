import { startMcpServer } from './server';

startMcpServer().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'MCP server startup failed.';
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    event: 'mcp.server.start_failed',
    error: message,
  })}\n`);
  process.exitCode = 1;
});
