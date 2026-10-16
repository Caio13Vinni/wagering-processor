import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money/money';

describe('Money', () => {
  test('from: aceita decimal valido com escala 2', () => {
    const m = Money.from({ amount: '25.00', currency: 'BRL' });
    expect(m.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  test('from: rejeita entradas invalidas', () => {
    const bad = ['abc', '', '1e3', 'NaN', 'Infinity', '-5.00', '10.999', '1,00'];
    for (const amount of bad) {
      expect(() => Money.from({ amount, currency: 'BRL' }), `amount="${amount}"`).toThrow();
    }
  });

  test('from: rejeita moeda invalida', () => {
    expect(() => Money.from({ amount: '10.00', currency: 'USD' })).toThrow();
    expect(() => Money.from({ amount: '10.00', currency: 'XXX' })).toThrow();
  });

  test('zero: cria money zero na moeda', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
  });

  test('add: soma com escala fixa', () => {
    const r = Money.from({ amount: '0.10', currency: 'BRL' })
      .add(Money.from({ amount: '0.20', currency: 'BRL' }));
    expect(r.toJSON().amount).toBe('0.30');
  });

  test('subtract: subtrai', () => {
    const r = Money.from({ amount: '100.00', currency: 'BRL' })
      .subtract(Money.from({ amount: '25.50', currency: 'BRL' }));
    expect(r.toJSON().amount).toBe('74.50');
  });

  test('operacoes entre moedas diferentes lancam erro', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    // from() valida BRL-only; rehydrate reconstrói estado (moeda estrangeira) p/ testar conflito
    const other = Money.rehydrate({ amount: '10.00', currency: 'USD' });
    expect(() => brl.add(other)).toThrow();
    expect(() => brl.subtract(other)).toThrow();
    expect(() => brl.isLessThan(other)).toThrow();
  });

  test('imutavel: operacoes retornam nova instancia', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = a.add(Money.from({ amount: '5.00', currency: 'BRL' }));
    expect(a.toJSON().amount).toBe('10.00');
    expect(b.toJSON().amount).toBe('15.00');
    expect(a).not.toBe(b);
  });

  test('comparacoes', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '20.00', currency: 'BRL' });
    expect(a.isLessThan(b)).toBe(true);
    expect(b.isPositive()).toBe(true);
    expect(a.equals(Money.from({ amount: '10.00', currency: 'BRL' }))).toBe(true);
    expect(a.isNegative()).toBe(false);
  });

  test('negate', () => {
    const m = Money.from({ amount: '10.00', currency: 'BRL' });
    expect(m.negate().isNegative()).toBe(true);
    expect(m.negate().negate().equals(m)).toBe(true);
  });

  test('toString', () => {
    expect(Money.from({ amount: '25.00', currency: 'BRL' }).toString()).toBe('25.00 BRL');
  });
});