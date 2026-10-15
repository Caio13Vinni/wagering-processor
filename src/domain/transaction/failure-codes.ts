export enum FailureCode {
  // Erros de validação do payload
  InvalidAmount = 'INVALID_AMOUNT',
  UnsupportedCurrency = 'UNSUPPORTED_CURRENCY',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  UnknownKind = 'UNKNOWN_KIND',
  OpeningNotAllowed = 'OPENING_NOT_ALLOWED',
  MissingReference = 'MISSING_REFERENCE',
  // Rejeições de negócio
  InsufficientBalance = 'INSUFFICIENT_BALANCE',
  InsufficientBalanceForReversal = 'INSUFFICIENT_BALANCE_FOR_REVERSAL',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  ReferenceScopeMismatch = 'REFERENCE_SCOPE_MISMATCH', // provider/player/wallet/round divergente
  ReferenceAlreadyReverted = 'REFERENCE_ALREADY_REVERTED',
  AmountMismatch = 'AMOUNT_MISMATCH', // reversão parcial não suportada
  SelfReference = 'SELF_REFERENCE',
}

/* 
caso use a msg de error em ptbr, apenas comente o código acima e descomente o código abaixo.
*/

// export enum FailureCode {
//   // Erros de validação do payload
//   ValorInvalido = 'VALOR_INVALIDO',
//   MoedaNaoSuportada = 'MOEDA_NAO_SUPORTADA',
//   DivergenciaDeMoeda = 'DIVERGENCIA_DE_MOEDA',
//   TipoDesconhecido = 'TIPO_DESCONHECIDO',
//   AberturaNaoPermitida = 'ABERTURA_NAO_PERMITIDA',
//   ReferenciaAusente = 'REFERENCIA_AUSENTE',
//   // Rejeições de negócio (terminais)
//   SaldoInsuficiente = 'SALDO_INSUFICIENTE',
//   SaldoInsuficienteParaEstorno = 'SALDO_INSUFICIENTE_PARA_ESTORNO',
//   ReferenciaNaoEncontrada = 'REFERENCIA_NAO_ENCONTRADA',
//   ReferenciaNaoProcessada = 'REFERENCIA_NAO_PROCESSADA',
//   TipoDeReferenciaInvalido = 'TIPO_DE_REFERENCIA_INVALIDO',
//   DivergenciaDeEscopoDeReferencia = 'DIVERGENCIA_DE_ESCOPO_DE_REFERENCIA', // provedor/jogador/carteira/rodada divergente
//   ReferenciaJaEstornada = 'REFERENCIA_JA_ESTORNADA',
//   DivergenciaDeValor = 'DIVERGENCIA_DE_VALOR', // reversão parcial não suportada
//   AutoReferencia = 'AUTO_REFERENCIA',
// }