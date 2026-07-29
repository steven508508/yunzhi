/**
 * 整班或勾選一批，一次登錄家長同意。
 *
 * # 為什麼要有這一支，而不是讓前端打 200 次單筆
 *
 * 前端迴圈打 200 次是 200 次網路往返、200 個交易、200 筆稽核插入，
 * 而其中任何一次失敗都會留下一個「做了一半」的狀態——哪幾位登錄了、
 * 哪幾位沒有，畫面上看不出來。個資法的憑據不能是這種狀態。
 *
 * 一支路由、一句 `updateMany`、一次 `createMany` 的稽核。
 *
 * # 權限與單筆那一支相同
 *
 * `POST /api/students/[studentId]/consent` 允許的是四種角色，理由寫在
 * 那支路由的檔頭：**學生是在櫃檯跟現場的那一位老師講的**。整批不是
 * 更危險的動作（它做的是同一件事，只是一次做完），所以規則一致——
 * 兩邊分開判的話，會出現「他登錄得了一位、登錄不了兩位」這種說不出
 * 道理的組合。
 *
 * 對象限制在**這個班在籍的學生**，那一道在 `recordConsentBatch` 裡。
 * 少了它，這就變成一支「給我任何 userId 就幫你啟用帳號」的 API。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { scopedRoute } from '@/lib/route';
import { recordConsentBatch } from '@/lib/roster';

export const dynamic = 'force-dynamic';

/**
 * 一次最多 500 位。
 *
 * 不是效能上限（`updateMany` 一句話做得完），是**誤送的上限**：
 * 一份 5 000 個 id 的 body 不可能來自任何一個真的班級名冊。
 */
const MAX_IDS = 500;

const MAY_RECORD = new Set(['SYS_ADMIN', 'SCHOOL_ADMIN', 'TEACHER', 'SUBJECT_LEAD']);

const Body = z.object({
  // 現場同意（櫃檯報名時當場簽）與線上同意的證據力不同，要記下來。
  method: z.enum(['IN_PERSON', 'ONLINE', 'PAPER']),
  note: z.string().max(500).optional(),
  /**
   * 勾選了哪幾位。**不給（undefined）代表整班。**
   *
   * 空陣列與「整班」是兩件事：前者是「一個都沒勾就按了」，
   * 那應該回一句話而不是安靜地把全班啟用。zod 這裡不擋空陣列，
   * `recordConsentBatch` 會回「沒有選到任何一位」。
   */
  studentIds: z.array(z.string().min(1)).max(MAX_IDS).optional(),
});

export const POST = scopedRoute<{ classId: string }>(
  async (req: NextRequest, { user, params }) => {
    if (!MAY_RECORD.has(user.systemRole)) {
      return NextResponse.json({ error: '沒有權限登錄家長同意' }, { status: 403 });
    }
    const klass = await prisma.class.findFirst({
      where: { id: params.classId },
      select: { id: true, name: true },
    });
    if (!klass) return NextResponse.json({ error: '找不到這個班級' }, { status: 404 });

    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: '請說明同意的取得方式',
          detail: parsed.error.issues.map((i) => i.message),
        },
        { status: 400 },
      );
    }

    try {
      const result = await recordConsentBatch(
        params.classId,
        parsed.data.studentIds ?? null,
        user.id,
        parsed.data.method,
        parsed.data.note,
      );
      return NextResponse.json({ ok: true, ...result });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  },
);
