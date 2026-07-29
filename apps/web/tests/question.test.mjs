/**
 * 改題目與送分的判斷規則。
 *
 * # 為什麼這一份的每一格都值得寫下來
 *
 * 因為改題目是這套系統裡**錯了最沒有症狀**的寫入路徑。三種錯法：
 *
 *   · 刪掉一個選項而答案鍵沒跟著搬 → 每一個答對的學生被判錯，
 *     而題目、選項、分數在畫面上都長得完全正常
 *   · 送分寫進作答記錄而不是題目上 → 下一次重新計分把它蓋掉，
 *     沒有任何提示，老師幾週後才發現「我明明送過分」
 *   · 下架一題還在考的題目 → 學生照樣考得到它（組卷時的狀態檢查
 *     只在加題目的當下跑一次），而老師以為已經處理掉了
 *
 * 三種都不會產生錯誤訊息，所以只有測試抓得到。每一個測試的註解寫的
 * 是「錯了會怎樣」。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gradeAttempt } from '../lib/grading.mjs';
import {
  bumpsVersion,
  checkOptionStructure,
  checkRetire,
  checkTypeChange,
  readAward,
  renumberLabels,
  shapeOptions,
  typeFamily,
  withAward,
} from '../lib/questionEdit.mjs';

/** 編輯畫面上的一列。`origin` 是它原本是第幾個選項。 */
const row = (origin, content, correct = false, label = null) => ({
  origin,
  label,
  content,
  correct,
});

// ═══════════════════════════════════════════════════════════════
// 一、選項增刪之後，答案鍵要跟著搬
// ═══════════════════════════════════════════════════════════════

test('刪掉中間一個選項，答案鍵跟著往前移', () => {
  // 原稿 (1)60元 (2)70元 (3)80元 (4)90元，答案是 (4)。
  // 掃描時 (2) 漏抓，老師在編輯畫面上把那一列刪掉。
  //
  // 沒有重新對映的話，answerKeys 還是 [4]，而入庫後只剩三個選項——
  // 「4」指到一個不存在的東西，全班都會被判成需人工確認或答錯。
  const r = shapeOptions([
    row(1, '60元'),
    row(3, '80元'),
    row(4, '90元', true),
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.answerKeys, [3], '90元 現在是第 3 個');
  assert.deepEqual(
    r.options.map((o) => o.content),
    ['60元', '80元', '90元'],
  );
});

test('在中間插一個選項，答案鍵往後移', () => {
  // 漏抓的那一個被補回來時，原本的答案要往後退一格。搬錯方向的話
  // 症狀一樣是全班判錯，而且是「答案剛好差一格」——最像正常資料的一種。
  const r = shapeOptions([
    row(1, '60元'),
    row(null, '70元'),
    row(2, '80元'),
    row(3, '90元', true),
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.answerKeys, [4]);
});

test('多選題可以有好幾個答案鍵，而且排序過', () => {
  const r = shapeOptions([
    row(1, '甲', true),
    row(2, '乙'),
    row(3, '丙', true),
    row(4, '丁'),
    row(5, '戊', true),
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.answerKeys, [1, 3, 5]);
});

test('內容留空的選項會被丟掉，而後面的答案鍵跟著往前', () => {
  // 老師清空一列的內容，意思就是「這一列不要了」。它與按刪除是同一件事，
  // 所以答案鍵一樣要重新對映。
  const r = shapeOptions([row(1, '甲'), row(2, '   '), row(3, '丙', true)]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.answerKeys, [2]);
  assert.equal(r.options.length, 2);
});

test('把標準答案那一列清空會被擋下來，不是靜靜地丟掉答案', () => {
  // 這是「答案指到不存在的選項」在編輯路徑上的樣子。硬存下去的話，
  // 這一題會變成沒有標準答案，而每一份作答都掛在「需人工確認」，
  // 老師要一份一份看——而他不知道為什麼。
  const r = shapeOptions([row(1, '甲'), row(2, '', true), row(3, '丙')]);
  assert.equal(r.ok, false);
  assert.match(r.error, /內容是空的/);
});

test('兩個選項內容一模一樣時擋下來——這一題沒有唯一解', () => {
  // 多半是向量箭頭、上標、負號或單位被讀掉了。放行的話，選到
  // 「另一個一樣的」的學生會被判錯，而校對者掃過去不會停。
  const r = shapeOptions([row(1, '$v$', true), row(2, '$v$'), row(3, '$2v$')]);
  assert.equal(r.ok, false);
  assert.match(r.error, /完全一樣/);
});

test('有選項卻沒有勾標準答案時擋下來', () => {
  // 沒有標準答案的選擇題不會被判錯，它會讓每一份作答都變成
  // 「需人工確認」——一份 30 人的班就是 30 筆待處理，而畫面上
  // 只看得到一個「待確認」的數字。
  const r = shapeOptions([row(1, '甲'), row(2, '乙')]);
  assert.equal(r.ok, false);
  assert.match(r.error, /沒有標準答案/);
});

test('選項代號是預設編號時跟著重編，是原稿的代號時不動', () => {
  // (A)(B)(C) 或 甲乙丙 是原稿的一部分，硬改成 1..n 等於竄改原稿；
  // 而刪掉第 2 個之後畫面上剩下 (1)(3)(4) 則是明顯的錯誤。
  assert.deepEqual(renumberLabels([row(1, 'a', false, '1'), row(3, 'c', false, '3')]), ['1', '2']);
  assert.deepEqual(
    renumberLabels([row(1, 'a', false, 'A'), row(3, 'c', false, 'C')]),
    ['A', 'C'],
  );
  // 全形數字是台灣的輸入法在中文模式下打出來的，一樣算預設編號。
  assert.deepEqual(renumberLabels([row(1, 'a', false, '１'), row(2, 'b', false, '３')]), ['1', '2']);
});

// ═══════════════════════════════════════════════════════════════
// 二、已經考過的題目，選項的結構鎖住
// ═══════════════════════════════════════════════════════════════

test('沒有人作答過時，選項隨便增刪', () => {
  assert.equal(checkOptionStructure([row(1, 'a'), row(null, 'b')], 1, 0).ok, true);
  assert.equal(checkOptionStructure([row(1, 'a')], 3, 0).ok, true);
});

test('已經有人作答時，改文字可以、增刪不行', () => {
  // 學生的 AttemptAnswer.answerKeys 存的是「第幾個選項」。刪掉中間一個
  // 之後，他記錄裡的 (3) 會指到另一個選項——**檢討頁會顯示他選了一個
  // 他沒選過的答案**，而重新計分會用錯位的座標判對錯。沒有錯誤訊息。
  const same = checkOptionStructure([row(1, '改過的甲'), row(2, '乙'), row(3, '丙')], 3, 12);
  assert.equal(same.ok, true, '只改文字不動座標');

  const deleted = checkOptionStructure([row(1, '甲'), row(3, '丙')], 3, 12);
  assert.equal(deleted.ok, false);
  assert.match(deleted.error, /12 份作答/);
  assert.match(deleted.error, /另外建一題/, '要給出路，不是只說不行');
});

test('已經有人作答時，搬動選項順序也擋下來', () => {
  // 這是三種結構變更裡最不容易看出來的一種：數量沒變、文字沒變，
  // 只是第 2 個與第 3 個對調。答案鍵會跟著畫面走，而學生的記錄不會。
  const moved = checkOptionStructure([row(1, '甲'), row(3, '丙'), row(2, '乙')], 3, 5);
  assert.equal(moved.ok, false);
});

test('已經有人作答時，新增一列（origin 是 null）也擋下來', () => {
  const added = checkOptionStructure([row(1, '甲'), row(2, '乙'), row(null, '丙')], 2, 5);
  assert.equal(added.ok, false);
});

// ═══════════════════════════════════════════════════════════════
// 三、題型
// ═══════════════════════════════════════════════════════════════

test('答案存在同一欄的題型算同一家族', () => {
  assert.equal(typeFamily('SINGLE_CHOICE'), 'CHOICE');
  assert.equal(typeFamily('MULTI_CHOICE'), 'CHOICE');
  assert.equal(typeFamily('TRUE_FALSE'), 'CHOICE');
  assert.equal(typeFamily('FILL_SLOT'), 'SLOT');
  assert.equal(typeFamily('ESSAY'), 'TEXT');
  // 認不得的一律 UNKNOWN，不要猜。猜錯的方向是放行一個會把答案
  // 搬到別的欄位的改動。
  assert.equal(typeFamily('SOMETHING_NEW'), 'UNKNOWN');
});

test('考過的題目：單選改多選可以，單選改填空不行', () => {
  // 「這題其實是多選」是真的會發生的更正，而學生存的東西還是選項序號。
  assert.equal(checkTypeChange('SINGLE_CHOICE', 'MULTI_CHOICE', 30).ok, true);
  // 改成填空的話，已經存在的 answerKeys 變成沒有人讀的資料、
  // answerText 是空的——全班瞬間變成「未作答 0 分」，而每一題看起來
  // 都被正常計分了。
  const bad = checkTypeChange('SINGLE_CHOICE', 'FILL_TEXT', 30);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /未作答/);
  // 沒有人考過時隨便改。
  assert.equal(checkTypeChange('SINGLE_CHOICE', 'FILL_TEXT', 0).ok, true);
});

// ═══════════════════════════════════════════════════════════════
// 四、版本
// ═══════════════════════════════════════════════════════════════

test('動到計分依據才加版，改錯字不加', () => {
  // version 的意思是「這一題的計分依據被改過幾次」。改錯字也加版的話，
  // 家長申訴時翻出來的版號就失去意義了——它不再對應任何一次成績變動。
  assert.equal(bumpsVersion(['answerKeys']), true);
  assert.equal(bumpsVersion(['options']), true);
  assert.equal(bumpsVersion(['type']), true);
  assert.equal(bumpsVersion(new Set(['content'])), false);
  assert.equal(bumpsVersion(['content', 'knowledgePoints', 'explanation']), false);
  // 配分不算：卷子與作答都存了自己的快照，改題庫的預設配分動不到
  // 任何一份已經算出來的成績。
  assert.equal(bumpsVersion(['score']), false);
});

// ═══════════════════════════════════════════════════════════════
// 五、下架的擋阻
// ═══════════════════════════════════════════════════════════════

const NOW = new Date('2026-08-10T00:00:00Z');

const paperWith = (assignments, paperStatus = 'READY') => ({
  paperId: 'p1',
  paperTitle: '第三次小考',
  paperStatus,
  assignments,
});

test('沒有任何卷子用到時，下架得了', () => {
  assert.equal(checkRetire([], NOW).ok, true);
});

test('還沒截止的任務擋下來，而且說得出是哪幾份', () => {
  // 擋不住的話，學生照樣會考到這一題——組卷時的狀態檢查只在
  // 「加題目」的當下跑一次，考試當下沒有人再看一次題目狀態。
  const r = checkRetire(
    [
      paperWith([
        { assignmentId: 'a1', title: '高二數學第三次小考', dueAt: '2026-08-12T00:00:00Z' },
      ]),
    ],
    NOW,
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /高二數學第三次小考/);
  assert.equal(r.blocking.length, 1);
  assert.equal(r.blocking[0].kind, 'assignment');
});

test('已經截止的任務不擋——那是歷史', () => {
  // 下架不影響已經考完的成績。擋著的話，一題用過十年的考古題
  // 就永遠下架不了。
  const r = checkRetire(
    [paperWith([{ assignmentId: 'a1', title: '上學期期末', dueAt: '2026-01-20T00:00:00Z' }])],
    NOW,
  );
  assert.equal(r.ok, true);
});

test('沒有截止時間的任務也擋——那種永遠不會結束', () => {
  // 長期開放的自主練習就是這一種。當成「已經結束」放行的話，
  // 題目下架之後學生還是天天練得到它。
  const r = checkRetire(
    [paperWith([{ assignmentId: 'a2', title: '自主練習', dueAt: null }])],
    NOW,
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /沒有截止時間/);
});

test('還沒派出去、也還沒封存的卷子擋下來', () => {
  // 那份卷子隨時會被派出去，而派出去的時候不會再檢查一次題目狀態。
  const r = checkRetire([paperWith([], 'READY')], NOW);
  assert.equal(r.ok, false);
  assert.equal(r.blocking[0].kind, 'paper');
});

test('已封存的卷子不擋', () => {
  assert.equal(checkRetire([paperWith([], 'ARCHIVED')], NOW).ok, true);
});

test('多份時全部列出來，不是只說第一份', () => {
  // 只說一份的話，老師處理完它、再按一次下架、又被擋——那是最讓人
  // 覺得系統在跟自己作對的一種互動。
  const r = checkRetire(
    [
      paperWith([
        { assignmentId: 'a1', title: '甲班小考', dueAt: null },
        { assignmentId: 'a2', title: '乙班小考', dueAt: '2026-09-01T00:00:00Z' },
      ]),
    ],
    NOW,
  );
  assert.equal(r.blocking.length, 2);
  assert.match(r.error, /甲班小考/);
  assert.match(r.error, /乙班小考/);
});

// ═══════════════════════════════════════════════════════════════
// 六、送分的旗標
// ═══════════════════════════════════════════════════════════════

test('送分的旗標讀得出來，而殘留的假值不算', () => {
  assert.equal(readAward(null), null);
  assert.equal(readAward({ mode: 'ALL_OR_NOTHING' }), null);
  // 取消送分是把鍵刪掉。塞一個 false 進去而讀成「有送分」的話，
  // 取消送分會是一個按了沒有用的按鈕。
  assert.equal(readAward({ awardAll: false }), null);
  assert.equal(readAward({ awardAll: [] }), null);
  const a = readAward({ awardAll: { at: '2026-08-10', by: 'u1', reason: '選項印錯' } });
  assert.equal(a.reason, '選項印錯');
});

test('立旗標與取消都不會動到其他計分規則', () => {
  // 直接把 scoringRule 換成 {awardAll} 的話，多選題的「全對才給分」
  // 與簡答題的關鍵詞比對會一起消失——而計分仍然算得出一個看起來
  // 正常的分數，只是規則悄悄變回了預設值。
  const before = { mode: 'ALL_OR_NOTHING', keywords: ['光合作用'] };
  const on = withAward(before, { at: 'x', reason: 'y' });
  assert.equal(on.mode, 'ALL_OR_NOTHING');
  assert.deepEqual(on.keywords, ['光合作用']);

  const off = withAward(on, null);
  assert.equal(off.mode, 'ALL_OR_NOTHING');
  assert.equal(readAward(off), null);

  // 本來就沒有其他規則時，取消之後回到 null 而不是留一個空物件——
  // 留著的話「這一題有沒有設過計分規則」就答不出來了。
  assert.equal(withAward({ awardAll: { at: 'x' } }, null), null);
});

// ═══════════════════════════════════════════════════════════════
// 七、送分之後的分數
// ═══════════════════════════════════════════════════════════════

const item = (extra = {}) => ({
  questionId: 'q1',
  type: 'SINGLE_CHOICE',
  score: 5,
  correctKeys: [2],
  optionCount: 4,
  ...extra,
});

test('送分之後，答錯的人也拿到滿分', () => {
  const graded = gradeAttempt(
    [item({ scoringRule: { awardAll: { at: 'x', reason: '選項印錯' } } })],
    [{ questionId: 'q1', answerKeys: [1] }],
  );
  const r = graded.results[0];
  assert.equal(r.earnedScore, 5);
  assert.equal(graded.autoScore, 5);
});

test('送分之後，沒有作答的人也拿到滿分', () => {
  // 空白的那幾份最容易被漏掉：它們在 attempt_answers 裡根本沒有列。
  // 分數是以卷面題目為準算出來的，所以總分照樣要含這一題。
  const graded = gradeAttempt([item({ scoringRule: { awardAll: { at: 'x' } } })], []);
  assert.equal(graded.results[0].earnedScore, 5);
  assert.equal(graded.autoScore, 5);
});

test('送分不會把答對率變成 100%', () => {
  // isCorrect 是「這個學生本來會不會」，成績頁的答對率就是數它。
  // 一律改成 true 的話，一題爛到要送分的題目會看起來像全班都學會了，
  // 而那正是老師決定下一堂課要重講什麼的依據。
  const wrong = gradeAttempt(
    [item({ scoringRule: { awardAll: { at: 'x' } } })],
    [{ questionId: 'q1', answerKeys: [1] }],
  ).results[0];
  assert.equal(wrong.isCorrect, false, '答錯的還是答錯，只是拿得到分數');

  const right = gradeAttempt(
    [item({ scoringRule: { awardAll: { at: 'x' } } })],
    [{ questionId: 'q1', answerKeys: [2] }],
  ).results[0];
  assert.equal(right.isCorrect, true);
  assert.equal(right.earnedScore, 5);
});

test('送分的說明要說得出「全班送分」，而且不洩漏正確答案', () => {
  // 學生看到一個滿分卻對不上自己選的答案，第一個念頭是系統算錯了。
  // 而 scoreNote 存在 AttemptAnswer 上，解析什麼時候放行是另一個設定
  // 決定的——順手把答案寫進去等於繞過它。
  const r = gradeAttempt(
    [item({ scoringRule: { awardAll: { at: 'x' } } })],
    [{ questionId: 'q1', answerKeys: [1] }],
  ).results[0];
  assert.match(r.scoreNote, /全班送分/);
  assert.match(r.scoreNote, /5 分/);
  assert.doesNotMatch(r.scoreNote, /\(2\)/);
});

test('本來需人工確認的題目，送分之後不再卡住整份作答', () => {
  // 送分要處理的正是這一種：標準答案是壞的（指到不存在的選項），
  // 每一份作答都掛在「需人工確認」。旗標沒有清掉 needsReview 的話，
  // 那份作答會一直停在「待評分」，學生永遠等不到成績。
  const graded = gradeAttempt(
    [item({ correctKeys: [], scoringRule: { awardAll: { at: 'x' } } })],
    [{ questionId: 'q1', answerKeys: [1] }],
  );
  assert.equal(graded.needsReview, 0);
  assert.equal(graded.results[0].earnedScore, 5);
});

test('非選題送分之後也算得出分數，不再等人評', () => {
  // 一題出錯的作文題若還留在 pendingManual，整份卷子會停在
  // 「待評分」，而它的分數其實已經確定了。
  const graded = gradeAttempt(
    [item({ type: 'ESSAY', score: 25, scoringRule: { awardAll: { at: 'x' } } })],
    [{ questionId: 'q1', answerText: '' }],
  );
  assert.equal(graded.pendingManual, 0);
  assert.equal(graded.results[0].earnedScore, 25);
});

test('沒有送分旗標時，計分完全照舊', () => {
  // 這一條是回歸測試：送分的分支加在計分的最前面，寫錯的話
  // 每一題都會變成滿分，而測試以外沒有任何地方看得出來。
  const graded = gradeAttempt([item()], [{ questionId: 'q1', answerKeys: [1] }]);
  assert.equal(graded.results[0].earnedScore, 0);
  assert.equal(graded.results[0].isCorrect, false);
  assert.match(graded.results[0].scoreNote, /答錯/);
});

test('多選題的部分給分規則在送分之後仍然留著', () => {
  // 送分是加一個鍵，不是換掉整個 scoringRule。換掉的話，取消送分
  // 之後這一題會變回預設的部分給分，而老師設過的「全對才給分」
  // 不見了——分數看起來完全正常，只是規則變了。
  const rule = { mode: 'ALL_OR_NOTHING', awardAll: { at: 'x' } };
  const withFlag = gradeAttempt(
    [item({ type: 'MULTI_CHOICE', correctKeys: [1, 2], scoringRule: rule })],
    [{ questionId: 'q1', answerKeys: [1] }],
  );
  assert.equal(withFlag.results[0].earnedScore, 5, '送分期間一律滿分');

  const cancelled = withAward(rule, null);
  const after = gradeAttempt(
    [item({ type: 'MULTI_CHOICE', correctKeys: [1, 2], scoringRule: cancelled })],
    [{ questionId: 'q1', answerKeys: [1] }],
  );
  assert.equal(after.results[0].earnedScore, 0, '取消之後 ALL_OR_NOTHING 還在');
});
