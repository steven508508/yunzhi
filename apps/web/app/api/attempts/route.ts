import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  attemptFailure,
  listStudentTasks,
  loadAttemptForStudent,
  peekAssignment,
  startAttempt,
} from '@/lib/attempt';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

/**
 * 開始作答。
 *
 * 回傳的是**整份作答畫面**（題目、已存的答案、剩餘秒數），不是只有
 * 一個 id。理由是網路：學生多半在手機熱點下，一次往返就是幾百毫秒，
 * 而「開始」與「載入題目」之間沒有任何需要分開的理由。
 *
 * 這一支是有副作用的（會建立一份作答、用掉一次機會），所以它是 POST
 * 而且**只在學生真的按下按鈕時呼叫**。要先知道「能不能開始」用下面的
 * GET，那一支不寫任何東西。
 */
const PostBody = z.object({ assignmentId: z.string().min(1) });

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  const parsed = PostBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: '請求格式錯誤：缺少 assignmentId' }, { status: 400 });
  }

  try {
    const started = await startAttempt(parsed.data.assignmentId, user.id);
    const view = await loadAttemptForStudent(started.attemptId, user.id);
    return NextResponse.json({ ...view, resumed: started.resumed });
  } catch (e) {
    const { status, body } = attemptFailure(e);
    return NextResponse.json(body, { status });
  }
});

/**
 * 現在的狀況，**不開始作答**。
 *
 *   · 沒帶 assignmentId：這位學生的所有任務（任務清單頁用）
 *   · 帶了：那一份的狀態（作答頁進來時用）
 *
 * 這一支存在的理由很具體：作答頁若靠「呼叫 POST 看看會不會成功」來
 * 判斷能不能開始，學生按一次上一頁再按下一頁就用掉一次作答機會。
 */
export const GET = scopedRoute(async (req: NextRequest, { user }) => {
  const assignmentId = req.nextUrl.searchParams.get('assignmentId');
  try {
    if (!assignmentId) {
      return NextResponse.json({ tasks: await listStudentTasks(user.id) });
    }
    const task = await peekAssignment(assignmentId, user.id);
    if (!task) {
      return NextResponse.json(
        { error: '這份任務沒有派給你。如果你覺得這是錯的，請告訴班級老師。', code: 'FORBIDDEN' },
        { status: 403 },
      );
    }
    return NextResponse.json({ task });
  } catch (e) {
    const { status, body } = attemptFailure(e);
    return NextResponse.json(body, { status });
  }
});
