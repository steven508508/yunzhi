/**
 * 家長端的規則：他看得到哪幾個欄位，以及那些數字站不站得住。
 *
 * # 為什麼這幾條要抽出來、而且是純函式
 *
 * 因為它們是**界線本身**，而界線最需要的性質是「改動時會被發現」。
 * 寫在頁面裡的話，下一個人加一欄「逐題對錯」只是多打幾個字，
 * 沒有任何測試會紅——而那一欄正是規格書文件 06 第 9.5 節寫明
 * 家長不該看到的東西。
 *
 * 這個檔案不碰資料庫、不 import 任何伺服器專用的東西，所以
 * `apps/web/tests/guardian.test.mjs` 測得動每一條。
 *
 * # 白名單，不是黑名單
 *
 * `projectTask` 是**列出可以帶出去的欄位**，不是刪掉不可以的。
 * 黑名單的寫法在 `StudentTask` 多一個欄位時就會漏，而漏掉的方向
 * 一律是「家長多看到一樣東西」——與 `lib/result.ts` 檔頭第三條
 * （`rawBody` 不在任何 select 裡）同一個道理。
 *
 * # 型別走 JSDoc，沒有另一份 .d.ts
 *
 * 與 `lib/release.mjs` 相同。分成 `.mjs` 與 `.d.ts` 兩份的那幾支
 * （`accountRules`、`csv`）在這裡行不通：`allowJs` 之下，
 * `import … from '@/lib/x.mjs'` 拿到的是 **JS 推導出來的型別**，
 * 而 `.d.ts` 只服務不帶副檔名的那條路徑——於是同一個函式在兩個
 * 呼叫端有兩種型別，而其中一種是錯的。
 */

/**
 * @typedef {object} GuardianTask 家長那一份任務清單上的一列。
 * @property {string} title
 * @property {string} subjectName
 * @property {string|null} openAt
 * @property {string|null} dueAt
 * @property {string} state IN_PROGRESS / OPEN / UPCOMING / DONE / MISSED
 * @property {string|null} lastSubmittedAt
 * @property {boolean} lastLate
 * @property {number|null} score
 * @property {number|null} maxScore
 * @property {boolean} resultVisible
 */

/**
 * @typedef {object} ClassComparison
 * @property {boolean} show false 時 `why` 一定要印出來——空白的欄位
 *   會被讀成「系統壞了」或「老師還沒改完」。
 * @property {number|null} mean
 * @property {number|null} delta
 * @property {string} label
 * @property {string} why
 */

/**
 * @typedef {object} ChildSummary
 * @property {number} total
 * @property {number} pending 現在還寫得了的份數。
 * @property {number} running
 * @property {number} open
 * @property {number} upcoming
 * @property {number} done
 * @property {number} missed
 * @property {number} late
 * @property {number} waiting 交了但老師還沒開放成績。
 * @property {number} scored 看得到分數的份數。
 */

/** @typedef {'NO_CLASS'|'NO_TASK'|'NOT_SUBMITTED'|'NOT_RELEASED'|null} EmptyReason */

/**
 * 家長那一份任務清單上帶得出去的欄位。
 *
 * 刻意**沒有 `assignmentId` 與 `openAttemptId`**。
 *
 * 兩支 id 本身不是機密（每一支收下它們的 API 都自己比對 `userId`，
 * 家長拿著也打不開），但清單上不需要它們：家長端沒有任何一個連結
 * 指向作答或檢討。沒有 id 就沒有「把網址上的 id 換掉試試看」
 * 這件事，而少一個入口就少一次要重新確認的判斷。
 *
 * 也沒有 `attemptsUsed` / `maxAttempts` / `timeLimitMin` / `mode`：
 * 那些是作答的操作資訊，對「孩子交了沒」這個問題沒有幫助，
 * 而每多一欄，這一頁在手機上就多一行要掃過的字。
 *
 * **`resultNote` 也刻意不帶。** 那是寫給學生看的一句話，內容是
 * 「這一份的檢討什麼時候開放」——而家長本來就進不了檢討頁，
 * 給他一個開放時間等於承諾一件不會發生的事。更要緊的是它有一種
 * 寫法是「這一份作答已經作廢，不會計分」：作廢多半是誠信事件或
 * 系統故障的結果，而那種事**一定要由人來說明**。由系統推到家長
 * 的手機上，等於讓它替老師下了一個它沒有能力下的判斷。
 */
export const GUARDIAN_TASK_FIELDS = [
  'title',
  'subjectName',
  'openAt',
  'dueAt',
  'state',
  'lastSubmittedAt',
  'lastLate',
  'score',
  'maxScore',
  'resultVisible',
];

/**
 * 把學生自己那一份任務投影成家長看得到的那一份。
 *
 * **家長端的資料一律是學生端的投影，欄位只減不加。** 這條不變式
 * 讓「家長會不會看到學生看不到的東西」有一個確定的答案：不會，
 * 因為他手上這一份是從學生那一份挑欄位挑出來的。放行時機
 * （`maySeeResult`）已經在來源那一側算過了，這裡不重算——
 * 重算一次就是多一個會與學生端分岐的地方。
 *
 * @param {Record<string, unknown>} task
 * @returns {GuardianTask}
 */
export function projectTask(task) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of GUARDIAN_TASK_FIELDS) out[key] = task[key] ?? null;
  // 布林欄位不該因為 `?? null` 變成 null——畫面上 `null` 與 `false`
  // 長得一樣，但 `lastLate == null` 會讓「沒有遲交」讀起來像「不知道」。
  out.lastLate = task.lastLate === true;
  out.resultVisible = task.resultVisible === true;
  return /** @type {GuardianTask} */ (out);
}

/**
 * 要幾位同學交卷，班級平均才拿得出來。
 *
 * # 為什麼不是「有平均就顯示」
 *
 * 因為平均是可以反推的。三個人的平均，扣掉自己孩子的分數，
 * 剩下兩位的總分就出來了；兩個人的平均更直接——另一位的分數
 * 等於平均乘二減自己。那是**別人家孩子的成績**，而家長端的
 * 第一條規則就是「其他學生的任何資料都看不到」。
 *
 * 五位是一個折衷：小班制的補習班一班常常只有十幾個人，門檻訂得
 * 太高等於這個功能在多數班級上不存在；訂在五位時，扣掉自己還有
 * 四位，反推不出任何一個人。規格書文件 06 第 7.4 節對在校排名
 * 訂的是三人，那一項是排名（洩漏的是序位），這一項是分數，
 * 反推的精確度更高，所以這裡訂得比它嚴。
 */
export const PEER_FLOOR = 5;

/**
 * 差距要多大才說得上「高於」或「低於」。
 *
 * 佔卷面滿分的比例。一百分的卷子上差兩分是雜訊，而把雜訊講成
 * 「低於班級平均」會讓家長對著一個不存在的問題採取行動——
 * 那正是這一頁最該避免的事。
 */
export const NOISE_BAND = 0.05;

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * 這次考試與班級的相對位置。
 *
 * 回傳的 `show` 為 false 時**一定要把 `why` 印出來**：一個空白的
 * 「班級平均」欄位會被讀成「系統壞了」或「老師還沒改完」，
 * 而實際原因（人數太少，說出來會洩漏別人的分數）家長是聽得懂的。
 *
 * @param {{score: number|null, maxScore: number|null, mean: number|null, peers: number}} p
 * @returns {ClassComparison}
 */
export function compareToClass({ score, maxScore, mean, peers }) {
  if (score == null || maxScore == null || maxScore <= 0) {
    return { show: false, mean: null, delta: null, label: '', why: '這一份還沒有分數。' };
  }
  if (mean == null || peers < PEER_FLOOR) {
    return {
      show: false,
      mean: null,
      delta: null,
      label: '',
      why:
        `這一份目前只有 ${peers} 位同學交卷。人數太少的時候，` +
        `平均數反推得出其他同學的分數，所以不顯示——` +
        `等交卷的人多一些就會出現。`,
    };
  }
  // **先四捨五入平均，再算差距。** 反過來的話畫面上的三個數字加不
  // 起來：68 分、平均 74.3、差距 −6.2（真正的平均是 74.25）。
  // 家長會在心裡減一次，然後認為系統算錯了——而他沒有辦法知道
  // 那 0.1 是四捨五入。看得到的數字要自己對得起來。
  const shown = round1(mean);
  const delta = round1(score - shown);
  const ratio = delta / maxScore;
  return {
    show: true,
    mean: shown,
    delta,
    label:
      ratio >= NOISE_BAND
        ? '高於班級平均'
        : ratio <= -NOISE_BAND
          ? '低於班級平均'
          : '與班級平均差不多',
    why: '',
  };
}

/**
 * 一個孩子現在的狀況，濃縮成幾個數字。
 *
 * 家長端刻意**不做儀表板**：他一個月看兩次，而且多半在手機上。
 * 所以這裡只算「他會問的那幾件事」——還有沒有沒交的、有沒有錯過的、
 * 有沒有考完在等老師放行的。題數、作答次數、平均耗時那些不算，
 * 因為沒有一個家長會照著那些數字做任何事。
 *
 * @param {readonly GuardianTask[]} tasks
 * @returns {ChildSummary}
 */
export function summarizeChild(tasks) {
  /** @type {(state: string) => number} */
  const by = (state) => tasks.filter((t) => t.state === state).length;
  const running = by('IN_PROGRESS');
  const open = by('OPEN');
  return {
    total: tasks.length,
    /** 現在還可以寫的：寫到一半的，加上還沒開始的。 */
    pending: running + open,
    running,
    open,
    upcoming: by('UPCOMING'),
    done: by('DONE'),
    /** 已經過了截止時間而且沒交。這是家長唯一真的需要介入的一項。 */
    missed: by('MISSED'),
    /** 交了但遲交。 */
    late: tasks.filter((t) => t.lastLate).length,
    /** 交了、但老師還沒開放成績。畫面上要說得出來，否則看起來像沒考。 */
    waiting: tasks.filter((t) => t.lastSubmittedAt && !t.resultVisible).length,
    /** 有分數看得到的份數。0 的時候整個成績區塊要換成一句說明。 */
    scored: tasks.filter((t) => t.resultVisible && t.score != null).length,
  };
}

/**
 * 為什麼這一頁現在是空的。
 *
 * # 為什麼要有這一支，而不是直接畫一個空狀態
 *
 * 因為「空」有四種完全不同的原因，而它們的下一步不一樣：孩子還沒被
 * 排進班（要找櫃檯）、班上還沒派過任何任務（等老師）、派了但還沒交
 * （要問孩子）、交了但老師還沒放行（等老師）。四種都畫成一片空白的話，
 * 家長會打同一通電話問同一句「是不是壞了」——而其中三種根本不必打。
 *
 * 回傳的是一個代號而不是一句話：文案在頁面上，這裡只負責挑哪一句，
 * 而挑得對不對測得出來。
 *
 * @param {{inClass: boolean, taskCount: number, submittedCount: number, scoredCount: number}} p
 * @returns {EmptyReason}
 */
export function noDataReason({ inClass, taskCount, submittedCount, scoredCount }) {
  if (!inClass) return 'NO_CLASS';
  if (taskCount === 0) return 'NO_TASK';
  if (submittedCount === 0) return 'NOT_SUBMITTED';
  if (scoredCount === 0) return 'NOT_RELEASED';
  return null;
}
