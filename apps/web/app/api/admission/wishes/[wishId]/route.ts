/**
 * 改一個志願、或刪掉它。
 *
 * 「不是他的」與「不存在」回一模一樣的 404。分開回的話，這一支就變成
 * 一個查詢別人有沒有填某個志願的工具——攻擊者拿一串 cuid 試過去，
 * 403 與 404 的差別就是答案。`deleteWish()` 與 `updateWish()` 都用
 * `[id, userId]` 一起查，所以它們連「存在但不是你的」都分不出來。
 *
 * # PATCH 不改「這是哪一個管道的志願」
 *
 * 管道決定整組規則（繁星要學群、個申至多 6 個、繁星錄取會封鎖個申），
 * 而改管道等於換一件事。那要刪掉重加——**那一次刪除是有意義的**，
 * 學生會看到自己在做一個換管道的決定。相對地，改志願序、改校名、
 * 補上系名都只是修正，不該逼他走一趟刪除。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { STAR_GROUPS } from '@/lib/admission.mjs';
import { admissionStatus, admissionYearOf, deleteWish, updateWish } from '@/lib/admissionDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const Patch = z.object({
  year: z.number().int().min(100).max(200).optional(),
  /** 志願序。撞號時與原本那一個**對調**，不是整串往後推。 */
  rank: z.number().int().min(1).max(100).optional(),
  institutionName: z.string().trim().min(1).max(60).optional(),
  programName: z.string().trim().max(80).nullish(),
  starGroup: z.number().int().min(1).max(8).nullish(),
  interestTag: z.string().trim().max(120).nullish(),
  note: z.string().trim().max(500).nullish(),
});

export const PATCH = scopedRoute<{ wishId: string }>(
  async (req: NextRequest, { user, params }) => {
    if (user.systemRole !== 'STUDENT') {
      return NextResponse.json({ error: '志願由學生本人維護' }, { status: 403 });
    }

    const parsed = Patch.safeParse((await req.json().catch(() => null)) ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return NextResponse.json(
        { error: `「${first?.path.join('.') || '參數'}」這一欄不正確。` },
        { status: 400 },
      );
    }
    const { year, ...patch } = parsed.data;

    // 繁星沒有學群就排不出校內位置，所以**改的時候也要擋**——只擋在
    // 新增那一支的話，學生把學群改成空的就繞過去了，而症狀是他在
    // 繁星那一區安靜地消失。
    if (patch.starGroup !== undefined && patch.starGroup !== null) {
      if (!STAR_GROUPS.includes(patch.starGroup)) {
        return NextResponse.json({ error: '繁星學群要是第 1 至 8 類。' }, { status: 400 });
      }
    }

    let out: Awaited<ReturnType<typeof updateWish>>;
    try {
      out = await updateWish(user.id, params.wishId, patch);
    } catch {
      // 唯一鍵撞號。對調已經處理掉最常見的那一種，剩下的多半是同時
      // 有另一個分頁在改——訊息要說得出「重新整理一次再試」。
      return NextResponse.json(
        { error: '這個志願序剛剛被另一個動作佔走了。重新整理一次再改。' },
        { status: 409 },
      );
    }
    if (!out) return NextResponse.json({ error: '找不到這個志願' }, { status: 404 });

    const y = year ?? (Number(new URL(req.url).searchParams.get('year')) || admissionYearOf());
    return NextResponse.json({ ...(await admissionStatus(user.id, y)), swappedWith: out.swappedWith });
  },
);

export const DELETE = scopedRoute<{ wishId: string }>(
  async (req: NextRequest, { user, params }) => {
    if (user.systemRole !== 'STUDENT') {
      return NextResponse.json({ error: '志願由學生本人維護' }, { status: 403 });
    }
    const ok = await deleteWish(user.id, params.wishId);
    if (!ok) return NextResponse.json({ error: '找不到這個志願' }, { status: 404 });

    const y = Number(new URL(req.url).searchParams.get('year')) || admissionYearOf();
    return NextResponse.json(await admissionStatus(user.id, y));
  },
);
