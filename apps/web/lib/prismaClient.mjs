/**
 * 建一個「會自動告訴資料庫現在是哪個租戶」的 Prisma client。
 *
 * 寫成 .mjs 是因為有三個呼叫端，其中兩個不經過 TypeScript 編譯：
 *
 *   apps/web/lib/prisma.ts          網頁端的單例
 *   apps/web/scripts/worker.mjs     背景工作者
 *   apps/web/scripts/migrate-and-seed.mjs
 *
 * 各寫一份的話，遲早有一個忘了設租戶——而那一個會在 RLS 底下什麼都
 * 查不到（如果它該限定租戶），或者更糟：如果有人為了讓它「動起來」
 * 而把它改成永遠跨租戶，隔離就從那個缺口整個漏掉。
 */
import { currentTenant, guc } from './tenantContext.mjs';

/**
 * 每一個查詢都先設定租戶，再執行。
 *
 * # 為什麼要包成交易
 *
 * `set_config(key, value, true)` 的第三個參數是 is_local——設定只在
 * **目前交易**內有效。這是整段程式的關鍵：連線是從連線池借來的，
 * 若把租戶設成 session 層級，這次查詢結束後設定會留在那條連線上，
 * 下一個請求借到同一條連線就繼承了上一個請求的租戶。
 *
 * 那是最糟的一種洩漏：與程式碼無關、與請求內容無關，只跟連線池
 * 這次剛好給了哪一條連線有關——所以它會偶發、無法重現、測不出來。
 *
 * 代價是每次查詢多一次往返。300 人同時作答的量級下這可以接受，
 * 而「偶發的跨租戶洩漏」不行。
 *
 * # 沒有租戶脈絡時
 *
 * 設成空字串。RLS 政策比對 `"tenantId" = current_setting(...)`，
 * 空字串對不上任何一列，所以查不到東西——**fail closed**。
 * 忘記包 `withTenant` 會在開發時立刻現形（畫面空了），不是等到上線。
 */
export function tenantScoped(base) {
  return base.$extends({
    query: {
      async $allOperations({ args, query }) {
        const g = guc(currentTenant());
        const [, , result] = await base.$transaction([
          base.$executeRaw`SELECT set_config('app.tenant_id', ${g.tenantId}, true)`,
          base.$executeRaw`SELECT set_config('app.cross_tenant', ${g.crossTenant}, true)`,
          query(args),
        ]);
        return result;
      },
    },
  });
}
