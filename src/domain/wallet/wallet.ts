import { Money } from '../money/money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new Error('INITIAL_BALANCE_NEGATIVE');
    }
    return new Wallet(
      props.id, props.playerId, props.initialBalance.currency,
      props.initialBalance, 1, new Date(), new Date(),
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.rehydrate({ amount: state.balance, currency: state.currency }),
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money { return this._balance; }
  get version(): number { return this._version; }
  get updatedAt(): Date { return this._updatedAt; }

  debit(amount: Money): Money {
    this.assertSameCurrency(amount);
    const next = this._balance.subtract(amount);
    if (next.isNegative()) {
      throw new WalletError('INSUFFICIENT_BALANCE', `balance ${this._balance} < debit ${amount}`);
    }
    this.apply(next);
    return next;
  }

  /** Crédito — apenas valida moeda. */
  credit(amount: Money): Money {
    this.assertSameCurrency(amount);
    const next = this._balance.add(amount);
    this.apply(next);
    return next;
  }

  private apply(next: Money): void {
    this._balance = next;
    this._version += 1;
    this._updatedAt = new Date();
  }

  private assertSameCurrency(amount: Money): void {
    if (amount.currency !== this.currency) {
      throw new WalletError('CURRENCY_MISMATCH', `${amount.currency} vs ${this.currency}`);
    }
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance.toJSON().amount,
      version: this._version,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }
}

export class WalletError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WalletError';
  }
}