/**
 * BullMQ 自訂 job id 的組成。**刻意零相依**，理由同
 * `lib/questionShape.mjs`：queue.ts 一被 import 就會建立 Redis 連線，
 * 純函式抽出來才進得了單元測試，而這個格式正是需要被測的東西。
 *
 * **分隔符不能用冒號。** BullMQ 的 Redis key 以 `:` 分段，所以它明確
 * 拒絕含冒號的自訂 id（bullmq 5.x 的 Job.create：
 * `throw new Error('Custom Id cannot contain :')`）。
 *
 * 這個限制在 v0.27.5 之前讓匯入功能**從來沒有成功過**，而症狀完全
 * 指向別的地方：資料庫的匯入工作先建好、畫面顯示「已排隊」，入列
 * 才拋錯，於是佇列裡什麼都沒有、worker 永遠等不到東西。使用者看到
 * 的是「排隊超過兩分鐘還沒開始處理，多半是背景工作者沒有在跑」——
 * 一句把人指往完全錯誤方向的提示。
 */

/**
 * @param {string} jobId 資料庫裡的匯入工作 id
 * @returns {string} 可以直接當 BullMQ jobId 的字串
 */
export function importJobKey(jobId) {
  return `import-${jobId}`;
}
