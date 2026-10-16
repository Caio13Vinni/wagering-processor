import { Controller, Get, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { ListQueuesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { env } from '../../config/env';

@Controller('health')
export class HealthController {
  private readonly sqs = new SQSClient({
    endpoint: env.sqs.endpoint,
    region: env.sqs.region,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });

  constructor(private readonly em: EntityManager) {}

  /** Liveness: processo vivo — sem dependências externas, sempre aberto. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL e SQS alcançáveis — sem autenticação. */
  @Get('ready')
  async ready() {
    const checks: Record<string, 'up' | 'down'> = {};

    try {
      await this.em.getConnection().execute('select 1');
      checks.database = 'up';
    } catch {
      checks.database = 'down';
    }

    try {
      await this.sqs.send(new ListQueuesCommand({}));
      checks.sqs = 'up';
    } catch {
      checks.sqs = 'down';
    }

    const ok = Object.values(checks).every((c) => c === 'up');
    if (!ok) {
      throw new ServiceUnavailableException({ status: 'unavailable', checks });
    }
    return { status: 'ready', checks };
  }
}