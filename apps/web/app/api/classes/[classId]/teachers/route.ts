/**
 * 這個班的授課老師：指派與取消。
 *
 * # 為什麼權限比「改名冊」嚴格
 *
 * 改名冊的權限是管理員與該班導師（見 roster 路由），因為那是班務。
 * 指派授課老師不是班務——它**發出去的是權限**：被指派的人從此看得到
 * 那個班那一科每一位學生的姓名、學號與成績，而且改得動分數。
 *
 * 讓導師指派得動自己班的科任老師，等於讓他決定誰看得到自己班學生的
 * 個人資料。那是機構要負責的事，與「開一個新班」同一條規則。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { scopedRoute } from '@/lib/route';
import { assignSubjectTeacher, removeSubjectTeacher } from '@/lib/teaching';

export const dynamic = 'force-dynamic';

const ADMIN = new Set(['SYS_ADMIN', 'SCHOOL_ADMIN']);

const Body = z.object({
  subjectId: z.string().min(1),
  userId: z.string().min(1),
});

export const POST = scopedRoute<{ classId: string }>(
  async (req: NextRequest, { user, params }) => {
    if (!ADMIN.has(user.systemRole)) {
      return NextResponse.json(
        { error: '只有管理員可以指派授課老師——被指派的人會看得到這個班這一科的所有成績。' },
        { status: 403 },
      );
    }
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: '請選擇科目與老師' }, { status: 400 });
    }
    try {
      const row = await assignSubjectTeacher(
        params.classId,
        parsed.data.subjectId,
        parsed.data.userId,
        user,
      );
      return NextResponse.json({ ok: true, assignment: row });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  },
);

/**
 * 取消指派。用查詢字串帶科目與老師，與知識點的前置關係同一個做法
 * （`/api/knowledge-points/[kpId]/prerequisites`）——DELETE 帶 body
 * 在各家 fetch 實作與反向代理上的行為不一致，而「有時候送不到」
 * 的症狀是「按了沒反應」。
 */
export const DELETE = scopedRoute<{ classId: string }>(
  async (req: NextRequest, { user, params }) => {
    if (!ADMIN.has(user.systemRole)) {
      return NextResponse.json({ error: '只有管理員可以取消授課指派' }, { status: 403 });
    }
    const subjectId = req.nextUrl.searchParams.get('subject');
    const userId = req.nextUrl.searchParams.get('user');
    if (!subjectId || !userId) {
      return NextResponse.json({ error: '請指定要取消哪一位老師的哪一科' }, { status: 400 });
    }
    try {
      await removeSubjectTeacher(params.classId, subjectId, userId, user);
      return NextResponse.json({ ok: true });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  },
);
