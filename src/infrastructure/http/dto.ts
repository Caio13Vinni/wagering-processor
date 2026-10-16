import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class MoneyDto {
  /** String decimal, ate 17 digitos inteiros + 2 casas — rejeita notacao cientifica,
   * NaN, Infinity e estouro do numeric(19,2)  */
  @Matches(/^\d{1,17}(\.\d{1,2})?$/, { message: 'amount must be a decimal string with up to 2 places and 17 integer digits' })
  amount!: string;

  @IsIn(['BRL'], { message: 'currency must be BRL' })
  currency!: string;
}

export class CreateWalletDto {
  @IsUUID() 
  playerId!: string;

  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}

export class SubmitWagerTransactionDto {
  @IsString()
  @MaxLength(64)
  providerId!: string;

  @IsString()
  @MaxLength(128)
  externalTransactionId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  @MaxLength(128)
  roundId!: string;

  @IsString()
  @MaxLength(128)
  gameId!: string;

  @IsIn(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'])
  kind!: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  referenceExternalTransactionId?: string;
}
