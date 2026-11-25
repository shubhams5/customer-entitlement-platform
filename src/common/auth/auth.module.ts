import { Body, Controller, HttpCode, HttpStatus, Injectable, Module, Post } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { timingSafeEqual } from 'crypto';
import { Problems } from '../errors/problem-details.exception';
import { Public } from './auth.decorators';
import { ALL_OAUTH_SCOPES, OAuthScope, signHs256Jwt } from './jwt.util';

interface OAuthClientRecord {
  clientId: string;
  clientSecret: string;
  allowedScopes: readonly OAuthScope[];
}

const REGISTERED_CLIENTS: readonly OAuthClientRecord[] = [
  {
    clientId: 'platform-admin-client',
    clientSecret: 'dev-secret-platform-admin',
    allowedScopes: ALL_OAUTH_SCOPES,
  },
  {
    clientId: 'support-agent-client',
    clientSecret: 'dev-secret-support-agent',
    allowedScopes: [
      'customers:read',
      'entitlements:read',
      'usage:read',
      'cases:read',
      'cases:write',
    ],
  },
  {
    clientId: 'finance-analyst-client',
    clientSecret: 'dev-secret-finance-analyst',
    allowedScopes: ['customers:read', 'customers:arr:read', 'entitlements:read', 'usage:read'],
  },
  {
    clientId: 'readonly-auditor-client',
    clientSecret: 'dev-secret-readonly-auditor',
    allowedScopes: ['customers:read', 'entitlements:read', 'usage:read', 'cases:read', 'audit:read'],
  },
];

export class TokenRequestDto {
  @IsString()
  @IsIn(['client_credentials'])
  grant_type: 'client_credentials';

  @IsString()
  @MinLength(3)
  client_id: string;

  @IsString()
  @MinLength(6)
  client_secret: string;

  @IsOptional()
  @IsString()
  scope?: string;
}

@Injectable()
export class AuthService {
  issueToken(dto: TokenRequestDto) {
    const client = REGISTERED_CLIENTS.find((c) => c.clientId === dto.client_id);
    if (!client || !this.safeCompare(client.clientSecret, dto.client_secret)) {
      throw Problems.unauthorized(
        'Invalid OAuth client_id or client_secret.',
        'INVALID_CLIENT_CREDENTIALS',
      );
    }

    let scopesToGrant: string[];
    if (dto.scope && dto.scope.trim().length > 0) {
      const requested = dto.scope.trim().split(/\s+/).filter(Boolean);
      const disallowed = requested.filter(
        (s) => !client.allowedScopes.includes(s as OAuthScope),
      );
      if (disallowed.length > 0) {
        throw Problems.badRequest(
          `Client '${client.clientId}' is not permitted to request scope(s): ${disallowed.join(', ')}.`,
          'INVALID_SCOPE',
        );
      }
      scopesToGrant = requested;
    } else {
      scopesToGrant = [...client.allowedScopes];
    }

    const signed = signHs256Jwt({
      sub: client.clientId,
      scopes: scopesToGrant,
      expiresInSeconds: 3600,
    });

    return {
      access_token: signed.token,
      token_type: 'Bearer' as const,
      expires_in: signed.expiresIn,
      scope: signed.scope,
    };
  }

  private safeCompare(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) {
      return false;
    }
    return timingSafeEqual(bufA, bufB);
  }
}

@Controller('oauth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('token')
  @HttpCode(HttpStatus.OK)
  issueToken(@Body() dto: TokenRequestDto) {
    return this.authService.issueToken(dto);
  }
}

@Module({
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
