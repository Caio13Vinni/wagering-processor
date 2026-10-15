import Decimal from 'decimal.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!props.amount || !AMOUNT_PATTERN.test(props.amount)) {
      throw new MoneyError('INVALID_AMOUNT', `amount must be a decimal string with up to 2 places: "${props.amount}"`);
    }
    if (props.currency !== 'BRL') {
      throw new MoneyError('UNSUPPORTED_CURRENCY', `currency must be BRL, got "${props.currency}"`);
    }
    return new Money(new Decimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    return new Money(new Decimal('0.00'), currency);
  }

  /** Reidratação a partir do banco — confia na representação persistida. */
  static rehydrate(props: MoneyProps): Money {
    return new Money(new Decimal(props.amount), props.currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean { return this.value.isZero(); }
  isPositive(): boolean { return this.value.gt(0); }
  isNegative(): boolean { return this.value.lt(0); }
  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new MoneyError('CURRENCY_MISMATCH', `${this.currency} vs ${other.currency}`);
    }
  }
}

export class MoneyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MoneyError';
  }
}