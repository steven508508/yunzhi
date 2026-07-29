/**
 * 能力分析：掌握度怎麼算出來的。
 *
 * # 為什麼掌握度不是答對率
 *
 * 答對率把三個月前的一題與昨天的一題算成一樣重，而遺忘是真的——
 * `KnowledgePoint.decayRate` 這一欄存在就是為了這件事。一位學生
 * 六月時「機率統計」答對率 80%，整個暑假一題都沒碰，九月開學時
 * 那個 80% 仍然掛在畫面上；他照著它決定不用複習，然後段考考壞。
 *
 * 但**只把每一題加上時間權重是不夠的**，那是這個公式最容易寫錯的
 * 地方：掌握度若寫成 `Σ(w·答對) / Σw`，全部的權重會在分子分母裡
 * 同時縮小然後互相抵銷——一位三個月沒碰的學生，他的掌握度**一個
 * 小數點都不會動**。要讓「沒碰就會掉」真的發生，分母必須有一項
 * 不隨時間縮小的東西。
 *
 * # 公式
 *
 *     age_i    = max(0, now − answeredAt_i)  以天計
 *     decay_i  = exp(−decayRate × age_i / 7)
 *     w_i      = decay_i × 題目對這個知識點的權重 × 難度係數
 *     W        = Σ w_i          （證據的總量）
 *     C        = Σ w_i·答對_i   （其中支持「他會」的部分）
 *
 *     掌握度 = C / (W + PRIOR_WEIGHT)
 *
 * `PRIOR_WEIGHT` 是一份**永遠不會消失的反面證據**，講白話是
 * 「在沒有證據之前，先當作還沒學會」。它同時解掉兩個問題：
 *
 *   · **證據放久了會失效。** 作答一直不更新的話 W → 0，
 *     於是掌握度 → 0。這就是「三個月沒碰所以掉下來」的來源。
 *   · **一題答對不等於學會。** 1/1 算出來是 0.33 而不是 1.00。
 *
 * 兩件事用同一個機制處理不是巧合：它們本來就是同一件事——
 * **手上的證據夠不夠支撐「他會」這個結論。**
 *
 * # 衰減的單位是「每週」
 *
 * `decayRate` 的 schema 註解只說「程序性知識衰減快，概念性較慢」，
 * 沒有給單位，所以這裡定：**每週**。預設值 0.05 換算成半衰期是
 * 7×ln2/0.05 ≈ 97 天，大約三個多月——一個暑假。也就是說預設設定下，
 * 「暑假前練熟的東西，開學時剩一半」，這與老師的直覺對得起來。
 *
 * 選每週而不是每天，是因為每天在預設值下是 14 天半衰期：學生兩週前
 * 剛考完的段考成績會被打到剩一半，而那份資料是這套系統最有價值的
 * 東西。選每月則是 14 個月半衰期，那等於沒有衰減——而沒有衰減正是
 * 這個檔案要解決的問題。
 *
 * # 難度
 *
 * 答對一題難題與答對一題送分題不該一樣。`Question.difficulty` 的慣例
 * 是 **1 = 最難**（`lib/commit.ts` 用 `1 − 全國答對率` 算出來），
 * 沒有值時當 0.5（中等）處理，於是難度對它完全不起作用。
 *
 * 四個方向都要對：
 *
 *   答對難題 → 加權放大   這是「他會」的強證據
 *   答對送分題 → 加權縮小 全班都對的題目說明不了什麼
 *   答錯送分題 → 加權放大 這是「他不會」的強證據
 *   答錯難題 → 加權縮小   全國一半的人也錯
 *
 * # 為什麼這個檔案不碰資料庫（大部分）
 *
 * §1 是純函式，沒有任何 import，所以測得動——公式算錯的症狀是
 * 一個看起來很正常的小數，沒有測試的話沒有人會發現。
 *
 * §2 是讀寫，但**client 由呼叫端傳進來**。三個呼叫端要跑同一份程式：
 * 網頁端（`lib/abilityDb.ts` 的 prisma 單例）、整批重算腳本、
 * 端到端測試（pg-shim）。各寫一份的話，「交卷後逐次更新」與
 * 「整批重建」會算出不同的答案，而那時沒有人知道哪一個是對的。
 * 這與 `lib/prismaClient.mjs`、`lib/tenantContext.mjs` 是同一個做法。
 */

// ═════════════════════════════════════════════════════════════════
// §1 純函式：公式與門檻
// ═════════════════════════════════════════════════════════════════

/** 一天的毫秒數。 */
const DAY = 24 * 60 * 60 * 1000;

/**
 * 樣本量門檻：低於這個題數，掌握度不標成可靠。
 *
 * # 為什麼是 5
 *
 * 往下：1 題只有 0% 與 100% 兩種結果，2 題只有三種。單選題猜對的
 * 機率是 1/5，也就是說**一位完全不會的學生，有兩成機率在 1 題的
 * 樣本下看起來完全掌握**。3 到 4 題仍然被一次幸運猜中主導。
 *
 * 往上：一份段考涵蓋同一個知識點通常只有 2 到 4 題。門檻設 10 的話，
 * 一個知識點要考三四次才會有數字——也就是開學後兩個月，整頁都寫著
 * 「資料不足」，而那正是老師最需要它的時候。一個永遠不顯示的分析
 * 等於沒有分析。
 *
 * 5 題大約是「同一個知識點被考過兩次」，而且到這個量級之後，
 * 單獨一次幸運猜中已經不足以翻轉結論（它只移動 1/(5+2) 的幅度）。
 *
 * **這是一個折衷，不是一個定理。** 調高它，畫面上會誠實但空曠；
 * 調低它，會出現看起來精確但站不住的數字。改之前請先想清楚
 * 「介面上那個數字要被誰拿去做什麼決定」。
 */
export const MIN_ITEMS = 5;

/**
 * 證據的有效總量下限。低於它一樣不可靠，即使題數夠。
 *
 * 沒有這一條的話，「兩年前答對過 8 題、之後再也沒碰」會被標成可靠，
 * 而畫面上顯示的是一個因為衰減而掉到 0.2 的掌握度——看的人會以為
 * 「他不會」，但真相是「不知道他現在會不會」。那兩件事的下一步
 * 完全不同：前者要補課，後者要先測一次。
 *
 * 取 `MIN_ITEMS / 2`：預設衰減率下，剛好是「這批作答老到只剩一半
 * 權重」的那個點，約三個多月。
 */
export const STALE_FLOOR = MIN_ITEMS / 2;

/**
 * 先驗權重：在沒有任何證據時，把掌握度拉向 0 的那個力道。
 *
 * 2 的意思是「要看到兩題份量的新證據，才願意把掌握度從 0 抬起來」。
 * 具體長相（全部答對、剛考完、中等難度）：
 *
 *     1 題 → 0.33     5 題 → 0.71     10 題 → 0.83     20 題 → 0.91
 *
 * **全對不會是 1.00，這是刻意的。** 掌握度是「證據支不支持他會」，
 * 而證據永遠不完備。給出 1.00 等於宣稱這個知識點他不可能再錯。
 */
export const PRIOR_WEIGHT = 2;

/**
 * 難度係數的擺幅。0.6 代表係數落在 0.7 到 1.3 之間。
 *
 * 不敢開更大：`difficulty` 多數時候來自原稿印的全國答對率，而那個
 * 數字對應的母體（全國考生）與這裡的學生不是同一群。讓它主導掌握度
 * 是拿一個借來的常數去改寫本班的事實。
 */
export const DIFF_SPAN = 0.6;

/** 沒有難度資料時當成中等。係數會剛好是 1，也就是難度不起作用。 */
export const NEUTRAL_DIFFICULTY = 0.5;

/**
 * 「這個要補」的界線。
 *
 * 0.5 在這個公式下大約是「五題裡答對三題、而且是剛考完的」。
 * 學測的脈絡下，一個知識點三成到四成的題目做不出來就是要處理的。
 */
export const WEAK = 0.5;

/** 「這個穩了」的界線。要六題份量的新證據而且幾乎全對才到得了。 */
export const SOLID = 0.75;

/** 連續答錯幾次算「卡住了」。三次是一個學生自己也感覺得到的次數。 */
export const STUCK_STREAK = 3;

/**
 * 一個班要有幾位學生的可靠資料，才說得出「全班都不會」。
 *
 * 兩位學生同時弱是巧合，三位開始像是教的問題。低於它的知識點不是
 * 不顯示，是**標成資料不足**——老師要看得到「這裡還沒有結論」，
 * 而不是看到一片空白然後以為全班都會。
 */
export const MIN_CLASS_SAMPLE = 3;

const clamp = (v, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

/** 存進資料庫之前收斂到 4 位小數。多出來的位數是浮點雜訊，不是資訊。 */
const round4 = (v) => Math.round(v * 1e4) / 1e4;

/**
 * 時間衰減權重。
 *
 * @param {Date|number|null|undefined} answeredAt 什麼時候答的
 * @param {Date|number} now
 * @param {number} decayRate 每週的衰減率（`KnowledgePoint.decayRate`）
 * @returns {number} 0 到 1
 *
 * **未來的時間戳一律當成「現在」。** 伺服器時鐘跑掉、或資料從別的
 * 機器搬過來時，答題時間會落在未來；不夾住的話 exp 的指數變成正的，
 * 那一題的權重會超過 1——一題就能蓋過其他二十題，而畫面上只是
 * 一個看起來偏高的掌握度。
 */
export function decayWeight(answeredAt, now, decayRate) {
  const t = answeredAt instanceof Date ? answeredAt.getTime() : Number(answeredAt);
  const n = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(t) || !Number.isFinite(n)) return 1;
  const ageDays = Math.max(0, (n - t) / DAY);
  const rate = clamp(decayRate, 0, 1);
  if (rate === 0) return 1; // 不衰減的知識點（老師刻意設 0）
  return Math.exp((-rate * ageDays) / 7);
}

/**
 * 難度係數。見檔頭的四個方向。
 *
 * @param {number|null|undefined} difficulty 1 = 最難，0 = 最簡單，null = 不知道
 * @param {boolean} isCorrect
 */
export function difficultyFactor(difficulty, isCorrect) {
  const d = difficulty == null || !Number.isFinite(difficulty)
    ? NEUTRAL_DIFFICULTY
    : clamp(difficulty, 0, 1);
  // 答對時「愈難愈重」，答錯時「愈簡單愈重」。中等難度兩邊都是 1。
  const lean = isCorrect ? d - NEUTRAL_DIFFICULTY : NEUTRAL_DIFFICULTY - d;
  return 1 + DIFF_SPAN * lean;
}

/**
 * @typedef {object} AbilityItem 一題已經判過對錯的作答，對某一個知識點的證據
 * @property {boolean} isCorrect
 * @property {Date} answeredAt
 * @property {number|null} [difficulty] `Question.difficulty`，1 = 最難
 * @property {number} [linkWeight] `QuestionKnowledgePoint.weight`，這一題有多少
 *   份量在講這個知識點
 */

/**
 * @typedef {object} AbilityStat
 * @property {number} correct 原始答對題數（**不加權**）
 * @property {number} total 原始題數
 * @property {number} mastery 0 到 1
 * @property {boolean} reliable 樣本夠不夠、資料新不新
 * @property {number} evidence 證據的有效總量 W。介面上不顯示，
 *   但「為什麼這個標成資料不足」只有它答得出來。
 * @property {Date|null} lastAnsweredAt
 * @property {number} streakWrong 最近連續答錯幾題
 */

/**
 * 一個學生在一個知識點上的掌握度。
 *
 * `correct` 與 `total` 是**原始計數，不加權**。老師一定會問
 * 「這個 0.35 是怎麼算出來的」，而一個算不出來的數字沒有人會相信；
 * 「你 7 題錯 5 題」是他當場驗證得了的東西。
 *
 * 取名 `masteryOf` 而不是 `mastery`，是因為結果物件裡有一個叫
 * `mastery` 的欄位——同名的話，讀的人分不出哪一個是哪一個。
 *
 * @param {AbilityItem[]} items 這個知識點上所有判過對錯的作答
 * @param {{ decayRate?: number, now?: Date }} [opts]
 * @returns {AbilityStat}
 */
export function masteryOf(items, opts = {}) {
  const now = opts.now ?? new Date();
  const decayRate = opts.decayRate ?? 0.05;

  // 零作答：不是 0 分，是「沒有資料」。呼叫端要靠 total === 0 分辨。
  if (!Array.isArray(items) || items.length === 0) {
    return {
      correct: 0,
      total: 0,
      mastery: 0,
      reliable: false,
      evidence: 0,
      lastAnsweredAt: null,
      streakWrong: 0,
    };
  }

  // 連續答錯要從最近的一題往回數，所以先排序。時間相同時維持原順序
  // （Array.prototype.sort 在 V8 是穩定的），那多半是同一份卷子裡
  // 一起存進來的幾題，誰先誰後沒有意義。
  const sorted = [...items].sort(
    (a, b) => timeOf(a.answeredAt) - timeOf(b.answeredAt),
  );

  let correct = 0;
  let W = 0;
  let C = 0;
  let last = null;
  let streakWrong = 0;

  for (const it of sorted) {
    const ok = it.isCorrect === true;
    if (ok) correct++;

    const link = clamp(it.linkWeight ?? 1, 0, 1) || 1e-6;
    const w = decayWeight(it.answeredAt, now, decayRate)
      * link
      * difficultyFactor(it.difficulty, ok);
    W += w;
    if (ok) C += w;

    const t = it.answeredAt instanceof Date ? it.answeredAt : new Date(it.answeredAt);
    if (!last || t > last) last = t;

    streakWrong = ok ? 0 : streakWrong + 1;
  }

  const total = sorted.length;
  return {
    correct,
    total,
    mastery: round4(C / (W + PRIOR_WEIGHT)),
    // 兩個條件缺一不可：題數夠（不是一次幸運猜中），而且這些作答
    // 還沒有舊到失去參考價值。
    reliable: total >= MIN_ITEMS && W >= STALE_FLOOR,
    evidence: round4(W),
    lastAnsweredAt: last,
    streakWrong,
  };
}

function timeOf(v) {
  const t = v instanceof Date ? v.getTime() : Number(new Date(v));
  return Number.isFinite(t) ? t : 0;
}

/**
 * 把一位學生的作答攤平成「每個知識點一列」。
 *
 * 這是 `refreshAbility` 真正在算的東西，抽出來是為了測得到：
 * 進去的是幾張表的原始列，出來的是要寫進 `ability_snapshots` 的值。
 *
 * **只有 `points` 裡列出來的知識點會被算。** 逐次更新時那是「這份
 * 卷子碰到的知識點」，整批重算時那是「全部」——而兩條路走的是同一段
 * 程式，所以不可能算出不同的答案。
 *
 * @param {object} rows
 * @param {{questionId: string, isCorrect: boolean|null, answeredAt: Date}[]} rows.answers
 *   **`isCorrect === null` 的會被跳過**：非選題還沒有人評分，
 *   對錯未定。把它算成答錯，等於在作文改完之前先扣他的掌握度。
 * @param {{questionId: string, knowledgePointId: string, weight?: number}[]} rows.links
 * @param {{id: string, difficulty?: number|null}[]} rows.questions
 * @param {{id: string, decayRate?: number}[]} rows.points
 * @param {Date} [now]
 * @returns {(AbilityStat & {knowledgePointId: string})[]}
 */
export function computeSnapshots(rows, now = new Date()) {
  const difficultyOf = new Map(
    (rows.questions ?? []).map((q) => [q.id, q.difficulty ?? null]),
  );
  const decayOf = new Map((rows.points ?? []).map((p) => [p.id, p.decayRate ?? 0.05]));

  // 題目 → 它掛在哪幾個知識點上。一題掛多個是常態（一道題同時考
  // 「三角函數」與「一元二次方程式」），每一個都拿到這一題的證據。
  const linksOf = new Map();
  for (const l of rows.links ?? []) {
    if (!decayOf.has(l.knowledgePointId)) continue; // 不在這次要算的範圍
    const list = linksOf.get(l.questionId) ?? [];
    list.push(l);
    linksOf.set(l.questionId, list);
  }

  /** @type {Map<string, AbilityItem[]>} */
  const byKp = new Map();
  for (const a of rows.answers ?? []) {
    if (a.isCorrect === null || a.isCorrect === undefined) continue;
    for (const l of linksOf.get(a.questionId) ?? []) {
      const list = byKp.get(l.knowledgePointId) ?? [];
      list.push({
        isCorrect: a.isCorrect === true,
        answeredAt: a.answeredAt,
        difficulty: difficultyOf.get(a.questionId) ?? null,
        linkWeight: l.weight ?? 1,
      });
      byKp.set(l.knowledgePointId, list);
    }
  }

  const out = [];
  for (const [knowledgePointId, items] of byKp) {
    out.push({
      knowledgePointId,
      ...masteryOf(items, { decayRate: decayOf.get(knowledgePointId), now }),
    });
  }
  // 排序只是為了讓兩次執行的輸出順序一致（比對與稽核好讀），
  // 與掌握度的計算無關。
  return out.sort((a, b) => (a.knowledgePointId < b.knowledgePointId ? -1 : 1));
}

/**
 * @typedef {object} KpView 一個知識點在畫面上的樣子（畫面自己的型別更寬，見 lib/abilityDb.ts）
 * @property {string} id
 * @property {string} name
 * @property {number} mastery
 * @property {boolean} reliable
 * @property {number} correct
 * @property {number} total
 * @property {number} streakWrong
 */

/**
 * 弱的排前面。
 *
 * **資料不足的一律排到最後**，即使它的掌握度數字更低。理由是這一份
 * 清單要回答的是「接下來練什麼」，而一個只做過一題的知識點給不出
 * 那個答案——把它排在第一位，學生會照著它去練一個其實他早就會的東西。
 *
 * @param {KpView[]} points
 * @returns {KpView[]}
 */
export function weakestFirst(points) {
  return [...points].sort((a, b) => {
    if (a.reliable !== b.reliable) return a.reliable ? -1 : 1;
    if (a.mastery !== b.mastery) return a.mastery - b.mastery;
    // 同分時題數多的排前面：同樣是 0.4，錯了 12 題比錯了 3 題重要。
    return b.total - a.total;
  });
}

/**
 * 「接下來練什麼」——這一份分析真正要交付的東西。
 *
 * 「機率統計掌握度 0.35」對學生沒有用。有用的是「機率統計你 7 題錯
 * 5 題，而它的前置『排列組合』你也只有 0.4——先補排列組合」。
 * 差別在於後者說得出**下一個動作**。
 *
 * 判斷順序是刻意的：
 *
 *   1. **卡住了**（連續錯 `STUCK_STREAK` 題）優先於一切，連樣本量
 *      門檻都排在它後面。一個連錯三題的人再多練十題也是連錯十三題，
 *      他需要的是有人講一次。
 *   2. **資料不足**就誠實說不知道，不要編一個建議。
 *   3. **前置沒補**：往回走 `KpPrerequisite`，找最弱的那一個前置。
 *      在前置還缺的時候練這一個知識點，是拿正確的方法練錯的東西。
 *   4. 前置都穩了才是**直接練**。
 *
 * @param {KpView} point
 * @param {KpView[]} prereqs 這個知識點的前置，附這位學生的掌握度。
 *   資料不足的前置也傳進來——「不知道他會不會」也是一種答案。
 * @returns {{ kind: string, prereq: KpView|null, text: string }}
 */
export function nextStep(point, prereqs = []) {
  const wrong = point.total - point.correct;

  // **卡住了排在樣本量門檻前面**，因為 `streakWrong` 是數出來的，
  // 不是估出來的。「連續錯三題」在只做過三題的時候一樣成立，而那
  // 恰恰是最該講一句話的時候——樣本不足的理由是「掌握度這個估計
  // 站不住」，它管不到一個真實發生過的計數。
  if (point.streakWrong >= STUCK_STREAK) {
    return {
      kind: 'STUCK',
      prereq: null,
      text: `最近連續錯 ${point.streakWrong} 題，卡住了。這種時候再多練也是繼續錯——先找老師或用檢討頁的智慧老師把其中一題從頭走一次。`,
    };
  }

  if (!point.reliable) {
    return {
      kind: 'UNKNOWN',
      prereq: null,
      text: `目前只有 ${point.total} 題的紀錄，還說不準。再練幾題（或等下一次考試）之後這裡才會有結論。`,
    };
  }

  // 已經知道他不會的前置，排在「不知道會不會」的前面：兩者都值得處理，
  // 但前者是事實，後者只是缺資料。
  const broken = prereqs
    .filter((p) => p.reliable && p.mastery < WEAK)
    .sort((a, b) => a.mastery - b.mastery)[0];
  if (broken) {
    return {
      kind: 'PREREQ',
      prereq: broken,
      text:
        `這一個你 ${point.total} 題錯 ${wrong} 題，而它的前置「${broken.name}」` +
        `你也只有 ${fmt(broken.mastery)}——先補前置，再回頭練這一個。` +
        `前置還缺的時候練這一個，是拿對的方法練錯的東西。`,
    };
  }

  // 前置沒有足夠的紀錄。**這不是「前置沒問題」**，而這兩件事在
  // 下一步上完全不同：一個是去練這個知識點，一個是先去確認底子。
  const unknown = prereqs.filter((p) => !p.reliable).sort((a, b) => a.total - b.total)[0];
  if (unknown) {
    return {
      kind: 'PREREQ',
      prereq: unknown,
      text:
        `這一個你 ${point.total} 題錯 ${wrong} 題。它的前置是「${unknown.name}」，` +
        `而你在前置上只有 ${unknown.total} 題的紀錄——先做幾題前置確認底子在，` +
        `不然練這一個很可能一直卡在同一個地方。`,
    };
  }

  return {
    kind: 'PRACTICE',
    prereq: null,
    text: `這一個你 ${point.total} 題錯 ${wrong} 題，前置都穩，就是這個知識點本身要多練。`,
  };
}

const fmt = (v) => v.toFixed(2);

/**
 * 一個班在一個知識點上的整體狀況。
 *
 * 老師問的是「哪一個章節全班都不會」，而那決定下一堂課重講什麼。
 * 所以排序的第一鍵是**多少比例的人是弱的**，不是平均掌握度：
 * 一個「半數的人 0.2、半數的人 0.9」的知識點，平均起來很正常，
 * 但它其實是全班最該處理的那一個。
 *
 * @param {{knowledgePointId: string, mastery: number, reliable: boolean,
 *   correct: number, total: number}[]} snapshots 全班的快照（同一個知識點會有多列）
 * @returns {{knowledgePointId: string, students: number, reliableStudents: number,
 *   weakStudents: number, meanMastery: number|null, correct: number, total: number,
 *   enough: boolean}[]}
 */
export function classWeakness(snapshots) {
  const acc = new Map();
  for (const s of snapshots ?? []) {
    const a = acc.get(s.knowledgePointId) ?? {
      knowledgePointId: s.knowledgePointId,
      students: 0,
      reliableStudents: 0,
      weakStudents: 0,
      sum: 0,
      correct: 0,
      total: 0,
    };
    a.students++;
    a.correct += s.correct ?? 0;
    a.total += s.total ?? 0;
    if (s.reliable) {
      a.reliableStudents++;
      a.sum += s.mastery;
      if (s.mastery < WEAK) a.weakStudents++;
    }
    acc.set(s.knowledgePointId, a);
  }

  return [...acc.values()]
    .map((a) => ({
      knowledgePointId: a.knowledgePointId,
      students: a.students,
      reliableStudents: a.reliableStudents,
      weakStudents: a.weakStudents,
      meanMastery: a.reliableStudents > 0 ? round4(a.sum / a.reliableStudents) : null,
      correct: a.correct,
      total: a.total,
      // 樣本不夠的不是「沒問題」，是「還沒有結論」。畫面上要分開講。
      enough: a.reliableStudents >= MIN_CLASS_SAMPLE,
    }))
    .sort((x, y) => {
      if (x.enough !== y.enough) return x.enough ? -1 : 1;
      const rx = x.reliableStudents > 0 ? x.weakStudents / x.reliableStudents : 0;
      const ry = y.reliableStudents > 0 ? y.weakStudents / y.reliableStudents : 0;
      if (rx !== ry) return ry - rx;
      return (x.meanMastery ?? 1) - (y.meanMastery ?? 1);
    });
}

/**
 * 依題型的表現。業主明講要「題目類型」的分析。
 *
 * **分母只算有作答的題目。** 空白題在 `attempt_answers` 裡根本沒有列
 * （見 lib/scoring.ts 檔頭），從這裡看不到；硬要把它算成答錯，
 * 就得改從卷面推回來，而那條路要對每一份作答讀一次版面快照。
 * 這個取捨要寫在畫面上——不寫的話，「多選題答對率 71%」會被讀成
 * 「全班多選很好」，但真相可能是一半的人直接跳過。
 *
 * @param {{type: string, isCorrect: boolean|null}[]} rows
 * @returns {{type: string, answered: number, correct: number, rate: number|null,
 *   pending: number}[]}
 */
export function typeBreakdown(rows) {
  const acc = new Map();
  for (const r of rows ?? []) {
    const type = r.type || 'UNKNOWN';
    const a = acc.get(type) ?? { type, answered: 0, correct: 0, pending: 0 };
    if (r.isCorrect === null || r.isCorrect === undefined) {
      // 非選題還沒改完。列出來讓老師知道「這一格還不是結論」。
      a.pending++;
    } else {
      a.answered++;
      if (r.isCorrect === true) a.correct++;
    }
    acc.set(type, a);
  }
  return [...acc.values()]
    .map((a) => ({
      ...a,
      rate: a.answered > 0 ? round4(a.correct / a.answered) : null,
    }))
    .sort((x, y) => {
      // 低的排前面，那是老師要處理的。沒有答對率的排最後。
      if (x.rate === null) return 1;
      if (y.rate === null) return -1;
      return x.rate - y.rate;
    });
}

// ═════════════════════════════════════════════════════════════════
// §2 讀寫：三個呼叫端共用同一份
//
// 這一段的 `db` 是外部傳進來的 Prisma client（或 tools/pg-shim.mjs
// 的替身）。**只用 pg-shim 也支援的語法**：平的 where、`in`、
// `select`、`orderBy`、`take`，沒有關聯過濾、沒有 include、
// 沒有 upsert、沒有 $transaction。多用一個，端到端測試就跑不到
// 這段程式，而跑不到的地方就是兩條路徑開始分岐的地方。
// ═════════════════════════════════════════════════════════════════

/**
 * 一次最多回溯幾份作答。
 *
 * 三年 240 份是正常的量，400 給轉班與重考留餘裕。真的超過時被丟掉的
 * 是最舊的那幾份，而它們在衰減之後本來就只剩百分之幾的權重。
 * **兩條路徑都用同一個上限，所以截斷不會讓它們算出不同答案。**
 */
const ATTEMPT_LIMIT = 400;

/**
 * 重算一位學生的能力快照。
 *
 * # 為什麼是「重算」而不是「累加」
 *
 * 因為老師會改標準答案、會送分、會作廢一份作答。累加的寫法在那三件事
 * 之後就永遠對不回來了——而它錯的方式是安靜的：畫面上仍然是一個
 * 看起來正常的小數。從既有作答重算一次是幾十毫秒的事，
 * 而「快照與作答記錄永遠一致」值得這幾十毫秒。
 *
 * 這也是「逐次更新」與「整批重算」不可能分岐的原因：**它們是同一支
 * 函式**，差別只在 `knowledgePointIds` 有沒有限定範圍。
 *
 * @param {any} db Prisma client 或 pg-shim
 * @param {object} opts
 * @param {string} opts.tenantId 建立快照時要寫進去
 * @param {string} opts.userId
 * @param {string[]|null} [opts.knowledgePointIds] 只重算這幾個知識點。
 *   `null` = 全部。**證據一律取自這位學生的全部作答**，不因為限定範圍
 *   而只看這一份卷子——否則掌握度會在每次交卷後被最後一份卷子覆蓋。
 * @param {Date} [opts.now]
 * @returns {Promise<{userId: string, points: number, written: number, removed: number}>}
 */
export async function refreshAbility(db, opts) {
  const { tenantId, userId, knowledgePointIds = null, now = new Date() } = opts;

  // 只有交出去的作答算數。**作廢的（VOIDED）與進行中的（IN_PROGRESS）
  // 都不算**：前者的意思就是「這一份不算數」，而它若混進能力分析，
  // 一份因為作弊而作廢的滿分卷會把掌握度拉高，沒有人看得出來。
  const attempts = await db.attempt.findMany({
    where: { userId, status: { in: ['SUBMITTED', 'GRADED'] } },
    select: { id: true },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    take: ATTEMPT_LIMIT,
  });

  const answers = attempts.length
    ? await db.attemptAnswer.findMany({
        where: { attemptId: { in: attempts.map((a) => a.id) } },
        select: { questionId: true, isCorrect: true, answeredAt: true },
      })
    : [];

  const questionIds = [...new Set(answers.map((a) => a.questionId))];
  const allLinks = questionIds.length
    ? await db.questionKnowledgePoint.findMany({
        where: { questionId: { in: questionIds } },
        select: { questionId: true, knowledgePointId: true, weight: true },
      })
    : [];

  // 要算哪幾個知識點：限定範圍時取交集，否則取這位學生碰過的全部。
  const wanted = knowledgePointIds ? new Set(knowledgePointIds) : null;
  const links = wanted ? allLinks.filter((l) => wanted.has(l.knowledgePointId)) : allLinks;
  const kpIds = [...new Set(links.map((l) => l.knowledgePointId))];

  const [questions, points] = await Promise.all([
    questionIds.length
      ? db.question.findMany({
          where: { id: { in: questionIds } },
          select: { id: true, difficulty: true },
        })
      : Promise.resolve([]),
    kpIds.length
      ? db.knowledgePoint.findMany({
          where: { id: { in: kpIds } },
          select: { id: true, decayRate: true },
        })
      : Promise.resolve([]),
  ]);

  const computed = computeSnapshots({ answers, links, questions, points }, now);

  // 既有的快照。限定範圍時只碰範圍內的那幾列——一份數學卷子不該
  // 把這位學生的物理快照刪掉。
  const existing = await db.abilitySnapshot.findMany({
    where: {
      userId,
      ...(knowledgePointIds ? { knowledgePointId: { in: knowledgePointIds } } : {}),
    },
    select: { id: true, knowledgePointId: true },
  });
  const rowIdOf = new Map(existing.map((e) => [e.knowledgePointId, e.id]));

  let written = 0;
  for (const c of computed) {
    const data = {
      correct: c.correct,
      total: c.total,
      mastery: c.mastery,
      reliable: c.reliable,
      lastAnsweredAt: c.lastAnsweredAt,
      streakWrong: c.streakWrong,
    };
    const id = rowIdOf.get(c.knowledgePointId);
    if (id) {
      await db.abilitySnapshot.update({ where: { id }, data });
    } else {
      await db.abilitySnapshot.create({
        data: { tenantId, userId, knowledgePointId: c.knowledgePointId, ...data },
      });
    }
    written++;
  }

  // 沒有任何證據留下來的快照要刪掉，不是留一列 0。
  //
  // **「掌握度 0」與「沒有資料」在畫面上是兩件完全不同的事**，
  // 而作廢一份作答、或老師把題目的知識點標註改掉之後，這一列的證據
  // 就真的不存在了。留著 0 的話，那位學生的能力分析上會多出一個
  // 他從來沒被考過、卻標著「完全不會」的知識點。
  const alive = new Set(computed.map((c) => c.knowledgePointId));
  const stale = existing.filter((e) => !alive.has(e.knowledgePointId)).map((e) => e.id);
  let removed = 0;
  if (stale.length) {
    const r = await db.abilitySnapshot.deleteMany({ where: { id: { in: stale } } });
    removed = r?.count ?? stale.length;
  }

  return { userId, points: computed.length, written, removed };
}

/**
 * 這一份作答碰到哪幾個知識點。逐次更新時用它縮小重算範圍。
 *
 * 回傳空陣列有兩種意思：這份卷子的題目一個知識點都沒標，或者
 * 知識點圖譜本身還是空的。兩種的結果都一樣——這一次不必重算。
 *
 * @param {any} db
 * @param {string[]} questionIds
 * @returns {Promise<string[]>}
 */
export async function knowledgePointsOfQuestions(db, questionIds) {
  const ids = [...new Set(questionIds ?? [])].filter(Boolean);
  if (ids.length === 0) return [];
  const links = await db.questionKnowledgePoint.findMany({
    where: { questionId: { in: ids } },
    select: { knowledgePointId: true },
  });
  return [...new Set(links.map((l) => l.knowledgePointId))];
}

/**
 * 整批重建：從既有作答把全部快照重算一次。
 *
 * 第一次上線時快照是空的（能力分析是後來才加的，而作答記錄已經
 * 累積了一整個學期），這支就是把那段歷史補回來的路徑。它也是
 * 「快照懷疑不準」時的復原手段——重算一次一定會回到與作答記錄一致。
 *
 * **一位學生失敗不該讓整批停住。** 停住的話結果是「前 40 位重算了、
 * 後 160 位沒有」，而畫面上只有一句錯誤訊息。
 *
 * @param {any} db
 * @param {object} opts
 * @param {string} opts.tenantId
 * @param {string[]} opts.userIds
 * @param {Date} [opts.now]
 * @param {(done: number, total: number, userId: string) => void} [opts.onProgress]
 */
export async function rebuildAbility(db, opts) {
  const { tenantId, userIds, now = new Date(), onProgress } = opts;
  const result = { users: userIds.length, points: 0, removed: 0, failures: [] };
  let done = 0;
  for (const userId of userIds) {
    try {
      const r = await refreshAbility(db, { tenantId, userId, knowledgePointIds: null, now });
      result.points += r.points;
      result.removed += r.removed;
    } catch (e) {
      result.failures.push({ userId, error: e instanceof Error ? e.message : String(e) });
    }
    done++;
    if (onProgress) onProgress(done, userIds.length, userId);
  }
  return result;
}
