/**
 * 通知的文案。
 *
 * # 為什麼文案在程式裡，而 `NotificationTemplate` 那張表空著
 *
 * 因為這裡每一則的內容都不只是一句話，而是**一個承諾：收到它的人
 * 下一步做得到什麼**。「你的作答被作廢了」如果後面沒有一條路，
 * 那則通知只會製造一通電話——而電話那頭的人也不知道發生了什麼事。
 * 所以每一則都必須同時說出「發生了什麼」與「現在去哪裡」，
 * 而後者是一條真的走得通的網址。
 *
 * 一張可以被編輯、而且**第一天是空的**資料表給不了這個保證：
 * 少了一列的症狀是一則沒有字的通知，而那比沒有通知更糟——
 * 學生看到收件匣裡多一列空白，只會以為系統壞了。
 *
 * `NotificationTemplate` 留著不是忘了它：日後「這家補習班想把
 * 『快到期』改成自己的說法」是一個合理的需求，而那時它會是
 * **覆寫**（找不到就用這裡的），不是唯一來源。現在先做成唯一來源
 * 的話，每一家新開的租戶都要先被灌一份種子資料才收得到通知。
 *
 * # 三條寫作規則
 *
 * **一、不替人下結論，尤其是誠信事件。** `attempt.voided` 全文
 * 不出現「作弊」「違規」，也不說是誰的錯——作廢的原因有兩種
 * （誠信事件與系統故障，見 `lib/scoring.ts` 的 `voidAttempt`），
 * 而**兩種都必須由人來說明**。系統只負責讓學生知道「這一份不算數了」
 * 以及「去找誰問」。措辭與 `lib/release.mjs` 對 VOIDED 的那一句
 * 刻意一致：同一件事在兩個畫面上不可以有兩種語氣。
 *
 * **二、家長那一份是投影，欄位只減不加。** 家長的文案只吃
 * `GUARDIAN_PAYLOAD_KEYS` 裡那幾個欄位（孩子的名字、份數、任務名稱、
 * 時間），而 `tests/notify.test.mjs` 會把這件事釘住。逐題作答與
 * 智慧老師的對話不在裡面，理由見 `lib/guardian.ts` 的檔頭——
 * 一則通知是把資料**推出去**，比一個頁面更難收回來。
 *
 * **三、不寫「這一頁」。** 同一則文字會出現在收件匣、未讀清單，
 * 日後也可能出現在別的地方。指涉版面的話在另一個位置就變成一句
 * 對不上的話（`lib/release.mjs` 的 MANUAL 那一句也是這個理由）。
 */

/** 收件人的身分。決定這一則會不會出現在某個角色的收件匣裡。 */
export const AUDIENCE = Object.freeze({
  STUDENT: 'STUDENT',
  GUARDIAN: 'GUARDIAN',
  STAFF: 'STAFF',
});

/**
 * 家長那一份文案唯一可以讀的 payload 欄位。
 *
 * 這是一份白名單而不是黑名單，理由與 `lib/attempt.ts` 挑欄位的
 * 做法相同：黑名單在 payload 多一個欄位時就會漏，而漏的方向
 * 是家長看到了他不該看到的東西。
 */
export const GUARDIAN_PAYLOAD_KEYS = Object.freeze([
  'childName',
  'studentId',
  'count',
  'titles',
  'title',
  'dueAt',
  'canStillSubmit',
]);

// ─────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────

/**
 * 訊息裡的時間一律台灣時間。
 *
 * 與 `lib/release.mjs` 的 `fmtTaipei` 是同一件事、同一個格式。
 * 沒有共用一份是因為那個檔案在禁改清單裡，而**跨檔案 import 一個
 * 格式化函式所省下的四行，換來的是通知模組相依於放行模組**——
 * 那個方向的相依沒有道理。格式對不上的後果是兩個畫面上的時間
 * 長得不一樣，所以這裡的參數逐一與那邊對齊。
 */
export function fmtTime(value) {
  const d = toDate(value);
  if (!d) return '';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

/** @param {unknown} v */
function toDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * payload 裡的字串。讀不出來就是空字串，**絕不 `String(v)`**。
 *
 * 理由與 `lib/release.mjs` 的 `text()` 一樣：`[object Object]` 出現在
 * 畫面上時，使用者回報的是「通知壞掉了」而不是「通知少了東西」，
 * 而那兩件事要查的地方完全不同。
 */
function str(v, fallback = '') {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback;
}

/** payload 裡的正整數。讀不出來就是 0。 */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** 「數學小考、英文週考 等 5 份」。最多列三個，其餘用數字帶過。 */
function nameSome(titles, count) {
  const list = Array.isArray(titles) ? titles.filter((t) => typeof t === 'string' && t) : [];
  const n = count || list.length;
  if (list.length === 0) return `${n} 份`;
  const head = list.slice(0, 3).join('、');
  return list.length < n || n > 3 ? `${head} 等 ${n} 份` : head;
}

// ─────────────────────────────────────────────────────────────────
// 樣板
// ─────────────────────────────────────────────────────────────────

/**
 * @typedef {object} Template
 * @property {string} audience AUDIENCE 之一。收件匣不靠它過濾（收件人
 *   本來就只查得到自己那幾列），它的用途是**測試**：家長的那幾則
 *   要被檢查 payload 白名單。
 * @property {boolean} mandatory 不可以被使用者關掉。見 `MANDATORY`。
 * @property {string} label 偏好設定頁上這一類通知的名字。
 * @property {string} why 偏好設定頁上「為什麼會收到這個」。
 * @property {(payload: Record<string, unknown>) => string} title
 * @property {(payload: Record<string, unknown>) => string} body
 *   **一定要包含下一步。** 沒有下一步的通知只是噪音。
 * @property {(payload: Record<string, unknown>) => string} href 按下去去哪裡。
 * @property {string} action 那個連結上的字。
 */

/** @type {Record<string, Template>} */
export const TEMPLATES = Object.freeze({
  // ── 學生 ──────────────────────────────────────────────────────

  /**
   * 快到期還沒交。
   *
   * **一則，不是六則。** 一個學生同時有六份快到期時，六則通知的下一步
   * 完全相同（去任務清單看），而六列一模一樣的東西會把收件匣裡真正
   * 個別的事情（成績放行、卷子被作廢）擠出畫面。所以這一則是摘要，
   * 一天最多一次——去重鍵是「學生＋台灣日期」，見 `lib/notify.mjs`。
   */
  'assignment.due_soon': {
    audience: AUDIENCE.STUDENT,
    mandatory: false,
    label: '作業快到期',
    why: '有作業即將截止而你還沒有交的時候，一天最多提醒一次。',
    title: (p) => (num(p.count) > 1 ? `有 ${num(p.count)} 份作業快到期了` : '有一份作業快到期了'),
    body: (p) => {
      const when = fmtTime(p.dueAt);
      return (
        `${nameSome(p.titles, num(p.count))}還沒有交` +
        (when ? `，最近的一份 ${when} 截止` : '') +
        '。現在還來得及寫，過了截止時間就交不了了。'
      );
    },
    href: () => '/take',
    action: '去寫',
  },

  /**
   * 逾期未交。
   *
   * 與「快到期」一樣是摘要而不是逐份，理由相同。但這一則的下一步
   * 分兩種，而它們差很多：**還收遲交的**要他現在去交，**不收的**
   * 只能找老師。把兩種寫成同一句的話，其中一半的人會照著做一件
   * 做不到的事，然後認為系統在騙他。
   */
  'assignment.overdue': {
    audience: AUDIENCE.STUDENT,
    mandatory: false,
    label: '逾期未交',
    why: '有作業過了截止時間而你沒有交的時候。',
    title: (p) => (num(p.count) > 1 ? `有 ${num(p.count)} 份作業逾期未交` : '有一份作業逾期未交'),
    body: (p) =>
      `${nameSome(p.titles, num(p.count))}已經過了截止時間。` +
      (p.canStillSubmit === true
        ? '這幾份還收遲交，現在交出去仍然會計分，但會標記為遲交。'
        : '系統上已經不能再作答了。要補交或有特殊狀況，請直接找班級老師處理。'),
    href: () => '/take',
    action: '看是哪幾份',
  },

  /**
   * 成績放行了（`releasePolicy = MANUAL`，老師按下放行）。
   *
   * 這一則存在的理由很具體：MANUAL 的任務交完卷之後，學生畫面上
   * 只有一句「老師還沒有開放」（見 `lib/release.mjs`），而**開放的
   * 那一刻沒有任何跡象**。學生唯一的辦法是每天回來按一次。
   */
  'grade.released': {
    audience: AUDIENCE.STUDENT,
    mandatory: false,
    label: '成績開放',
    why: '老師把一份「手動放行」的考試開放給你看的時候。',
    title: () => '老師開放了一份考試的成績',
    body: (p) =>
      `「${str(p.title, '一份考試')}」的分數與逐題檢討已經開放。` +
      '看得到自己每一題對錯與解析了，答錯的那幾題可以在檢討頁問智慧老師。',
    href: (p) => (str(p.assignmentId) ? `/take/${str(p.assignmentId)}/result` : '/take'),
    action: '看成績',
  },

  /**
   * 老師代為結算了你的卷子。
   *
   * **必收。** 這是「有人動了你的成績」——他的卷子多了一個他沒有
   * 按下交卷的分數。關掉之後他會一直以為那一份沒有交出去，而成績
   * 單上有它。`lib/attempt.ts` 的 `finalizeAttemptOnBehalf` 存在的
   * 理由就是那些卡住的卷子，而學生那一側在此之前完全沒有回音。
   */
  'attempt.finalized_by_teacher': {
    audience: AUDIENCE.STUDENT,
    mandatory: true,
    label: '老師代為結算你的作答',
    why: '你的作答卡住沒有交出去（斷線、關掉分頁），老師代替你收卷的時候。這一類不能關閉。',
    title: () => '老師代替你收了一份卷子',
    body: (p) =>
      `「${str(p.title, '一份考試')}」你沒有按到交卷（多半是斷線或關掉了作答畫面），` +
      '老師代替你把它收起來計分了。你寫過的答案都在，沒有寫的題目不計分。' +
      '如果你覺得這一份的狀況需要說明，直接找班級老師。',
    href: (p) => (str(p.assignmentId) ? `/take/${str(p.assignmentId)}/result` : '/take'),
    action: '看這一份',
  },

  /**
   * 作答被作廢。
   *
   * **必收，而且理由不寫在這裡。**
   *
   * 作廢的原因有兩種——誠信事件與系統故障（斷電毀掉一份卷子）——
   * 而系統分不出來，`reason` 那一欄是老師寫給稽核看的一句話，
   * 不是寫給學生看的。把它原文推到學生面前，等於讓系統代替老師
   * 說出一句指控；而**猜錯的那一次是指控一個沒有作弊的孩子**。
   *
   * 所以這一則只做兩件事：讓他知道這一份不算數了，以及去找誰。
   * 措辭與 `lib/release.mjs` 對 VOIDED 的那一句一致。
   */
  'attempt.voided': {
    audience: AUDIENCE.STUDENT,
    mandatory: true,
    label: '作答被作廢',
    why: '你的某一份作答被標記為不計分的時候。這一類不能關閉——不知道的話，你會在成績單上看到一個沒有說明的空缺。',
    title: () => '有一份作答被作廢了',
    body: (p) =>
      `「${str(p.title, '一份考試')}」這一份作答已經作廢，不會計分。` +
      '要知道原因或申請重考，請直接找班級老師——這件事系統上說不清楚，' +
      '要由處理的老師跟你說明。',
    // 刻意不連到檢討頁：那一頁對作廢的作答只會顯示同一句話。
    // 連到任務清單，他至少看得到這一份現在的狀態與別的任務。
    href: () => '/take',
    action: '看我的任務',
  },

  /**
   * 撤銷作廢：誤判或申訴成立。
   *
   * **必收，理由與作廢同一條。** 少了這一則，一個被誤判的學生會
   * 永遠停在「我的卷子不算數」——他收到過作廢的通知，而恢復
   * 沒有任何人告訴他。
   */
  'attempt.unvoided': {
    audience: AUDIENCE.STUDENT,
    mandatory: true,
    label: '作廢被撤銷',
    why: '先前被作廢的作答又恢復計分的時候。這一類不能關閉。',
    title: () => '先前作廢的那一份恢復計分了',
    body: (p) =>
      `「${str(p.title, '一份考試')}」的作廢已經撤銷，這一份重新計分。` +
      '成績可能還要等老師確認一次，出現的時間會比別人晚一點。',
    href: (p) => (str(p.assignmentId) ? `/take/${str(p.assignmentId)}/result` : '/take'),
    action: '看這一份',
  },

  // ── 家長 ──────────────────────────────────────────────────────

  /**
   * 孩子逾期未交。**家長只有這一則。**
   *
   * # 為什麼「快到期」不通知家長
   *
   * 因為那時候家長沒有做得到的下一步。截止前十二小時推一則給家長，
   * 他唯一能做的事是催——而系統把「催」變成一個每週三次的推播，
   * 學生會在收到通知之前先被問一次，然後兩邊都開始忽略它。
   *
   * 逾期不一樣：那是一件**已經發生的事實**，而家長的下一步是真的
   * ——問孩子發生什麼事，或者跟老師談補交。所以家長端只留這一則。
   *
   * 內容裡沒有分數、沒有逐題、沒有智慧老師的對話，只有份數與任務
   * 名稱。理由見檔頭第二條。
   */
  'assignment.overdue.guardian': {
    audience: AUDIENCE.GUARDIAN,
    mandatory: false,
    label: '孩子逾期未交',
    why: '孩子有作業過了截止時間而沒有交的時候。',
    title: (p) => `${str(p.childName, '孩子')}有作業沒有交`,
    body: (p) =>
      `${str(p.childName, '孩子')}的${nameSome(p.titles, num(p.count))}已經過了截止時間還沒有交。` +
      (p.canStillSubmit === true
        ? '這幾份還收遲交，現在交出去仍然會計分。'
        : '系統上已經不能再作答了。要補交請跟班級老師談。'),
    href: (p) => (str(p.studentId) ? `/guardian?child=${str(p.studentId)}` : '/guardian'),
    action: '看狀況',
  },

  // ── 老師 ──────────────────────────────────────────────────────

  /**
   * 題本解析完了，等你校對。
   *
   * 匯入是這台機器上最慢的工作（一份 200 頁的題本可能跑一個小時），
   * 而老師上傳完就會去做別的事。沒有這一則的話，他要自己記得回來
   * 按重新整理；而**在那之前那些題目一題都不在題庫裡**。
   */
  'import.ready': {
    audience: AUDIENCE.STAFF,
    mandatory: false,
    label: '題本解析完成',
    why: '你上傳的題本解析完、可以校對的時候。',
    title: () => '有一份題本解析完了',
    body: (p) =>
      `「${str(p.title, '一份題本')}」已經解析完` +
      (num(p.candidates) ? `，抽出 ${num(p.candidates)} 題候選` : '') +
      '。校對確認之後才會進題庫——AI 抽出來的答案與配分都可能是錯的。',
    href: (p) => (str(p.jobId) ? `/import/${str(p.jobId)}` : '/import'),
    action: '去校對',
  },

  /**
   * 匯入失敗了。
   *
   * 失敗的匯入不會自己重試（重跑要花錢，該由人決定），而老師那邊
   * 看到的是一個停住的進度條。這一則要說得出**卡在哪裡**，否則
   * 他唯一的選擇是整份重跑，而多數情況可以從上一個完成的階段接下去。
   */
  'import.failed': {
    audience: AUDIENCE.STAFF,
    mandatory: false,
    label: '匯入失敗',
    why: '你上傳的題本匯入失敗的時候。',
    title: () => '有一份題本匯入失敗',
    body: (p) =>
      `「${str(p.title, '一份題本')}」的匯入停住了。` +
      (str(p.error) ? `原因：${str(p.error)}` : '進度頁上有卡在哪一個階段。') +
      '失敗的匯入不會自己重試，多數情況可以從上一個完成的階段繼續，不必整份重跑。',
    href: (p) => (str(p.jobId) ? `/import/${str(p.jobId)}` : '/import'),
    action: '看原因',
  },

  /**
   * 有非選題等你閱卷。
   *
   * 一份含作文的卷子在作文改完之前**整份停在「待評分」**
   * （見 `lib/scoring.ts`：`pendingManual > 0` 就不標 GRADED），
   * 於是學生看到的是一個還會變的分數，或者什麼都看不到。
   * 而老師那邊除了自己點進那一份任務，沒有任何地方會提起這件事。
   *
   * **一份任務只通知一次。** 卷子是陸續交上來的，每天播報一次
   * 「還有 12 份沒改」會變成一個永遠不會消失的東西——那是首頁待辦
   * 的工作，不是收件匣的（兩者的分界見 `app/(app)/inbox/page.tsx`）。
   */
  'grading.pending': {
    audience: AUDIENCE.STAFF,
    mandatory: false,
    label: '有卷子等你閱卷',
    why: '你派出去的任務有非選題需要人工評分的時候。',
    title: () => '有非選題等你閱卷',
    body: (p) =>
      `「${str(p.title, '一份任務')}」有 ${num(p.count) || 1} 份作答含非選題還沒有給分。` +
      '在改完之前，那幾份的總分是不完整的——學生看到的分數會少掉這幾題。',
    href: (p) =>
      str(p.assignmentId) ? `/grades/${str(p.assignmentId)}/grading` : '/grades',
    action: '去閱卷',
  },
});

/** 全部的樣板代號。偏好設定頁與測試都用它，不各自列一份。 */
export const TEMPLATE_KEYS = Object.freeze(Object.keys(TEMPLATES));

/**
 * 不可以被關掉的那幾則。
 *
 * # 規則說得出來，不是一份任意的清單
 *
 * **凡是「別人動了你的成績」的事件都不可關閉；「提醒你自己去做某件
 * 事」的都可以。**
 *
 * 前者關掉之後，學生會在成績單上看到一個他無法解釋的數字（或空缺），
 * 而系統裡沒有任何一條路徑能讓他知道發生了什麼——他甚至不知道
 * 「有事發生過」這件事。後者關掉的後果只是少一個提醒，而該做的事
 * 仍然在任務清單與首頁待辦上，看得見也做得到。
 *
 * 「不可關閉」不等於「不受免打擾時段限制」：必收的意思是**一定送到**，
 * 不是**一定現在吵你**。半夜三點的作廢通知延到早上七點出現，
 * 學生收到的資訊完全一樣。見 `lib/notify.mjs` 的 `scheduleFor`。
 */
export const MANDATORY = Object.freeze(
  TEMPLATE_KEYS.filter((k) => TEMPLATES[k].mandatory),
);

/** 這一則可不可以被使用者關掉。認不得的代號一律當成可以關。 */
export function mayTurnOff(templateKey) {
  return !MANDATORY.includes(templateKey);
}

/**
 * @typedef {object} RenderedNotification
 * @property {string} title
 * @property {string} body
 * @property {string} href
 * @property {string} action
 * @property {boolean} known 認得這個樣板代號嗎。
 */

/**
 * 把一列通知算成畫得出來的東西。
 *
 * # 認不得的代號不會讓收件匣壞掉
 *
 * 資料庫裡的 `templateKey` 是一個字串，而程式會改版：某一則被改名、
 * 或者一列是舊版留下來的。這時**丟出例外會讓整個收件匣變成錯誤頁**，
 * 而使用者失去的不是那一列，是全部。
 *
 * 所以認不得的一律回一句誠實的話加一個回得去的連結。`known: false`
 * 讓呼叫端可以把它畫得低調一點，但它仍然在清單上——一列看得到的
 * 「這一則顯示不出來」是一個會被回報的症狀，一列消失的通知不是。
 *
 * @param {string} templateKey
 * @param {unknown} payload
 * @returns {RenderedNotification}
 */
export function render(templateKey, payload) {
  const t = TEMPLATES[templateKey];
  const p =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? /** @type {Record<string, unknown>} */ (payload)
      : {};
  if (!t) {
    return {
      title: '一則通知',
      body: '這一則通知的內容顯示不出來（系統更新過，格式對不上）。如果你覺得它重要，請告訴老師。',
      href: '/',
      action: '回到首頁',
      known: false,
    };
  }
  // 每一支都包起來：一則通知的 payload 少一個欄位不該讓整頁掛掉，
  // 而 payload 是 JSON，它的形狀不受型別系統保護。
  return {
    title: safe(() => t.title(p), '一則通知'),
    body: safe(() => t.body(p), '這一則通知的內容顯示不出來。如果你覺得它重要，請告訴老師。'),
    href: safe(() => t.href(p), '/'),
    action: t.action,
    known: true,
  };
}

function safe(fn, fallback) {
  try {
    const v = fn();
    return typeof v === 'string' && v !== '' ? v : fallback;
  } catch {
    return fallback;
  }
}
