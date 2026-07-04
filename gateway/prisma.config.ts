import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // `prisma generate` runs without a database (build images, CI); only
    // migrate commands need a real URL, and they always receive one via env.
    url: process.env.DATABASE_URL ?? 'postgresql://placeholder:5432/placeholder',
    // Only `prisma migrate diff --from-migrations` (used when authoring
    // new migrations against a throwaway database) needs this.
    ...(process.env.SHADOW_DATABASE_URL !== undefined && {
      shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
    }),
  },
});
