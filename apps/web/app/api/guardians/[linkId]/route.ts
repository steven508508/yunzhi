/**
 * 一條家長連結：解除，以及標記／撤回「初始密碼已經交付」。
 *
 * # 為什麼路徑上是 linkId 而不是 guardianId + studentId
 *
 * 因為一條連結是一個東西。用兩個 id 當參數的話，這一支就要自己
 * 再找一次那一列，而「找不到」與「不是同一條」兩種情況會走到同一個
 * 分支——而其中一種代表畫面上的資料已經過期了（另一位老師剛移除
 * 過），那件事要說得出來。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { guardianFailure, isStaff, setGuardianDelivered, unlinkGuardian } from '@/lib/guardian';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const deny = () =>
  NextResponse.json({ error: '只有老師與管理員可以調整家長連結。' }, { status: 403 });

/**
 * 解除連結。
 *
 * 這位家長沒有別的孩子時，帳號會一併停用而且被登出——回應裡的
 * `archived` 就是那件事，畫面上要說出來。理由見 `unlinkGuardian`。
 */
export const DELETE = scopedRoute<{ linkId: string }>(async (_req, { user, params }) => {
  if (!isStaff(user.systemRole)) return deny();
  try {
    return NextResponse.json({ ok: true, ...(await unlinkGuardian(params.linkId, user.id)) });
  } catch (e) {
    const { status, body } = guardianFailure(e);
    return NextResponse.json(body, { status });
  }
});

const Body = z.object({ delivered: z.boolean() });

/**
 * 標記「帳號密碼當面交給這位家長了」，或撤回那個標記。
 *
 * 這是 `GuardianLink.verifiedAt` 唯一的寫入端。它擋住的東西只有一樣：
 * 沒有標記的連結**不得作為任何推播出去的收件人**（`notifiableGuardians`
 * 是那個唯一的入口）。它不擋登入——進得來就代表他手上有那組只顯示
 * 一次的密碼。完整的理由寫在 `lib/guardian.ts` 的 `notifiableGuardians`。
 */
export const PATCH = scopedRoute<{ linkId: string }>(
  async (req: NextRequest, { user, params }) => {
    if (!isStaff(user.systemRole)) return deny();
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: '請求格式錯誤' }, { status: 400 });
    }
    try {
      const link = await setGuardianDelivered(params.linkId, parsed.data.delivered, user.id);
      return NextResponse.json({ ok: true, delivered: link.verifiedAt != null });
    } catch (e) {
      const { status, body } = guardianFailure(e);
      return NextResponse.json(body, { status });
    }
  },
);
