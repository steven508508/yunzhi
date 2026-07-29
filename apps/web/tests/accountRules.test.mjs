/**
 * 帳號生命週期的規則。
 *
 * 這一支測的全部是**每學期都會發生、而且錯了不會當機**的那幾件事：
 * 名冊上的錯字要改得掉、學號撞了要說得出被誰佔走、整班登錄同意按
 * 兩次不能把第一次的憑據覆蓋掉、刪除之後那個學號要放得回去。
 *
 * 每一項都對應到一個具體的失敗場景，而那些場景全部沒有錯誤訊息——
 * 它們的症狀是「三個月後有人發現數字對不起來」。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ERASED_NAME,
  ERASED_STAFF_NAME,
  checkDisplayName,
  checkUsernameChange,
  erasedUsername,
  isErasedUsername,
  parseConsentCell,
  planConsentBatch,
} from '../lib/accountRules.mjs';

// ── 姓名 ─────────────────────────────────────────────────────────

test('姓名不能是空的或只有空白', () => {
  // 空的話名冊上會出現一列沒有名字的人，而每一個下拉、每一張成績表
  // 都印一個空白。
  assert.ok(checkDisplayName(''));
  assert.ok(checkDisplayName('   '));
  assert.ok(checkDisplayName(null));
});

test('正常的姓名通過，前後空白不算在長度裡', () => {
  assert.equal(checkDisplayName('王大明'), null);
  assert.equal(checkDisplayName('  王大明  '), null);
});

test('超過 40 個字擋下來', () => {
  assert.equal(checkDisplayName('王'.repeat(40)), null);
  assert.ok(checkDisplayName('王'.repeat(41)));
});

// ── 登入代號 ─────────────────────────────────────────────────────

test('沒有改的話一律通過，就算它被自己佔用', () => {
  // 「有人在用」與「就是他自己在用」是兩件事。混在一起的話，
  // 只改姓名的那一次會被擋成「這個學號已經有人用了」。
  assert.equal(
    checkUsernameChange({ current: 'S1140312', next: 'S1140312', takenByOther: true }),
    null,
  );
});

test('撞到別人的代號要說得出可能是誰', () => {
  const msg = checkUsernameChange({
    current: 'S1140312',
    next: 'T001',
    takenByOther: true,
  });
  assert.ok(msg);
  // 訊息要說得出被誰佔走了。只回 P2002 的話，櫃檯會以為是自己打錯字，
  // 然後換一個學號重來——而那位學生的歷史成績就此斷成兩半。
  assert.match(msg, /T001/);
  assert.match(msg, /學號|代號/);
});

test('沒有被佔用時改得動', () => {
  assert.equal(
    checkUsernameChange({ current: 'S1140312', next: 'S1140313', takenByOther: false }),
    null,
  );
});

test('中間有空白的代號擋下來', () => {
  // 登入表單不會幫使用者 trim 中間的空白，而「S114 0312」與「S1140312」
  // 在畫面上幾乎看不出差別——症狀是他拿到帳號卻登不進去，
  // 而老師照著螢幕唸給他聽的那一串是對的。
  assert.ok(checkUsernameChange({ current: 'A1', next: 'S114 0312' }));
});

test('太短或太長的代號擋下來', () => {
  assert.ok(checkUsernameChange({ current: 'AAA', next: 'A' }));
  assert.ok(checkUsernameChange({ current: 'AAA', next: 'A'.repeat(41) }));
  assert.equal(checkUsernameChange({ current: 'AAA', next: 'AB' }), null);
  assert.equal(checkUsernameChange({ current: 'AAA', next: 'A'.repeat(40) }), null);
});

test('空的代號擋下來，而且訊息不是格式錯誤', () => {
  const msg = checkUsernameChange({ current: 'A1', next: '   ' });
  assert.match(msg, /請填寫/);
});

// ── 去識別化的代號 ───────────────────────────────────────────────

test('刪除之後的代號一定不撞，而且原本那個放得回去', () => {
  // `@@unique([tenantId, username])` 沒有把 deletedAt 算進去，所以留著
  // 原學號等於它被一個已刪除的帳號永久佔住。補習班的學號依入學年度
  // 編號、會重覆使用，下一年的新生拿到同一個學號時，名冊匯入會
  // findFirst 到那個殼、把新生接上去。
  const a = erasedUsername('ckq1abc');
  const b = erasedUsername('ckq2xyz');
  assert.notEqual(a, b);
  assert.ok(isErasedUsername(a));
  // 原本的學號不再出現在任何一個帳號上。
  assert.ok(!a.includes('S1140312'));
});

test('正常的學號不會被誤判成已刪除', () => {
  assert.ok(!isErasedUsername('S1140312'));
  assert.ok(!isErasedUsername('T001'));
  assert.ok(!isErasedUsername(''));
  assert.ok(!isErasedUsername(undefined));
});

test('學生與教職員的去識別化名稱不同', () => {
  // 同一句話用在兩處的話，看題庫的人會看到一列「已刪除的學生」出的題目。
  assert.notEqual(ERASED_NAME, ERASED_STAFF_NAME);
});

// ── 批次登錄同意的冪等 ───────────────────────────────────────────

const S = (id, consentAt = null) => ({ id, displayName: id, consentAt });

test('整班：只挑出還沒有同意紀錄的人', () => {
  const plan = planConsentBatch([S('a'), S('b', new Date()), S('c')]);
  assert.deepEqual(plan.toRecord, ['a', 'c']);
  assert.deepEqual(plan.alreadyDone, ['b']);
  assert.deepEqual(plan.missing, []);
});

test('按第二次什麼都不寫——這就是冪等', () => {
  // consentAt 記的是第一次取得同意的時間。整班一鍵按第二次若把所有人
  // 都寫一次，那些人的同意日期會集體變成第二次按下的時刻，
  // 而**一份被覆蓋過的憑據等於沒有憑據**。
  const now = new Date();
  const plan = planConsentBatch([S('a', now), S('b', now)]);
  assert.deepEqual(plan.toRecord, []);
  assert.equal(plan.alreadyDone.length, 2);
});

test('勾選清單：只動勾到的那幾位', () => {
  const plan = planConsentBatch([S('a'), S('b'), S('c')], ['a', 'c']);
  assert.deepEqual(plan.toRecord, ['a', 'c']);
});

test('勾選清單裡的重複值不會讓同一位被寫兩次', () => {
  const plan = planConsentBatch([S('a'), S('b')], ['a', 'a', 'a']);
  assert.deepEqual(plan.toRecord, ['a']);
});

test('勾到不在這個班的人：不做，但要回報出來', () => {
  // 另一個分頁上的舊畫面送出來的 id。默默照做的話，一位已經轉走的
  // 學生會被重新啟用；默默忽略的話，沒有人知道畫面過期了。
  const plan = planConsentBatch([S('a')], ['a', 'ghost']);
  assert.deepEqual(plan.toRecord, ['a']);
  assert.deepEqual(plan.missing, ['ghost']);
});

test('勾選清單是空陣列時什麼都不做（不等於整班）', () => {
  // 空陣列是「一個都沒勾就按了」，那應該回一句話，
  // 而不是安靜地把全班啟用。
  const plan = planConsentBatch([S('a'), S('b')], []);
  assert.deepEqual(plan.toRecord, []);
});

test('null 代表整班，與空陣列不同', () => {
  const plan = planConsentBatch([S('a'), S('b')], null);
  assert.deepEqual(plan.toRecord, ['a', 'b']);
});

test('名冊是空的時候不會爆', () => {
  const plan = planConsentBatch([], ['a']);
  assert.deepEqual(plan.toRecord, []);
  assert.deepEqual(plan.missing, ['a']);
});

// ── 名冊 CSV 的同意欄 ────────────────────────────────────────────

test('空白代表沒有同意，不是讀不懂', () => {
  // 大部分名冊根本不會有這一欄。空白要能安靜地通過。
  assert.equal(parseConsentCell(''), false);
  assert.equal(parseConsentCell(null), false);
  assert.equal(parseConsentCell(undefined), false);
  assert.equal(parseConsentCell('  '), false);
});

test('明確說「否」的要讀成沒有同意', () => {
  // 櫃檯的 Excel 裡一整欄填著「否」是很正常的事，而把它讀成同意，
  // 等於系統自己造了兩百筆假的法定代理人同意紀錄。
  for (const no of ['否', '無', '未取得', '沒有', 'N', 'no', 'FALSE', '0', '-']) {
    assert.equal(parseConsentCell(no), false, `「${no}」被讀成同意了`);
  }
});

test('說出取得方式的直接照用', () => {
  assert.equal(parseConsentCell('現場'), 'IN_PERSON');
  assert.equal(parseConsentCell('現場簽署'), 'IN_PERSON');
  assert.equal(parseConsentCell('紙本'), 'PAPER');
  assert.equal(parseConsentCell('回條'), 'PAPER');
  assert.equal(parseConsentCell('線上'), 'ONLINE');
  assert.equal(parseConsentCell('online'), 'ONLINE');
});

test('只說「是」的當成紙本回條', () => {
  // 補習班報名時最常見的形式，而且它是三種裡證據力中間的那一個。
  for (const yes of ['是', '有', '已取得', '已同意', 'Y', 'yes', 'TRUE', '1', 'V']) {
    assert.equal(parseConsentCell(yes), 'PAPER', `「${yes}」沒有被讀成同意`);
  }
});

test('讀不懂的值回 null，讓呼叫端擋下整份', () => {
  // fail closed：猜錯的方向只能往「還要人工確認」倒。
  // 而「櫃檯打了一個系統看不懂的字，於是那 40 位靜靜地維持登不進去」
  // 這個除錯迴圈沒有出口——他會以為是同意功能壞了。
  assert.equal(parseConsentCell('待補'), null);
  assert.equal(parseConsentCell('明天給'), null);
  assert.equal(parseConsentCell('？'), null);
});

test('大小寫與前後空白不影響判定', () => {
  assert.equal(parseConsentCell('  YES  '), 'PAPER');
  assert.equal(parseConsentCell(' Online '), 'ONLINE');
});
