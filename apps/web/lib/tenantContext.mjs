/**
 * 租戶脈絡的實作。**純 JS、沒有任何相依。**
 *
 * 寫成 .mjs 而不是 .ts，理由與 `questionShape.mjs` 一樣：它有兩個
 * 呼叫端，而其中一個不經過 TypeScript 編譯。
 *
 *   正式路徑    `lib/tenant.ts` → `lib/prisma.ts`
 *   測試路徑    `tools/pg-shim.mjs`（沒有 Prisma 引擎時的替身）
 *
 * 兩邊各寫一份的話，測試會綠燈而正式環境會洩漏——而這一段管的正是
 * 「A 補習班看不看得到 B 補習班的資料」。那是分歧代價最高的一處，
 * 所以它只有一份。
 *
 * 型別由 `lib/tenant.ts` 提供。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage();

/** 目前的租戶脈絡。沒有就是 null。 */
export function currentTenant() {
  return store.getStore() ?? null;
}

/**
 * 在某個租戶的脈絡下執行。
 *
 * 忘記包的話會**查不到東西，不是查到全部**。這是刻意的：fail closed
 * 的錯誤在開發時立刻看得到（畫面空了），fail open 的錯誤要等到出事。
 */
export function withTenant(tenantId, fn) {
  if (!tenantId) {
    throw new Error('withTenant 需要 tenantId。空字串會讓 RLS 擋掉所有查詢。');
  }
  return store.run({ tenantId }, fn);
}

/**
 * 跨租戶執行。**只有背景工作者與遷移腳本該用。**
 *
 * 有些工作本來就是跨租戶的：worker 要從佇列取出任意租戶的工作、
 * 遷移要改所有租戶的資料、備份要讀全部。沒有這個逃生口，那些程式
 * 會被迫整個關掉 RLS，而那比留一個有名字、要求說明理由、
 * 而且被靜態檢查盯著的開關糟得多。
 *
 * `tools/rls-check.mjs` 會檢查 `app.cross_tenant` 只出現在允許的檔案裡。
 */
export function withoutTenantScope(reason, fn) {
  if (!reason || reason.length < 6) {
    throw new Error('跨租戶執行必須說明理由——那是唯一能繞過隔離的地方。');
  }
  return store.run({ tenantId: '', crossTenant: true, reason }, fn);
}

/**
 * 把脈絡翻譯成資料庫要的兩個設定值。
 *
 * 呼叫端一律要用 `set_config(key, value, true)`——第三個參數是
 * is_local，**只在目前交易內有效**。
 *
 * 這一點是整段設計的關鍵：連線是從連線池借來的。若把租戶設成
 * session 層級，請求結束後設定會留在那條連線上，下一個請求借到
 * 同一條連線就繼承了上一個請求的租戶。那種洩漏與程式碼無關、
 * 與請求內容無關，只跟連線池這次剛好給了哪一條連線有關——
 * 所以它會偶發、無法重現、而且測不出來。
 */
export function guc(ctx) {
  if (!ctx) return { tenantId: '', crossTenant: '' };
  return {
    tenantId: ctx.tenantId ?? '',
    crossTenant: ctx.crossTenant ? 'on' : '',
  };
}

/**
 * 離開所有租戶脈絡執行。**只給測試用。**
 *
 * 「忘記包 withTenant 會怎樣」是這整套設計最重要的一條性質，
 * 而要驗證它就必須真的製造出「沒有脈絡」的狀態。
 * AsyncLocalStorage 的 `exit()` 是唯一做得到的方法——用 Promise
 * 或 setTimeout 都逃不出去，脈絡會跟著非同步鏈走。
 *
 * 正式程式一律不該呼叫它：需要跨租戶就用 `withoutTenantScope`，
 * 那個會留下理由，而這個什麼都不留。
 */
export function exitTenantScope(fn) {
  return store.exit(fn);
}
