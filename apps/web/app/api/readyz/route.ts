/**
 * 就緒探測。
 *
 * 與 /api/healthz 的分工必須講清楚，因為搞混會造成兩種相反的災難：
 *
 *   healthz（存活）— 只回答「這個行程還活著嗎」。永遠不打外部相依。
 *                    它失敗代表容器該被重啟。
 *                    如果讓它去檢查資料庫，資料庫短暫抖動就會讓
 *                    Docker 把所有 web 容器連環重啟，把小故障
 *                    放大成全面停機。
 *
 *   readyz（就緒）— 回答「現在可以接流量嗎」。要打資料庫與 Redis。
 *                    它失敗代表把流量導去別的實例，但**不要重啟**。
 *
 * Caddy 的 health_uri 指向 readyz，Docker 的 healthcheck 也用 readyz
 * （因為 compose 沒有分開的就緒概念），但 restart policy 靠的是行程
 *  真的退出，而不是 healthcheck 失敗 —— 這是刻意的。
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type CheckResult = {
  ok: boolean;
  latencyMs: number;
  error?: string;
};

async function timed(fn: () => Promise<unknown>): Promise<CheckResult> {
  const t0 = performance.now();
  try {
    await fn();
    return { ok: true, latencyMs: Math.round(performance.now() - t0) };
  } catch (e) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - t0),
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function GET() {
  // 逾時保護：探測本身不能卡住。資料庫掛住時，沒有逾時的探測
  // 會讓 Caddy 的健康檢查排隊堆積，最後連健康的實例也拿不到流量。
  const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, rej) =>
        setTimeout(() => rej(new Error(`逾時 ${ms}ms`)), ms),
      ),
    ]);

  const [database, cache] = await Promise.all([
    timed(() => withTimeout(prisma.$queryRaw`SELECT 1`, 3000)),
    timed(() => withTimeout(redis.ping(), 2000)),
  ]);

  // AI 服務不列入就緒條件。這是規格書文件 01 §16 的降級要求：
  // AI 不可用時，作答、客觀題評分、檢視已生成的解析必須照常運作。
  // 把 AI 納入 readyz 會讓 AI 掛掉直接演變成整個考試系統不可用。
  const ready = database.ok && cache.ok;

  return NextResponse.json(
    {
      ready,
      checks: { database, cache },
      timestamp: new Date().toISOString(),
    },
    {
      status: ready ? 200 : 503,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    },
  );
}
