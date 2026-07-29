/**
 * 這個班的導師：指派與取消。
 *
 * 導師的職權與授課老師不同（見 `lib/teaching.ts` 的檔頭）：他管的是
 * 班務——改名冊、匯入名冊、重設全班密碼、催繳。所以指派導師發出去的
 * 是「這個班全部學生的個人資料與登入憑證」，比單一科目的成績更重。
 * 一樣只有管理員做得了。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { scopedRoute } from '@/lib/route';
import { clearHomeroom, setHomeroom } from '@/lib/teaching';

export const dynamic = 'force-dynamic';

const ADMIN = new Set(['SYS_ADMIN', 'SCHOOL_ADMIN']);

const Body = z.object({ userId: z.string().min(1) });

export const POST = scopedRoute<{ classId: string }>(
  async (req: NextRequest, { user, params }) => {
    if (!ADMIN.has(user.systemRole)) {
      return NextResponse.json(
        { error: '只有管理員可以指派導師——導師改得動整份名冊，也重設得了全班的密碼。' },
        { status: 403 },
      );
    }
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: '請選擇一位老師' }, { status: 400 });
    }
    try {
      await setHomeroom(params.classId, parsed.data.userId, user);
      return NextResponse.json({ ok: true });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  },
);

/** 取消導師。查詢字串帶 userId，理由與授課老師那一支相同。 */
export const DELETE = scopedRoute<{ classId: string }>(
  async (req: NextRequest, { user, params }) => {
    if (!ADMIN.has(user.systemRole)) {
      return NextResponse.json({ error: '只有管理員可以取消導師' }, { status: 403 });
    }
    const userId = req.nextUrl.searchParams.get('user');
    if (!userId) {
      return NextResponse.json({ error: '請指定要取消哪一位導師' }, { status: 400 });
    }
    try {
      await clearHomeroom(params.classId, userId, user);
      return NextResponse.json({ ok: true });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  },
);
