/**
 * 結算一個學年度：把它底下所有班級的在籍名冊收掉，班級停用。
 *
 * # 為什麼是一支獨立的路由，不是 PATCH 的一個欄位
 *
 * 因為它是這一頁上唯一一個會**同時動到兩百列名冊**的動作，而 PATCH
 * 的其他欄位（改名、改日期）都只動一列。混在同一支裡的話，一次打錯的
 * body 會把整個學年度收掉，而使用者以為自己只是在改日期。
 *
 * 用 POST 而不是 PATCH 也是同一個理由：它不是「把某個欄位改成某個值」，
 * 它是一個流程。
 *
 * 實際做什麼、為什麼離班日期用學年度的結束日、為什麼考試中要擋，
 * 見 `lib/academicYear.ts` 的 `closeAcademicYear`。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { closeAcademicYear } from '@/lib/academicYear';
import { mayUse } from '@/lib/nav';
import { prisma } from '@/lib/prisma';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const AREA = '/settings/years';

const Body = z.object({
  /**
   * 使用者打進去的學年度名稱。要與資料庫裡的完全相同才執行。
   *
   * 與整班重設密碼同一道防線（見 `classes/[classId]/passwords`）：
   * 這顆按鈕要比旁邊那幾顆難按。「確定嗎」擋得掉誤觸，
   * 擋不掉**按到隔壁那一年**——而按錯的代價是兩百位學生被移出班級，
   * 加上七個班從列表上消失。
   */
  confirmName: z.string().min(1).max(40),
});

export const POST = scopedRoute<{ yearId: string }>(
  async (req: NextRequest, { user, params }) => {
    if (!mayUse(user.systemRole, AREA)) {
      return NextResponse.json({ error: '只有管理員可以結算學年度' }, { status: 403 });
    }
    const year = await prisma.academicYear.findFirst({
      where: { id: params.yearId },
      select: { id: true, name: true },
    });
    if (!year) return NextResponse.json({ error: '找不到這個學年度' }, { status: 404 });

    const parsed = Body.safeParse(await req.json().catch(() => null));
    // 名稱比對在伺服器端再做一次。前端當然也擋，但前端擋的是誤觸，
    // 不是規則——而這一條規則要防的正是「按到隔壁那一年」。
    if (!parsed.success || parsed.data.confirmName.trim() !== year.name) {
      return NextResponse.json(
        { error: `請完整打出學年度名稱「${year.name}」再確認。` },
        { status: 400 },
      );
    }

    try {
      const result = await closeAcademicYear(params.yearId, user.id);
      return NextResponse.json({ ok: true, ...result });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  },
);
