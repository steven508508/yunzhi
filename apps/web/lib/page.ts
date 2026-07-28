/**
 * 伺服器元件（頁面）的外殼。與 `lib/route.ts` 的 `scopedRoute` 同一件事，
 * 只是頁面沒有統一的 handler 簽章可以包，所以做成一個小函式。
 *
 * ```ts
 * export default async function BankPage() {
 *   return scopedPage(async (user) => {
 *     const rows = await prisma.question.findMany();   // 已限定租戶
 *     return <Bank rows={rows} />;
 *   });
 * }
 * ```
 *
 * 沒登入就轉到登入頁——與各頁自己寫 `if (!user) redirect('/login')`
 * 的結果一樣，但少一次忘記的機會。
 */
import { redirect } from 'next/navigation';

import { requireUser, type SessionUser } from '@/lib/auth';
import { withTenant } from '@/lib/tenant';

export async function scopedPage<T>(
  render: (user: SessionUser) => Promise<T>,
): Promise<T> {
  const user = await requireUser();
  if (!user) redirect('/login');
  return withTenant(user.tenantId, () => render(user));
}
