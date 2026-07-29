/**
 * 作廢與撤銷作廢的狀態轉移。
 *
 * # 為什麼這幾格值得一張表
 *
 * 因為作廢是**不可逆的方向錯了就救不回來**的那一種動作：一份作答被
 * 標成 VOIDED 之後，全班統計、答對率、級分換算與學生自己的檢討頁
 * 全部把它當成不存在。判斷放寬一格的代價是一個學生的成績從班上消失，
 * 而他要等到看成績單才會發現。
 *
 * 而撤銷的還原目標更隱蔽：猜成 GRADED 的話，一份含作文、老師還沒改
 * 的卷子會被標成「已評分」，那 25 分永遠不會被補上——**畫面上完全
 * 正常**，只是分數少了四分之一。
 *
 * 所以每一個測試的註解寫的是錯了會怎樣。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MIN_REASON,
  checkReason,
  checkUnvoid,
  checkVoid,
  restoreStatus,
} from '../lib/attemptVoid.mjs';

const SUBMITTED_AT = new Date('2026-08-01T01:00:00Z');

const writing = { status: 'IN_PROGRESS', submittedAt: null };
const handedIn = { status: 'SUBMITTED', submittedAt: SUBMITTED_AT };
const graded = { status: 'GRADED', submittedAt: SUBMITTED_AT };
const voidedAfterSubmit = { status: 'VOIDED', submittedAt: SUBMITTED_AT };
const voidedWhileWriting = { status: 'VOIDED', submittedAt: null };

// ─────────────────────────────────────────────────────────────────
// 一、什麼作廢得了
// ─────────────────────────────────────────────────────────────────

test('進行中、已交卷、已評分三種都作廢得了', () => {
  // IN_PROGRESS 一定要能作廢：抓到作弊的時間點多半就是考試進行中。
  // 擋掉它的話，監考老師看到手機也只能等他考完——而那段時間學生
  // 還在繼續作答。
  for (const attempt of [writing, handedIn, graded]) {
    assert.equal(checkVoid(attempt).ok, true, `${attempt.status} 應該作廢得了`);
  }
});

test('已經作廢的不能再作廢一次，而且不是靜靜地成功', () => {
  // 兩位老師同時看著同一頁時，後按的那一位會以為是自己作廢的，
  // 而他填的理由不會被寫進去——稽核上留下的是前一位的說法，
  // 而那兩份說法可能完全不同（一個寫「跳電」、一個寫「使用手機」）。
  const r = checkVoid(voidedAfterSubmit);
  assert.equal(r.ok, false);
  assert.match(r.error, /已經作廢/);
});

test('認不得的狀態一律不動', () => {
  // 日後 schema 多一個 AttemptStatus 而這裡忘了跟上時，症狀要是
  // 「作廢不了」——那會被回報。反過來預設放行的話，是把一份狀態
  // 不明的作答改成 VOIDED，而那不可逆。
  const r = checkVoid({ status: 'ARCHIVED', submittedAt: null });
  assert.equal(r.ok, false);
  assert.match(r.error, /看不懂/);
});

// ─────────────────────────────────────────────────────────────────
// 二、理由
// ─────────────────────────────────────────────────────────────────

test('太短的理由不收，而且錯誤訊息要舉例', () => {
  // 空白的理由等於沒有稽核：記錄上寫著「王老師在 9 月 3 日作廢了
  // 這一份」，然後三個月後家長問起時沒有人說得出為什麼。
  for (const junk of ['', '   ', '錯', 'ok']) {
    const r = checkReason(junk);
    assert.equal(r.ok, false, `「${junk}」不該被收下`);
    assert.match(r.error, /監考記錄|跳電/, '錯誤訊息要示範一句好的理由長什麼樣');
  }
});

test('理由前後的空白會被去掉，長度以去掉之後為準', () => {
  // 不 trim 的話，四個空白鍵就能通過長度檢查，而稽核上留下的是
  // 一串看不見的字元。
  const spaces = ' '.repeat(MIN_REASON + 2);
  assert.equal(checkReason(spaces).ok, false);

  const r = checkReason('  教室跳電，這一份只剩前 4 題  ');
  assert.equal(r.ok, true);
  assert.equal(r.reason, '教室跳電，這一份只剩前 4 題');
});

test('不是字串的理由當成沒填', () => {
  // API 收的是 JSON，而 JSON 送得進 null 與數字。
  for (const junk of [null, undefined, 42, {}, []]) {
    assert.equal(checkReason(junk).ok, false);
  }
});

test('過長的理由擋掉', () => {
  const r = checkReason('作'.repeat(501));
  assert.equal(r.ok, false);
  assert.match(r.error, /太長/);
});

// ─────────────────────────────────────────────────────────────────
// 三、撤銷之後回到哪裡
// ─────────────────────────────────────────────────────────────────

test('交過卷的回到 SUBMITTED，不是 GRADED', () => {
  // **這一格是整支測試最重要的一格。**
  //
  // 回 GRADED 而其實還有非選題沒改的話，畫面上寫著「已評分」，
  // 老師以為處理完了，那 25 分永遠不會被補上——那正是 lib/scoring.ts
  // 檔頭警告的錯。
  //
  // 反過來猜錯（回 SUBMITTED 而其實早就評完了）的代價是狀態欄顯示
  // 「待評分」，老師按一次重新計分就好。**自己會好。**
  assert.equal(restoreStatus(voidedAfterSubmit), 'SUBMITTED');

  const r = checkUnvoid(voidedAfterSubmit);
  assert.equal(r.ok, true);
  assert.equal(r.status, 'SUBMITTED');
});

test('沒交過卷的回到 IN_PROGRESS', () => {
  // 回 SUBMITTED 的話，稽核與成績單上會宣稱一位從來沒有按過交卷的
  // 學生交了卷，而 submittedAt 是 null——那一列自己互相矛盾。
  assert.equal(restoreStatus(voidedWhileWriting), 'IN_PROGRESS');

  const r = checkUnvoid(voidedWhileWriting);
  assert.equal(r.ok, true);
  assert.equal(r.status, 'IN_PROGRESS');
});

test('submittedAt 是 undefined 與 null 一樣算沒交過', () => {
  // 呼叫端的 select 有可能沒帶這一欄。`undefined == null` 成立，
  // 但寫成 `=== null` 的話 undefined 會被當成「交過卷」——
  // 而那會讓一份沒交的作答被還原成 SUBMITTED。
  assert.equal(restoreStatus({ status: 'VOIDED' }), 'IN_PROGRESS');
});

test('沒有作廢的東西撤銷不了', () => {
  // 靜靜地成功不行：畫面上看起來與真的撤銷一模一樣，老師會以為
  // 自己剛剛做了一件事。
  for (const attempt of [writing, handedIn, graded]) {
    const r = checkUnvoid(attempt);
    assert.equal(r.ok, false, `${attempt.status} 不該撤銷得了`);
    assert.match(r.error, /沒有作廢/);
  }
});

// ─────────────────────────────────────────────────────────────────
// 四、來回一趟
// ─────────────────────────────────────────────────────────────────

test('作廢再撤銷，交過卷的那一份回得到統計裡', () => {
  // 這一圈就是「誤判之後把學生救回來」的完整路徑。任何一段斷掉，
  // 那個學生的成績就永遠停在作廢狀態，而成績單上他什麼都沒有。
  assert.equal(checkVoid(graded).ok, true);
  const afterVoid = { status: 'VOIDED', submittedAt: graded.submittedAt };
  const back = checkUnvoid(afterVoid);
  assert.equal(back.ok, true);
  // 回到 SUBMITTED——而 classStats 查的是 SUBMITTED 與 GRADED 兩種，
  // 所以它立刻回到平均、答對率與級分換算裡。
  assert.equal(back.status, 'SUBMITTED');
  assert.equal(checkVoid({ status: back.status, submittedAt: graded.submittedAt }).ok, true);
});
