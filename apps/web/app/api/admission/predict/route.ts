/**
 * 把現在的級分預測**落地一份**，供日後校準。
 *
 * # 為什麼落地要是一個明確的動作
 *
 * 因為 `GradePrediction` 不是快取，是**證據**。規格書 §6.2：「預測系統
 * 若不追蹤自己的準確度，就只是在製造好看的數字。」那張表存的是
 * 「我們在某一天對這位學生說了什麼」，等學測成績出來之後拿來對答案。
 *
 * 如果它在每次讀頁面時自動寫入，那張表會塞滿同一個預測的幾百份複本，
 * 於是校準曲線的每一筆權重變成「這位學生重整了幾次頁面」——而那條
 * 曲線是這整套東西唯一的品質訊號。
 *
 * # 資料不足的科目不會被落地，而回應要說出來
 *
 * `thin` 的科目沒有區間（`predictGrade()` 刻意不給），所以寫不進那張表
 * （`intervalLow` 是 NOT NULL）。要寫就得編一個區間，而那個編出來的
 * 區間會進入校準曲線、讓曲線看起來很健康——也就是說補值會破壞掉唯一
 * 能檢查樣本門檻訂得對不對的機制。
 *
 * 所以回應裡有 `skipped`：學生按了「存一份」而只存了三科的時候，
 * 畫面要說得出另外三科為什麼沒存。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  admissionYearOf,
  myPredictionHistory,
  predictionsFor,
  savePredictions,
} from '@/lib/predictDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const Body = z.object({
  year: z.number().int().min(100).max(200).optional(),
  /**
   * 目標信心水準。畫面上讓學生切 60/70/80——**這不是讓他把區間調到好看**，
   * 而是讓他看到同一份資料在不同信心下區間差多少。那個對比比任何一句
   * 說明都能講清楚不確定性是什麼。
   */
  confidence: z.number().min(0.5).max(0.95).optional(),
});

const STUDENT_ONLY = '級分預測是學生自己的東西。老師要看的是校準報告（/admission/calibration）。';

export const GET = scopedRoute(async (req: NextRequest, { user }) => {
  if (user.systemRole !== 'STUDENT') {
    return NextResponse.json({ error: STUDENT_ONLY }, { status: 403 });
  }
  const url = new URL(req.url);
  const year = Number(url.searchParams.get('year')) || admissionYearOf();
  const confidence = Number(url.searchParams.get('confidence'));
  const [now, history] = await Promise.all([
    predictionsFor(user.id, year, Number.isFinite(confidence) ? confidence : undefined),
    myPredictionHistory(user.id, year),
  ]);
  return NextResponse.json({ ...now, history });
});

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  if (user.systemRole !== 'STUDENT') {
    return NextResponse.json({ error: STUDENT_ONLY }, { status: 403 });
  }
  const parsed = Body.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json({ error: '參數不正確' }, { status: 400 });

  const year = parsed.data.year ?? admissionYearOf();
  const saved = await savePredictions(user.id, year, parsed.data.confidence);
  const [now, history] = await Promise.all([
    predictionsFor(user.id, year, parsed.data.confidence),
    myPredictionHistory(user.id, year),
  ]);
  return NextResponse.json({ ...now, history, saved });
});
