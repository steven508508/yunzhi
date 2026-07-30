/**
 * AI 使用記錄與揭露聲明。
 *
 * # 這一支只有學生本人進得來，而且沒有第二個入口
 *
 * 規格書 §9.5：「AI 對話紀錄僅學生本人可見，**老師連摘要都看不到**」。
 * 這與智慧老師模組相反（那裡老師看得到班上的對話），因為這裡的內容
 * 涉及個人生涯與家庭——他為什麼想讀那個系、家裡是什麼狀況。
 *
 * 落實的方式有三層：這一支的 `myDisclosure()` 走 `assertStudent()`；
 * `lib/portfolioDb.ts` 裡**沒有第二支查 `AiDisclosureLog` 的函式**；
 * 而老師唯一看得到的 `SharedEssayView` 型別裡沒有欄位裝得下這些記錄。
 *
 * # 揭露聲明走的是閘門的另一條路
 *
 * POST 產生的聲明本身就是一段五十幾字的連續第一人稱敘述，如果走防
 * 代寫閘門會被自己擋掉、無限重試（規格書 §13 點名的陷阱）。所以它以
 * `feature = DISCLOSURE_STATEMENT` 進入閘門，改去比對**聲明內容與
 * 記錄是否相符**——一份宣稱「未使用 AI 生成內容」而完全沒提到十次
 * 撰寫回饋的聲明，會在這裡被擋下來重新生成。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { editStatement, makeStatement, myDisclosure, portfolioFailure } from '@/lib/portfolioDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const Body = z.object({
  essayId: z.string().nullish(),
  /** 帶 `statementId` 就是在編輯既有的那一份，不是產生新的。 */
  statementId: z.string().nullish(),
  edited: z.string().max(2000).nullish(),
});

export const GET = scopedRoute(async (req: NextRequest, { user }) => {
  try {
    const url = new URL(req.url);
    return NextResponse.json(await myDisclosure(user, url.searchParams.get('essayId')));
  } catch (e) {
    const { status, body } = portfolioFailure(e);
    return NextResponse.json(body, { status });
  }
});

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  const parsed = Body.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json({ error: '參數不正確' }, { status: 400 });
  try {
    if (parsed.data.statementId) {
      // 學生編輯自己的版本。**原始的 `generated` 留著**——前者是系統
      // 說了什麼，後者是他決定要說什麼，兩者都要留。
      await editStatement(user, parsed.data.statementId, parsed.data.edited ?? '');
      return NextResponse.json(await myDisclosure(user, parsed.data.essayId));
    }
    const made = await makeStatement(user, parsed.data.essayId);
    return NextResponse.json({ made, ...(await myDisclosure(user, parsed.data.essayId)) });
  } catch (e) {
    const { status, body } = portfolioFailure(e);
    return NextResponse.json(body, { status });
  }
});
