import { PrismaClient } from '@prisma/client';

/**
 * 單例。Next.js 在開發模式下會熱重載模組，每次重載都 new 一個
 * PrismaClient 會很快耗盡 Postgres 的連線數。
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.LOG_LEVEL === 'debug'
        ? ['query', 'warn', 'error']
        : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
