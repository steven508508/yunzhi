/**
 * 家長連結：列出與新增。**這一整棵路由樹是給職員用的。**
 *
 * # 家長自己沒有讀取 API
 *
 * 家長端的頁面是伺服器元件，資料在伺服器端組好才送到瀏覽器
 * （見 `lib/guardian.ts` 檔頭第三點）。多一支「家長讀自己孩子」的
 * API，就多一個要重新判斷「這個 studentId 是不是他的孩子」的地方，
 * 而那個判斷寫錯的方向是別人家的成績。
 *
 * 所以這裡每一支的第一行都是同一件事：**你是職員嗎**。
 *
 * # 誰按得動
 *
 * 與「重設一位學生的密碼」「登錄家長同意」同一組角色，而且是同一個
 * 現實：家長站在櫃檯說「我收不到成績」，處理的是現場那一位老師。
 * 要求他去找導師或管理員，等於這個功能在最需要的那一刻不存在。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  addGuardianForStudent,
  guardianFailure,
  isStaff,
  listGuardiansOfStudent,
} from '@/lib/guardian';
import { prisma } from '@/lib/prisma';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const deny = () =>
  NextResponse.json(
    { error: '只有老師與管理員可以調整家長連結。' },
    { status: 403 },
  );

/** 這位學生現在有哪幾位家長。名冊那一頁的對話框開啟時問一次。 */
export const GET = scopedRoute(async (req: NextRequest, { user }) => {
  if (!isStaff(user.systemRole)) return deny();
  const studentId = req.nextUrl.searchParams.get('studentId');
  if (!studentId) {
    return NextResponse.json({ error: '請指定 studentId' }, { status: 400 });
  }
  // 對象一定要是學生帳號。不擋的話這一支就變成「給我任何 userId
  // 就告訴你他的關聯」——而管理員與老師的帳號也在同一張表上。
  const student = await prisma.user.findFirst({
    where: { id: studentId, systemRole: 'STUDENT', deletedAt: null },
    select: { id: true },
  });
  if (!student) return NextResponse.json({ error: '找不到這位學生' }, { status: 404 });

  return NextResponse.json({ guardians: await listGuardiansOfStudent(studentId) });
});

const Body = z.object({
  studentId: z.string().min(1),
  email: z.string().min(3).max(200),
});

/**
 * 新增一位家長。信箱已經有家長帳號就直接接上去，沒有就開一個。
 *
 * 回應裡的 `credential` **只有真的開了新帳號時才有**，而且只有這一次
 * 拿得到——與名冊匯入的初始密碼同一條規則。既有帳號不重設密碼：
 * 那位家長可能正在用它看另一個孩子。
 */
export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  if (!isStaff(user.systemRole)) return deny();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: '請填寫學生與家長信箱' }, { status: 400 });
  }
  try {
    const result = await addGuardianForStudent(
      parsed.data.studentId,
      parsed.data.email,
      user.id,
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const { status, body } = guardianFailure(e);
    return NextResponse.json(body, { status });
  }
});
