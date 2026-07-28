/**
 * 租戶脈絡：這一次請求是誰在看。
 *
 * # 為什麼不是「每個查詢自己帶 tenantId」
 *
 * 那正是這個 repo 原本的做法，而它的失敗方式很安靜：漏掉一個
 * `where: { tenantId }`，查詢仍然成功、仍然回傳資料、沒有任何錯誤，
 * 只是多回傳了別家補習班的幾列。等到系統白牌授權給第二家，
 * 那就從 bug 變成法律問題——出版社詳解的授權範圍是「機構內部使用」，
 * 跨機構就是對外散布。
 *
 * 所以隔離下沉到 Postgres 的 row-level security（見
 * `packages/db/migrations/20260736000000_tenant_isolation_rls`）。
 * 這一層負責的只是把「現在是誰」告訴資料庫。
 *
 * # 怎麼用
 *
 * ```ts
 * const user = await requireUser();
 * return withTenant(user.tenantId, async () => {
 *   // 這裡面的每一次 prisma 查詢都自動限定在這個租戶
 *   return prisma.question.findMany();     // 不必寫 where: { tenantId }
 * });
 * ```
 *
 * 舊程式仍然帶著 `where: { tenantId }` 沒關係——那是多一道保險，
 * 不衝突。新程式不必再寫。
 *
 * # AsyncLocalStorage 而不是參數傳遞
 *
 * 租戶要傳到每一個查詢，而查詢散落在 lib 的十幾個檔案裡。用參數傳
 * 意味著每一個函式都要多一個參數，而**漏傳一個就回到原點**。
 * AsyncLocalStorage 讓它跟著非同步呼叫鏈走，中間的函式不必知道它存在。
 *
 * # 實作在 .mjs
 *
 * 實際的 store 在 `tenantContext.mjs`，因為 `tools/pg-shim.mjs`
 * （沒有 Prisma 引擎時的測試替身）也要用同一份。兩邊各寫一份的話，
 * 測試會綠燈而正式環境會洩漏。
 */
import {
  currentTenant as _currentTenant,
  guc as _guc,
  withTenant as _withTenant,
  withoutTenantScope as _withoutTenantScope,
} from '@/lib/tenantContext.mjs';

export type TenantContext = {
  tenantId: string;
  /** 跨租戶模式。只有背景工作者與遷移腳本該用。 */
  crossTenant?: boolean;
  /** 誰要求跨租戶、為了什麼。跨租戶一定要說得出理由。 */
  reason?: string;
};

export const currentTenant = _currentTenant as () => TenantContext | null;

export const withTenant = _withTenant as <T>(
  tenantId: string,
  fn: () => Promise<T>,
) => Promise<T>;

export const withoutTenantScope = _withoutTenantScope as <T>(
  reason: string,
  fn: () => Promise<T>,
) => Promise<T>;

export const guc = _guc as (
  ctx: TenantContext | null,
) => { tenantId: string; crossTenant: string };

/**
 * 確認目前確實在某個租戶的脈絡下，並回傳它。
 *
 * 給「必須知道 tenantId 才寫得下去」的程式用（例如建立資料時要填
 * tenantId 欄位）。RLS 的 WITH CHECK 也會擋，但在應用層先報錯，
 * 錯誤訊息好懂得多——「忘記包 withTenant」比「new row violates
 * row-level security policy」有用。
 */
export function requireTenant(): string {
  const ctx = currentTenant();
  if (!ctx || ctx.crossTenant || !ctx.tenantId) {
    throw new Error(
      '這段程式需要明確的租戶，但目前沒有租戶脈絡'
        + (ctx?.crossTenant ? '（現在是跨租戶模式）' : '（忘記包 withTenant？）'),
    );
  }
  return ctx.tenantId;
}
