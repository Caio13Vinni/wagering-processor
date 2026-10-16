import { Migration } from '@mikro-orm/migrations';

export class Migration20261016211243 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "inbox_messages" ("message_id" varchar(128) not null, "consumer_name" varchar(64) not null, "payload_hash" varchar(64) not null, "received_at" timestamptz not null, "processed_at" timestamptz null, constraint "inbox_messages_pkey" primary key ("message_id"));`);
    this.addSql(`alter table "inbox_messages" add constraint "inbox_messages_consumer_name_message_id_unique" unique ("consumer_name", "message_id");`);

    this.addSql(`create table "outbox_messages" ("id" uuid not null, "aggregate_id" uuid not null, "event_type" varchar(64) not null, "payload" jsonb not null, "occurred_at" timestamptz not null, "attempts" int not null default 0, "next_attempt_at" timestamptz null, "published_at" timestamptz null, "lease_owner" varchar(16) null, "leased_until" timestamptz null, constraint "outbox_messages_pkey" primary key ("id"));`);
    this.addSql(`create index "outbox_messages_lease_owner_index" on "outbox_messages" ("lease_owner");`);

    this.addSql(`create table "wager_transactions" ("id" uuid not null, "provider_id" varchar(64) not null, "external_transaction_id" varchar(128) not null, "idempotency_key" varchar(255) not null, "payload_hash" varchar(64) not null, "wallet_id" uuid not null, "player_id" uuid not null, "round_id" varchar(128) not null, "game_id" varchar(128) not null, "kind" varchar(32) not null, "amount" numeric(19,2) not null, "currency" char(3) not null, "reference_external_transaction_id" varchar(128) null, "reference_transaction_id" uuid null, "status" varchar(32) not null, "failure_code" varchar(48) null, "resulting_balance" numeric(19,2) null, "attempts" int null default 0, "next_attempt_at" timestamptz null, "created_at" timestamptz not null, "processed_at" timestamptz null, constraint "wager_transactions_pkey" primary key ("id"), constraint chk_tx_amount check (amount >= 0));`);
    this.addSql(`create index "wager_transactions_provider_id_index" on "wager_transactions" ("provider_id");`);
    this.addSql(`create index "wager_transactions_wallet_id_index" on "wager_transactions" ("wallet_id");`);
    this.addSql(`create index "wager_transactions_status_index" on "wager_transactions" ("status");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_provider_id_external_transaction_id_unique" unique ("provider_id", "external_transaction_id");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_idempotency_key_unique" unique ("idempotency_key");`);

    this.addSql(`create table "wallets" ("id" uuid not null, "player_id" uuid not null, "currency" char(3) not null, "balance" numeric(19,2) not null, "version" int not null default 1, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "wallets_pkey" primary key ("id"), constraint wallets_check check (balance >= 0));`);
    this.addSql(`alter table "wallets" add constraint "wallets_player_id_currency_unique" unique ("player_id", "currency");`);

    this.addSql(`create table "wallet_ledger" ("id" uuid not null, "wallet_id" uuid not null, "transaction_id" uuid not null, "direction" varchar(6) not null, "amount" numeric(19,2) not null, "currency" char(3) not null, "balance_before" numeric(19,2) not null, "balance_after" numeric(19,2) not null, "created_at" timestamptz not null, constraint "wallet_ledger_pkey" primary key ("id"), constraint chk_ledger_amount check (amount > 0), constraint chk_ledger_direction check (direction in ('DEBIT', 'CREDIT')));`);
    this.addSql(`create index "wallet_ledger_wallet_id_index" on "wallet_ledger" ("wallet_id");`);
    this.addSql(`alter table "wallet_ledger" add constraint "wallet_ledger_transaction_id_unique" unique ("transaction_id");`);

    // FKs (nao gerados pelo diff das entities)
    this.addSql(`alter table wallet_ledger add constraint fk_ledger_wallet foreign key (wallet_id) references wallets (id) deferrable initially deferred;`);
    this.addSql(`alter table wager_transactions add constraint fk_tx_wallet foreign key (wallet_id) references wallets (id) deferrable initially deferred;`);
    this.addSql(`alter table wager_transactions add constraint fk_tx_reference foreign key (reference_transaction_id) references wager_transactions (id) deferrable initially deferred;`);

    // ledger append-only — trigger nao expressavel em entity
    this.addSql(`create or replace function prevent_ledger_mutation() returns trigger as $$
      begin
        raise exception 'wallet_ledger is append-only: mutations are not allowed';
      end;
      $$ language plpgsql;`);
    this.addSql(`create trigger wallet_ledger_no_update_delete
      before update or delete on wallet_ledger
      for each row execute function prevent_ledger_mutation();`);

    // reversao unica por tipo (regra 4) no schema — mata a race do reprocess
    this.addSql(`create unique index ux_wager_reversal_once on wager_transactions (provider_id, reference_external_transaction_id, kind) where status = 'PROCESSED' and reference_external_transaction_id is not null;`);

    // indices dos workers
    this.addSql(`create index ix_wager_pending on wager_transactions (status, next_attempt_at) where status = 'PENDING_REFERENCE';`);
    this.addSql(`create index ix_outbox_pending on outbox_messages (next_attempt_at) where published_at is null;`);    

  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "inbox_messages" cascade;`);

    this.addSql(`drop table if exists "outbox_messages" cascade;`);

    this.addSql(`drop table if exists "wager_transactions" cascade;`);

    this.addSql(`drop table if exists "wallets" cascade;`);

    this.addSql(`drop table if exists "wallet_ledger" cascade;`);
  }

}


