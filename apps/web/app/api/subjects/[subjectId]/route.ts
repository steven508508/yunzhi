/**
 * 修改一個科目：改名，或停用／重新啟用。
 *
 * **代碼不在可修改的欄位裡**，理由見 `lib/subject.ts` 的檔頭：它是
 * AI 匯入管線的分科鍵，改了之後管線送回來的題目對不上任何一科，
 * 而匯入畫面上一路都是綠燈。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { mayUse } from '@/lib/nav';
import { scopedRoute } from '@/lib/route';
import { renameSubject, setSubjectActive } from '@/lib/subject';

export const dynamic = 'force-dynamic';

const AREA = '/settings/subjects';

const Body = z.object({
  name: z.string().min(1).max(30).optional(),
  active: z.boolean().optional(),
});

export const PATCH = scopedRoute<{ subjectId: string }>(
  async (req: NextRequest, { user, params }) => {
    if (!mayUse(user.systemRole, AREA)) {
      return NextResponse.json({ error: '只有管理員可以修改科目' }, { status: 403 });
    }
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: '這次修改的內容看不懂', detail: parsed.error.issues.map((i) => i.message) },
        { status: 400 },
      );
    }
    const { name, active } = parsed.data;
    if (name === undefined && active === undefined) {
      return NextResponse.json({ error: '沒有任何要修改的內容' }, { status: 400 });
    }
    try {
      // 順序：先改名再改啟用狀態。反過來的話，停用被擋下時名稱已經
      // 寫進去了，而使用者看到的是一則錯誤訊息——他會以為兩件事都
      // 沒發生，然後重打一次名稱。
      let subject = name !== undefined ? await renameSubject(params.subjectId, name, user.id) : null;
      if (active !== undefined) {
        subject = await setSubjectActive(params.subjectId, active, user.id);
      }
      return NextResponse.json({ ok: true, subject });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  },
);
