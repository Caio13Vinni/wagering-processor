/**
 * Setup compartilhado dos testes de integração — PostgreSQL REAL.
 * Pré-requisito: docker compose up -d --wait postgres
 *
 * IMPORTANTE: cada teste/arquivo deve usar SEU PRÓPRIO em.fork().
 * Compartilhar um fork faz entidades "pendentes" de transações abortadas
 * ou concorrentes vazarem para o flush de um teste unrelated (UoW compartilhado).
 */
import { Logger } from '@nestjs/common';
Logger.overrideLogger(['error']); // silencia INFO/WARN do Nest nos testes

import { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import config from '../../src/config/mikro-orm.config';

export const orm = await MikroORM.init(config);

/** Fork isolado para cada teste/arquivo. */
export const forkEm = (): EntityManager => orm.em.fork();

/** runId único por execução — testes não colidem entre si nem com re-runs. */
export const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** CADA teste deve gerar seu próprio player — wallets são únicas por player+currency. */
export const newPlayer = (): string => crypto.randomUUID();

export function money(amount: string) {
  return { amount, currency: 'BRL' as const };
}
