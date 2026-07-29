/**
 * 帳號生命週期的規則判斷。**純函式，不碰資料庫。**
 *
 * # 為什麼這一支要單獨存在
 *
 * 與 `lib/staffRules.mjs` 同一個分工：**會判錯的東西要能在沒有資料庫
 * 的情況下驗。** 這裡的四件事各自有一個「錯了不會當機，只會安靜地
 * 壞掉」的症狀：
 *
 *   · **改登入代號沒有檢查衝突** → 資料庫回 P2002 加一個欄位名，
 *     而櫃檯看到的是一串英文；更糟的是他會以為是自己打錯字，
 *     然後換一個代號重來——那個學生的歷史成績就此斷成兩半。
 *   · **批次登錄同意不冪等** → 兩位老師同時按下「整班一鍵」，
 *     第二次會把第一次的 `consentAt` 覆蓋掉。個資法要的是「什麼時候
 *     取得的」，被覆蓋成第二次按下的時間之後，那筆憑據就不是實話了。
 *   · **去識別化的代號沒有釋放原本的學號** → 學號在
 *     `@@unique([tenantId, username])` 底下被一個已刪除的帳號永久佔住，
 *     而下一年的新生正好拿到同一個學號。
 *   · **姓名改成空字串** → 名冊上出現一列沒有名字的人，
 *     而每一個下拉、每一張成績表都印一個空白。
 *
 * 判斷本身在這裡，查詢（誰佔走了那個代號）留在 `lib/roster.ts`
 * 與 `lib/staff.ts` 那一側。
 */

/**
 * 登入代號的格式。與 `lib/staffRules.mjs` 的 `USERNAME_SHAPE` **刻意
 * 相同**：學生的學號與老師的代號在同一張表、同一個唯一鍵底下，
 * 兩邊各定一套的話，會出現「這個代號建得出學生、建不出老師」這種
 * 說不出道理的組合。
 */
const USERNAME_SHAPE = /^[^\s]{2,40}$/;

/**
 * 去識別化之後的顯示名稱。
 *
 * 兩個而不是一個：學生的名字會印在成績表與班級統計上，老師的名字會
 * 印在「這一題是誰出的」與「這份卷子是誰派的」旁邊。同一句話用在
 * 兩處的話，看題庫的人會看到一列「已刪除的學生」出的題目。
 */
export const ERASED_NAME = '已刪除的學生';
export const ERASED_STAFF_NAME = '已刪除的帳號';

/**
 * 檢查姓名。回傳問題敘述，沒問題回 `null`。
 *
 * 上限 40 個字與教職員那一支相同——同一張 `users` 表，同一個欄位。
 */
export function checkDisplayName(raw) {
  const name = (raw ?? '').trim();
  if (!name) return '請填寫姓名';
  if (name.length > 40) return '姓名太長（最多 40 個字）';
  return null;
}

/**
 * 檢查改登入代號這件事。回傳問題敘述，沒問題回 `null`。
 *
 * `takenByOther` 由呼叫端查好再傳進來：**「有人在用」與「就是他自己
 * 在用」是兩件事**。後者代表這次根本沒有改（大小寫或前後空白的差別），
 * 直接擋成「已經有人在用」的話，使用者會以為系統壞了。
 *
 * @param {object} p
 * @param {string} p.current 目前的代號
 * @param {string} p.next 要改成的代號
 * @param {boolean} [p.takenByOther] 這個代號已經被**別的帳號**佔用
 * @returns {string | null}
 */
export function checkUsernameChange({ current, next, takenByOther = false }) {
  const value = (next ?? '').trim();
  if (!value) return '請填寫登入帳號';
  if (!USERNAME_SHAPE.test(value)) {
    return '登入帳號要 2 到 40 個字，而且中間不能有空白（他會照著它打）。';
  }
  if (value === (current ?? '').trim()) return null;
  if (takenByOther) {
    return (
      `「${value}」已經有人在用了（可能是另一位學生的學號，或某位老師的代號）。` +
      '同一個機構裡的登入帳號不能重複，請換一個。'
    );
  }
  return null;
}

/**
 * 去識別化之後要用的登入代號。
 *
 * # 為什麼非改代號不可
 *
 * `@@unique([tenantId, username])` 沒有把 `deletedAt` 算進去，所以一個
 * 軟刪除的帳號**仍然佔著那個學號**。補習班的學號會重覆使用（依入學
 * 年度編號），下一年的新生拿到同一個學號時，名冊匯入會 `findFirst`
 * 到那個已刪除的帳號、把新生接到一個去識別化過的殼上——而畫面上
 * 顯示的是「已刪除的學生」，沒有人看得出發生了什麼。
 *
 * 所以刪除的同時要把代號換掉，把原本那一個放回去給別人用。
 *
 * 前綴用中括號是刻意的：登入表單送得出 `[` 但沒有人會這樣取代號，
 * 所以它同時也是「這是系統產生的、不是誰真的帳號」的標記。
 *
 * @param {string} userId cuid，本身就唯一，所以拼出來的代號一定不撞
 */
export function erasedUsername(userId) {
  return `[deleted]${userId}`;
}

/** 這是不是一個被去識別化過的帳號。名冊與清單上要標得出來。 */
export function isErasedUsername(username) {
  return typeof username === 'string' && username.startsWith('[deleted]');
}

/**
 * 批次登錄家長同意要做什麼、不做什麼。**這一支就是冪等的定義。**
 *
 * # 為什麼「已經有同意紀錄的人」要被挑出來而不是一起寫
 *
 * 因為 `consentAt` 是個資法第 15 條的憑據，它記的是**第一次取得同意
 * 的時間**。整班一鍵按第二次（兩位老師同時操作、或按完重新整理再按
 * 一次）若把所有人都寫一次，那些人的同意日期會集體變成第二次按下的
 * 時刻——一份被覆蓋過的憑據等於沒有憑據。
 *
 * 回傳裡把三種結果分開，是為了讓畫面說得出「登錄了 18 位，另外 12 位
 * 本來就有紀錄」。只回一個數字的話，按第二次會顯示「登錄了 0 位」，
 * 而那看起來像失敗。
 *
 * @param {readonly {id: string, displayName?: string, consentAt?: unknown}[]} students
 *   這個班在籍的學生（呼叫端已經確認過班籍，所以這裡不再查）
 * @param {readonly string[] | null} [requestedIds]
 *   勾選了哪幾位。給 `null` 代表「整班」。
 */
export function planConsentBatch(students, requestedIds = null) {
  // 勾選清單可能含重複（表格重繪時按兩次同一格）與不在這個班的 id
  // （另一個分頁上的舊畫面）。兩者都不該讓整批失敗，但也不能默默
  // 照著做——不在班上的那幾個要回報出來，因為那代表畫面過期了。
  const wanted = requestedIds === null ? null : new Set(requestedIds);
  const byId = new Map(students.map((s) => [s.id, s]));

  const toRecord = [];
  const alreadyDone = [];
  for (const s of students) {
    if (wanted !== null && !wanted.has(s.id)) continue;
    if (s.consentAt) alreadyDone.push(s.id);
    else toRecord.push(s.id);
  }

  const missing = wanted === null ? [] : [...wanted].filter((id) => !byId.has(id));

  return { toRecord, alreadyDone, missing };
}

/**
 * 名冊 CSV 的同意欄要怎麼讀。
 *
 * # 為什麼不是「有填就算同意」
 *
 * 因為這一欄產生的是個資法的憑據。空白、`否`、`未取得`、`0` 這些值
 * 必須解讀成「沒有」，而不是「有填東西所以算有」——櫃檯的 Excel 裡
 * 一整欄填著「否」是很正常的事，而把它讀成同意，等於系統自己造了
 * 兩百筆假的法定代理人同意紀錄。
 *
 * 讀不懂的值一律回 `null`（＝當成沒有同意，fail closed），
 * 並由呼叫端在試算畫面上逐列列出來。**猜錯的方向只能往「還要人工
 * 確認」倒。**
 *
 * @param {unknown} raw
 * @returns {'IN_PERSON' | 'PAPER' | 'ONLINE' | false | null}
 *   取得方式，或 `false`（明確地沒有），或 `null`（讀不懂）。
 */
export function parseConsentCell(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return false;
  if (NO_WORDS.has(s)) return false;
  const hit = METHOD_WORDS.get(s);
  if (hit) return hit;
  // 「是」「已取得」「y」這種沒有說出方式的，一律當成紙本回條——
  // 那是補習班報名時最常見的形式，而且它是三種裡證據力中間的那一個。
  // 猜的這件事要在試算畫面上講出來（見 `planRoster`）。
  if (YES_WORDS.has(s)) return 'PAPER';
  return null;
}

const NO_WORDS = new Set(['否', '無', '未取得', '沒有', 'n', 'no', 'false', '0', '-', '—']);
const YES_WORDS = new Set(['是', '有', '已取得', '已同意', '同意', 'y', 'yes', 'true', '1', 'v']);
const METHOD_WORDS = new Map([
  ['現場', 'IN_PERSON'],
  ['現場簽署', 'IN_PERSON'],
  ['現場簽名', 'IN_PERSON'],
  ['臨櫃', 'IN_PERSON'],
  ['in_person', 'IN_PERSON'],
  ['紙本', 'PAPER'],
  ['紙本回條', 'PAPER'],
  ['回條', 'PAPER'],
  ['paper', 'PAPER'],
  ['線上', 'ONLINE'],
  ['線上同意', 'ONLINE'],
  ['online', 'ONLINE'],
]);
