import {
  Body, Controller, Get, Headers, HttpCode, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Post, Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  SubmitWagerTransactionUseCase,
  IdempotencyRaceUnresolvedError,
} from '../../application/submit-wager-transaction.use-case';
import { WagerTransactionEntity } from '../../domain/transaction/wager-transaction.entity';
import { SubmitWagerTransactionDto } from './dto';

@Controller()
export class WageringController {
  constructor(
    private readonly em: EntityManager,
    private readonly submit: SubmitWagerTransactionUseCase,
  ) {}

  @Post('wagering/transactions')
  async submitTransaction(
    @Body() dto: SubmitWagerTransactionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      // o header é obrigatório e é a FONTE DA VERDADE da idempotência
      res.status(HttpStatus.BAD_REQUEST);
      return {
        statusCode: 400,
        error: 'MissingIdempotencyKey',
        message: 'Idempotency-Key header is required',
      };
    }

    const result = await this.submit.execute(dto, idempotencyKey, { channel: 'http' });

    const body: Record<string, unknown> = {
      transactionId: result.transactionId,
      status: result.status,
      idempotentReplay: result.idempotentReplay,
    };
    if (result.failureCode) body.failureCode = result.failureCode;
    if (result.balance) body.balance = result.balance;

    // mapeamento consistente de status:
    //   201 primeira vez processado | 200 replay | 202 pendente | 422 rejeitado por regra
    if (result.idempotentReplay) res.status(HttpStatus.OK);
    else if (result.status === 'PROCESSED') res.status(HttpStatus.CREATED);
    else if (result.status === 'PENDING_REFERENCE') res.status(HttpStatus.ACCEPTED);
    else res.status(HttpStatus.UNPROCESSABLE_ENTITY); // REJECTED = regra de negócio

    return body;
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId', ParseUUIDPipe) transactionId: string) {
    const tx = await this.em.fork().findOne(WagerTransactionEntity, { id: transactionId });
    if (!tx) throw new NotFoundException('transaction not found');
    return this.toResponse(tx);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const tx = await this.em.fork().findOne(WagerTransactionEntity, {
      providerId,
      externalTransactionId,
    });
    if (!tx) throw new NotFoundException('transaction not found');
    return this.toResponse(tx);
  }

  private toResponse(tx: WagerTransactionEntity) {
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      money: { amount: tx.amount, currency: tx.currency },
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      status: tx.status,
      failureCode: tx.failureCode ?? null,
      resultingBalance: tx.resultingBalance
        ? { amount: tx.resultingBalance, currency: tx.currency }
        : null,
      createdAt: tx.createdAt,
      processedAt: tx.processedAt ?? null,
    };
  }
}