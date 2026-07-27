/**
 * 存活探測。刻意不打任何外部相依 —— 理由見 readyz 的註解。
 */
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const startedAt = Date.now();

export async function GET() {
  return NextResponse.json(
    {
      alive: true,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      pid: process.pid,
    },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
