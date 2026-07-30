/**
 * 把通知標成已讀。
 *
 * # 為什麼「已讀」需要一支 API
 *
 * 因為未讀數必須有辦法歸零，而**「處理完那件事」不是歸零的條件**。
 * 一則「作業快到期」的通知在他寫完作業之後不會自動變成已讀——
 * 它們是兩件不同的事（收件匣說「發生了什麼」，首頁待辦說「該做什麼」，
 * 分界寫在 `app/(app)/inbox/page.tsx`）。歸零的條件只有一個：**他看過了。**
 *
 * 所以收件匣一打開就把畫面上那幾則標起來（`ids`），而清單超過一頁時
 * 有一顆「全部標成已讀」（`all`）。少了後者，一個累積了三個月未讀的
 * 帳號要翻六頁才能讓數字歸零，而沒有人會翻。
 *
 * # 為什麼 `all` 是一個明確的參數，不是「不給 ids 就是全部」
 *
 * 因為前端送出一個空陣列是很平常的事（沒有東西可標的那一頁），
 * 而「空陣列 = 全部」會讓一次無害的呼叫清掉他所有的未讀。
 * 那種錯誤沒有任何症狀——數字歸零看起來正是預期的結果。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { markRead, unread } from '@/lib/notifyDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const Body = z.object({
  /** 這幾則。上限是為了擋一次送十萬個 id 的請求。 */
  ids: z.array(z.string().min(1)).max(500).optional(),
  /** 全部。明著送，不用「沒給 ids」暗示。 */
  all: z.boolean().optional(),
});

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  const parsed = Body.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: '參數不正確' }, { status: 400 });
  }
  const { ids, all } = parsed.data;
  if (!all && (!ids || ids.length === 0)) {
    // 沒有東西可標不是錯誤——收件匣是空的那一次就會走到這裡。
    // 回目前的未讀數，讓導覽列有東西可以更新。
    return NextResponse.json({ ok: true, marked: 0, unread: await unread(user.id) });
  }

  // **收件人一律是問的人自己。** `markRead` 的 where 同時比對
  // `recipientId`，所以就算送來的是別人的 id 也一列都動不了——
  // 理由與 `lib/attempt.ts` 的第三條規則相同：RLS 擋得住別家補習班，
  // 擋不住同一間補習班的隔壁同學。
  const marked = await markRead(user.id, { ids, all });
  return NextResponse.json({ ok: true, marked, unread: await unread(user.id) });
});
