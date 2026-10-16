import {
  ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger,
} from '@nestjs/common';
import {
  IdempotencyConflictError,
  IdempotencyRaceUnresolvedError,
} from '../../application/submit-wager-transaction.use-case';
import { WalletAlreadyExistsError } from '../../application/create-wallet.use-case';
import { MoneyError } from '../../domain/money/money';

/**
 * Mapeamento consistente entre TODOS os endpoints:
 *   400 payload invalido (ValidationPipe/MoneyError)
 *   404 nao encontrado
 *   409 conflito (idempotencia, wallet duplicada)
 *   422 rejeicao de NEGOCIO (vinda como resultado, nao excecao)
 *   202 aceite com processamento pendente
 *   503 falha transitoria de infraestrutura
 *   500 falha nao tratada — SEM vazar exception.message (pode conter SQL/dados)
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const req = ctx.getRequest();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      res.status(status).json(
        typeof response === 'object' && response !== null
          ? response
          : { statusCode: status, message: response },
      );
      return;
    }

    let statusCode: number;
    let error: string;

    if (exception instanceof IdempotencyConflictError) {
      statusCode = HttpStatus.CONFLICT;
      error = 'IdempotencyConflict';
    } else if (exception instanceof WalletAlreadyExistsError) {
      statusCode = HttpStatus.CONFLICT;
      error = 'WalletAlreadyExists';
    } else if (exception instanceof IdempotencyRaceUnresolvedError) {
      statusCode = HttpStatus.SERVICE_UNAVAILABLE;
      error = 'TransientInfrastructure';
    } else if (exception instanceof MoneyError) {
      statusCode = HttpStatus.BAD_REQUEST;
      error = exception.code;
    } else {
      this.logger.error({
        msg: 'unhandled exception',
        path: req.url,
        error: exception instanceof Error ? exception.stack : String(exception),
      });
      statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
      error = 'InternalError';
    }

    res.status(statusCode).json({
      statusCode,
      error,
      message: statusCode === HttpStatus.INTERNAL_SERVER_ERROR
        ? 'unexpected error'
        : exception instanceof Error ? exception.message : 'unknown error',
      path: req.url,
    });
  }
}
