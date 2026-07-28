/**
 * 記錄法定代理人的同意。
 *
 * **這是個資法的要件，不是一個核取方塊。** 個資法第 15 條：蒐集
 * 未成年人的個人資料需法定代理人同意。沒有同意紀錄，整個資料庫的
 * 合法性都有疑問。
 *
 * 學生帳號在同意之前是 PENDING_CONSENT，登不進去。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { scopedRoute } from '@/lib/route';
import { recordConsent } from '@/lib/roster';

export const dynamic = 'force-dynamic';

const Body = z.object({
  // 現場同意（櫃檯報名時當場簽）與線上同意的證據力不同，要記下來。
  method: z.enum(['IN_PERSON', 'ONLINE', 'PAPER']),
  note: z.string().max(500).optional(),
});

export const POST = scopedRoute<{ studentId: string }>(
  async (req: NextRequest, { user, params }) => {
    if (!['SYS_ADMIN', 'SCHOOL_ADMIN', 'TEACHER', 'SUBJECT_LEAD'].includes(user.systemRole)) {
      return NextResponse.json({ error: '沒有權限' }, { status: 403 });
    }
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: '請說明同意的取得方式' }, { status: 400 });
    }
    try {
      const student = await recordConsent(
        params.studentId,
        user.id,
        parsed.data.method,
        parsed.data.note,
      );
      return NextResponse.json({ ok: true, student });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  },
);
