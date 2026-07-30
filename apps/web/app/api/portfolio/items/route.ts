/**
 * 素材清單與新增。
 *
 * # 為什麼沒有 `?student=` 這種參數
 *
 * 因為這一區裝的是學生的個人陳述與生涯敘事，敏感度高於作答資料。
 * 多一個參數就多一個要自己比對「這是不是他本人」的地方，而 RLS 擋得住
 * 別家補習班，擋不住隔壁同學。老師要看的東西只有一種：學生**主動
 * 分享過來**的自述，那走 `/api/portfolio/essays`（GET，職員身分）。
 *
 * 家長在這一支會拿到 403，而且是在 `lib/portfolioDb.ts` 的
 * `assertStudent()` 裡擋的——不是靠畫面上沒有連結。學生可能在素材的
 * 備註裡寫下家裡的事，那正是這種文件的本質。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { addItem, admissionYearOf, myPortfolio, portfolioFailure } from '@/lib/portfolioDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const Body = z.object({
  category: z.enum(['COURSE_OUTCOME', 'DIVERSE_PERFORMANCE', 'OTHER']),
  itemCode: z.string().min(1).max(4),
  title: z.string().min(1).max(200),
  semester: z.string().max(20).nullish(),
  fileName: z.string().max(255).nullish(),
  fileBytes: z.number().int().nonnegative().nullish(),
  fileKind: z.enum(['DOC', 'MEDIA']).nullish(),
  courseRef: z.string().max(200).nullish(),
  abilityTags: z.array(z.string().max(40)).max(12).optional(),
  note: z.string().max(2000).nullish(),
  year: z.number().int().min(100).max(200).optional(),
});

export const GET = scopedRoute(async (req: NextRequest, { user }) => {
  try {
    const url = new URL(req.url);
    const year = Number(url.searchParams.get('year')) || admissionYearOf();
    return NextResponse.json(await myPortfolio(user, year));
  } catch (e) {
    const { status, body } = portfolioFailure(e);
    return NextResponse.json(body, { status });
  }
});

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  const parsed = Body.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json({ error: '參數不正確' }, { status: 400 });
  try {
    const item = await addItem(user, parsed.data);
    // 回的是重算後的整份，而不是新增的那一件。學生按下新增的下一秒
    // 最想知道的是「這樣還剩幾件」——讓畫面不必再問一次。
    const all = await myPortfolio(user, parsed.data.year ?? admissionYearOf());
    return NextResponse.json({ item, ...all });
  } catch (e) {
    const { status, body } = portfolioFailure(e);
    return NextResponse.json(body, { status });
  }
});
