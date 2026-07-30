/**
 * 我的未讀數。
 *
 * # 為什麼是一支 API，而不是由版面算好傳給導覽列
 *
 * 因為那個數字要在**不重新載入整頁的情況下**跟著變。使用者在收件匣裡
 * 把幾則標成已讀之後，導覽列上那個數字必須跟著掉——由伺服器元件
 * 傳進去的話它會停在原本的數字，而**一個不會歸零的紅點在一週之後
 * 就被完全忽略了**，那正是這個功能最重要的一條要求。
 *
 * # 為什麼不做輪詢
 *
 * 這一支只在導覽列掛載時打一次。定時輪詢會讓每一個開著頁面的瀏覽器
 * 每分鐘敲一次資料庫，而**同一台機器同時要服務正在考試的學生**
 * （理由與 `scripts/worker.mjs` 把匯入併發設成 1 完全相同）。
 * 站內通知不是聊天室，晚一次換頁才看到沒有任何損失。
 */
import { NextResponse } from 'next/server';

import { unread } from '@/lib/notifyDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

export const GET = scopedRoute(async (_req, { user }) => {
  // 收件人一律是「問的人自己」。**不接受 userId 參數**——接了就等於
  // 開一支「查任何人有幾則未讀」的 API，而那是一條沒有任何理由存在的
  // 資訊通道（RLS 擋得住別家補習班，擋不住同班同學）。
  const n = await unread(user.id);
  return NextResponse.json({ unread: n });
});
