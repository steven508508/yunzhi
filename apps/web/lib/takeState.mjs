/**
 * 作答畫面的幾條判斷。
 *
 * # 為什麼這幾條要離開元件
 *
 * 它們回答的全部是同一個問題：**學生的答案現在到底在不在。**
 * 而那幾種會答錯的情況，恰恰是開發機上重現不出來的——訊號飄、
 * 切出去看訊息、分頁被系統回收、時間到的那一秒剛好連不上。
 * 留在 React 元件裡的話，驗證它們的唯一方法是把一場考試從頭考到尾，
 * 而且要考在一條爛網路上。
 *
 * 所以這裡只放不碰 DOM、不碰網路、不碰系統時間的純函式，
 * 由 `tests/takeState.test.mjs` 一條一條釘住。元件那邊只負責把
 * 目前的狀態餵進來、把回傳畫出去，不再自己做判斷。
 *
 * # 一條貫穿全檔的原則
 *
 * **不確定的時候要說得出「不確定」，不可以說「已存檔」。**
 * v0.21.0 之前這一頁的存檔指示器只寫過一次就永遠掛著「已存檔」，
 * 於是斷線之後畫面上顯示的是一句假話。假話比沉默貴得多：
 * 學生會照著它決定要不要關掉分頁。
 */

// ─────────────────────────────────────────────────────────────────
// 逾時
// ─────────────────────────────────────────────────────────────────

/**
 * 各種請求最多等多久（毫秒）。
 *
 * 沒有逾時的 fetch 在熱點網路上不會失敗，它會**掛著**——TCP 一路重傳，
 * 而存檔那條路上「上一批還在飛」時會直接早退，所以一個掛住的請求
 * 會靜靜擋掉之後所有的存檔，畫面上還是寫著「存檔中…」。
 *
 * 交卷給得最寬：那一支在伺服器端要順手算分，30 個人同時按下去時
 * 本來就會慢，而把它判成失敗會讓學生重按、再加一輪負載。
 */
export const FETCH_TIMEOUT_MS = {
  load: 15_000,
  save: 12_000,
  status: 10_000,
  submit: 20_000,
};

// ─────────────────────────────────────────────────────────────────
// 一、待送出佇列的狀態機
// ─────────────────────────────────────────────────────────────────

/**
 * 存檔指示器現在該說什麼。
 *
 * 四種狀態必須長得**完全不一樣**，因為它們要學生做的事不一樣：
 * 前三種都是「什麼都不必做」，第四種是「不要關掉這一頁」。
 * 舊版把第四種畫成第三種，代價是學生在資訊真空裡自己去按重新整理。
 *
 * `failures` 排在最前面判斷：只要上一輪送失敗了，即使這一秒剛好
 * 沒有請求在飛，畫面也不可以退回「已存檔」——那個「已存檔」講的是
 * 四十分鐘前的事。
 */
export function saveIndicator({
  inFlight = false,
  pendingCount = 0,
  failures = 0,
  savedAtLabel = null,
} = {}) {
  if (failures > 0) {
    // 佇列理論上不會是空的（送失敗的會被放回去），但真的是空的時候
    // 也不能說「未送出 0 題」，那句話讀起來像沒事。
    const n = Math.max(pendingCount, 1);
    return {
      kind: 'retrying',
      urgent: true,
      label: `未送出 ${n} 題`,
      detail:
        `有 ${n} 題還沒送到伺服器（已重試 ${failures} 次）。` +
        '答案還在這台裝置上，系統會一直重試。' +
        '請不要關掉或重新整理這個畫面；一直沒有恢復就舉手告訴監考老師。',
    };
  }
  if (inFlight || pendingCount > 0) {
    return { kind: 'saving', urgent: false, label: '存檔中…', detail: null };
  }
  if (savedAtLabel) {
    // 帶上時刻。只寫「已存檔」的話，四十分鐘前存的與三秒前存的
    // 在畫面上一模一樣。
    return { kind: 'saved', urgent: false, label: `已存檔 ${savedAtLabel}`, detail: null };
  }
  return { kind: 'idle', urgent: false, label: '', detail: null };
}

// ─────────────────────────────────────────────────────────────────
// 二、本機與伺服器的答題數比對
// ─────────────────────────────────────────────────────────────────

/**
 * 考試進行中的比對。伺服器每 30 秒的校時裡就帶著它真正收到幾題，
 * 舊版收到之後直接丟掉。
 *
 * 三種結果要分開，因為「還在佇列裡」與「不見了」對學生的意義差很多：
 *
 *   ok       伺服器收到的不比本機少
 *   pending  差額落在待送出佇列裡——正常，重試會補上，不要嚇他
 *   lost     差額比佇列還多——這是真的少了，要說
 */
export function answeredGap({ local, server, pendingCount = 0 } = {}) {
  if (typeof local !== 'number' || typeof server !== 'number') {
    return { kind: 'unknown', gap: 0, detail: null };
  }
  const gap = local - server;
  if (gap <= 0) return { kind: 'ok', gap: 0, detail: null };
  if (gap <= pendingCount) return { kind: 'pending', gap, detail: null };
  return {
    kind: 'lost',
    gap,
    detail:
      `你寫了 ${local} 題，伺服器目前只收到 ${server} 題。` +
      '系統正在補送，請不要關掉這一頁；一分鐘後還是對不起來就舉手。',
  };
}

/**
 * 交卷那一刻的比對。
 *
 * 系統在這裡同時握著「學生以為寫了幾題」與「資料庫裡真的有幾題」，
 * 舊版把兩者並列在畫面上而不比較。三題選擇題在學測數學是 15 分，
 * 而學生要到隔天檢討頁上看到「沒有作答」才會發現，那時已經無法舉證。
 *
 *   ok        伺服器收到的不比本機少，而且全部題目都寫了
 *   short     兩邊一致，只是有幾題本來就空著——正常，但要列出來
 *   mismatch  伺服器比本機少——**這是資料遺失，要講重話**
 */
export function submitCheck({ local, server, total } = {}) {
  const l = typeof local === 'number' ? local : 0;
  const t = typeof total === 'number' ? total : 0;
  if (typeof server !== 'number') {
    // 伺服器沒回這個數字（舊版本、或回應被截掉）。不要編一個出來——
    // 沒有比對過就不能說「都收到了」。
    return { kind: 'unknown', local: l, server: null, total: t, missing: 0, blank: 0 };
  }
  const missing = l - server;
  if (missing > 0) {
    return { kind: 'mismatch', local: l, server, total: t, missing, blank: Math.max(0, t - server) };
  }
  const blank = Math.max(0, t - server);
  if (blank > 0) return { kind: 'short', local: l, server, total: t, missing: 0, blank };
  return { kind: 'ok', local: l, server, total: t, missing: 0, blank: 0 };
}

// ─────────────────────────────────────────────────────────────────
// 三、題組素材的回頭查找
// ─────────────────────────────────────────────────────────────────

/**
 * 這一題該顯示哪一段題幹素材。
 *
 * `loadAttemptForStudent` 為了省頻寬，只把素材掛在題組的第一題上
 * （一篇 500 字的閱讀素材在封包裡出現三次，學生的手機在熱點網路下
 * 要多等那幾百 KB）。那個決定是對的，**但作答畫面一次只畫一題**，
 * 所以第 38 題的學生看不到第 37 題上面那篇文章。
 *
 * 檢討頁一次列出全部 25 題，素材就在上面一列，所以同一個決定在
 * 那邊完全沒有症狀——這正是它不會在開發時被發現的原因。
 *
 * 往回掃而不是往前掃：`buildLayout` 保證同一個題組的各小題在版面上
 * 相鄰且維持原順序，所以帶素材的那一題一定在前面。掃到列表開頭為止
 * 而不是碰到別的題組就停，是因為版面快照萬一有髒資料時，
 * 多掃 24 次的成本遠低於學生看不到題目。
 */
export function stimulusFor(questions, index) {
  const q = Array.isArray(questions) ? questions[index] : null;
  if (!q) return null;
  if (q.stimulus) {
    return { stimulus: q.stimulus, label: q.stimulusLabel ?? null, inherited: false };
  }
  if (!q.groupId) return null;
  for (let i = index - 1; i >= 0; i--) {
    const prev = questions[i];
    if (!prev || prev.groupId !== q.groupId) continue;
    if (prev.stimulus) {
      return { stimulus: prev.stimulus, label: prev.stimulusLabel ?? null, inherited: true };
    }
  }
  return null;
}

/**
 * 這個題組在版面上涵蓋哪幾題。畫面上要寫「第 37–39 題共用」，
 * 學生才知道自己讀的是不是同一段，而不是懷疑上一題的內容跑進來了。
 */
export function groupRange(questions, index) {
  const q = Array.isArray(questions) ? questions[index] : null;
  if (!q || !q.groupId) return null;
  const mine = questions.filter((x) => x && x.groupId === q.groupId).map((x) => x.order);
  if (mine.length < 2) return null;
  return { from: Math.min(...mine), to: Math.max(...mine), count: mine.length };
}

// ─────────────────────────────────────────────────────────────────
// 四、剩餘時間的提醒門檻
// ─────────────────────────────────────────────────────────────────

/**
 * 要主動提醒的兩個時刻（秒）。
 *
 * 舊版只讓右上角 17px 的數字換一個顏色，而學生此刻的視線在螢幕
 * 下半部——他正在捲動看選項。「不閃爍」的理由成立（慌不會讓人寫得
 * 比較快），但「不閃爍」與「不通知」是兩件事。
 */
export const TIME_ALERTS = [300, 60];

/**
 * 從 `prev` 走到 `left` 這一步，有沒有跨過某個門檻。
 *
 * 回傳的是**門檻**而不是訊息，因為續考的人一進來 `prev` 就是 null、
 * 而 `left` 可能已經是 200 秒——那時說「剩下 5 分鐘」是假的。
 * 訊息由呼叫端用真正的 `left` 去寫（「剩下不到 5 分鐘（03:20）」），
 * 門檻只負責保證同一個提醒不會每半秒跳一次。
 */
export function timeAlert(prev, left) {
  if (typeof left !== 'number') return null;
  // 由小到大：已經剩不到一分鐘的人不需要再被告知「剩不到五分鐘」。
  const ordered = [...TIME_ALERTS].sort((a, b) => a - b);
  for (const t of ordered) {
    if (left <= t && (prev == null || prev > t)) {
      return { threshold: t, minutes: Math.round(t / 60) };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────
// 五、哪幾題還沒寫
// ─────────────────────────────────────────────────────────────────

/**
 * 未作答的題號。
 *
 * 舊版只給一個總數（「已答 9 / 25」），而學生在剩五分鐘時要問的是
 * 「是哪幾題」。題號欄的底色本來說得出來，但它不黏著，這時候
 * 已經捲到看不見的地方了。
 *
 * 超過 `max` 就收尾，因為 20 個題號連著唸完，學生一個都記不住，
 * 而那時他要做的事是回去把它們寫完，不是讀一串數字。
 */
export function listUnanswered(items, max = 8) {
  const all = (Array.isArray(items) ? items : []).filter((i) => i && !i.answered);
  const orders = all.map((i) => i.order);
  if (orders.length === 0) return { count: 0, orders: [], text: '' };
  const head = orders.slice(0, max);
  const text =
    orders.length > max ? `${head.join('、')} 等 ${orders.length} 題` : head.join('、');
  return { count: orders.length, orders, text };
}

// ─────────────────────────────────────────────────────────────────
// 六、自動交卷的重試
// ─────────────────────────────────────────────────────────────────

/**
 * 時間到的自動交卷失敗之後，隔多久再試（毫秒）。
 *
 * 舊版只試一次：那個 effect 的相依是 `left`，而 `Math.max(0, …)` 之後
 * 恆為 0，React 用 `Object.is` 比對 → effect 不重跑。於是倒數走到
 * 00:00 的那一刻剛好在收訊死角的學生，卷子就永遠停在 IN_PROGRESS，
 * 而他的成績單上什麼都沒有。
 *
 * `submitAttempt` 是冪等的（compare-and-set，重複交卷回同一個結果），
 * 所以重試完全安全。**而且不設上限**——只要這個畫面還開著就一直試，
 * 因為放棄的代價是一整份成績。
 */
export const SUBMIT_RETRY_MS = [5_000, 15_000, 30_000, 60_000];

export function submitRetryDelay(failures) {
  if (typeof failures !== 'number' || failures < 1) return null;
  const i = Math.min(Math.floor(failures), SUBMIT_RETRY_MS.length) - 1;
  return SUBMIT_RETRY_MS[i];
}
