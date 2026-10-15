import { Money, MoneyProps } from '../money/money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt?: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const money = Money.from(props.money);
    const before = Money.from(props.balanceBefore);
    const after = Money.from(props.balanceAfter);
    const entry = new WalletLedgerEntry(
      props.id, props.walletId, props.transactionId, props.direction,
      money, before, after, props.createdAt ?? new Date(),
    );
    if (!entry.isBalanced()) {
      throw new Error('LEDGER_ARITHMETIC_MISMATCH');
    }
    return entry;
  }

  static rehydrate(state: CreateLedgerEntryProps & { createdAt: Date }): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id, state.walletId, state.transactionId, state.direction,
      Money.rehydrate(state.money), Money.rehydrate(state.balanceBefore),
      Money.rehydrate(state.balanceAfter), state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter — validada na fatory */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}