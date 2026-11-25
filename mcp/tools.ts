import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { NestApiClient, NestApiError, ApiTransportError } from './api-client';
import { ApprovalStore } from './approval-store';
import type { DelegatedIdentity } from './identity';
import { requireDelegatedScope } from './identity';

const caseStatuses = [
  'OPEN',
  'IN_PROGRESS',
  'WAITING_CUSTOMER',
  'ESCALATED',
  'RESOLVED',
  'CLOSED',
] as const;
const caseSeverities = ['P1', 'P2', 'P3', 'P4'] as const;
const caseSorts = [
  'createdAt',
  '-createdAt',
  'updatedAt',
  '-updatedAt',
  'slaResponseDueAt',
  '-slaResponseDueAt',
  'severity',
  '-severity',
] as const;

const searchInput = z.object({
  accountId: z.string().regex(/^(?:acct_[A-Za-z0-9_-]{6,64}|ACC-\d{3})$/).optional(),
  status: z.enum(caseStatuses).optional(),
  severity: z.enum(caseSeverities).optional(),
  assigneeId: z.string().min(1).max(100).optional(),
  q: z.string().max(200).optional(),
  createdAfter: z.iso.datetime().optional(),
  createdBefore: z.iso.datetime().optional(),
  sort: z.enum(caseSorts).default('-createdAt'),
  cursor: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(25).default(10),
}).strict();

const searchOutput = z.object({
  cases: z.array(z.object({
    id: z.string(),
    caseNumber: z.string(),
    accountId: z.string(),
    status: z.enum(caseStatuses),
    severity: z.enum(caseSeverities),
    version: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    slaResponseDueAt: z.iso.datetime(),
  }).strict()).max(25),
  nextCursor: z.string().max(512).nullable(),
  hasMore: z.boolean(),
}).strict();

const customerInput = z.object({
  accountId: z.string().regex(/^(?:acct_[A-Za-z0-9_-]{6,64}|ACC-\d{3})$/),
}).strict();

const customerOutput = z.object({
  accountId: z.string(),
  status: z.enum(['ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CHURNED']),
  tier: z.enum(['STARTER', 'BUSINESS', 'ENTERPRISE', 'Platinum']),
  version: z.number().int().positive(),
  entitlementCount: z.number().int().nonnegative().nullable(),
  entitlementRenewals: z.array(z.object({
    featureCode: z.string(),
    renewalDate: z.iso.datetime(),
  }).strict()).max(100).nullable(),
  usageMetricCount: z.number().int().nonnegative().nullable(),
  usageMetrics: z.array(z.object({
    metricCode: z.string(),
    totalQuantity: z.number().int().nonnegative(),
    eventCount: z.number().int().nonnegative(),
    quotaLimit: z.number().int().nonnegative().nullable(),
    remainingQuota: z.number().int().nonnegative().nullable(),
    overQuota: z.boolean(),
  }).strict()).max(100).nullable(),
  caseCount: z.number().int().nonnegative().nullable(),
  partialSections: z.array(z.enum(['entitlements', 'usage', 'cases'])).max(3),
  generatedAt: z.iso.datetime(),
}).strict();

const commentInput = z.object({
  caseId: z.string().min(1).max(128),
  body: z.string().min(1).max(5000),
}).strict();

const commentOutput = z.object({
  commentId: z.string(),
  caseId: z.string(),
  createdAt: z.iso.datetime(),
}).strict();

const escalateInput = z.object({
  caseId: z.string().min(1).max(128),
  expectedVersion: z.number().int().positive(),
  approvalToken: z.string().min(40).max(64).optional(),
}).strict();

const escalationOutput = z.object({
  decision: z.enum(['approved', 'declined', 'escalated']),
  caseId: z.string(),
  expectedVersion: z.number().int().positive().optional(),
  approvalToken: z.string().optional(),
  expiresAt: z.iso.datetime().optional(),
  status: z.literal('ESCALATED').optional(),
  version: z.number().int().positive().optional(),
  escalatedAt: z.iso.datetime().optional(),
}).strict().superRefine((value, context) => {
  const expectedKeys = value.decision === 'approved'
    ? ['decision', 'caseId', 'expectedVersion', 'approvalToken', 'expiresAt']
    : value.decision === 'declined'
      ? ['decision', 'caseId', 'expectedVersion']
      : ['decision', 'caseId', 'status', 'version', 'escalatedAt'];
  for (const key of expectedKeys) {
    if (!(key in value)) context.addIssue({ code: 'custom', message: `Missing ${key}.`, path: [key] });
  }
  for (const key of Object.keys(value)) {
    if (!expectedKeys.includes(key)) context.addIssue({ code: 'custom', message: `Unexpected ${key}.`, path: [key] });
  }
});

export interface McpAuditEvent {
  timestamp: string;
  event: string;
  tool: string;
  actorId: string;
  actorFingerprint: string;
  correlationId: string;
  resourceId?: string;
  outcome?: 'success' | 'denied' | 'failure';
  errorCode?: string;
}

export type McpAuditSink = (event: McpAuditEvent) => void;

interface ToolDependencies {
  api: NestApiClient;
  identity: DelegatedIdentity;
  approvals: ApprovalStore;
  audit: McpAuditSink;
}

export function registerPlatformTools(server: McpServer, dependencies: ToolDependencies): void {
  const { api, identity, approvals, audit } = dependencies;

  server.registerTool('search_cases', {
    title: 'Search support cases',
    description: 'Search cases by filters. Returns only allowlisted metadata; case text and requester details are never returned.',
    inputSchema: searchInput,
    outputSchema: searchOutput,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (input) => audited('search_cases', identity, audit, async (correlationId) => {
    requireDelegatedScope(identity, 'cases:read');
    const params = new URLSearchParams({
      limit: String(input.limit),
      sort: input.sort,
    });
    for (const key of ['accountId', 'status', 'severity', 'assigneeId', 'q', 'createdAfter', 'createdBefore', 'cursor'] as const) {
      const value = input[key];
      if (value !== undefined) params.set(key, value);
    }
    const response = z.object({
      data: z.array(z.object({
        id: z.string(),
        caseNumber: z.string(),
        accountId: z.string(),
        status: z.enum(caseStatuses),
        severity: z.enum(caseSeverities),
        version: z.number().int().positive(),
        createdAt: z.iso.datetime(),
        slaResponseDueAt: z.iso.datetime(),
      })).max(25),
      page: z.object({
        nextCursor: z.string().max(512).nullable(),
        hasMore: z.boolean(),
      }),
    }).passthrough().parse(await api.getJson(`/v1/cases?${params}`, correlationId));
    return {
      cases: response.data.map(({ id, caseNumber, accountId, status, severity, version, createdAt, slaResponseDueAt }) => ({
        id,
        caseNumber,
        accountId,
        status,
        severity,
        version,
        createdAt,
        slaResponseDueAt,
      })),
      nextCursor: response.page.nextCursor,
      hasMore: response.page.hasMore,
    };
  }));

  server.registerTool('get_customer_summary', {
    title: 'Get customer summary',
    description: 'Get customer status, renewal dates, and compact usage metrics. ARR, email, names, entitlement details beyond feature and renewal date, and case text are never returned.',
    inputSchema: customerInput,
    outputSchema: customerOutput,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (input) => audited('get_customer_summary', identity, audit, async (correlationId) => {
    requireDelegatedScope(identity, 'customers:read');
    const response = z.object({
      accountId: z.string(),
      status: z.enum(['ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CHURNED']),
      tier: z.enum(['STARTER', 'BUSINESS', 'ENTERPRISE', 'Platinum']),
      version: z.number().int().positive(),
      entitlements: z.array(z.object({
        featureCode: z.string(),
        effectiveTo: z.iso.datetime().nullable(),
      }).passthrough()).max(100).nullable(),
      usage: z.object({
        metrics: z.array(z.object({
          metricCode: z.string(),
          totalQuantity: z.number().int().nonnegative(),
          eventCount: z.number().int().nonnegative(),
          quotaLimit: z.number().int().nonnegative().nullable(),
          remainingQuota: z.number().int().nonnegative().nullable(),
          overQuota: z.boolean(),
        }).passthrough()).max(100),
      }).passthrough().nullable(),
      cases: z.array(z.unknown()).nullable(),
      generatedAt: z.iso.datetime(),
      partialFailures: z.array(z.object({
        section: z.enum(['entitlements', 'usage', 'cases']),
        code: z.enum(['SECTION_UNAVAILABLE', 'SECTION_FORBIDDEN']),
      }).passthrough()),
    }).passthrough().parse(await api.getJson(`/v1/customers/${encodeURIComponent(input.accountId)}`, correlationId));
    return {
      accountId: response.accountId,
      status: response.status,
      tier: response.tier,
      version: response.version,
      entitlementCount: response.entitlements?.length ?? null,
      entitlementRenewals: response.entitlements
        ?.flatMap(({ featureCode, effectiveTo }) => effectiveTo
          ? [{ featureCode, renewalDate: effectiveTo }]
          : []) ?? null,
      usageMetricCount: response.usage?.metrics.length ?? null,
      usageMetrics: response.usage?.metrics ?? null,
      caseCount: response.cases?.length ?? null,
      partialSections: response.partialFailures.map(({ section }) => section),
      generatedAt: response.generatedAt,
    };
  }));

  server.registerTool('add_case_comment', {
    title: 'Add case comment',
    description: 'Add a non-internal comment. The comment body is treated as untrusted data and is never returned or logged.',
    inputSchema: commentInput,
    outputSchema: commentOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (input) => audited('add_case_comment', identity, audit, async (correlationId) => {
    requireDelegatedScope(identity, 'cases:write');
    const response = z.object({
      id: z.string(),
      caseId: z.string(),
      createdAt: z.iso.datetime(),
    }).passthrough().parse(await api.postIdempotentJson(
      `/v1/cases/${encodeURIComponent(input.caseId)}/comments`,
      { authorId: identity.actorId, authorRole: 'AGENT', body: input.body, isInternal: false },
      randomUUID(),
      correlationId,
    ));
    return { commentId: response.id, caseId: response.caseId, createdAt: response.createdAt };
  }));

  server.registerTool('escalate_case', {
    title: 'Escalate support case',
    description: 'Requires explicit human approval. First call requests approval and returns a user-bound, single-use token; call again with that token to escalate.',
    inputSchema: escalateInput,
    outputSchema: escalationOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (input, extra) => audited('escalate_case', identity, audit, async (correlationId) => {
    requireDelegatedScope(identity, 'cases:write');
    if (!input.approvalToken) {
      const approval = await extra.sendRequest(
        {
          method: 'elicitation/create',
          params: {
            mode: 'form',
            message: `Approve escalating case ${input.caseId} at version ${input.expectedVersion}?`,
            requestedSchema: {
              type: 'object',
              properties: {
                approved: { type: 'boolean', title: 'Approve escalation' },
              },
              required: ['approved'],
            },
          },
        },
        ElicitResultSchema,
        { timeout: 30_000 },
      );
      if (approval.action !== 'accept' || approval.content?.approved !== true) {
        return { decision: 'declined', caseId: input.caseId, expectedVersion: input.expectedVersion };
      }
      const grant = approvals.issue(identity, input.caseId, input.expectedVersion);
      audit({
        timestamp: new Date().toISOString(),
        event: 'escalation.approval_granted',
        tool: 'escalate_case',
        actorId: identity.actorId,
        actorFingerprint: identity.fingerprint,
        correlationId,
        resourceId: input.caseId,
      });
      return {
        decision: 'approved',
        caseId: input.caseId,
        expectedVersion: input.expectedVersion,
        approvalToken: grant.token,
        expiresAt: grant.expiresAt,
      };
    }

    approvals.consume(input.approvalToken, identity, input.caseId, input.expectedVersion);
    const response = z.object({
      id: z.string(),
      status: z.literal('ESCALATED'),
      version: z.number().int().positive(),
      escalatedAt: z.iso.datetime(),
    }).passthrough().parse(await api.postIdempotentJson(
      `/v1/cases/${encodeURIComponent(input.caseId)}/escalate`,
      undefined,
      randomUUID(),
      correlationId,
      `"v${input.expectedVersion}"`,
    ));
    return {
      decision: 'escalated',
      caseId: response.id,
      status: response.status,
      version: response.version,
      escalatedAt: response.escalatedAt,
    };
  }));
}

async function audited<T extends Record<string, unknown>>(
  tool: string,
  identity: DelegatedIdentity,
  sink: McpAuditSink,
  operation: (correlationId: string) => Promise<T>,
) {
  const correlationId = randomUUID();
  const base = {
    timestamp: new Date().toISOString(),
    tool,
    actorId: identity.actorId,
    actorFingerprint: identity.fingerprint,
    correlationId,
  };
  sink({ ...base, event: 'tool.started' });
  try {
    const output = await operation(correlationId);
    const result = JSON.stringify(output);
    if (Buffer.byteLength(result, 'utf8') > 32_768) {
      throw new Error('MCP tool output exceeded its size limit.');
    }
    sink({ ...base, timestamp: new Date().toISOString(), event: 'tool.completed', outcome: 'success' });
    return { content: [{ type: 'text' as const, text: result }], structuredContent: output };
  } catch (error) {
    const code = errorCode(error);
    sink({
      ...base,
      timestamp: new Date().toISOString(),
      event: 'tool.failed',
      outcome: error instanceof Error && error.message.startsWith('Missing required scope:') ? 'denied' : 'failure',
      errorCode: code,
    });
    return {
      content: [{ type: 'text' as const, text: safeErrorMessage(error) }],
      isError: true,
    };
  }
}

function errorCode(error: unknown): string {
  if (error instanceof NestApiError) return error.code;
  if (error instanceof ApiTransportError) return error.code;
  if (error instanceof Error && error.message.startsWith('Missing required scope:')) return 'INSUFFICIENT_SCOPE';
  if (error instanceof Error && error.message.startsWith('Approval token')) return 'APPROVAL_INVALID';
  if (error instanceof Error && error.message.includes('output exceeded')) return 'OUTPUT_LIMIT';
  return 'MCP_TOOL_FAILED';
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof NestApiError) return `NestJS API request failed (${error.status}, ${error.code}).`;
  if (error instanceof ApiTransportError) return `NestJS API request failed (${error.code}).`;
  if (error instanceof Error && error.message.startsWith('Missing required scope:')) return error.message;
  if (error instanceof Error && error.message.startsWith('Approval token')) return error.message;
  if (error instanceof Error && error.message.includes('output exceeded')) return 'MCP tool output exceeded its size limit.';
  return 'MCP tool request failed; check the audit log.';
}
