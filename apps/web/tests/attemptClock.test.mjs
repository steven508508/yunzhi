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
  attemptStranded,
  attemptWritable,
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
