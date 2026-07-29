/**
 * 改一個教職員帳號：姓名、登入代號、信箱、角色、啟用狀態，以及刪除。
 *
 * 真正的規則在 `lib/staffRules.mjs`（純函式、有測試），這裡只負責
 * 權限入口與錯誤訊息。**最重要的那一條**是「最後一個系統管理員不能
 * 被停用或降級」——按下去之後沒有人進得了管理功能，而把權限拿回來
 * 需要一個管理員帳號，那正是剛剛被停掉的那一個。
 *
 * # 為什麼 DELETE 與 PATCH 分開
 *
 * 因為停用是可逆的、刪除不是。同一支路由靠一個 `deleted: true` 欄位
 * 區分的話，一次打錯的 body 會讓一個帳號永久去識別化——而 HTTP 方法
 * 本身就是最便宜的一道「你確定你要的是哪一種」。
 *
 * 刪除做的事見 `lib/staff.ts` 的 `deleteStaff`：軟刪除、**把登入代號
 * 放回去**（停用不釋放代號，於是新來接手的老師用不了 `T001`）、
 * 清掉授課指派與導師身分。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { mayUse } from '@/lib/nav';
import { scopedRoute } from '@/lib/route';
import {
  changeStaffRole,
  deleteStaff,
  setStaffStatus,
  updateStaffProfile,
} from '@/lib/staff';

export const dynamic = 'force-dynamic';

const AREA = '/settings/staff';

const Body = z.object({
  displayName: z.string().min(1).max(40).optional(),
  username: z.string().min(1).max(40).optional(),
  // `null` 與「沒給」是兩件事：前者是「清掉這一欄」，後者是「不要動它」。
  email: z.string().max(200).nullable().optional(),
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
    const { displayName, username, email, systemRole, status } = parsed.data;
    if (
      displayName === undefined &&
      username === undefined &&
      email === undefined &&
      systemRole === undefined &&
      status === undefined
    ) {
      return NextResponse.json({ error: '沒有任何要修改的內容' }, { status: 400 });
    }
    try {
      // 順序：先改基本資料、再改角色、最後改狀態。
      //
      // 反過來的話，後面那一步被擋下時前面已經生效了——而使用者看到
      // 的是一則錯誤訊息，他會以為所有事都沒發生。順序照「愈不危險的
      // 愈先做」排，於是被擋下時已經發生的那幾件都是安全的。
      let result: unknown = null;
      if (displayName !== undefined || username !== undefined || email !== undefined) {
        result = await updateStaffProfile(params.userId, { displayName, username, email }, user);
      }
      if (systemRole !== undefined) {
        result = await changeStaffRole(params.userId, systemRole, user);
      }
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

export const DELETE = scopedRoute<{ userId: string }>(
  async (_req: NextRequest, { user, params }) => {
    if (!mayUse(user.systemRole, AREA)) {
      return NextResponse.json({ error: '只有管理員可以刪除教職員帳號' }, { status: 403 });
    }
    try {
      const removed = await deleteStaff(params.userId, user);
      return NextResponse.json({ ok: true, removed });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  },
);
