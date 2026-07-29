/**
 * 志願的新增。
 *
 * # 這一支刻意不擋任何「不可能的組合」
 *
 * 學生填了繁星第 3 類又填六個個人申請，這在制度上是一個注定作廢的
 * 組合。系統**照樣存**，然後在回應裡附上後果說明（`conflicts`）。
 *
 * 不擋的理由與文件 04 防作弊的「記錄而非中斷」相同：判斷擋錯的那一次
 * 沒有出口。學生的狀況可能是「我打算等繁星放榜再決定要不要放棄」，
 * 而那是完全合理的規劃；系統若拒絕存，他只會改用一張紙寫，而那張紙
 * 上沒有任何後果說明。**讓後果透明比讓資料乾淨重要。**
 *
 * 唯一會回 4xx 的是志願序撞號（`[userId, year, channel, rank]` 是唯一鍵）
 * 與欄位格式，那兩件是資料完整性而不是制度判斷。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { STAR_GROUPS } from '@/lib/admission.mjs';
import { addWish, admissionStatus, admissionYearOf } from '@/lib/admissionDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const Body = z.object({
  year: z.number().int().min(100).max(200).optional(),
  channel: z.enum(['SPECIAL', 'STAR', 'APPLY', 'PLACEMENT']),
  rank: z.number().int().min(1).max(100),
  institutionName: z.string().trim().min(1).max(60),
  programName: z.string().trim().max(80).nullish(),
  /** 繁星學群 1 至 8。**繁星志願沒有它就排不出校內位置**，見下方。 */
  starGroup: z.number().int().min(1).max(8).nullish(),
  interestTag: z.string().trim().max(120).nullish(),
  note: z.string().trim().max(500).nullish(),
});

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  if (user.systemRole !== 'STUDENT') {
    return NextResponse.json({ error: '志願由學生本人填寫' }, { status: 403 });
  }

  const parsed = Body.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: '參數不正確' }, { status: 400 });
  }
  const { year, ...input } = parsed.data;
  const y = year ?? admissionYearOf();

  // 繁星沒有學群就排不出校內位置——繁星的整個競爭結構就是
  // 「大學 × 學群」。**這一條擋在這裡而不是留給模擬去猜**：
  // 猜錯學群等於把這位學生放進別人的隊伍裡排序，而畫面上一切正常。
  // 這是資料完整性，不是制度判斷，所以擋得下去。
  if (input.channel === 'STAR' && !STAR_GROUPS.includes(input.starGroup as number)) {
    return NextResponse.json(
      { error: '繁星志願要選學群（第 1 至 8 類）。沒有學群就算不出你在校內的位置。' },
      { status: 400 },
    );
  }

  try {
    await addWish(user.id, y, input);
  } catch {
    // 唯一鍵是 [userId, year, channel, rank]。撞號的訊息要說得出撞在哪，
    // 否則使用者看到的是「存不起來」然後再按一次。
    return NextResponse.json(
      { error: `這個管道的第 ${input.rank} 志願已經有了。換一個志願序，或先把原本那個刪掉。` },
      { status: 409 },
    );
  }

  return NextResponse.json(await admissionStatus(user.id, y));
});
