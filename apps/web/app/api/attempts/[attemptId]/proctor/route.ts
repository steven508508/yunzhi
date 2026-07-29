/**
 * 考試期間的行為事件。學生端寫，老師端讀（讀那一側走頁面，不走這裡）。
 *
 * # 這一支失敗不可以有任何後果
 *
 * 它收的是輔助資料——切走幾次、離開多久。學生的答案不走這條路。
 * 所以：
 *
 *   · 前端拿到非 2xx 時**直接把那一批丟掉**，不重試、不排隊、不擋存檔
 *   · 這裡不做任何會讓請求變慢的事（不算分、不寫稽核、不通知）
 *   · 收不下的（作答已經結束、已經滿了）回 200 加一個數字，不回錯誤——
 *     回錯誤只會讓前端的錯誤處理多一條沒有用的分支
 *
 * 反過來說也成立：**這一支不可以變成一個能拖慢作答的入口**。批次上限
 * 40 筆、每份作答上限 1000 列，兩道都在收下之前就擋住。
 *
 * # meta 是一個封閉的形狀，不是任意 JSON
 *
 * `ProctorEvent.meta` 在 schema 上是 jsonb，而 jsonb 加上 `z.any()`
 * 等於開了一個「什麼都存得進去」的洞——包括貼上的內容本身，而不記錄
 * 貼上的內容正是這個功能的前提之一（那可能是學生自己打的草稿）。
 * 所以這裡用 `.strict()` 鎖死三個數字欄位：多一個鍵就整批 400。
 *
 * # 時刻由伺服器算
 *
 * 前端送的是「幾毫秒之前」，不是時刻。理由與倒數以伺服器為準完全相同：
 * 改系統時間就能偽造時刻，而這個功能的使用者正是有動機改系統時間的人。
 * 換算與夾範圍在 `lib/proctorDb.ts`。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { PROCTOR, PROCTOR_TYPES, type ProctorType } from '@/lib/proctor.mjs';
import { recordProctorEvents } from '@/lib/proctorDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

/** **只有數字。** 沒有任何一個欄位放得下貼上的內容或作答的內容。 */
const Meta = z
  .object({
    /** 貼上的字元數。 */
    chars: z.number().int().min(0).max(1_000_000).optional(),
    /** 合併了幾次貼上。 */
    count: z.number().int().min(1).max(10_000).optional(),
    /** 這一段離開由幾次 blur／hidden 合併而來（見 lib/proctor.mjs）。 */
    bursts: z.number().int().min(1).max(10_000).optional(),
  })
  .strict();

const Event = z.object({
  type: z.enum(PROCTOR_TYPES as [ProctorType, ...ProctorType[]]),
  /** 這件事發生在幾毫秒之前。前端用單調時鐘算，所以改系統時間不影響。 */
  atOffsetMs: z.number().int().min(0).max(PROCTOR.MAX_OFFSET_MS),
  // 三個 `.default(null)` 不只是省事：少了它，「沒有送」與「送了 null」
  // 在型別上是兩件事，而資料層要為那個差別多一條分支——而那條分支
  // 存在的唯一理由是 zod 的預設行為，不是任何真實的區別。
  durationMs: z.number().int().min(0).max(PROCTOR.MAX_OFFSET_MS).nullable().default(null),
  // 題號上限給得寬：一份 200 題的模擬卷是存在的，而擋錯的代價是
  // 整批 400，連帶把同一批裡正常的事件一起丟掉。
  questionOrder: z.number().int().min(1).max(500).nullable().default(null),
  meta: Meta.nullable().default(null),
});

const Body = z.object({
  events: z.array(Event).min(1).max(PROCTOR.MAX_BATCH),
});

/**
 * 收一批事件。
 *
 * **是 POST 而不是 PATCH**，因為 `navigator.sendBeacon` 只能送 POST，
 * 而分頁關閉時的那一次 beacon 正是最該送到的一次——「他切走之後就
 * 沒有再回來」只有在那個時候送得出去。作答存檔那一支為了同一個理由
 * 多了一行 `export const POST = PATCH`，這裡直接就是 POST。
 *
 * 可以重複送：重複的事件會變成重複的列，但前端送出去之後就把那一批
 * 清掉了，唯一會重送的情況是 beacon 與正常送出撞在一起——那時多幾列
 * 一模一樣的記錄，比丟掉「他離開了」這件事好。
 */
export const POST = scopedRoute<{ attemptId: string }>(
  async (req: NextRequest, { user, params }) => {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: '請求格式錯誤' }, { status: 400 });
    }

    try {
      const result = await recordProctorEvents(
        params.attemptId,
        user.id,
        parsed.data.events,
      );
      return NextResponse.json(result);
    } catch (e) {
      // 這一支出錯絕對不能變成學生畫面上的一句話。記在伺服器的日誌裡，
      // 對前端就是一個它會忽略的狀態碼。
      console.error('[proctor] 寫入行為事件失敗', e);
      return NextResponse.json({ error: '沒有記錄下來' }, { status: 500 });
    }
  },
);
