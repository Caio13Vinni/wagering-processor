import {
  Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, ParseIntPipe, ParseUUIDPipe, Post, Query,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import Decimal from 'decimal.js';
import { CreateWalletUseCase } from '../../application/create-wallet.use-case';
import { WalletEntity } from '../../domain/wallet/wallet.entity';
import { WalletLedgerEntryEntity } from '../../domain/ledger/ledger-entry.entity';
import { CreateWalletDto } from './dto';
import { metrics } from '../metrics/metrics';

@Controller('wallets')
export class WalletController {
  constructor(
    private readonly em: EntityManager,
    private readonly createWallet: CreateWalletUseCase,
  ) {}

  @Post()
  async create(@Body() dto: CreateWalletDto) {
    const { walletId } = await this.createWallet.execute({
      playerId: dto.playerId,
      initialBalance: dto.initialBalance,
    });
    const wallet = await this.em.fork().findOneOrFail(WalletEntity, { id: walletId });
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: { amount: wallet.balance, currency: wallet.currency },
      version: wallet.version,
    };
  }

  @Get(':walletId')
  async get(@Param('walletId', ParseUUIDPipe) walletId: string) {
    const wallet = await this.em.fork().findOne(WalletEntity, { id: walletId });
    if (!wallet) throw new NotFoundException('wallet not found');
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: { amount: wallet.balance, currency: wallet.currency },
      version: wallet.version,
    };
  }

  /**
   * Ledger com cursor opaco e estável: base64 de `${createdAt ISO}|${id}`.
   * ordenação (created_at, id) — id desempata entradas no mesmo timestamp.
   */
  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 50,
    @Query('cursor') cursor?: string,
  ) {
    const take = Math.min(Math.max(limit, 1), 100);
    const fork = this.em.fork();
    const wallet = await fork.findOne(WalletEntity, { id: walletId });
    if (!wallet) throw new NotFoundException('wallet not found');

    const where: Record<string, unknown> = { walletId };
    if (cursor) {
      const [iso, id] = Buffer.from(cursor, 'base64').toString('utf8').split('|');
      // comparacao lexica de tupla via OR — id desempata
      where.$or = [
        { createdAt: { $gt: new Date(iso) } },
        { createdAt: new Date(iso), id: { $gt: id } },
      ];
    }

    const entries = await fork.find(
      WalletLedgerEntryEntity,
      where,
      { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], limit: take + 1 },
    );

    const hasMore = entries.length > take;
    const page = hasMore ? entries.slice(0, take) : entries;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last
      ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString('base64')
      : undefined;

    return {
      data: page.map((e) => ({
        id: e.id,
        transactionId: e.transactionId,
        direction: e.direction.trim(),
        money: { amount: e.amount, currency: e.currency },
        balanceBefore: { amount: e.balanceBefore, currency: e.currency },
        balanceAfter: { amount: e.balanceAfter, currency: e.currency },
        createdAt: e.createdAt,
      })),
      nextCursor,
    };
  }

  /**
   * Reconciliação: saldo materializado vs Σ ledger. Divergência NUNCA é
   * corrigida silenciosamente — sinalizada na resposta e logada.
   */
  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcile(@Param('walletId', ParseUUIDPipe) walletId: string) {
    const conn = this.em.getConnection();
    const rows = (await conn.execute(
      `select w.balance::text as balance, w.currency,
              (select coalesce(sum(case when l.direction = 'DEBIT' then -l.amount else l.amount end), 0)
                 from wallet_ledger l where l.wallet_id = w.id)::text as calculated,
              (select count(*) from wallet_ledger l where l.wallet_id = w.id)::int as entries
         from wallets w where w.id = ?`,
      [walletId],
    )) as Array<{ balance: string; currency: string; calculated: string; entries: number }>;

    if (rows.length === 0) throw new NotFoundException('wallet not found');
    const r = rows[0];

    const stored = new Decimal(r.balance);
    const calculated = new Decimal(r.calculated);
    const consistent = stored.equals(calculated);

    if (!consistent) {
      metrics.increment('wallets.reconciliation_mismatch');
      console.warn(JSON.stringify({
        msg: 'reconciliation mismatch',
        walletId,
        storedBalance: r.balance,
        calculatedBalance: r.calculated,
        checkedEntries: r.entries,
      }));
    }

    return {
      walletId,
      storedBalance: { amount: stored.toFixed(2), currency: r.currency },
      calculatedBalance: { amount: calculated.toFixed(2), currency: r.currency },
      difference: { amount: stored.minus(calculated).toFixed(2), currency: r.currency },
      consistent,
      checkedEntries: r.entries,
    };
  }
}