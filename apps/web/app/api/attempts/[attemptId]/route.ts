import { NextRequest, NextResponse } from 'next/server';

import { attemptFailure, getAttemptStatus, loadAttemptForStudent } from '@/lib/attempt';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

/**
 * 這份作答現在的狀況。
 *
 * 預設只回狀態與**伺服器算出來的剩餘秒數**——作答頁每半分鐘打一次
 * 來校時。前端自己減一秒的倒數在分頁切到背景時會被瀏覽器節流，
 * 手機鎖屏更嚴重；學生切出去回個訊息再回來，畫面上還剩八分鐘而
 * 其實已經結束了。
 *
 * 帶 `?full=1` 時回整份作答（題目與已存的答案）。續考與重新整理走這條，
 * 因為那時不該再呼叫「開始作答」——那一支有副作用。
 *
 * 兩種都**不含正確答案**：`loadAttemptForStudent` 是白名單挑欄位的。
 */
export const GET = scopedRoute<{ attemptId: string }>(
  async (req: NextRequest, { user, params }) => {
    const full = req.nextUrl.searchParams.get('full') === '1';
    try {
      const data = full
        ? await loadAttemptForStudent(params.attemptId, user.id)
        : await getAttemptStatus(params.attemptId, user.id);
      return NextResponse.json(data);
    } catch (e) {
      const { status, body } = attemptFailure(e);
      return NextResponse.json(body, { status });
    }
  },
);
