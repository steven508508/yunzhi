/**
 * 放行：學生什麼時候看得到成績，以及哪一份解析可以給他看。
 *
 * # 為什麼這兩條規則寫在同一個檔案，而且是純函式
 *
 * 它們是同一種東西——**「這個東西現在可不可以出現在學生的螢幕上」**——
 * 而且兩條都有一個共同特徵：**寫錯不會有任何錯誤訊息**。
 *
 * 放行時機寫錯的症狀是一份 ON_DUE 的考試在交卷後就給看答案，
 * 於是先寫完的人把答案傳給還在寫的人；解析權利判斷寫錯的症狀是
 * 出版社的詳解原文出現在學生畫面上，而那是一封律師函。兩者在
 * 開發時看起來都完全正常，因為它們在畫面上長得就像「功能好了」。
 *
 * 所以這兩段刻意抽成不碰資料庫、不碰 React 的純函式：**它們是這個
 * 功能裡唯一有單元測試保護的部分**（`tests/release.test.mjs`），
 * 而散在頁面裡的 `if` 一個都測不到。
 *
 * # 三種結果，不是兩種
 *
 * 「看得到」與「看不到」不夠用。真正的中間狀態是**看得到分數、
 * 但看不到答案**——ON_DUE 要防的是「答案外流」而不是「知道自己幾分」，
 * 把分數也一起藏起來只會讓學生在截止前的那幾天以為系統壞了。
 *
 * 而「什麼都還看不到」必須說得出**什麼時候才看得到**。一個空白畫面
 * 會變成一通打給老師的電話，而老師也不知道答案。
 */

/**
 * @typedef {'FULL'|'SCORE_ONLY'|'NONE'} ResultLevel
 *   FULL       分數、逐題對錯、解析全部看得到
 *   SCORE_ONLY 只看得到分數。**逐題與解析一律不查、不傳、不畫**
 *   NONE       現在什麼都還看不到
 */

/**
 * @typedef {object} ResultVisibility
 * @property {ResultLevel} level
 * @property {string} reason 給學生看的一句話。**每一種結果都要有**——
 *   包含 FULL，因為畫面上要說得出「為什麼現在看得到」。
 * @property {Date|null} availableAt 什麼時候會開放。永遠不開、或
 *   時間由老師決定（MANUAL）時是 null。
 */

/**
 * @typedef {object} ReleaseAssignment
 * @property {string} releasePolicy IMMEDIATE / ON_SUBMIT / ON_DUE / MANUAL / NEVER
 * @property {Date|null} [dueAt]
 * @property {Date|null} [releasedAt] 老師手動放行的時刻。MANUAL 時才看它。
 */

/**
 * @typedef {object} ReleaseAttempt
 * @property {string} status IN_PROGRESS / SUBMITTED / GRADED / VOIDED
 * @property {Date|null} [submittedAt]
 */

/** @type {(reason: string, availableAt?: Date|null) => ResultVisibility} */
const none = (reason, availableAt = null) => ({ level: 'NONE', reason, availableAt });
/** @type {(reason: string, availableAt?: Date|null) => ResultVisibility} */
const scoreOnly = (reason, availableAt = null) => ({
  level: 'SCORE_ONLY',
  reason,
  availableAt,
});
/** @type {(reason: string) => ResultVisibility} */
const full = (reason) => ({ level: 'FULL', reason, availableAt: null });

/**
 * 這一份作答現在可以給這位學生看到什麼程度。
 *
 * # 判斷順序是刻意的，換了順序訊息就會說謊
 *
 * 作廢 → 不開放 → 還沒交卷 → 才輪到各政策。
 *
 * `NEVER` 排在「還沒交卷」前面，是因為對一份永遠不開放的考試說
 * 「交卷之後才看得到」是**騙人**——學生會交完卷再回來看一次，
 * 然後找老師問為什麼還是沒有。訊息的正確性與擋不擋得住同樣重要。
 *
 * # 三件不參與判斷的事
 *
 * **一、`mode`（正式測驗／練習）不參與。** 派任務的表單上，模式與
 * 「解析什麼時候給看」是並排的兩個選項，老師是分別選的。用 PRACTICE
 * 去推翻他明確選的 ON_DUE，等於系統自作主張改了老師的設定。
 *
 * **二、非選題改完了沒有不參與。** 那是「這個分數準不準」，不是
 * 「可不可以看」，由畫面上的提示處理（見結果頁的待評分提醒）。
 * 混進來的話，一份含作文的考卷會在老師改完之前完全打不開。
 *
 * **三、`allowLate` 不參與 ON_DUE 的判斷。** 開了遲交的任務在截止後
 * 仍有人在寫，而那時已交卷的人看得到答案了——這是真的破口，但
 * 系統不該自己把老師設定的時間往後延（延到什麼時候？沒有答案），
 * 那只會變成「老師設了截止時間卻沒有開放」。真的要擋，用 MANUAL。
 *
 * @param {ReleaseAssignment} assignment
 * @param {ReleaseAttempt} attempt
 * @param {Date} [now]
 * @returns {ResultVisibility}
 */
export function maySeeResult(assignment, attempt, now = new Date()) {
  // 作廢的作答沒有分數可言（`gradeAttemptById` 直接拒絕計分），
  // 而它是誠信事件或系統故障的結果——這種事一定要人來說明，
  // 不能讓學生在檢討頁看到一個 0 分然後自己猜。
  if (attempt.status === 'VOIDED') {
    return none('這一份作答已經作廢，不會計分。要知道原因或申請重考，請直接找老師。');
  }

  if (assignment.releasePolicy === 'NEVER') {
    return none('這份考試不開放檢討，有問題請找老師。');
  }

  // 交卷之前一律看不到整份檢討，**五種政策都一樣，包含 IMMEDIATE**。
  //
  // IMMEDIATE 的意思是「每題作答後」——那是作答畫面裡逐題揭曉的
  // 機制。這一頁是整份卷子的檢討，寫到第 10 題就打開它的話，
  // 後面 30 題的答案會一起出現在畫面上。**那不是即時解析，
  // 那是一份答案卡。**
  const finished = attempt.status === 'SUBMITTED' || attempt.status === 'GRADED';
  if (!finished) {
    return none('這一份還在作答中，交卷之後才會結算成績。');
  }

  switch (assignment.releasePolicy) {
    case 'IMMEDIATE':
      return full('這份任務設定為作答後立即開放檢討。');

    case 'ON_SUBMIT':
      return full('這份任務在交卷後開放檢討。');

    case 'ON_DUE': {
      const dueAt = assignment.dueAt ?? null;
      if (!dueAt) {
        // 設了「截止後開放」卻沒有截止時間。那個時刻永遠不會到，
        // 所以逐題檢討不能開——但分數沒有理由跟著扣住，而且要
        // 說得出這是設定的問題，否則學生會一直等一個不會來的時間。
        return scoreOnly(
          '這份任務設定為截止後開放檢討，但老師還沒有設定截止時間。' +
            '想看逐題檢討與解析，請告訴老師。',
        );
      }
      if (now > dueAt) {
        return full('已經過了截止時間，全班同時開放檢討。');
      }
      // **這一格就是整個檔案存在的理由。**
      //
      // 判成 FULL 的話，先交卷的人在截止前就拿得到整份答案，
      // 而他的同學還在寫。傳一張截圖只要三秒，而事後完全查不出來
      // ——成績單上只會看到那個班的平均特別高。
      return scoreOnly(
        `逐題檢討與解析要等 ${fmtTaipei(dueAt)} 截止之後才會開放，全班同時。` +
          '這是為了避免先交卷的人把答案傳出去。',
        dueAt,
      );
    }

    case 'MANUAL': {
      const releasedAt = assignment.releasedAt ?? null;
      if (releasedAt && releasedAt <= now) {
        return full('老師已經開放這份考試的檢討。');
      }
      // 手動放行時連分數都不給看，與 ON_DUE 不同。理由是老師選
      // MANUAL 多半正是因為**還有東西沒處理完**（非選題還在改、
      // 補考還沒考、某一題要送分）。這時候給出一個自動計分的分數，
      // 學生會拿一個還會變的數字當結果——一份含作文的卷子在作文
      // 還沒改之前是 60 分，而他不知道那 25 分還沒算進去。
      // 這一句同時會出現在任務清單與檢討頁上，所以不能寫「這一頁」
      // 之類指涉版面的話——在另一個畫面上它就變成一句對不上的話。
      return none('老師還沒有開放這份考試的成績與檢討。開放之後就看得到了。');
    }

    default:
      // 認不得的政策一律當成不開放。日後 schema 多一個 enum 值而
      // 這裡忘了跟上時，症狀是「學生看不到成績」——那會被回報；
      // 反過來預設開放的話，症狀是洩題，而那不會被回報。
      return none('這份任務的成績開放設定看不懂，請告訴老師。');
  }
}

// ─────────────────────────────────────────────────────────────────
// 手動放行：老師那一側
// ─────────────────────────────────────────────────────────────────

/**
 * @typedef {object} ReleaseControl
 * @property {boolean} applicable 這份任務是不是「老師手動放行」。false 時整塊 UI 不出現。
 * @property {boolean} released 學生現在看得到了沒——判定與 `maySeeResult` 完全一致。
 * @property {Date|null} releasedAt
 * @property {string} note 老師看到的一句狀態說明。
 */

/**
 * 這份任務的手動放行現在是什麼狀態。
 *
 * # 為什麼這一支要存在，而不是在頁面裡寫 `assignment.releasedAt ? ... : ...`
 *
 * 因為「放行了沒」有兩個讀者：**學生端的 `maySeeResult` 與老師端的
 * 按鈕**，而它們必須是同一個答案。分開寫的話，`releasedAt` 是一個
 * 未來時刻時（時鐘校正、或日後真的做了預約放行），老師看到「已放行」
 * 而學生看到「還沒開放」——兩邊都不覺得自己壞了，於是變成一通
 * 「系統說已經放行但我看不到」的電話，而那通電話沒有人查得出原因。
 *
 * 所以這裡與 `maySeeResult` 的 MANUAL 分支用同一條判斷：
 * `releasedAt != null && releasedAt <= now`。
 *
 * @param {ReleaseAssignment} assignment
 * @param {Date} [now]
 * @returns {ReleaseControl}
 */
export function releaseControl(assignment, now = new Date()) {
  if (assignment.releasePolicy !== 'MANUAL') {
    return { applicable: false, released: false, releasedAt: null, note: '' };
  }
  const releasedAt = assignment.releasedAt ?? null;
  const released = releasedAt != null && releasedAt <= now;
  return {
    applicable: true,
    released,
    releasedAt,
    note: released
      ? `已於 ${fmtTaipei(/** @type {Date} */ (releasedAt))} 放行，學生看得到分數與逐題檢討。`
      : releasedAt != null
        ? // 放行時刻在未來。目前的 UI 寫不出這種值，但時鐘校正過的機器會
          // 產生它，而學生端一定會照 `maySeeResult` 判成「還沒開放」。
          // 老師這裡跟著說實話，否則兩個畫面會各說各話。
          `放行時間記成了 ${fmtTaipei(releasedAt)}，那一刻還沒到，學生現在仍看不到。`
        : '還沒放行。學生交完卷之後看不到分數，也看不到逐題檢討。',
  };
}

/**
 * 老師按下放行／收回，這一次動作合不合法。
 *
 * # 為什麼「已經是這個狀態」要當成錯誤而不是靜靜地成功
 *
 * 因為兩個老師同時看著同一頁時，後按的那一位會以為是自己放行的。
 * 而「收回」尤其不能靜靜地成功——收回一份根本沒放行過的任務，
 * 畫面上看起來與真的收回一模一樣，老師會以為自己剛剛做了一件事。
 *
 * # 為什麼非 MANUAL 一律拒絕
 *
 * `releasedAt` 這一欄只有 MANUAL 會被讀（見 `maySeeResult`）。對一份
 * ON_DUE 的任務寫進放行時刻，是一個**看起來成功但完全沒有作用**的
 * 動作：老師按了、畫面說已放行、學生仍然要等截止。
 *
 * @param {ReleaseAssignment} assignment
 * @param {boolean} release true = 放行，false = 收回
 * @param {Date} [now]
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function checkReleaseChange(assignment, release, now = new Date()) {
  const state = releaseControl(assignment, now);
  if (!state.applicable) {
    return {
      ok: false,
      error:
        '這份任務不是「老師手動放行」，成績開放的時機由設定決定，' +
        '按這裡不會有任何作用。要改成手動放行，請到任務設定裡改。',
    };
  }
  // 判斷用的是 releasedAt 有沒有值，不是 state.released。未來時刻的
  // 那一格對老師來說是「已經按過了」——再按一次不會改變任何東西
  // （`updateAssignment` 保留原本的 releasedAt），所以要擋。
  const marked = state.releasedAt != null;
  if (release && marked) {
    return { ok: false, error: '這份任務已經放行過了。重新整理看看是不是別人剛按的。' };
  }
  if (!release && !marked) {
    return { ok: false, error: '這份任務還沒有放行，沒有東西可以收回。' };
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────
// 解析：哪一份可以給學生看
// ─────────────────────────────────────────────────────────────────

/**
 * @typedef {object} RawExplanation
 * @property {string} id
 * @property {boolean} isPrimary
 * @property {string} origin
 * @property {string} displayMode FULL / SUMMARY_ONLY / HIDDEN
 * @property {string} licenseScope PUBLIC / TENANT_EXPORTABLE / TENANT_NO_EXPORT / INTERNAL_USE_ONLY
 * @property {Date|null} takedownAt
 * @property {unknown} layers
 * @property {string|null} [sourceRef]
 * @property {string|null} [modelUsed]
 * @property {Date} [updatedAt]
 */

/**
 * @typedef {object} LayerItem
 * @property {string|null} lead 這一項前面的小標：步驟編號、選項代號。沒有就是 null。
 * @property {string} body
 */

/**
 * @typedef {object} Layer
 * @property {string} key conclusion / steps / distractors / extensions
 * @property {string} label 給學生看的層名
 * @property {LayerItem[]} items
 */

/**
 * @typedef {object} VisibleExplanation
 * @property {string} id
 * @property {string} origin
 * @property {Layer[]} layers
 * @property {boolean} noExport 授權只到「本補習班內部線上閱讀」。
 *   畫面上不可以提供複製／下載／列印的便利功能。
 * @property {string|null} sourceRef
 * @property {string|null} modelUsed
 */

/**
 * `origin` 的預設優先序（文件 02 §3.9）。
 *
 * 老師自編排第一不是禮貌——**補習班老師的解題方法與符號習慣是機構的
 * 教學資產**，學生上課學的是那一套，系統拿另一套教他等於兩邊都不熟。
 */
const ORIGIN_RANK = {
  TEACHER_WRITTEN: 0,
  OFFICIAL_CEEC: 1,
  AI_GENERATED: 2,
  AI_REWRITTEN: 3,
  VERBATIM_IMPORT: 4,
};

/**
 * 學生看得到的那一份解析，沒有就是 null。
 *
 * # 三道排除，順序無關但一條都不能少
 *
 * **一、`takedownAt` 不是 null 的一律不要。** 下架的意思是權利人來信了、
 * 或機構自己覺得這一份的權利基礎有問題。下架之後還看得到，等於沒有下架。
 *
 * **二、`displayMode = HIDDEN` 的不要。** 那是老師把這一份收起來了。
 *
 * **三、`INTERNAL_USE_ONLY` 的不要。** 「內部」指的是機構內部的老師，
 * 不是學生。`TENANT_NO_EXPORT` 才是「本補習班的學生可以看，但不可以
 * 帶出去」——兩者差一個字，而放錯的那一次會把一份聲明為僅供內部參考
 * 的原文送到兩百個學生面前。
 *
 * # 為什麼「排完之後 layers 是空的」要再往下找一份
 *
 * `layers` 預設是 `{}`，而匯入時只有真的有詳解原文才會寫進去。挑中一份
 * 空的就直接回傳的話，學生看到的是一個標著「解析」卻什麼都沒有的區塊
 * ——那比誠實地說「這一題還沒有解析」更糟，因為他會以為是自己網路壞了。
 *
 * **這一支永遠不碰 `rawBody`。** 呼叫端的 select 裡根本沒有那一欄
 * （見 lib/result.ts），而這裡的輸出是重建出來的物件、不是把輸入
 * 刪幾個欄位——多一個欄位時預設不會外流。
 *
 * @param {RawExplanation[]} candidates
 * @returns {VisibleExplanation|null}
 */
export function pickExplanation(candidates) {
  const usable = (candidates ?? []).filter(
    (e) =>
      e &&
      e.takedownAt == null &&
      e.displayMode !== 'HIDDEN' &&
      e.licenseScope !== 'INTERNAL_USE_ONLY',
  );

  usable.sort((a, b) => {
    // 逐題設定（isPrimary）壓過一切：那是老師對這一題的明確決定。
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    const ra = ORIGIN_RANK[a.origin] ?? 99;
    const rb = ORIGIN_RANK[b.origin] ?? 99;
    if (ra !== rb) return ra - rb;
    return time(b.updatedAt) - time(a.updatedAt);
  });

  for (const e of usable) {
    const layers = readLayers(e.layers, { summaryOnly: e.displayMode === 'SUMMARY_ONLY' });
    if (layers.length === 0) continue;
    return {
      id: e.id,
      origin: e.origin,
      layers,
      noExport: e.licenseScope === 'TENANT_NO_EXPORT',
      sourceRef: e.sourceRef ?? null,
      modelUsed: e.modelUsed ?? null,
    };
  }
  return null;
}

const LAYER_LABELS = {
  conclusion: '結論',
  steps: '完整步驟',
  distractors: '錯誤選項為什麼錯',
  extensions: '延伸',
};

/**
 * 把 `Explanation.layers` 這個 JSON 讀成畫得出來的形狀。
 *
 * # 為什麼要這麼防
 *
 * 這一欄裡實際存在**兩種形狀**，而且都是對的：
 *
 *   · 匯入管線寫的是 `{ steps: ['出版社詳解的整段原文'] }`——字串陣列
 *   · AI 產的是 `{ steps: [{ order: 1, content: '…' }] }`——物件陣列
 *
 * 只認其中一種的話，另一種會整層消失（讀到的是 undefined，
 * 沒有錯誤、沒有日誌，畫面上就是少一塊）。所以兩種都讀。
 *
 * 其餘任何讀不懂的東西一律跳過，**絕不 `String(x)`**——那會在畫面上
 * 印出 `[object Object]`，而學生會回報「解析壞掉了」而不是「解析不見了」，
 * 兩者要查的地方完全不同。
 *
 * @param {unknown} raw
 * @param {{ summaryOnly?: boolean }} [opts] summaryOnly 時只留結論那一層
 *   （`displayMode = SUMMARY_ONLY`：老師只想給結論，不想給完整推導）。
 * @returns {Layer[]}
 */
export function readLayers(raw, opts = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const src = /** @type {Record<string, unknown>} */ (raw);
  /** @type {Layer[]} */
  const out = [];

  const conclusion = text(src.conclusion);
  if (conclusion) {
    out.push({ key: 'conclusion', label: LAYER_LABELS.conclusion, items: [{ lead: null, body: conclusion }] });
  }
  if (opts.summaryOnly) return out;

  const steps = list(src.steps)
    .map((s, i) => {
      const body = typeof s === 'string' ? text(s) : text(pluck(s, 'content'));
      if (!body) return null;
      const order = typeof pluck(s, 'order') === 'number' ? Number(pluck(s, 'order')) : i + 1;
      return { order, item: { lead: String(order), body } };
    })
    .filter((x) => x != null)
    // 步驟的順序是解析的全部意義。存進來的陣列順序不保證是推導順序
    // （AI 那一路帶了 order），照陣列順序畫出來的話會變成一份亂序的解法。
    .sort((a, b) => a.order - b.order)
    .map((x) => x.item);
  if (steps.length) out.push({ key: 'steps', label: LAYER_LABELS.steps, items: steps });

  /** @type {LayerItem[]} */
  const distractors = [];
  for (const d of list(src.distractors)) {
    const why = text(pluck(d, 'why'));
    if (!why) continue;
    const option = text(pluck(d, 'option'));
    const misconception = text(pluck(d, 'misconception'));
    distractors.push({
      lead: option ? `(${option})` : null,
      body: misconception ? `${why}（常見的想錯：${misconception}）` : why,
    });
  }
  if (distractors.length) {
    out.push({ key: 'distractors', label: LAYER_LABELS.distractors, items: distractors });
  }

  /** @type {LayerItem[]} */
  const extensions = [];
  const ext = src.extensions ?? src.extension;
  if (ext && typeof ext === 'object' && !Array.isArray(ext)) {
    for (const trap of list(pluck(ext, 'commonTraps'))) {
      const body = text(trap);
      if (body) extensions.push({ lead: '常見陷阱', body });
    }
    for (const pattern of list(pluck(ext, 'relatedPatterns'))) {
      const body = text(pattern);
      if (body) extensions.push({ lead: '相關題型', body });
    }
    // `similarQuestionIds` 刻意不畫。那是題庫裡其他題目的 id，
    // 把它們變成連結等於在檢討頁開一道通往整個題庫的門。
  }
  if (extensions.length) {
    out.push({ key: 'extensions', label: LAYER_LABELS.extensions, items: extensions });
  }

  return out;
}

/** 訊息裡的時間一律台灣時間。伺服器多半跑在 UTC，直接印會差八小時。 */
export function fmtTaipei(d) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

/** @param {unknown} v @returns {string} 讀不出字串就是空字串，不 String(v)。 */
function text(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** @param {unknown} v @returns {unknown[]} */
function list(v) {
  return Array.isArray(v) ? v : [];
}

/** @param {unknown} o @param {string} key @returns {unknown} */
function pluck(o, key) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
  return /** @type {Record<string, unknown>} */ (o)[key];
}

/** @param {Date|undefined|null} d */
function time(d) {
  return d instanceof Date ? d.getTime() : 0;
}
