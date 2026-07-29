/**
 * 組卷的三個純判斷：配分怎麼分、這一題是不是重複的、順序怎麼移。
 *
 * # 為什麼這三件事要離開頁面元件
 *
 * 因為它們錯了都**沒有症狀**：
 *
 *   · 配分分完加起來是 99.99 → 卷頭印 100 分，成績頁的得分率用 99.99
 *     當分母。沒有人會去加那 25 個數字。
 *   · 同一題的兩個版本都加進同一份卷子 → 資料庫的
 *     `UNIQUE (paperId, questionId)` 擋不住（版本是不同的列），
 *     學生會在同一張卷子上看到兩題只差一個字的題目。
 *   · 移動一題算錯了位置 → 送出去的是一份完整的新順序，伺服器照收，
 *     而錯的是「第 12 題現在在第 13 位」這種一眼看不出來的事。
 *
 * 三件都是純函式，所以測得動。碰資料庫的部分留在 `lib/paper.ts`。
 */

/**
 * 兩位小數。與 `lib/paper.ts` 的 `round2` 同一個理由：
 * 20 題各 2.5 分加起來會是 49.99999999999999，而那個數字會被印在卷頭上。
 */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * 配分要用多大的單位來分。
 *
 * 由粗到細取**第一個同時滿足兩件事**的：總分是它的整數倍（不然分完
 * 湊不回老師打的那個數字），而且每一題至少分得到一個單位（不然會出現
 * 0 分的題目，那種題在作答畫面上與其他題長得一模一樣）。
 *
 * 1 分優先，是因為老師報分時說的是「前 20 題各 4 分、後 5 題各 5 分」。
 * 一整排 4.16 分的卷子沒有人念得出來。
 */
function pickUnit(count, total) {
  for (const u of [1, 0.5, 0.01]) {
    const units = total / u;
    if (Math.abs(units - Math.round(units)) < 1e-9 && Math.round(units) >= count) return u;
  }
  return 0.01;
}

/**
 * 把總分平均分配到每一題，**加起來剛好等於總分**。
 *
 * 除不盡的餘數放在**最後幾題**，不是散在中間：段考卷後面通常是選填與
 * 非選，配分本來就高一點，而且「前 20 題 4 分、後 4 題 5 分」這句話
 * 老師要能寫在卷頭上。餘數散在中間就寫不出來了。
 *
 * @param {number} count 題數
 * @param {number} total 總分
 * @returns {number[]} 每一題的配分，長度為 count
 */
export function spreadScores(count, total) {
  if (!Number.isInteger(count) || count < 0) throw new Error('題數要是 0 或正整數');
  if (!Number.isFinite(total) || total < 0) throw new Error('總分要是 0 或正數');
  if (count === 0) return [];

  const want = round2(total);
  if (want === 0) return Array.from({ length: count }, () => 0);

  const unit = pickUnit(count, want);
  const units = Math.round(want / unit);
  const base = Math.floor(units / count);
  const extra = units - base * count;

  return Array.from({ length: count }, (_, i) =>
    round2((base + (i >= count - extra ? 1 : 0)) * unit),
  );
}

/**
 * 每一題同一個分數。
 *
 * 看起來不需要一個函式，但它要回答一個問題：**這樣加起來是多少**。
 * 老師按下「全部套用」之前要先看到那個數字，否則「25 題各 4 分」
 * 與「總分 100」之間還是他自己心算。
 */
export function uniformScores(count, score) {
  if (!Number.isInteger(count) || count < 0) throw new Error('題數要是 0 或正整數');
  if (!Number.isFinite(score) || score < 0) throw new Error('配分要是 0 或正數');
  return Array.from({ length: count }, () => round2(score));
}

/** 一組配分加起來是多少。浮點數的尾巴在這裡收乾淨。 */
export function sumScores(scores) {
  return round2(scores.reduce((n, s) => n + s, 0));
}

/**
 * 這一題已經在卷子上了嗎。
 *
 * 兩種「已經在上面」，而**只有第一種資料庫擋得住**：
 *
 *   `same`    同一列題目（`UNIQUE (paperId, questionId)` 會擋）
 *   `version` 同一題的另一個版本。`Question.familyId` 跨版本穩定、
 *             `id` 不穩定（schema 的版本控制註解），所以改過一次的
 *             題目會有兩列，兩列的 id 不同——資料庫看不出它們是同一題，
 *             而學生會在同一張卷子上看到兩題只差一個字的題目。
 *
 * @param {readonly {questionId: string, familyId: string, order: number}[]} existing
 * @param {{questionId: string, familyId: string}} candidate
 * @returns {{kind: 'same'|'version', order: number} | null}
 */
export function alreadyPicked(existing, candidate) {
  const same = existing.find((e) => e.questionId === candidate.questionId);
  if (same) return { kind: 'same', order: same.order };
  // familyId 可能是空的（理論上不會，但這裡是防守位置）：空字串
  // 對空字串會把所有沒有 familyId 的題目判成同一題。
  if (candidate.familyId) {
    const ver = existing.find((e) => e.familyId === candidate.familyId);
    if (ver) return { kind: 'version', order: ver.order };
  }
  return null;
}

/**
 * 「這一題我用過嗎」——把 `ExamPaperItem` 的反查結果整理成一題一筆。
 *
 * 傳進來的列要**已經照時間由新到舊排好**（`ExamPaperItem` 沒有時間欄位，
 * 排序來自 paper 的 updatedAt／createdAt）。這裡只做分組與截斷，
 * 因為排序規則屬於查詢，而截斷屬於畫面。
 *
 * @param {readonly {questionId: string, paperId: string, paperTitle: string}[]} rows
 * @param {number} limit 每一題最多列幾份卷名
 * @returns {Map<string, {count: number, papers: {id: string, title: string}[], more: number}>}
 */
export function usageByQuestion(rows, limit = 2) {
  /** @type {Map<string, {count: number, papers: {id: string, title: string}[], more: number}>} */
  const out = new Map();
  for (const r of rows) {
    let hit = out.get(r.questionId);
    if (!hit) {
      hit = { count: 0, papers: [], more: 0 };
      out.set(r.questionId, hit);
    }
    // 同一份卷子不會有同一題兩次（UNIQUE），但反查是 join 出來的，
    // 呼叫端有可能送重複的列進來。去重放在這裡比放在每一個呼叫端安全。
    if (hit.papers.some((p) => p.id === r.paperId)) continue;
    hit.count += 1;
    if (hit.papers.length < limit) hit.papers.push({ id: r.paperId, title: r.paperTitle });
    else hit.more += 1;
  }
  return out;
}

/**
 * 把第 `from` 題移到第 `to` 位，回傳完整的新順序。
 *
 * 超出範圍的目標**夾到兩端而不是丟錯**：老師在 25 題的卷子上打
 * 「99」意思是「移到最後」，不是「我打錯了」。而 0 與負數是「移到最前」。
 *
 * @param {readonly string[]} ids 現在的順序
 * @param {number} from 0 起算的來源位置
 * @param {number} to 0 起算的目標位置
 */
export function moveTo(ids, from, to) {
  const next = [...ids];
  if (!Number.isInteger(from) || from < 0 || from >= next.length) {
    throw new Error('要移動的題目不在這份卷子上');
  }
  if (!Number.isFinite(to)) throw new Error('請輸入要移到第幾題');
  const target = Math.min(Math.max(Math.trunc(to), 0), next.length - 1);
  if (target === from) return next;
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}
