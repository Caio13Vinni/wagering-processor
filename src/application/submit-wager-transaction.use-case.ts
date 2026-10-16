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

const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

/** Tentativas de resolução de referência antes de REJECTED (TTL ~45min com backoff de 5s). */
const MAX_REFERENCE_ATTEMPTS = 10;

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
        const validAmount = AMOUNT_PATTERN.test(dto.money.amount);
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

        // ---- 4b. REFUND/ROLLBACK exigem referência; auto-referência é rejeitada ----
        if (dto.kind === 'REFUND' || dto.kind === 'ROLLBACK') {
          if (!dto.referenceExternalTransactionId) {
            return this.reject(em, dto, idempotencyKey, payloadHash, FailureCode.MissingReference, correlationId);
          }
          if (dto.referenceExternalTransactionId === dto.externalTransactionId) {
            return this.reject(em, dto, idempotencyKey, payloadHash, FailureCode.SelfReference, correlationId);
          }
        }

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
              : FailureCode.InsufficientBalanceForReversal; // regra 9: código distinto
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
        // Bug 2 (regra 7): snapshot do saldo — replay responde o resultado ORIGINAL
        if (status === 'PROCESSED' && direction !== undefined) {
          tx.resultingBalance = balanceAfter.toJSON().amount;
        }
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
      // ---- Bug 1: corrida de idempotência — a unique constraint decide quem venceu ----
      // A transação perdedora abortou; a re-leitura ACONTECE EM FORK NOVO
      // (a transação abortada não pode mais executar SQL).
      if (isUniqueViolation(e)) {
        this.logger.log({
          correlationId,
          idempotencyKey,
          msg: 'duplicate request resolved by unique constraint',
          outcome: 'replay-or-conflict',
        });
        // Três desfechos semanticamente distintos:
        //   1. winner + hash igual  → replay legítimo
        //   2. winner + hash difere → 409 (conflito real de payload)
        //   3. winner não visível   → erro transitório (NUNCA mentir 409)
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

  /**
   * Lote E: reprocessa uma transação PENDING_REFERENCE (worker agendado).
   * Referência agora existe e está PROCESSED → aplica a movimentação (mesma
   * lógica do fluxo principal, mesmo commit: saldo + ledger + outbox + status).
   * Ainda ausente → backoff exponencial; esgotado → REJECTED + evento (mesmo commit).
   */
  async reprocess(txId: string): Promise<SubmitResult> {
    const correlationId = randomUUID();
    return this.em.transactional(async (em) => {
      const tx = await em.findOne(WagerTransactionEntity, { id: txId }, {
        lockMode: LockMode.PESSIMISTIC_WRITE, // serializa entre instâncias do worker
      });
      if (!tx) throw new Error(`transaction ${txId} not found`);

      if (tx.status !== 'PENDING_REFERENCE') {
        // resolvida por outra instância/caminho enquanto esperávamos — devolve o estado atual
        return {
          transactionId: tx.id,
          status: tx.status as SubmitResult['status'],
          failureCode: tx.failureCode ?? undefined,
          balance: tx.resultingBalance
            ? { amount: tx.resultingBalance, currency: tx.currency }
            : undefined,
          idempotentReplay: true,
        };
      }

      const dto: SubmitInput = {
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        playerId: tx.playerId,
        walletId: tx.walletId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind as SubmitInput['kind'],
        money: { amount: tx.amount, currency: tx.currency },
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
      };
      const money = Money.rehydrate({ amount: tx.amount, currency: tx.currency });

      const reference = tx.referenceExternalTransactionId
        ? await em.findOne(WagerTransactionEntity, {
            providerId: tx.providerId,
            externalTransactionId: tx.referenceExternalTransactionId,
          })
        : null;

      const attempts = (tx.attempts ?? 0) + 1;

      // ---- referência ainda não disponível: backoff ou esgotamento ----
      if (!reference || reference.status !== 'PROCESSED') {
        if (attempts >= MAX_REFERENCE_ATTEMPTS) {
          tx.status = 'REJECTED';
          tx.failureCode = FailureCode.MissingReference;
          tx.processedAt = new Date();
          em.persist(OutboxMessageEntity.enqueue(WagerTransactionRejected.from({
            correlationId,
            transactionId: tx.id,
            providerId: tx.providerId,
            externalTransactionId: tx.externalTransactionId,
            walletId: tx.walletId,
            kind: tx.kind,
            failureCode: FailureCode.MissingReference,
          })));
          await em.flush();
          return {
            transactionId: tx.id, status: 'REJECTED',
            failureCode: FailureCode.MissingReference, idempotentReplay: false,
          };
        }
        tx.attempts = attempts;
        // backoff exponencial: 5s, 10s, 20s ... teto 15min
        tx.nextAttemptAt = new Date(Date.now() + Math.min(5_000 * 2 ** (attempts - 1), 900_000));
        await em.flush();
        return { transactionId: tx.id, status: 'PENDING_REFERENCE', idempotentReplay: false };
      }

      // ---- referência pronta: mesmas validações de domínio do fluxo principal ----
      const scopeError = this.validateReference(dto, reference, money);
      if (scopeError) {
        return this.rejectExisting(em, tx, scopeError, correlationId);
      }
      const alreadyReverted = await em.findOne(WagerTransactionEntity, {
        providerId: tx.providerId,
        referenceExternalTransactionId: tx.referenceExternalTransactionId!,
        kind: tx.kind,
        status: 'PROCESSED',
      });
      if (alreadyReverted) {
        return this.rejectExisting(em, tx, FailureCode.ReferenceAlreadyReverted, correlationId);
      }

      // ---- aplica a movimentação (espelha passos 6-7 do execute) ----
      const wallet = await em.findOne(WalletEntity, { id: tx.walletId }, {
        lockMode: LockMode.PESSIMISTIC_WRITE,
      });
      if (!wallet || wallet.playerId !== tx.playerId) {
        return this.rejectExisting(em, tx, FailureCode.ReferenceScopeMismatch, correlationId);
      }
      const balanceBefore = Money.rehydrate({ amount: wallet.balance, currency: wallet.currency });
      const direction = this.directionFor(tx.kind, reference);
      let status: 'PROCESSED' | 'REJECTED' = 'PROCESSED';
      let failureCode: FailureCode | undefined;
      let balanceAfter = balanceBefore;

      if (direction === LedgerDirection.Debit) {
        if (balanceBefore.isLessThan(money)) {
          status = 'REJECTED';
          failureCode = FailureCode.InsufficientBalanceForReversal; // regra 9
        } else {
          balanceAfter = balanceBefore.subtract(money);
        }
      } else if (direction === LedgerDirection.Credit) {
        balanceAfter = balanceBefore.add(money);
      }

      const now = new Date();
      tx.status = status;
      tx.referenceTransactionId = reference.id;
      if (status === 'REJECTED') {
        tx.failureCode = failureCode;
      } else if (direction !== undefined) {
        tx.resultingBalance = balanceAfter.toJSON().amount;
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
        if (updated === 0) throw new Error('CONCURRENT_MODIFICATION');

        em.persist(em.create(WalletLedgerEntryEntity, {
          id: randomUUID(),
          walletId: wallet.id,
          transactionId: tx.id,
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
          transactionId: tx.id,
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
              transactionId: tx.id,
              providerId: tx.providerId,
              externalTransactionId: tx.externalTransactionId,
              walletId: tx.walletId,
              playerId: tx.playerId,
              roundId: tx.roundId,
              kind: tx.kind,
              money: money.toJSON(),
              referenceExternalTransactionId: tx.referenceExternalTransactionId,
            })
          : WagerTransactionRejected.from({
              correlationId,
              transactionId: tx.id,
              providerId: tx.providerId,
              externalTransactionId: tx.externalTransactionId,
              walletId: tx.walletId,
              kind: tx.kind,
              failureCode: failureCode!,
            }),
      ));

      await em.flush();
      return {
        transactionId: tx.id,
        status,
        failureCode,
        balance: balanceAfter.toJSON(),
        idempotentReplay: false,
      };
    });
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
      await new Promise((r) => setTimeout(r, 25 * (i + 1)));
    }
    return null;
  }

  /**
   * Replay devolve o resultado ORIGINAL (regra 7), incluindo o saldo observado
   * no processamento — lido do snapshot, sem tocar na wallet, sem lock.
   */
  private replayResult(existing: WagerTransactionEntity | null): SubmitResult {
    return {
      transactionId: existing?.id ?? 'unknown',
      status: (existing?.status as SubmitResult['status']) ?? 'PENDING_REFERENCE',
      failureCode: existing?.failureCode ?? undefined,
      balance: existing?.resultingBalance
        ? { amount: existing.resultingBalance, currency: existing.currency }
        : undefined,
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

  /** REJECTED para transação já persistida como PENDING_REFERENCE (worker). */
  private async rejectExisting(
    em: EntityManager,
    tx: WagerTransactionEntity,
    code: FailureCode,
    correlationId: string,
  ): Promise<SubmitResult> {
    tx.status = 'REJECTED';
    tx.failureCode = code;
    tx.processedAt = new Date();
    em.persist(tx);
    em.persist(OutboxMessageEntity.enqueue(WagerTransactionRejected.from({
      correlationId,
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      walletId: tx.walletId,
      kind: tx.kind,
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

  /**
   * Transação REJECTADA sem Money validado — sanitiza o amount antes de gravar,
   * senão 'abc'/'1e10' quebram o INSERT na coluna numeric(19,2).
   */
  private buildRawTransaction(
    dto: SubmitInput,
    idempotencyKey: string,
    payloadHash: string,
    status: string,
  ): WagerTransactionEntity {
    const safeAmount = AMOUNT_PATTERN.test(dto.money.amount) ? dto.money.amount : '0.00';
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
      amount: safeAmount,
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