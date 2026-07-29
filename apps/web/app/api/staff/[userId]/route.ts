/**
 * 改一個教職員帳號的角色或啟用狀態。
 *
 * 真正的規則在 `lib/staffRules.mjs`（純函式、有測試），這裡只負責
 * 權限入口與錯誤訊息。**最重要的那一條**是「最後一個系統管理員不能
 * 被停用或降級」——按下去之後沒有人進得了管理功能，而把權限拿回來
 * 需要一個管理員帳號，那正是剛剛被停掉的那一個。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { mayUse } from '@/lib/nav';
import { scopedRoute } from '@/lib/route';
import { changeStaffRole, setStaffStatus } from '@/lib/staff';

export const dynamic = 'force-dynamic';

const AREA = '/settings/staff';

const Body = z.object({
  systemRole: z.string().min(1).max(30).optional(),
  // 只收這兩種。PENDING_CONSENT 是未成年學生的狀態、ARCHIVED 是軟刪除，
  // 兩者都不該從這一頁按得到——它們的復原路徑與「停用／啟用」不同。
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
});

export const PATCH = scopedRoute<{ userId: string }>(
  async (req: NextRequest, { user, params }) => {
    if (!mayUse(user.systemRole, AREA)) {
      return NextResponse.json({ error: '只有管理員可以修改教職員帳號' }, { status: 403 });
    }
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: '這次修改的內容看不懂', detail: parsed.error.issues.map((i) => i.message) },
        { status: 400 },
      );
    }
    const { systemRole, status } = parsed.data;
    if (systemRole === undefined && status === undefined) {
      return NextResponse.json({ error: '沒有任何要修改的內容' }, { status: 400 });
    }
    try {
      // 順序：先改角色再改狀態。反過來的話，角色被擋下時帳號已經停用了
      // ——而使用者看到的是一則錯誤訊息，他會以為兩件事都沒發生。
      let result = systemRole !== undefined
        ? await changeStaffRole(params.userId, systemRole, user)
        : null;
      if (status !== undefined) {
        result = await setStaffStatus(params.userId, status, user);
      }
      return NextResponse.json({ ok: true, staff: result });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  },
);
