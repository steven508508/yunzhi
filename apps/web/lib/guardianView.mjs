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

/**
 * @typedef {'LEFT'|'BETWEEN_CLASSES'|'NO_CLASS'|'NEW_CLASS'|'NO_TASK'
 *   |'NOT_SUBMITTED'|'NOT_RELEASED'|null} EmptyReason
 */

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
 *
 * # 這個數字數的是**人**，不是作答次數
 *
 * 上一版數的是 GRADED 的作答列，而一份 `maxAttempts = 3` 的練習卷
 * 上，兩個學生各交三次就湊出 6 列——門檻過了，畫面上出現
 * 「這一份目前有 6 位同學交卷／班級平均 74.3」，而實際上扣掉自己
 * 只剩**一個人**：媽媽知道自己孩子的分數，`(2×平均 − 自己)` 就是
 * 另一個孩子的分數。整段防線在重考三次的練習卷上完全失效，
 * 而畫面上沒有任何跡象。
 *
 * 所以人數一律由 `classMeansFromAttempts` 去重之後才算，而這個
 * 常數的單位是「交過卷的**不同學生**（含自己的孩子）」。
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
 * 一批作答算成「每份任務的班級平均與交卷人數」。
 *
 * # 一個學生一票，而且是他**最近一次交出去**的那一份
 *
 * 兩件事都會錯，而且錯法不一樣：
 *
 *   **一人多票**（重考三次的那一位佔三票）讓平均變成「按作答次數
 *   加權」的東西。它與孩子那一欄的分數不是同一個口徑——孩子那一欄
 *   用的是最後一次交卷（見 `lib/attempt.ts` 的 `listStudentTasks`），
 *   於是畫面上「68 分／班級平均 74.3／−6.3」三個數字對不起來，
 *   而那正是 `compareToClass` 特地「先四捨五入再算差距」要避免的事。
 *
 *   **人數數成次數**讓 `PEER_FLOOR` 那道反推防線失效。詳見那個常數。
 *
 * 挑「最近一次」而不是最高分或第一次：**與孩子自己那一欄同一個
 * 口徑**。挑最高分會讓班級平均系統性地高於每個人自己看到的分數，
 * 而家長讀到的是「我孩子低於平均」——一個由統計口徑製造出來的結論。
 *
 * # 為什麼在這裡而不是在查詢裡用 SQL 做掉
 *
 * 因為這是會算錯而且錯了沒有症狀的那一種邏輯，屬於純函式這一層
 * （與 `compareToClass` 同一個理由）。查詢那一邊只負責「撈哪幾列」。
 *
 * @param {readonly {assignmentId: string, userId: string, totalScore: number|null,
 *   attemptNo?: number|null}[]} attempts
 *   已經先篩過的作答：只有學生的、狀態是交出去了的、而且有分數。
 * @returns {Map<string, {mean: number, peers: number}>}
 */
export function classMeansFromAttempts(attempts) {
  /** 任務 → 學生 → 這位學生算數的那一次作答。 */
  const best = new Map();
  for (const a of attempts ?? []) {
    if (!a || typeof a.totalScore !== 'number' || !Number.isFinite(a.totalScore)) continue;
    if (!a.assignmentId || !a.userId) continue;
    let byUser = best.get(a.assignmentId);
    if (!byUser) best.set(a.assignmentId, (byUser = new Map()));
    const prev = byUser.get(a.userId);
    // `attemptNo` 讀不到時當成 0：同一位學生的多列若都沒有次數，
    // 取後來遇到的那一列。**不猜順序**，但也不要靜靜地留下第一列——
    // 查詢那一側是照 attemptNo 排的，最後遇到的就是最近的一次。
    const no = typeof a.attemptNo === 'number' ? a.attemptNo : 0;
    if (!prev || no >= prev.no) byUser.set(a.userId, { no, score: a.totalScore });
  }

  /** @type {Map<string, {mean: number, peers: number}>} */
  const out = new Map();
  for (const [assignmentId, byUser] of best) {
    let sum = 0;
    for (const { score } of byUser.values()) sum += score;
    const peers = byUser.size;
    if (peers > 0) out.set(assignmentId, { mean: sum / peers, peers });
  }
  return out;
}

/**
 * 這次考試與班級的相對位置。
 *
 * 回傳的 `show` 為 false 時**一定要把 `why` 印出來**：一個空白的
 * 「班級平均」欄位會被讀成「系統壞了」或「老師還沒改完」，
 * 而實際原因（人數太少，說出來會洩漏別人的分數）家長是聽得懂的。
 *
 * @param {{score: number|null, maxScore: number|null, mean: number|null, peers: number}} p
 *   `peers` 的單位是**交過卷的不同學生人數**（含自己的孩子），
 *   不是作答次數——理由見 `PEER_FLOOR`，來源見 `classMeansFromAttempts`。
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
 * 因為「空」有好幾種完全不同的原因，而它們的下一步不一樣：孩子還沒被
 * 排進班（要找櫃檯）、班上還沒派過任何任務（等老師）、派了但還沒交
 * （要問孩子）、交了但老師還沒放行（等老師）。都畫成一片空白的話，
 * 家長會打同一通電話問同一句「是不是壞了」——而其中多數根本不必打。
 *
 * # 為什麼「沒有班級」不能只有一種
 *
 * 因為在資料上，**「還沒編班」與「已經離開」長得一模一樣**：兩者
 * 的 `ClassMembership` 都沒有一列 `leftAt = null`。而那兩件事家長
 * 要做的完全相反——前者要去問櫃檯，後者不必做任何事。
 *
 * 這個差別不是理論上的：`closeAcademicYear` 一句 `updateMany` 把
 * 全部班籍寫上 `leftAt`，所以**學年度結算的那個晚上，全補習班每一位
 * 家長會同時讀到「孩子還沒有編進任何班級，請告訴櫃檯」**——兩百通
 * 電話，而每一通問的都是一件系統自己做的、而且完全正常的事。
 * 轉學走了（`archiveStudent`）也是同一個症狀，只是它永遠不會結束。
 *
 * 所以拆成三種：
 *
 *   `LEFT`             帳號已經停用／離開了。**不必做任何事**。
 *   `BETWEEN_CLASSES`  曾經在班上，現在沒有班籍（學年度結算、還沒編新班）。
 *                      **等編班，不必打電話**。
 *   `NO_CLASS`         從來沒有進過任何班。這一種才要找櫃檯。
 *
 * 以及轉班：`NEW_CLASS`。新班還沒派任務時，任務數是 0，而舊班的
 * 作業與成績不在這一頁上（`listStudentTasks` 只看還在的班籍）。
 * 這時候說「老師還沒有派任何作業或考試」，對一個上了兩年的孩子
 * 是假話——家長讀到的是「這兩年的東西不見了」。
 *
 * 回傳的是一個代號而不是一句話：文案在頁面上，這裡只負責挑哪一句，
 * 而挑得對不對測得出來。
 *
 * @param {{
 *   inClass: boolean,
 *   taskCount: number,
 *   submittedCount: number,
 *   scoredCount: number,
 *   hasLeft?: boolean,
 *   everInClass?: boolean,
 *   changedClass?: boolean,
 * }} p
 *   `hasLeft` 帳號已停用或已被移出（轉學、結業）。
 *   `everInClass` 曾經有過班籍——用來把「結算後」與「從來沒編班」分開。
 *   `changedClass` 現在這個班是最近才進的，之前在別的班。
 * @returns {EmptyReason}
 */
export function noDataReason({
  inClass,
  taskCount,
  submittedCount,
  scoredCount,
  hasLeft = false,
  everInClass = false,
  changedClass = false,
}) {
  // 「已經離開」排在最前面：它是所有其他狀況的原因，而且它是唯一
  // 一種**接下來不會再有新資料**的狀況。放在後面的話，一個已經轉學
  // 的孩子會被說成「還沒編班」，而那句話會把家長送到櫃檯。
  if (hasLeft) return 'LEFT';
  if (!inClass) return everInClass ? 'BETWEEN_CLASSES' : 'NO_CLASS';
  if (taskCount === 0) return changedClass ? 'NEW_CLASS' : 'NO_TASK';
  if (submittedCount === 0) return 'NOT_SUBMITTED';
  if (scoredCount === 0) return 'NOT_RELEASED';
  return null;
}
