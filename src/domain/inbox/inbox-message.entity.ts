import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/core';

@Entity({ tableName: 'inbox_messages' })
@Unique({ properties: ['consumerName', 'messageId'] })
export class InboxMessageEntity {
  @PrimaryKey({ length: 128 })
  messageId!: string;

  @Property({ length: 64 })
  consumerName!: string;

  @Property({ length: 64 })
  payloadHash!: string;

  @Property({ type: 'datetime' })
  receivedAt: Date = new Date();

  @Property({ type: 'datetime', nullable: true })
  processedAt?: Date;
}