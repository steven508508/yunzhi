/**
 * 當年度的件數與容量上限。
 *
 * # 這幾個數字是資料不是常數，而且填的人要說得出來源
 *
 * 每年簡章可能改。寫死在程式裡的那一版，明年會用去年的規則擋住學生，
 * 而且**擋錯的方向是「你超過上限了」而他其實沒有**——他會相信系統
 * 然後刪掉一件該留的，而那件素材通常就沒了（他不會為了系統的一句話
 * 去重做一份實驗報告）。
 *
 * 所以 `sourceRef`（抄自哪一份簡章的哪一頁）是必填，而且沒有建檔時
 * 畫面上會一直顯示「這是預設值，請對照當年度的簡章」。
 *
 * 只有校務管理員能寫：這幾個數字影響全校每一位學生。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { admissionYearOf, limitsFor, portfolioFailure, saveLimits } from '@/lib/portfolioDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const Body = z.object({
  year: z.number().int().min(100).max(200).optional(),
  sourceRef: z.string().min(4).max(300),
  outcomePerYear: z.number().int().positive().max(50).optional(),
  diversePerYear: z.number().int().positive().max(50).optional(),
  outcomeSelected: z.number().int().positive().max(50).optional(),
  diverseSelected: z.number().int().positive().max(50).optional(),
  summaryChars: z.number().int().positive().max(20000).optional(),
  summaryImages: z.number().int().positive().max(50).optional(),
  docBytes: z.number().int().positive().optional(),
  mediaBytes: z.number().int().positive().optional(),
});

export const GET = scopedRoute(async (req: NextRequest, { user }) => {
  void user;
  const url = new URL(req.url);
  const year = Number(url.searchParams.get('year')) || admissionYearOf();
  return NextResponse.json(await limitsFor(year));
});

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  const parsed = Body.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: '參數不正確。請確認每一個數字都是正整數，而且填了這些數字抄自哪一份簡章的哪一頁。' },
      { status: 400 },
    );
  }
  try {
    const { year, ...patch } = parsed.data;
    return NextResponse.json(await saveLimits(user, year ?? admissionYearOf(), patch));
  } catch (e) {
    const { status, body } = portfolioFailure(e);
    return NextResponse.json(body, { status });
  }
});
