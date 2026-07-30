/**
 * 第二階段上傳前的確認清單。
 *
 * # 為什麼是 POST 而不是 GET
 *
 * 因為要核對的一半資訊**系統沒有**：每一校系的截止日各校自訂、
 * 用「勾選中央資料庫」還是「自行上傳 PDF」是學生自己在甄選會系統上
 * 的選擇。這些由畫面帶進來，所以請求有 body。
 *
 * 做成 GET 而讓系統去猜的話，清單會漏掉最會出事的那兩項——而一份
 * 漏掉重點的清單比沒有清單糟，因為學生會以為自己核對過了。
 *
 * # 這個功能技術含量低但實用價值高
 *
 * 規格書 §9.4 的原話。實務上因為技術性疏失（少傳一項、超過大小、
 * 搞錯擇一規則）而吃虧的案例意外地多，而它們每一件都是一份清單就
 * 可以避免的。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { checklistFor, portfolioFailure } from '@/lib/portfolioDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const Body = z.object({
  programs: z
    .array(
      z.object({
        programRef: z.string().min(1).max(40),
        name: z.string().max(80).optional(),
        /** `MIXED` 是學生自己勾了兩種——那在甄選會的系統上做不到。 */
        mode: z.enum(['CENTRAL', 'PDF', 'MIXED']).nullish(),
        deadline: z.string().max(20).nullish(),
      }),
    )
    .max(6)
    .optional(),
});

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  const parsed = Body.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json({ error: '參數不正確' }, { status: 400 });
  try {
    return NextResponse.json(await checklistFor(user, parsed.data.programs ?? []));
  } catch (e) {
    const { status, body } = portfolioFailure(e);
    return NextResponse.json(body, { status });
  }
});
