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

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [WalletController, WageringController, HealthController],
  providers: [
    // DI do EntityManager no lugar do MikroOrmModule (incompatível com Bun)
    { provide: EntityManager, useValue: orm.em.fork() },
    CreateWalletUseCase,
    SubmitWagerTransactionUseCase,
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule {}