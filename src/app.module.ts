import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from './common/auth/auth.module';
import { OAuthScopeGuard } from './common/auth/oauth-scope.guard';
import { AppConfigModule } from './common/config/app-config';
import { HealthController } from './common/health/health.controller';
import { RequestContextInterceptor } from './common/logging/request-context.interceptor';
import { PrismaModule } from './common/prisma/prisma.module';
import { AuditModule } from './modules/audit/audit.module';
import { CasesModule } from './modules/cases/cases.module';
import { CustomerModule } from './modules/customer/customer.module';
import { EntitlementModule } from './modules/entitlement/entitlement.module';
import {
  IdempotencyInterceptor,
  IdempotencyModule,
} from './modules/idempotency/idempotency.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { UpstreamModule } from './modules/upstream/upstream.module';
import { UsageModule } from './modules/usage/usage.module';
import { WebhookModule } from './modules/webhook/webhook.module';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    AuthModule,
    AuditModule,
    IdempotencyModule,
    WebhookModule,
    CustomerModule,
    EntitlementModule,
    UsageModule,
    CasesModule,
    UpstreamModule,
    IntegrationsModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: OAuthScopeGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestContextInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyInterceptor,
    },
  ],
})
export class AppModule {}
