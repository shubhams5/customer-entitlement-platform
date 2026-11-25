import { PrismaLibSQL } from '@prisma/adapter-libsql';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { defineConfig } from 'prisma/config';
import { resolveSqliteFileUrl } from './src/common/prisma/sqlite-url';

const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      const rawVal = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (process.env[key] === undefined) {
        process.env[key] = rawVal;
      }
    }
  }
}

export default defineConfig({
  experimental: {
    adapter: true,
  },
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'ts-node prisma/seed.ts',
  },
  engine: 'js',
  adapter: async () => {
    const url = resolveSqliteFileUrl(process.env.DATABASE_URL);
    return new PrismaLibSQL({ url });
  },
});
