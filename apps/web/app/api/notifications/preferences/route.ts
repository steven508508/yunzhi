/**
 * 我的通知設定。
 *
 * # 為什麼有些通知關不掉，而且擋在伺服器端
 *
 * 「作答被作廢」「老師代為結算」「作廢被撤銷」這三則不可以關閉。
 * 規則說得出來：**凡是「別人動了你的成績」的事件都不可關閉**
 * （完整理由見 `lib/notifyTemplates.mjs` 的 `MANDATORY`）。
 *
 * 而**畫面上把核取方塊設成 disabled 不是保護**——直接對這一支送
 * `{"attempt.voided": false}` 一樣是一次合法的請求。所以判斷在
 * `buildChannels`（`lib/notify.mjs`，純函式、有測試）裡：必收的代號
 * 就算送進來也不寫入。這一支只負責把身分接上。
 *
 * 靜靜地忽略而不是回 400，是刻意的：使用者沒有做錯任何事（他按到的
 * 是一個停用的方塊，或者他的瀏覽器把停用的欄位一起送出了），
 * 而一個錯誤訊息在這裡只會讓他以為整份設定沒有存到。
 * 回傳的是**存完之後的實際狀態**，所以畫面會自己顯示那一格仍然開著。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { loadPreference, savePreference } from '@/lib/notifyDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

/** 「22:00」。分鐘一律兩位數——`2:0` 這種值會讓 `parseQuietHours` 讀不懂而靜靜地失效。 */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const Body = z.object({
  /** templateKey → 收不收。沒列到的維持原狀？**不是——沒列到就是「收」。** */
  wanted: z.record(z.boolean()),
  quietHours: z
    .object({ start: z.string().regex(HHMM), end: z.string().regex(HHMM) })
    .nullable()
    .optional(),
});

export const GET = scopedRoute(async (_req, { user }) => {
  return NextResponse.json(await loadPreference(user.id));
});

export const PUT = scopedRoute(async (req: NextRequest, { user }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          '設定的格式不對。免打擾時段要填 24 小時制的「時:分」，例如 22:00 到 07:00。',
      },
      { status: 400 },
    );
  }

  // 開始與結束相同的免打擾時段等於「一整天都不要打擾」，而它的實際
  // 效果是一則通知都不會出現。`parseQuietHours` 會把它讀成「沒有設定」，
  // 但在這裡先擋下來，訊息才說得出原因——否則使用者存了一個看起來
  // 有效的設定，回來卻發現它變成空的。
  const q = parsed.data.quietHours;
  if (q && q.start === q.end) {
    return NextResponse.json(
      {
        error:
          '免打擾的開始與結束時間一樣，那等於一整天都不打擾——通知會全部收不到。' +
          '要完全不收某一類通知，請把那一類關掉。',
      },
      { status: 400 },
    );
  }

  const saved = await savePreference(user.id, {
    wanted: parsed.data.wanted,
    quietHours: q ?? null,
  });
  return NextResponse.json({ ok: true, ...saved });
});
