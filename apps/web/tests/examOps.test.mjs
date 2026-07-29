/**
 * 考試營運的四個口徑。
 *
 * # 這一支測的是「兩個畫面各算一次，然後不一樣」
 *
 * 每一項都不會當機，也不會有錯誤訊息。它們的症狀是**老師照著一個
 * 錯的數字做決定**：
 *
 *   · 「已作答 22/25，讓他繼續寫吧」——那個人其實只寫了 11 題
 *   · 「派給 31 人、交卷 31 人，全班都交了」——班上有 32 個人，
 *     少的那一個連考卷都沒打開，而他在成績頁的每一塊裡都不存在
 *   · 「重新計分」把老師昨天手動改過的那一題蓋回自動計分的結果，
 *     總分少了 4 分而沒有任何人知道
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MANUAL_SCORE_MARK,
  checkManualScore,
  countAnswered,
  hasAnswer,
  isManualScore,
  manualScoreNote,
  rosterTally,
} from '../lib/examOps.mjs';

// ─────────────────────────────────────────────────────────────────
// 一、有沒有作答
//
// `attempt_answers` 有一列不代表有答案。學生按了「標記待複查」會
// upsert 一列空的，點了選項又點一次取消也會把 answerKeys 覆蓋成空。
// 用列數當「已作答題數」的話，25 題的卷子標了 5 題、清掉 2 題，
// 老師看到 18 而學生自己畫面上是 11——兩個都是系統算的。
// ─────────────────────────────────────────────────────────────────

test('選了選項、打了字、填了格位，三種都算作答', () => {
  assert.equal(hasAnswer({ answerKeys: [2] }), true);
  assert.equal(hasAnswer({ answerKeys: [], answerText: '3/4' }), true);
  assert.equal(
    hasAnswer({ answerKeys: [], answerSlots: [{ slot: '①', value: '7' }] }),
    true,
  );
});

test('只按了標記待複查不算作答', () => {
  // 那是提醒自己回來看的記號。算成已作答會讓學生以為自己寫完了，
  // 也會讓老師以為那一份收出來有意義。
  assert.equal(hasAnswer({ answerKeys: [], answerText: null, flagged: true }), false);
});

test('點了選項又取消，那一列留著但不算作答', () => {
  assert.equal(hasAnswer({ answerKeys: [] }), false);
});

test('空白與只有空白字元都不算作答', () => {
  assert.equal(hasAnswer({ answerKeys: [], answerText: '' }), false);
  assert.equal(hasAnswer({ answerKeys: [], answerText: '   ' }), false);
  assert.equal(hasAnswer({ answerKeys: [], answerSlots: [{ slot: '①', value: '' }] }), false);
  assert.equal(hasAnswer({ answerKeys: [], answerSlots: [{ slot: '①', value: '  ' }] }), false);
});

test('answerSlots 是壞掉的形狀時不當機也不誤判', () => {
  // 這一欄是 jsonb，舊資料裡什麼都有可能。丟例外的話一份成績頁
  // 會因為一列髒資料整頁 500。
  assert.equal(hasAnswer({ answerKeys: [], answerSlots: null }), false);
  assert.equal(hasAnswer({ answerKeys: [], answerSlots: 'x' }), false);
  assert.equal(hasAnswer({ answerKeys: [], answerSlots: [null, 3, 'x'] }), false);
  assert.equal(hasAnswer({ answerKeys: [], answerSlots: [{ slot: '①' }] }), false);
});

test('一份作答裡真的寫了幾題', () => {
  const rows = [
    { answerKeys: [1] },
    { answerKeys: [] }, // 標記待複查
    { answerKeys: [], answerText: 'x=3' },
    { answerKeys: [], answerText: '  ' },
  ];
  assert.equal(countAnswered(rows), 2);
  assert.equal(countAnswered([]), 0);
});

// ─────────────────────────────────────────────────────────────────
// 二、應交 / 已開始 / 已交卷 / 未動作
//
// 「我沒收到」要從沒開過考卷的那個人身上查起，而他在只查 attempts
// 的畫面上完全不存在——不在全班表、不在未完成、不在已作廢。
// ─────────────────────────────────────────────────────────────────

const ROSTER = [
  { userId: 'u1' },
  { userId: 'u2' },
  { userId: 'u3' },
  { userId: 'u4' },
];

test('四個數字要加得起來，而且未動作的人要點得出名字', () => {
  const t = rosterTally(ROSTER, [
    { userId: 'u1', status: 'GRADED' },
    { userId: 'u2', status: 'SUBMITTED' },
    { userId: 'u3', status: 'IN_PROGRESS' },
  ]);
  assert.equal(t.expected, 4);
  assert.equal(t.started, 3);
  assert.equal(t.submitted, 2);
  assert.equal(t.inProgress, 1);
  assert.equal(t.untouched, 1);
  assert.deepEqual(t.untouchedIds, ['u4'], '這就是老師當下要打電話的名單');
  assert.equal(t.expected, t.started + t.untouched, '應交 = 已開始 + 未動作');
});

test('可作答多次的任務要以人算，不是以份算', () => {
  // 用份數的話，一個練習做了三次的學生會讓「已交卷」比「應交」還多。
  const t = rosterTally(ROSTER, [
    { userId: 'u1', status: 'GRADED' },
    { userId: 'u1', status: 'GRADED' },
    { userId: 'u1', status: 'IN_PROGRESS' },
  ]);
  assert.equal(t.started, 1);
  assert.equal(t.submitted, 1);
  assert.equal(t.inProgress, 1);
  assert.equal(t.untouched, 3);
});

test('作廢過的人算「開過考卷」，但不算交卷', () => {
  // 他的確動過這份考卷，只是那一份不算數。算成「未動作」的話，
  // 老師會打電話問一個其實已經考過、只是被作廢的學生。
  const t = rosterTally(ROSTER, [{ userId: 'u1', status: 'VOIDED' }]);
  assert.equal(t.started, 1);
  assert.equal(t.submitted, 0);
  assert.equal(t.untouched, 3);
  assert.ok(!t.untouchedIds.includes('u1'));
});

test('有作答但不在名單上的人單獨列出來，不混進應交人數', () => {
  // 兩種來源：老師個別指定自己試考，以及學生離開了班級名冊而
  // 作答記錄還在。兩種都不該影響應交人數，但也不能靜靜地消失。
  const t = rosterTally(ROSTER, [
    { userId: 'u1', status: 'SUBMITTED' },
    { userId: 'teacher', status: 'SUBMITTED' },
  ]);
  assert.equal(t.expected, 4);
  assert.equal(t.submitted, 1);
  assert.deepEqual(t.strangerIds, ['teacher']);
});

test('名單是空的、或還沒有人動過，都不會壞', () => {
  const none = rosterTally([], []);
  assert.equal(none.expected, 0);
  assert.equal(none.untouched, 0);

  const fresh = rosterTally(ROSTER, []);
  assert.equal(fresh.expected, 4);
  assert.equal(fresh.started, 0);
  assert.equal(fresh.untouched, 4);
});

// ─────────────────────────────────────────────────────────────────
// 三、人工評分不可以被重新計分蓋掉
//
// 沒有欄位可以記「這個分數是人給的」（不加遷移），所以記在
// `scoreNote` 的開頭。讀寫兩邊必須是同一個字串——不一致的症狀是
// 一個已經處理完的申訴在下一次重算時默默倒退。
// ─────────────────────────────────────────────────────────────────

test('人工評分寫出來的字串，自己認得出來', () => {
  assert.equal(isManualScore(manualScoreNote('第二段論證完整，給 8 分')), true);
  assert.equal(isManualScore(manualScoreNote('')), true, '老師什麼都沒寫也要留得住記號');
  assert.equal(isManualScore(manualScoreNote(null)), true);
});

test('自動計分寫的說明不會被誤認成人工評分', () => {
  // 誤認的方向是「自動計分的結果永遠不再更新」——老師改了標準答案
  // 之後按重新計分，分數一動也不動。
  assert.equal(isManualScore('答錯 1 個選項，得 3 / 5 分'), false);
  assert.equal(isManualScore('本題全班送分'), false);
  assert.equal(isManualScore(null), false);
  assert.equal(isManualScore(undefined), false);
  assert.equal(isManualScore(''), false);
});

test('老師寫的評語留在記號後面，家長問起時拿得出來', () => {
  const note = manualScoreNote('  第三步的代換寫反了，扣 2 分  ');
  assert.ok(note.startsWith(MANUAL_SCORE_MARK));
  assert.ok(note.includes('第三步的代換寫反了，扣 2 分'));
});

test('分數不能超過配分、不能是負的', () => {
  assert.deepEqual(checkManualScore(4, 5), { ok: true, score: 4 });
  assert.equal(checkManualScore(6, 5).ok, false);
  assert.equal(checkManualScore(-1, 5).ok, false);
  assert.equal(checkManualScore('4', 5).ok, false);
  assert.equal(checkManualScore(NaN, 5).ok, false);
});

test('滿分與零分都給得出來', () => {
  // 0 分要與「還沒評」分得開：前者是老師看過了決定不給分。
  assert.deepEqual(checkManualScore(0, 5), { ok: true, score: 0 });
  assert.deepEqual(checkManualScore(5, 5), { ok: true, score: 5 });
});

test('null 代表收回人工分數，回到自動計分', () => {
  assert.deepEqual(checkManualScore(null, 5), { ok: true, score: null });
});

test('分數一律兩位小數', () => {
  // 多選部分給分本來就會算出 2.4 這種值；三位以上多半是打錯，
  // 而且它會讓總分印出 78.30000000000001。
  assert.deepEqual(checkManualScore(2.456, 5), { ok: true, score: 2.46 });
});
