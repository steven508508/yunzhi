/**
 * 一位學生的帳號本身：改姓名、改學號、退補、個資刪除。
 *
 * # 這一支補的是兩個都會在每個學期發生的缺口
 *
 * **一、姓名改不掉。** `User.displayName`／`username` 全 repo 只在
 * `user.create` 時寫過一次。兩百筆名冊裡有三個錯字是必然的，
 * 而在此之前唯一的補救是給那位學生一個新學號重新匯入——
 * 他過去三個月的作答與成績就留在舊帳號上，而那正是家長約談要用的。
 *
 * **二、帳號停不掉也刪不掉。** 一位退費不來的學生，能做的只有
 * 「移出班級」，之後他的 `status` 仍然是 ACTIVE、密碼還能用、
 * **他登得進來**，而姓名、學號、家長信箱、生日永久留在 `users` 表裡。
 * `/settings/staff` 的停用明確擋掉學生，訊息說「請到他所屬的班級頁
 * 處理」——而班級頁上在此之前沒有這個功能。
 *
 * # 三個動作為什麼分成三種權限
 *
 * | 動作 | 誰按得到 | 理由 |
 * |---|---|---|
 * | 改姓名／學號 | 管理員、該班導師 | 與匯入名冊同一件事（改的是名冊上的欄位） |
 * | 退補（停用） | 管理員、該班導師 | 可逆，而且是班務 |
 * | 個資刪除 | **只有管理員** | 不可逆，而且是機構對個資法的責任 |
 *
 * 導師改得動名冊卻刪不掉人，是刻意的：刪除要有一個「機構層級的人
 * 決定過」的痕跡，而那個人也是收到家長來信的那一位。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { isHomeroomOf } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { scopedRoute } from '@/lib/route';
import {
  archiveStudent,
  eraseStudent,
  restoreStudent,
  updateStudent,
} from '@/lib/roster';

export const dynamic = 'force-dynamic';

const ADMIN = new Set(['SYS_ADMIN', 'SCHOOL_ADMIN']);

const Body = z.object({
  displayName: z.string().min(1).max(40).optional(),
  username: z.string().min(1).max(40).optional(),
  // `null` 與「沒給」是兩件事：前者是「清掉這一欄」，後者是「不要動它」。
  // 少了 nullable，櫃檯就沒有辦法把一個打錯的家長信箱清空。
  email: z.string().max(200).nullable().optional(),
  guardianEmail: z.string().max(200).nullable().optional(),
  /** ARCHIVED = 退補（可逆），ACTIVE = 放回來。 */
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  /** 個資法第 11 條的刪除。**不可逆**，所以要明確帶這一個旗標。 */
  erase: z.literal(true).optional(),
});

/**
 * 這位學生歸誰管。
 *
 * 導師的判定要看**他曾經在的任何一個班**——兩件事：
 *
 * 一、一位學生同時在行政班與加強班是常態，而兩個班的導師都該改得動
 *     他的名字。
 * 二、**已移出的班也算**。退補會把他從所有班級移出，若這裡只認在籍
 *     的，剛按下退補的那位導師下一秒就救不回自己按錯的那一下——
 *     而畫面上那是一顆按了說「你不是他的導師」的按鈕。
 *
 * 放寬的代價是「三年前帶過他的導師還改得動他」。那可以接受：
 * 導師本來就看得到自己帶過的名冊，而真正危險的動作（個資刪除）
 * 另外限定管理員。
 */
async function mayEdit(studentId: string, user: { id: string; systemRole: string }) {
  if (ADMIN.has(user.systemRole)) return true;
  const rows = await prisma.classMembership.findMany({
    where: { userId: studentId, role: 'STUDENT' },
    select: { classId: true },
    take: 40,
  });
  for (const r of rows) {
    if (await isHomeroomOf(user.id, r.classId)) return true;
  }
  return false;
}

export const PATCH = scopedRoute<{ studentId: string }>(
  async (req: NextRequest, { user, params }) => {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: '這次修改的內容看不懂', detail: parsed.error.issues.map((i) => i.message) },
        { status: 400 },
      );
    }
    const { displayName, username, email, guardianEmail, status, erase } = parsed.data;
    if (
      displayName === undefined &&
      username === undefined &&
      email === undefined &&
      guardianEmail === undefined &&
      status === undefined &&
      erase === undefined
    ) {
      return NextResponse.json({ error: '沒有任何要修改的內容' }, { status: 400 });
    }

    if (!(await mayEdit(params.studentId, user))) {
      return NextResponse.json(
        { error: '你不是這位學生任何一個班的導師，改不了他的帳號。' },
        { status: 403 },
      );
    }
    if (erase && !ADMIN.has(user.systemRole)) {
      // 訊息要說得出「該找誰」。只回「沒有權限」的話，導師會以為功能
      // 壞了然後去試別的路徑，而家長的刪除要求還在信箱裡等。
      return NextResponse.json(
        {
          error:
            '刪除個人資料是不可逆的，只有管理員做得到。請把家長的要求轉給校務管理員。',
        },
        { status: 403 },
      );
    }

    try {
      if (erase) {
        const result = await eraseStudent(params.studentId, user.id);
        return NextResponse.json({ ok: true, erased: result });
      }
      if (displayName !== undefined || username !== undefined ||
          email !== undefined || guardianEmail !== undefined) {
        await updateStudent(
          params.studentId,
          { displayName, username, email, guardianEmail },
          user.id,
        );
      }
      if (status === 'ARCHIVED') {
        const result = await archiveStudent(params.studentId, user.id);
        return NextResponse.json({ ok: true, archived: result });
      }
      if (status === 'ACTIVE') {
        const result = await restoreStudent(params.studentId, user.id);
        return NextResponse.json({ ok: true, restored: result });
      }
      return NextResponse.json({ ok: true });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  },
);
