import { resolve } from 'path';

export function resolveSqliteFileUrl(rawUrl?: string): string {
  const input = (rawUrl ?? process.env.DATABASE_URL ?? 'file:./dev.db').trim();
  if (input === ':memory:' || input === 'file::memory:') {
    return 'file::memory:';
  }
  if (input.startsWith('file:')) {
    const rest = input.slice('file:'.length);
    const absPath =
      rest.startsWith('./') || rest.startsWith('.\\')
        ? resolve(process.cwd(), 'prisma', rest.slice(2))
        : resolve(process.cwd(), rest);
    return `file:${absPath.replace(/\\/g, '/')}`;
  }
  return input;
}
