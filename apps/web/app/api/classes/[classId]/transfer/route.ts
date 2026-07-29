/**
 * 轉班：一位學生從這個班轉到另一個班。
 *
 * # 為什麼要有這一支，而不是讓人做兩步
 *
 * 因為在此之前那是兩步——「在舊班按移出」加上「到新班匯入一份只有
 * 他一列的 CSV」——而**沒有任何地方告訴你要做第二步**。移出的確認
 * 視窗說「他的帳號本身不受影響，如果他同時在別的班，那邊照常」，
 * 它沒有說「你現在要去另一個班把他加回去」。
 *
 * 只做第一步的結果是這位學生登入後看到「現在沒有任務」，而名冊上他
 * 不在任何班。每學期發生 5 到 10 次，而兩步之間沒有任何連結。
 *
 * # 權限要兩邊都有
 *
 * 轉出班與轉入班都要動得了。只檢查其中一邊的話，一位忠班的導師可以
 * 把學生塞進孝班的名冊——那等於他決定了孝班的應交人數與孝班老師的
 * 催繳名單。管理員兩邊都通過，所以這一道只擋導師。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { isHomeroomOf } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { scopedRoute } from '@/lib/route';
import { transferStudent } from '@/lib/roster';

export const dynamic = 'force-dynamic';

const ADMIN = new Set(['SYS_ADMIN', 'SCHOOL_ADMIN']);

const Body = z.object({
  studentId: z.string().min(1),
  toClassId: z.string().min(1),
});

export const POST = scopedRoute<{ classId: string }>(
  async (req: NextRequest, { user, params }) => {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: '請選擇要轉入的班級' }, { status: 400 });
    }
    const { studentId, toClassId } = parsed.data;

    const [from, to] = await Promise.all([
      prisma.class.findFirst({ where: { id: params.classId }, select: { id: true, name: true } }),
      prisma.class.findFirst({ where: { id: toClassId }, select: { id: true, name: true } }),
    ]);
    if (!from) return NextResponse.json({ error: '找不到轉出的班級' }, { status: 404 });
    if (!to) return NextResponse.json({ error: '找不到要轉入的班級' }, { status: 404 });

    if (!ADMIN.has(user.systemRole)) {
      const [mayFrom, mayTo] = await Promise.all([
        isHomeroomOf(user.id, from.id),
        isHomeroomOf(user.id, to.id),
      ]);
      if (!mayFrom || !mayTo) {
        return NextResponse.json(
          {
            error:
              `轉班要同時動到「${from.name}」與「${to.name}」的名冊，` +
              '而你不是兩邊的導師。請找管理員處理。',
          },
          { status: 403 },
        );
      }
    }

    try {
      const result = await transferStudent(from.id, to.id, studentId, user.id);
      return NextResponse.json({ ok: true, ...result });
    } catch (e) {
      // 「他正在作答」「已經移出了」都是說得出原因的狀況，而那些訊息
      // 本身就是要顯示給老師看的東西——尤其考試中那一句。
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 409 },
      );
    }
  },
);
