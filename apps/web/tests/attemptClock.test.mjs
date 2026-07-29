/**
 * 作答的時鐘：還寫得進去嗎，寫不進去了又還沒交怎麼辦。
 *
 * # 這一支測的是一種完全沒有症狀的資料遺失
 *
 * 學生寫到一半斷線且沒有再回來，時間到之後那一份會停在 IN_PROGRESS：
 * 伺服器不收他的答案了，但也沒有人按下交卷。於是
 *
 *   · 學生的清單把它算成「已作答 1 次」，次數用完，沒有任何按鈕
 *   · 老師的成績頁只查 SUBMITTED / GRADED，這個人整列不存在
 *
 * 他寫過的答案還在資料庫裡，而沒有任何一條路徑走得到。畫面上不會有
 * 錯誤，老師看到的是「這個人沒考」。
 *
 * 補救的那顆按鈕（代為結算）本身很危險：它把作答狀態推向不可逆的
 * SUBMITTED。所以「什麼時候准按」必須是一條被測過的規則，而不是
 * 散在路由與畫面裡的兩個 if。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  attemptClosed,
  attemptStranded,
  attemptWritable,
  checkEndNow,
  checkExtend,
  checkExtendMinutes,
  checkFinalizeOnBehalf,
} from '../lib/attemptClock.mjs';

const NOW = new Date('2026-08-03T09:00:00Z');
const EARLIER = new Date('2026-08-03T08:00:00Z');
const LATER = new Date('2026-08-03T10:00:00Z');

/** 正在考試中：時間還沒到。 */
const writing = { status: 'IN_PROGRESS', expiresAt: LATER };
/** 卡住的那一種：時間到了，卻沒有人按下交卷。 */
const stranded = { status: 'IN_PROGRESS', expiresAt: EARLIER };
/** 不限時也沒有截止時間的作答。學生隨時回得來。 */
const untimed = { status: 'IN_PROGRESS', expiresAt: null };

// ─────────────────────────────────────────────────────────────────
// 一、還收不收得到答案
// ─────────────────────────────────────────────────────────────────

test('進行中而且沒過期的才收得到答案', () => {
  assert.equal(attemptWritable(writing, NOW), true);
  assert.equal(attemptWritable(untimed, NOW), true, '不限時的一律收');
  assert.equal(attemptWritable(stranded, NOW), false);
});

test('已交卷、已評分、已作廢的一律不收', () => {
  // 少了狀態這一半的話，一份已經交出去的考卷會因為「時間還沒到」
  // 而繼續收得到答案——交卷之後還能改答案是最嚴重的一種。
  for (const status of ['SUBMITTED', 'GRADED', 'VOIDED']) {
    assert.equal(attemptWritable({ status, expiresAt: LATER }, NOW), false, status);
  }
});

test('到期的那一秒還收得到，下一秒就不收', () => {
  // 邊界要與 lib/attempt.ts 的 `now > expiresAt` 同一邊。倒過來寫的話，
  // 學生在最後一秒送出的那一題會被丟掉，而畫面上顯示已存檔。
  assert.equal(attemptWritable({ status: 'IN_PROGRESS', expiresAt: NOW }, NOW), true);
  assert.equal(
    attemptWritable({ status: 'IN_PROGRESS', expiresAt: NOW }, new Date(NOW.getTime() + 1)),
    false,
  );
});

// ─────────────────────────────────────────────────────────────────
// 二、哪一份是「卡住了」
// ─────────────────────────────────────────────────────────────────

test('只有進行中且已過期的才算卡住', () => {
  assert.equal(attemptStranded(stranded, NOW), true);
  assert.equal(attemptStranded(writing, NOW), false, '正在考的不能標成卡住，老師會誤按');
  assert.equal(attemptStranded(untimed, NOW), false, '不限時的學生隨時回得來，不是死路');
  assert.equal(attemptStranded({ status: 'SUBMITTED', expiresAt: EARLIER }, NOW), false);
});

// ─────────────────────────────────────────────────────────────────
// 三、老師能不能代為結算
// ─────────────────────────────────────────────────────────────────

test('只有卡住的那一種收得掉', () => {
  assert.equal(checkFinalizeOnBehalf(stranded, NOW).ok, true);
});

test('還在作答時間內的不准收——那是把學生正在寫的考卷抽走', () => {
  // 准了的話，老師誤按一次就是一位學生的考試在他沒有察覺的情況下
  // 結束了：他的畫面上不會有任何提示，要到下一次自動存檔才會跳出
  // 「這份考卷已經交出去了」。
  const r = checkFinalizeOnBehalf(writing, NOW);
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('抽走') || r.error.includes('作答時間'));
});

test('不限時的不准收，而且要說出正確的做法', () => {
  // 那些不是死路——學生的清單上「繼續作答」一直都在。
  // 要結束那種考試的正確做法是設截止時間，訊息要講得出來。
  const r = checkFinalizeOnBehalf(untimed, NOW);
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('截止時間'), `訊息要指出下一步（現在是：${r.error}）`);
});

test('已經交卷的收不動，而且要導向重新計分', () => {
  const r = checkFinalizeOnBehalf({ status: 'SUBMITTED', expiresAt: EARLIER }, NOW);
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('重新計分'), '擋下來的時候要說得出該做什麼');
});

test('已作廢的收不動', () => {
  // 作廢是誠信事件或系統故障的結果，那一份不計分。把它結算出一個
  // 分數等於推翻了作廢這個決定。
  const r = checkFinalizeOnBehalf({ status: 'VOIDED', expiresAt: EARLIER }, NOW);
  assert.equal(r.ok, false);
});

test('准收的條件與「收不到答案了」完全一致', () => {
  // 這兩個判斷若分岔，症狀是老師按下代為結算卻被告知時間還沒到
  // （或者相反：收掉了一份其實還寫得進去的考卷）。
  const CASES = [writing, stranded, untimed, { status: 'IN_PROGRESS', expiresAt: NOW }];
  for (const a of CASES) {
    const allowed = checkFinalizeOnBehalf(a, NOW).ok;
    const closed = a.expiresAt != null && !attemptWritable(a, NOW);
    assert.equal(allowed, closed, `expiresAt=${a.expiresAt}`);
  }
});

// ─────────────────────────────────────────────────────────────────
// 四、沒有時限的作答：任務截止之後就是死路
//
// 首頁的待辦一直是這樣算的（`expiresAt` 過了 **或** 任務截止而且不收
// 遲交），成績頁卻只看 `expiresAt`。於是同一份作答在兩個畫面上一個
// 算卡住、一個算「還在作答時間內」，而按不到代為結算的那一格給出的
// 錯誤訊息是「請把任務的截止時間改成現在」——老師剛剛就是這麼做的。
// ─────────────────────────────────────────────────────────────────

/** 任務已經截止而且不收遲交。 */
const CLOSED_ASSIGNMENT = { dueAt: EARLIER, allowLate: false };

test('沒帶任務設定時，判定與只看 expiresAt 完全一樣', () => {
  // 呼叫端沒查 dueAt / allowLate 時不可以推論出任何東西——
  // 用一份空的設定去判「已經截止」會把正在考試的人標成卡住。
  assert.equal(attemptClosed(writing, NOW), false);
  assert.equal(attemptClosed(stranded, NOW), true);
  assert.equal(attemptClosed(untimed, NOW), false);
});

test('不限時但任務已截止且不收遲交，算已經結束', () => {
  const a = { ...untimed, assignment: CLOSED_ASSIGNMENT };
  assert.equal(attemptClosed(a, NOW), true);
  assert.equal(attemptStranded(a, NOW), true);
  assert.equal(checkFinalizeOnBehalf(a, NOW).ok, true, '這一格不通的話那份作答永遠出不來');
});

test('開了遲交的任務，截止之後仍然不算結束', () => {
  // allowLate 的意思就是「截止之後還可以寫」。把它算成卡住的話，
  // 老師會把一位正在補寫的學生的考卷收掉。
  const a = { ...untimed, assignment: { dueAt: EARLIER, allowLate: true } };
  assert.equal(attemptClosed(a, NOW), false);
  assert.equal(checkFinalizeOnBehalf(a, NOW).ok, false);
});

test('任務還沒截止時，不限時的那一份仍然收不掉', () => {
  const a = { ...untimed, assignment: { dueAt: LATER, allowLate: false } };
  assert.equal(checkFinalizeOnBehalf(a, NOW).ok, false);
});

test('完全沒有時間限制的那一種，訊息要指出下一步', () => {
  const r = checkFinalizeOnBehalf({ ...untimed, assignment: { dueAt: null } }, NOW);
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('截止時間'), `訊息要指出下一步（現在是：${r.error}）`);
});

// ─────────────────────────────────────────────────────────────────
// 五、延長進行中的作答時間
//
// 全班斷網十分鐘，老師要補回來。改任務的 timeLimitMin 沒有用（凍結，
// 而且不會回頭重算已經開始的那幾份），所以唯一的做法是直接改
// attempts 的 expiresAt。這一組測的是「哪幾份可以動、動完是幾點」。
// ─────────────────────────────────────────────────────────────────

test('延長的分鐘數只收正整數', () => {
  assert.equal(checkExtendMinutes(10).ok, true);
  for (const bad of [0, -5, 1.5, NaN, '10', null, undefined, 601]) {
    const r = checkExtendMinutes(bad);
    assert.equal(r.ok, false, `${String(bad)} 應該被擋下來`);
    assert.ok(r.error.length > 0, '擋下來要說得出為什麼');
  }
});

test('延長是「原本的到期時刻 ＋ N」，不是「現在 ＋ N」', () => {
  // 用「現在 + N」的話，同一場考試裡先開始與後開始的人拿到的總時間
  // 不一樣——那正是任務設定凍結 timeLimitMin 想避免的事。
  const r = checkExtend(writing, 10, NOW);
  assert.equal(r.ok, true);
  assert.equal(+r.expiresAt, +new Date(LATER.getTime() + 10 * 60_000));
  assert.equal(r.reopened, false, '本來就還在寫的人不算「被救回來」');
});

test('已經過期的那一份延長之後又寫得進去，而且要標出來', () => {
  // 老師要看到的是「有幾個人真的被救回來」，不是「更新了 32 筆」。
  const r = checkExtend(stranded, 90, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.reopened, true);
  assert.equal(
    attemptWritable({ status: 'IN_PROGRESS', expiresAt: r.expiresAt }, NOW),
    true,
    '延長完還是寫不進去的話，這個功能等於沒有',
  );
});

test('過期太久的那一份，加 10 分鐘之後仍然是過期的', () => {
  // 這是對的，但呼叫端要說得出來——不然老師會以為每個人都被延到了。
  const longGone = { status: 'IN_PROGRESS', expiresAt: new Date(NOW.getTime() - 3 * 3600_000) };
  const r = checkExtend(longGone, 10, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.reopened, false);
  assert.equal(attemptWritable({ status: 'IN_PROGRESS', expiresAt: r.expiresAt }, NOW), false);
});

test('已交卷與已作廢的不受延長影響', () => {
  // 這一條是延長這個功能能不能被信任的前提：延長一整班的時間，
  // 不可以動到已經交出去的成績。
  for (const status of ['SUBMITTED', 'GRADED', 'VOIDED']) {
    const r = checkExtend({ status, expiresAt: EARLIER }, 10, NOW);
    assert.equal(r.ok, false, status);
    assert.ok(r.error.length > 0);
  }
});

test('沒有到期時刻的作答沒有東西可以延長', () => {
  const r = checkExtend(untimed, 10, NOW);
  assert.equal(r.ok, false);
  assert.ok(r.error.length > 0);
});

// ─────────────────────────────────────────────────────────────────
// 六、立刻結束這場考試
//
// 「把截止時間改成現在」停不掉正在寫的人（`attemptWritable` 只看
// `expiresAt`），而畫面上那句提示一直在教老師走那條沒有作用的路。
// ─────────────────────────────────────────────────────────────────

test('正在寫的那一份結束得掉，到期時刻就是現在', () => {
  const r = checkEndNow(writing, NOW);
  assert.equal(r.ok, true);
  assert.equal(+r.expiresAt, +NOW);
  assert.equal(attemptWritable({ status: 'IN_PROGRESS', expiresAt: r.expiresAt }, NOW), true);
  assert.equal(
    attemptWritable(
      { status: 'IN_PROGRESS', expiresAt: r.expiresAt },
      new Date(NOW.getTime() + 1000),
    ),
    false,
    '設成現在之後，下一秒就該收不到答案',
  );
});

test('不限時、也沒有截止時間的那一種也結束得掉', () => {
  // 這一格是 `checkFinalizeOnBehalf` 那條死路的出口：先結束，
  // 那一份就變成卡住的，然後才收得掉。
  const r = checkEndNow(untimed, NOW);
  assert.equal(r.ok, true);
  assert.equal(+r.expiresAt, +NOW);
});

test('已經結束或已經交卷的不重複動', () => {
  // 把已經過期的 expiresAt 往後挪到現在，等於偷偷多送了那幾分鐘。
  assert.equal(checkEndNow(stranded, NOW).ok, false);
  assert.equal(checkEndNow({ status: 'SUBMITTED', expiresAt: LATER }, NOW).ok, false);
  assert.equal(checkEndNow({ status: 'VOIDED', expiresAt: LATER }, NOW).ok, false);
});
