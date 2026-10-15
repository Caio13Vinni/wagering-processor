import { randomUUID } from 'node:crypto';
import { IntegrationEvent } from './integration-event';
import { MoneyProps } from '../money/money';
import { LedgerDirection } from '../ledger/ledger-entry';
import { WagerTransactionStatus } from '../transaction/wager-transaction';

export interface EventContext {
  correlationId: string;
  causationId?: string;
}

// ---------- WalletBalanceChanged ----------

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(
    input: WalletBalanceChangedData & EventContext,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: randomUUID(),
      aggregateId: input.walletId,
      correlationId: input.correlationId,
      causationId: input.causationId,
      occurredAt: new Date(),
      data: {
        walletId: input.walletId,
        transactionId: input.transactionId,
        direction: input.direction,
        money: input.money,
        balanceBefore: input.balanceBefore,
        balanceAfter: input.balanceAfter,
        walletVersion: input.walletVersion,
      },
    });
  }
}

// ---------- WagerTransactionProcessed ----------

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(
    input: WagerTransactionProcessedData & EventContext,
  ): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      eventId: randomUUID(),
      aggregateId: input.transactionId,
      correlationId: input.correlationId,
      causationId: input.causationId,
      occurredAt: new Date(),
      data: input,
    });
  }
}

// ---------- WagerTransactionRejected ----------

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  failureCode: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(
    input: WagerTransactionRejectedData & EventContext,
  ): WagerTransactionRejected {
    return new WagerTransactionRejected({
      eventId: randomUUID(),
      aggregateId: input.transactionId,
      correlationId: input.correlationId,
      causationId: input.causationId,
      occurredAt: new Date(),
      data: input,
    });
  }
}

// ---------- WagerTransactionPendingReference ----------

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  referenceExternalTransactionId: string;
  attempts: number;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(
    input: WagerTransactionPendingReferenceData & EventContext,
  ): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      eventId: randomUUID(),
      aggregateId: input.transactionId,
      correlationId: input.correlationId,
      causationId: input.causationId,
      occurredAt: new Date(),
      data: input,
    });
  }
}

export type AnyIntegrationEvent =
  | WalletBalanceChanged
  | WagerTransactionProcessed
  | WagerTransactionRejected
  | WagerTransactionPendingReference;

export type TransactionStatusPayload = WagerTransactionStatus;