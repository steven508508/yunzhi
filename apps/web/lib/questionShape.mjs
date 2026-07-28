/**
 * 選項與答案鍵的正規化。**純函式，沒有任何相依。**
 *
 * 放在這裡而不是寫在 commit.ts 裡，是因為它有兩個呼叫端：
 * 正式路徑（`lib/commit.ts`）與端到端測試用的 `tools/commit-shim.mjs`
 * （測試環境沒有 Prisma 引擎，所以那支是另一份實作）。
 *
 * 兩份實作分歧的風險是這個專案目前最脆弱的一處——測試會綠燈而
 * 正式環境會壞。把「會算錯答案」的那一段抽出來共用，至少讓最危險
 * 的部分只有一份。
 *
 * 寫成 .mjs 而不是 .ts：commit-shim 是直接跑在 node 上的，
 * 不經過 TypeScript 編譯。型別由同名的 .d.ts 提供。
 */

/**
 * 把選項重新編號，並把答案鍵一起對映過去。
 *
 * **這兩件事不能分開做。** 選項序號必須從 1 連續（`questions` 的
 * 選擇題檢核要求），所以丟掉內容為空的選項之後要重新編號；而
 * `answerKeys` 存的就是那個序號。分開做的話：
 *
 *     原稿  (1)60元 (2)70元 (3)80元 (4)90元   answerKeys=[4]
 *     掃描漏抓 (2)                            → 重編號後 4 應該變成 3
 *     入庫    (1)60元 (2)80元 (3)90元         answerKeys=[4] ← 指到「90元」以外的東西
 *
 * 沒有任何錯誤訊息。題目以 DRAFT 入庫，老師發布之後每一個
 * 答對的學生都被判錯。`answerKeys` 是 `Int[]`，對 `question_options`
 * 沒有外鍵也沒有 CHECK，資料庫層完全擋不住。
 *
 * @param {unknown} raw 候選題上的 options（JSON 欄位，形狀不保證）
 * @param {number[]} answerKeys 原稿的答案鍵
 * @returns {{options: {order:number,label:string,content:string}[],
 *            answerKeys: number[], dropped: number[]}}
 *          dropped 是**對不上任何選項**的答案鍵。有值就代表這一題
 *          不該入庫——不猜、不硬塞、不靜默丟掉。
 */
export function normalizeOptions(raw, answerKeys = []) {
  if (!Array.isArray(raw)) return { options: [], answerKeys: [...answerKeys], dropped: [] };

  const kept = [];
  for (const [i, o] of raw.entries()) {
    if (!o || typeof o !== 'object') continue;
    const content = String(o.content ?? '').trim();
    if (!content) continue;
    const order = Number(o.order) || i + 1;
    kept.push({ order, label: String(o.label ?? order), content });
  }
  kept.sort((a, b) => a.order - b.order);

  const remap = new Map();
  const options = kept.map((o, i) => {
    remap.set(o.order, i + 1);
    return { ...o, order: i + 1 };
  });

  const mapped = [];
  const dropped = [];
  for (const k of answerKeys) {
    const to = remap.get(k);
    if (to === undefined) dropped.push(k);
    else mapped.push(to);
  }
  mapped.sort((a, b) => a - b);
  return { options, answerKeys: mapped, dropped };
}
