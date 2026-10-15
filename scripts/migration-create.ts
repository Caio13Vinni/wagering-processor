import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/config/mikro-orm.config';

const orm = await MikroORM.init(config);
const migrator = orm.getMigrator();
await migrator.createMigration();
await orm.close(true);
console.log('✅ migration criada em ./migrations');