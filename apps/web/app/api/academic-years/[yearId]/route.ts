/**
 * 修改一個學年度：改名稱／起訖日，或把它設為當前。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { setCurrentAcademicYear, updateAcademicYear } from '@/lib/academicYear';
import { mayUse } from '@/lib/nav';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const AREA = '/settings/years';
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期要像 2026-08-01');

const Body = z.object({
  name: z.string().min(1).max(40).optional(),
  startDate: Day.optional(),
  endDate: Day.optional(),
  // 只收 true。「取消當前」而不指定新的，會讓開班、成績範圍這些
  // 「預設帶入本學年」的地方全部失去依據，所以不提供這個動作——
  // 要換就直接把另一個設為當前，舊的會自動被取消。
  isCurrent: z.literal(true).optional(),
});

export const PATCH = scopedRoute<{ yearId: string }>(
  async (req: NextRequest, { user, params }) => {
    if (!mayUse(user.systemRole, AREA)) {
      return NextResponse.json({ error: '只有管理員可以修改學年度' }, { status: 403 });
    }
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: '這次修改的內容看不懂', detail: parsed.error.issues.map((i) => i.message) },
        { status: 400 },
      );
    }
    const { isCurrent, ...patch } = parsed.data;
    try {
      // 順序：先寫欄位再設當前。反過來的話，欄位驗證失敗時
      // 「當前」已經換過去了，而使用者看到的是一則錯誤訊息——
      // 他會以為什麼都沒發生。
      let year =
        Object.keys(patch).length > 0
          ? await updateAcademicYear(params.yearId, patch, user.id)
          : null;
      if (isCurrent) year = await setCurrentAcademicYear(params.yearId, user.id);
      if (!year) return NextResponse.json({ error: '沒有任何要修改的內容' }, { status: 400 });
      return NextResponse.json({ ok: true, year });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  },
);
