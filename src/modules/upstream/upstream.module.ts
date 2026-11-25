import { Global, Injectable, Module } from '@nestjs/common';
import { resolve, sep } from 'path';
import { AppConfig } from '../../common/config/app-config';
import { ResilientHttpClient } from '../../common/resilience/http-client';
import {
  FileCrmAdapter,
  FileErpAdapter,
  FileUsageFeedAdapter,
  HttpCrmAdapter,
  HttpErpAdapter,
  HttpUsageFeedAdapter,
} from './upstream-adapters';
import { UpstreamAdapters } from './upstream.types';

export class FixturesPathError extends Error {}

/**
 * Resolves a caller-supplied fixtures directory and refuses anything that
 * escapes the project root (path traversal).
 */
export function resolveFixturesDirectory(relativeDir: string, projectRoot = process.cwd()): string {
  const root = resolve(projectRoot);
  const target = resolve(root, relativeDir);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new FixturesPathError('fixturesDir must resolve within the repository root.');
  }
  return target;
}

/**
 * Chooses CRM / ERP / usage-feed implementations. Each upstream uses its HTTP
 * adapter when a base URL is configured, otherwise the bundled fixture file.
 */
@Injectable()
export class UpstreamRegistry {
  private readonly defaults: UpstreamAdapters;

  constructor(
    private readonly config: AppConfig,
    readonly http: ResilientHttpClient,
  ) {
    const dir = resolveFixturesDirectory(config.fixturesDir);
    const { crmBaseUrl, erpBaseUrl, usageBaseUrl, policy } = config.upstream;
    this.defaults = {
      crm: crmBaseUrl ? new HttpCrmAdapter(crmBaseUrl, http, policy) : new FileCrmAdapter(dir),
      erp: erpBaseUrl ? new HttpErpAdapter(erpBaseUrl, http, policy) : new FileErpAdapter(dir),
      usage: usageBaseUrl
        ? new HttpUsageFeedAdapter(usageBaseUrl, http, policy)
        : new FileUsageFeedAdapter(dir),
    };
  }

  get default(): UpstreamAdapters {
    return this.defaults;
  }

  fromFixturesDirectory(absoluteDir: string): UpstreamAdapters {
    return {
      crm: new FileCrmAdapter(absoluteDir),
      erp: new FileErpAdapter(absoluteDir),
      usage: new FileUsageFeedAdapter(absoluteDir),
    };
  }
}

@Global()
@Module({
  providers: [ResilientHttpClient, UpstreamRegistry],
  exports: [ResilientHttpClient, UpstreamRegistry],
})
export class UpstreamModule {}
