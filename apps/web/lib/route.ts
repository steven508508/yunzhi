/**
 * API 路由的外殼：登入檢查與租戶脈絡，一次做完。
 *
 * # 為什麼要有這一層
 *
 * 每一個路由原本都長這樣：
 *
 * ```ts
 * const user = await requireUser();
 * if (!user) return NextResponse.json({ error: '未登入' }, { status: 401 });
 * const { jobId } = await params;
 * ...
 * ```
 *
 * 三行樣板，重複十二次。現在要再加一行「建立租戶脈絡」，變成十三次
 * 機會忘記其中一行——而**忘記建立租戶脈絡的症狀是查不到資料**
 * （RLS 是 fail closed），至少會被發現；但忘記登入檢查的症狀是
 * 沒有登入檢查，那不會被發現。
 *
 * 藍圖裡剩下的批次還要再加大約五十個路由。與其寫五十次樣板，
 * 不如讓它變成結構的一部分：**用了這個外殼，就不可能忘記。**
 *
 * # 用法
 *
 * ```ts
 * export const GET = scopedRoute(async (req, { user, params }) => {
 *   const rows = await prisma.question.findMany();   // 已限定在 user 的租戶
 *   return NextResponse.json(rows);
 * });
 *
 * // 有動態路徑參數時給型別，params 已經 await 過
 * export const POST = scopedRoute<{ jobId: string }>(
 *   async (req, { user, params }) => { ... params.jobId ... },
 * );
 * ```
 */
import { NextRequest, NextResponse } from 'next/server';

import { requireUser, type SessionUser } from '@/lib/auth';
import { withTenant } from '@/lib/tenant';

export type RouteContext<P> = {
  user: SessionUser;
  params: P;
};

export type ScopedHandler<P> = (
  req: NextRequest,
  ctx: RouteContext<P>,
) => Promise<Response>;

/**
 * 包一個需要登入的路由。
 *
 * 做三件事，順序不能換：
 *   1. 查出是誰（這一步跨租戶，因為此時還不知道租戶——見 lib/auth.ts）
 *   2. 沒登入就 401，**handler 完全不會被呼叫**
 *   3. 在該使用者的租戶脈絡下執行 handler
 */
export function scopedRoute<P = Record<string, never>>(handler: ScopedHandler<P>) {
  return async (
    req: NextRequest,
    // 第二個參數宣告成必填，是為了對上 Next 15.5 為每個 route 產生的
    // 型別驗證檔（`.next/types/.../route.ts`）：它要求 handler 的第二個
    // 參數能接受 `{ params: Promise<...> }`，而 `seg?:` 會讓推導出的型別
    // 多一個 `| undefined`，於是 `next build` 在 type-checking 階段整個
    // 停住——**產線映像根本建不出來，而錯誤訊息完全看不出是這裡**。
    // 執行期仍然用 `seg?.` 取值，因為非動態路由不保證拿得到這個物件。
    seg: { params: Promise<P> },
  ): Promise<Response> => {
    const user = await requireUser();
    if (!user) {
      return NextResponse.json({ error: '未登入' }, { status: 401 });
    }
    const params = seg?.params ? await seg.params : ({} as P);
    return withTenant(user.tenantId, () => handler(req, { user, params }));
  };
}

/**
 * 包一個**不需要登入**的路由（健檢、版本、登入本身）。
 *
 * 刻意做成一個明確的函式而不是「什麼都不包」，因為
 * `tools/rls-check.mjs` 會檢查每一個碰 prisma 的路由檔案有沒有
 * 建立租戶脈絡。公開路由必須在這裡明說「我不需要」，
 * 而不是安靜地被漏掉——那兩件事在程式碼上長得一模一樣。
 *
 * @param why 為什麼這個路由不需要登入。給下一個人看的。
 */
export function publicRoute(
  why: string,
  handler: (req: NextRequest) => Promise<Response>,
) {
  if (!why || why.length < 4) {
    throw new Error('公開路由要說明為什麼不需要登入');
  }
  return handler;
}
