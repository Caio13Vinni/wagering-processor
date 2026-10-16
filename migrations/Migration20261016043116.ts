import { Migration } from '@mikro-orm/migrations';

export class Migration20261016043116 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "wager_transactions" alter column "status" type varchar(32) using ("status"::varchar(32));`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "wager_transactions" alter column "status" type varchar(16) using ("status"::varchar(16));`);
  }

}
