import { PrismaClient } from '@prisma/client';

import { tenantScoped } from '@/lib/prismaClient.mjs';

/**
 * 單例。Next.js 在開發模式下會熱重載模組，每次重載都 new 一個
 * PrismaClient 會很快耗盡 Postgres 的連線數。
 *
 * 這個 client 會在每一次查詢前把「現在是哪個租戶」告訴資料庫，
 * 讓 row-level security 生效——實作與理由見 `lib/prismaClient.mjs`，
 * 租戶脈絡怎麼建立見 `lib/tenant.ts`。
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  (tenantScoped(
    new PrismaClient({
      log:
        process.env.LOG_LEVEL === 'debug'
          ? ['query', 'warn', 'error']
          : ['warn', 'error'],
    }),
  ) as unknown as PrismaClient);

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
