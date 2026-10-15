import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/config/mikro-orm.config';

const orm = await MikroORM.init(config);
const migrator = orm.migrator;
const result = await migrator.up();
await orm.close(true);
console.log('✅ migrations aplicadas:', result.length);