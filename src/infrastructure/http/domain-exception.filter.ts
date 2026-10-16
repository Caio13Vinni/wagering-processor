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
 *   400 payload inválido (ValidationPipe/MoneyError)
 *   404 não encontrado
 *   409 conflito (idempotência, wallet duplicada)
 *   422 rejeição de NEGÓCIO (vinda como resultado, não exceção)
 *   202 aceite com processamento pendente
 *   503 falha transitória de infraestrutura
 *   500 falha não tratada
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const req = ctx.getRequest();

    // 1. exceções HTTP do Nest (ValidationPipe, NotFoundException, etc.) passam com o status delas
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

    // 2. exceções de domínio
    let statusCode: number;
    let error: string;

    if (exception instanceof IdempotencyConflictError) {
      statusCode = HttpStatus.CONFLICT; // 409
      error = 'IdempotencyConflict';
    } else if (exception instanceof WalletAlreadyExistsError) {
      statusCode = HttpStatus.CONFLICT; // 409
      error = 'WalletAlreadyExists';
    } else if (exception instanceof IdempotencyRaceUnresolvedError) {
      statusCode = HttpStatus.SERVICE_UNAVAILABLE; // 503 transitório
      error = 'TransientInfrastructure';
    } else if (exception instanceof MoneyError) {
      statusCode = HttpStatus.BAD_REQUEST; // 400
      error = exception.code;
    } else {
      // 3. desconhecido = falha não tratada
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
      message: exception instanceof Error ? exception.message : 'unknown error',
      path: req.url,
    });
  }
}