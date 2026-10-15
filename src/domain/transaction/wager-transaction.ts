import { Money, MoneyProps } from '../money/money';
import { FailureCode } from './failure-codes';
import { LedgerDirection } from '../ledger/ledger-entry';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  referenceTransactionId?: string;
  createdAt: Date;
  processedAt?: Date;
}

export class InvalidTransactionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransactionStateError';
  }
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidTransactionStateError('OPENING is internal and cannot be submitted');
    }
    if (this.requiresReference(props.kind) && !props.referenceExternalTransactionId) {
      throw new InvalidTransactionStateError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (
      props.referenceExternalTransactionId &&
      props.referenceExternalTransactionId === props.externalTransactionId
    ) {
      throw new InvalidTransactionStateError('transaction cannot reference itself');
    }
    return new WagerTransaction(
      props.id, props.providerId, props.externalTransactionId, props.idempotencyKey,
      props.payloadHash, props.walletId, props.playerId, props.roundId, props.gameId,
      props.kind, Money.from(props.money), props.referenceExternalTransactionId,
      new Date(), WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id, state.providerId, state.externalTransactionId, state.idempotencyKey,
      state.payloadHash, state.walletId, state.playerId, state.roundId, state.gameId,
      state.kind, Money.rehydrate(state.money), state.referenceExternalTransactionId,
      state.createdAt, state.status, state.referenceTransactionId, state.failureCode,
      state.processedAt,
    );
  }

  get status(): WagerTransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this._failureCode; }
  get processedAt(): Date | undefined { return this._processedAt; }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return WagerTransaction.requiresReference(this.kind);
  }

  static requiresReference(kind: WagerTransactionKind): boolean {
    return (
      kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento no ledger.
   * REFUND é sempre crédito (só referencia BET). ROLLBACK inverte a referência.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Loss:
        return undefined;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionStateError('ROLLBACK needs reference to determine direction');
        }
        const refDirection = reference.ledgerDirectionFor();
        if (refDirection === LedgerDirection.Debit) return LedgerDirection.Credit;
        if (refDirection === LedgerDirection.Credit) return LedgerDirection.Debit;
        throw new InvalidTransactionStateError('cannot reverse a transaction without balance effect');
      }
    }
  }

  // ---- transições (estado terminal - >  erro de programação)

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `terminal status ${this._status} cannot transition`,
      );
    }
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = new Date();
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = new Date();
  }

  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money.toJSON(),
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      status: this._status,
      failureCode: this._failureCode,
      referenceTransactionId: this._referenceTransactionId,
      createdAt: this.createdAt,
      processedAt: this._processedAt,
    };
  }
}