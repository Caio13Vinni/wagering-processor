import { defineConfig } from '@mikro-orm/postgresql';
import { env } from './env';

export default defineConfig({
  dbName: env.db.name,
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  entities: ['./src/domain/**/*.entity.ts'],
  migrations: {
    path: './migrations',
    transactional: true,
    allOrNothing: true,
  },
});