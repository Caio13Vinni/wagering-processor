import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { EntityManager } from '@mikro-orm/postgresql';
import { orm } from './config/orm';
import { CreateWalletUseCase } from './application/create-wallet.use-case';
import { SubmitWagerTransactionUseCase } from './application/submit-wager-transaction.use-case';
import { WalletController } from './infrastructure/http/wallet.controller';
import { WageringController } from './infrastructure/http/wagering.controller';
import { HealthController } from './infrastructure/http/health.controller';
import { DomainExceptionFilter } from './infrastructure/http/domain-exception.filter';
import { SqsConsumer } from './infrastructure/sqs/sqs-consumer';
import { OutboxPublisherWorker } from './workers/outbox-publisher.worker';
import { PendingReferenceWorker } from './workers/pending-reference.worker';
import { MetricsController } from './infrastructure/http/metrics.controller';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [WalletController, WageringController, HealthController, MetricsController],
  providers: [
    { provide: EntityManager, useValue: orm.em.fork() },
    CreateWalletUseCase,
    SubmitWagerTransactionUseCase,
    SqsConsumer,
    OutboxPublisherWorker,
    PendingReferenceWorker,
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule {}