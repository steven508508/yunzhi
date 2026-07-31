/**
 * 個申落點模擬：跑一次，或看上一次跑的。
 *
 * # 為什麼 GET 不重跑
 *
 * 因為每一次模擬都會寫一列 `SimulationRun`（含輸入快照），而那張表存在
 * 的理由是「這個數字是什麼時候算的、用的是哪一份資料」。每次打開頁面
 * 都重跑的話，它會塞滿一模一樣的列，然後那個問題就答不出來了。
 *
 * 所以 GET 回的是**上一次的結果加上它的計算時間**，重跑是 POST。
 * 畫面上要看得出「這是三天前算的」——一份三天前的機率與剛剛算的，
 * 在學生眼裡長得一樣。
 *
 * # 這是這個系統裡唯一合法出現機率的地方
 *
 * `lib/adviceGuard.mjs` 會擋掉所有機率形式的輸出，而那一層擋的是
 * **AI 產生的文字**。這裡的數字是確定性計算的結果：輸入有快照、亂數有
 * 固定種子，所以任何一個數字都可以被重算出一模一樣的值。
 *
 * 兩者共存的方式是**分開通道**，不是放寬閘門：模擬的機率只出現在這一支
 * 的回應與對應的畫面上，而 `placementAdvicePayload()`（送給 AI 老師的
 * 脈絡）裡**沒有任何機率欄位**。詳見 `lib/placement.mjs` §8。
 *
 * # 每一個機率旁邊都要有它的資料基礎
 *
 * 規格書 §8.4：用了哪幾年的資料、可靠度分數、最後更新日期。這一支的
 * 回應裡那三樣東西是**每一個志願物件的一部分**（`thresholdYears`、
 * `reliability`、`thresholdRefs[].lookedUpAt`），不是另外一個欄位——
 * 分開放的話，畫面上遲早只剩機率。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { DEFAULT_DRAWS } from '@/lib/placement.mjs';
import { admissionYearOf, latestPlacement, placementRuns, runPlacement } from '@/lib/predictDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const Body = z.object({
  year: z.number().int().min(100).max(200).optional(),
  /**
   * 抽樣次數。規格書 §8.2 指定 10000，這裡允許調小是為了在資料很多的
   * 機器上還能在 5 秒內回應（§8.5 的驗收準則）。**不允許調大**：
   * 更多的抽樣不會讓門檻資料變準，只會讓一個建立在三年極值上的估計
   * 多幾位不存在的有效數字。
   */
  draws: z.number().int().min(1000).max(DEFAULT_DRAWS).optional(),
  confidence: z.number().min(0.5).max(0.95).optional(),
});

const STUDENT_ONLY =
  '落點模擬是學生自己的東西——它吃他自己的級分記錄與他自己查來的門檻。' +
  '老師要看班上的狀況：進「班級」點一個班，那一頁上有「升學總覽」。';

export const GET = scopedRoute(async (req: NextRequest, { user }) => {
  if (user.systemRole !== 'STUDENT') {
    return NextResponse.json({ error: STUDENT_ONLY }, { status: 403 });
  }
  const year = Number(new URL(req.url).searchParams.get('year')) || admissionYearOf();
  const [latest, runs] = await Promise.all([
    latestPlacement(user.id, year),
    placementRuns(user.id, year, 8),
  ]);
  return NextResponse.json({ year, latest, runs });
});

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  if (user.systemRole !== 'STUDENT') {
    return NextResponse.json({ error: STUDENT_ONLY }, { status: 403 });
  }
  const parsed = Body.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json({ error: '參數不正確' }, { status: 400 });

  const year = parsed.data.year ?? admissionYearOf();
  const out = await runPlacement(user.id, year, {
    draws: parsed.data.draws ?? DEFAULT_DRAWS,
    confidence: parsed.data.confidence,
  });
  const runs = await placementRuns(user.id, year, 8);
  return NextResponse.json({ year, ...out, runs });
});
