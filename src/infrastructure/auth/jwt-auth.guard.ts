import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from '../../config/env';

/**
 * Ponto de extensão de autenticação (seção 2 do desafio).
 * Valida JWT RS256 via JWKS do Keycloak (OIDC). Ativado com AUTH_ENABLED=true.
 *
 * Nota Keycloak: o access token carrega aud="account" por padrão; o client fica
 * em `azp` (authorized party). Validamos issuer + azp — padrão para client público.
 * (Alternativa de produção: audience mapper no client scope do Keycloak.)
 * Health e metrics permanecem abertos por requisito do desafio.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly jwks = createRemoteJWKSet(
    new URL(`${env.auth.issuerUrl}/protocol/openid-connect/certs`),
  );

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const path: string = (req.url ?? '').split('?')[0];

    // health/readiness e metrics ficam abertos (requisito)
    if (path.startsWith('/health') || path.startsWith('/metrics')) {
      return true;
    }

    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('missing Bearer token');
    }

    try {
      const { payload } = await jwtVerify(header.slice(7), this.jwks, {
        issuer: env.auth.issuerUrl,
      });
      // audience via azp (padrão Keycloak para client público)
      if (payload.azp !== env.auth.audience) {
        throw new UnauthorizedException('token not issued for this audience');
      }
      req.user = { sub: payload.sub, realm: payload.iss };
      return true;
    } catch (e) {
      if (e instanceof UnauthorizedException) throw e;
      throw new UnauthorizedException('invalid or expired token');
    }
  }
}