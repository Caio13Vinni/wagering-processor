import { Injectable, Logger } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { WalletEntity } from '../domain/wallet/wallet.entity';
import { WagerTransactionEntity } from '../domain/transaction/wager-transaction.entity';
import { WalletLedgerEntryEntity } from '../domain/ledger/ledger-entry.entity';
import { OutboxMessageEntity } from '../domain/outbox/outbox-message.entity';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
  WalletBalanceChanged,
} from '../domain/outbox/events';
import { Money } from '../domain/money/money';
import { LedgerDirection } from '../domain/ledger/ledger-entry';
import { FailureCode } from '../domain/transaction/failure-codes';
import { hashWagerPayload, WagerPayload } from '../infrastructure/payload-hash';

export interface SubmitInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export interface Source {
  channel: 'http' | 'sqs';
  messageId?: string;
  consumerName?: string;
}

export interface SubmitResult {
  transactionId: string;
  status: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE';
  failureCode?: string;
  balance?: { amount: string; currency: string };
  idempotentReplay: boolean;
}

@Injectable()
export class SubmitWagerTransactionUseCase {
  private readonly logger = new Logger(SubmitWagerTransactionUseCase.name);

  constructor(private readonly em: EntityManager) {}

  async execute(
    dto: SubmitInput,
    idempotencyKey: string,
    source: Source,
  ): Promise<SubmitResult> {
    const correlationId = randomUUID();
    const payloadHash = hashWagerPayload({ ...dto });

    try {
      return await this.em.transactional(async (em) => {
        // ---- 1. Inbox dedup (somente SQS): insert atômico, RETURNING detecta duplicata ----
        if (source.channel === 'sqs' && source.messageId) {
          const rows = (await em.getConnection().execute(
            `insert into inbox_messages (message_id, consumer_name, payload_hash, received_at)
             values (?, ?, ?, now())
             on conflict (consumer_name, message_id) do nothing
             returning message_id`,
            [source.messageId, source.consumerName ?? 'wager-consumer', payloadHash],
          )) as Array<{ message_id: string }>;
          if (rows.length === 0) {
            const original = await em.findOne(WagerTransactionEntity, { idempotencyKey });
            this.logger.log({ correlationId, messageId: source.messageId, msg: 'inbox duplicate, acking' });
            return this.replayResult(original);
          }
        }

        // ---- 2. Idempotência por chave ----
        const existing = await em.findOne(WagerTransactionEntity, { idempotencyKey });
        if (existing) {
          if (existing.payloadHash !== payloadHash) {
            throw new IdempotencyConflictError(idempotencyKey);
          }
          return this.replayResult(existing);
        }

        // ---- 3. Validação de formato do dinheiro ----
        const validAmount = /^\d+(\.\d{1,2})?$/.test(dto.money.amount);
        if (!validAmount || dto.money.currency !== 'BRL') {
          const code = !validAmount ? FailureCode.InvalidAmount : FailureCode.UnsupportedCurrency;
          const tx = this.buildRawTransaction(dto, idempotencyKey, payloadHash, 'REJECTED');
          tx.failureCode = code;
          tx.processedAt = new Date();
          em.persist(tx);
          em.persist(OutboxMessageEntity.enqueue(WagerTransactionRejected.from({
            correlationId,
            transactionId: tx.id,
            providerId: dto.providerId,
            externalTransactionId: dto.externalTransactionId,
            walletId: dto.walletId,
            kind: dto.kind,
            failureCode: code,
          })));
          await em.flush();
          return { transactionId: tx.id, status: 'REJECTED', failureCode: code, idempotentReplay: false };
        }
        const money = Money.from(dto.money);

        // ---- 4. Lock pessimista na wallet (unidade de concorrência) ----
        const wallet = await em.findOne(WalletEntity, { id: dto.walletId }, {
          lockMode: LockMode.PESSIMISTIC_WRITE,
        });
        if (!wallet || wallet.playerId !== dto.playerId) {
          return this.reject(em, dto, idempotencyKey, payloadHash, FailureCode.ReferenceScopeMismatch, correlationId);
        }
        if (wallet.currency !== money.currency) {
          return this.reject(em, dto, idempotencyKey, payloadHash, FailureCode.CurrencyMismatch, correlationId);
        }
        const balanceBefore = Money.rehydrate({ amount: wallet.balance, currency: wallet.currency });

        // ---- 5. Resolve referência (REFUND/ROLLBACK) ----
        let reference: WagerTransactionEntity | null = null;
        if (dto.referenceExternalTransactionId) {
          reference = await em.findOne(WagerTransactionEntity, {
            providerId: dto.providerId,
            externalTransactionId: dto.referenceExternalTransactionId,
          });

          if (!reference || reference.status !== 'PROCESSED') {
            const tx = this.buildTransactionEntity(dto, idempotencyKey, payloadHash, money, 'PENDING_REFERENCE');
            tx.attempts = 1;
            tx.nextAttemptAt = new Date(Date.now() + 1_000);
            em.persist(tx);
            em.persist(OutboxMessageEntity.enqueue(WagerTransactionPendingReference.from({
              correlationId,
              transactionId: tx.id,
              providerId: dto.providerId,
              externalTransactionId: dto.externalTransactionId,
              walletId: dto.walletId,
              referenceExternalTransactionId: dto.referenceExternalTransactionId,
              attempts: 1,
            })));
            await em.flush();
            return { transactionId: tx.id, status: 'PENDING_REFERENCE', idempotentReplay: false };
          }

          const scopeError = this.validateReference(dto, reference, money);
          if (scopeError) {
            return this.reject(em, dto, idempotencyKey, payloadHash, scopeError, correlationId, reference.id);
          }

          const alreadyReverted = await em.findOne(WagerTransactionEntity, {
            providerId: dto.providerId,
            referenceExternalTransactionId: dto.referenceExternalTransactionId,
            kind: dto.kind,
            status: 'PROCESSED',
          });
          if (alreadyReverted) {
            return this.reject(em, dto, idempotencyKey, payloadHash, FailureCode.ReferenceAlreadyReverted, correlationId, reference.id);
          }
        }

        // ---- 6. Decide efeito no saldo ----
        const direction = this.directionFor(dto.kind, reference ?? undefined);
        let status: 'PROCESSED' | 'REJECTED' = 'PROCESSED';
        let failureCode: FailureCode | undefined;
        let balanceAfter = balanceBefore;

        if (dto.kind === 'LOSS') {
          // sem efeito no saldo, sem ledger
        } else if (direction === LedgerDirection.Debit) {
          if (balanceBefore.isLessThan(money)) {
            status = 'REJECTED';
            failureCode = dto.kind === 'BET'
              ? FailureCode.InsufficientBalance
              : FailureCode.InsufficientBalanceForReversal;
          } else {
            balanceAfter = balanceBefore.subtract(money);
          }
        } else if (direction === LedgerDirection.Credit) {
          balanceAfter = balanceBefore.add(money);
        }

        // ---- 7. Persiste transação + saldo + ledger + outbox (mesmo commit) ----
        const txId = randomUUID();
        const now = new Date();
        const tx = this.buildTransactionEntity(dto, idempotencyKey, payloadHash, money, status, txId);
        tx.referenceTransactionId = reference?.id;
        if (status === 'REJECTED') {
          tx.failureCode = failureCode;
        }
        tx.processedAt = now;
        em.persist(tx);

        if (status === 'PROCESSED' && direction !== undefined) {
          const updated = await em.nativeUpdate(
            WalletEntity,
            { id: wallet.id, version: wallet.version },
            {
              balance: balanceAfter.toJSON().amount,
              version: wallet.version + 1,
              updatedAt: now,
            },
          );
          if (updated === 0) {
            throw new Error('CONCURRENT_MODIFICATION');
          }

          em.persist(em.create(WalletLedgerEntryEntity, {
            id: randomUUID(),
            walletId: wallet.id,
            transactionId: txId,
            direction,
            amount: money.toJSON().amount,
            currency: money.currency,
            balanceBefore: balanceBefore.toJSON().amount,
            balanceAfter: balanceAfter.toJSON().amount,
            createdAt: now,
          }));

          em.persist(OutboxMessageEntity.enqueue(WalletBalanceChanged.from({
            correlationId,
            walletId: wallet.id,
            transactionId: txId,
            direction,
            money: money.toJSON(),
            balanceBefore: balanceBefore.toJSON(),
            balanceAfter: balanceAfter.toJSON(),
            walletVersion: wallet.version + 1,
          })));
        }

        em.persist(OutboxMessageEntity.enqueue(
          status === 'PROCESSED'
            ? WagerTransactionProcessed.from({
                correlationId,
                transactionId: txId,
                providerId: dto.providerId,
                externalTransactionId: dto.externalTransactionId,
                walletId: dto.walletId,
                playerId: dto.playerId,
                roundId: dto.roundId,
                kind: dto.kind,
                money: money.toJSON(),
                referenceExternalTransactionId: dto.referenceExternalTransactionId,
              })
            : WagerTransactionRejected.from({
                correlationId,
                transactionId: txId,
                providerId: dto.providerId,
                externalTransactionId: dto.externalTransactionId,
                walletId: dto.walletId,
                kind: dto.kind,
                failureCode: failureCode!,
              }),
        ));

        await em.flush();

        return {
          transactionId: txId,
          status,
          failureCode,
          balance: balanceAfter.toJSON(),
          idempotentReplay: false,
        };
      });
    } catch (e) {
      // ---- CORREÇÃO BUG 1: corrida de idempotência ----
      // Duas requisições com a mesma key passam pelo passo 2 ao mesmo tempo.
      // A unique constraint do schema decide quem venceu; a transação perdedora
      // abortou, então a re-leitura ACONTECE EM FORK NOVO (a transação abortada
      // não pode mais executar SQL: "current transaction is aborted").
      if (isUniqueViolation(e)) {
        this.logger.warn({
          correlationId,
          idempotencyKey,
          msg: 'idempotency race resolved by unique constraint',
        });
        // Re-leitura com retry: sob 50+ concorrentes, o fork pode competir por
        // conexão do pool — o winner commitado nem sempre é visível no 1º instante.
        // Três desfechos possíveis, semanticamente distintos:
        //   1. winner + hash igual  → replay legítimo
        //   2. winner + hash difere → 409 (conflito real de payload)
        //   3. winner não visível   → 503 transitório (NUNCA mentir 409)
        const winner = await this.findWinner(idempotencyKey);
        if (winner && winner.payloadHash === payloadHash) {
          return this.replayResult(winner);
        }
        if (winner) {
          throw new IdempotencyConflictError(idempotencyKey);
        }
        throw new IdempotencyRaceUnresolvedError(idempotencyKey, e);
      }
      throw e;
    }
  }

  // ---------- helpers ----------

  /** Re-leitura do vencedor com backoff curto (visibilidade/pool sob alta concorrência). */
  private async findWinner(
    idempotencyKey: string,
    attempts = 5,
  ): Promise<WagerTransactionEntity | null> {
    for (let i = 0; i < attempts; i++) {
      const found = await this.em.fork().findOne(WagerTransactionEntity, { idempotencyKey });
      if (found) return found;
      await new Promise((r) => setTimeout(r, 25 * (i + 1))); // 25, 50, 75, 100, 125ms
    }
    return null;
  }

  private replayResult(existing: WagerTransactionEntity | null): SubmitResult {
    return {
      transactionId: existing?.id ?? 'unknown',
      status: (existing?.status as SubmitResult['status']) ?? 'PENDING_REFERENCE',
      failureCode: existing?.failureCode ?? undefined,
      idempotentReplay: true,
    };
  }

  private async reject(
    em: EntityManager,
    dto: SubmitInput,
    idempotencyKey: string,
    payloadHash: string,
    code: FailureCode,
    correlationId: string,
    referenceTransactionId?: string,
  ): Promise<SubmitResult> {
    const tx = this.buildRawTransaction(dto, idempotencyKey, payloadHash, 'REJECTED');
    tx.failureCode = code;
    tx.referenceTransactionId = referenceTransactionId;
    tx.processedAt = new Date();
    em.persist(tx);
    em.persist(OutboxMessageEntity.enqueue(WagerTransactionRejected.from({
      correlationId,
      transactionId: tx.id,
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      walletId: dto.walletId,
      kind: dto.kind,
      failureCode: code,
    })));
    await em.flush();
    return { transactionId: tx.id, status: 'REJECTED', failureCode: code, idempotentReplay: false };
  }

  private directionFor(
    kind: string,
    reference?: WagerTransactionEntity,
  ): LedgerDirection | undefined {
    switch (kind) {
      case 'BET': return LedgerDirection.Debit;
      case 'WIN':
      case 'REFUND': return LedgerDirection.Credit;
      case 'LOSS': return undefined;
      case 'ROLLBACK': {
        if (!reference) throw new Error('ROLLBACK requires reference');
        return reference.kind === 'BET' ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      default: throw new Error(`UNKNOWN_KIND: ${kind}`);
    }
  }

  private validateReference(
    dto: SubmitInput,
    ref: WagerTransactionEntity,
    money: Money,
  ): FailureCode | undefined {
    if (ref.playerId !== dto.playerId || ref.walletId !== dto.walletId ||
        ref.roundId !== dto.roundId || ref.currency !== money.currency) {
      return FailureCode.ReferenceScopeMismatch;
    }
    if (dto.kind === 'REFUND' && ref.kind !== 'BET') {
      return FailureCode.InvalidReferenceKind;
    }
    if (dto.kind === 'ROLLBACK' && !['BET', 'WIN', 'REFUND'].includes(ref.kind)) {
      return FailureCode.InvalidReferenceKind;
    }
    if (ref.amount !== money.toJSON().amount) {
      return FailureCode.AmountMismatch;
    }
    return undefined;
  }

  private buildTransactionEntity(
    dto: SubmitInput,
    idempotencyKey: string,
    payloadHash: string,
    money: Money,
    status: string,
    id: string = randomUUID(),
  ): WagerTransactionEntity {
    return this.em.create(WagerTransactionEntity, {
      id,
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      idempotencyKey,
      payloadHash,
      walletId: dto.walletId,
      playerId: dto.playerId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: dto.kind,
      amount: money.toJSON().amount,
      currency: money.currency,
      referenceExternalTransactionId: dto.referenceExternalTransactionId,
      status,
      createdAt: new Date(),
    });
  }

  private buildRawTransaction(
    dto: SubmitInput,
    idempotencyKey: string,
    payloadHash: string,
    status: string,
  ): WagerTransactionEntity {
    return this.em.create(WagerTransactionEntity, {
      id: randomUUID(),
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      idempotencyKey,
      payloadHash,
      walletId: dto.walletId,
      playerId: dto.playerId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: dto.kind,
      amount: dto.money.amount,
      currency: dto.money.currency,
      referenceExternalTransactionId: dto.referenceExternalTransactionId,
      status,
      createdAt: new Date(),
    });
  }
}

/** 23505 = unique_violation (Postgres). MikroORM pode embrulhar o erro do driver. */
function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === '23505' || err?.cause?.code === '23505';
}

export class IdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`idempotency key "${idempotencyKey}" reused with different payload`);
    this.name = 'IdempotencyConflictError';
  }
}

/**
 * Violação de unique SEM winner visível após retries.
 * Transitório por definição — NÃO mapear para 409.
 * Controller: 503. SQS: deixar visibility expirar (reenvio seguro).
 */
export class IdempotencyRaceUnresolvedError extends Error {
  constructor(
    readonly idempotencyKey: string,
    readonly originalError: unknown,
  ) {
    super(`idempotency race unresolved for key "${idempotencyKey}"`);
    this.name = 'IdempotencyRaceUnresolvedError';
  }
}