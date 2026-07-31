/**
 * 發布前置條件。
 *
 * # 這一支守的是什麼
 *
 * 在 `checkPublish` 之前，發布**一個條件都沒有**：`setQuestionStatus`
 * 只在 `to === 'RETIRED'` 時檢查，題目內頁的按鈕是無條件畫出來的，
 * API 只驗 enum。於是一題沒有標準答案的單選題可以入庫 → 發布 →
 * 被組進卷子 → 全班考完，四十份成績掛在「需人工確認」，而老師是在
 * 成績出不來的那一天才發現的。
 *
 * # 為什麼 BLOCK 與 WARN 要分別被釘住
 *
 * 兩個方向都會壞：擋太少就是上面那件事；擋太多的話，「沒標知識點就
 * 不給發布」會把老師推去繞過整個流程——他要的是明天的考卷，不是
 * 一棵整理好的知識點樹。分法的理由寫在 `checkPublish` 的說明裡，
 * 這裡把它變成會紅的東西。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { checkPublish } from '../lib/questionEdit.mjs';

/** 一題完全健康的單選題。 */
const ok = (extra) => ({
  type: 'SINGLE_CHOICE',
  content: '下列何者正確？',
  score: 2,
  answerKeys: [1],
  options: [
    { order: 1, label: '(1)', content: '甲' },
    { order: 2, label: '(2)', content: '乙' },
  ],
  knowledgePointCount: 1,
  explanationCount: 1,
  ...extra,
});

const codes = (r) => r.blocking.map((b) => b.code);
const warns = (r) => r.warnings.map((w) => w.code);

test('健康的題目直接放行，什麼都不說', () => {
  const r = checkPublish(ok());
  assert.equal(r.ok, true);
  assert.deepEqual(r.blocking, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.error, null);
});

// ── 擋 ───────────────────────────────────────────────────────────

test('選擇題沒有標準答案 → 擋，因為全班會掛在需人工確認', () => {
  const r = checkPublish(ok({ answerKeys: [] }));
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ['no_answer']);
  // 錯誤訊息要說得出後果，不能只說「不行」。
  assert.ok(r.error.includes('需人工確認'), r.error);
});

test('標準答案指到不存在的選項 → 擋，全班拿不到分數', () => {
  const r = checkPublish(ok({ answerKeys: [5] }));
  assert.deepEqual(codes(r), ['answer_orphan']);
  assert.ok(r.error.includes('(5)'), r.error);
});

test('單選題有兩個標準答案 → 擋', () => {
  assert.deepEqual(codes(checkPublish(ok({ answerKeys: [1, 2] }))), ['multi_answer_on_single']);
  // 多選題本來就可以有兩個。
  assert.equal(checkPublish(ok({ type: 'MULTI_CHOICE', answerKeys: [1, 2] })).ok, true);
});

test('選擇題只剩一個選項 → 擋，那不是一道題目', () => {
  const r = checkPublish(ok({ options: [{ order: 1, label: '(1)', content: '甲' }] }));
  assert.ok(codes(r).includes('too_few_options'));
});

test('題幹是空的 → 擋', () => {
  assert.ok(codes(checkPublish(ok({ content: '   ' }))).includes('empty_content'));
});

test('計分程式不認得的題型 → 擋', () => {
  const r = checkPublish(ok({ type: 'MATCHING' }));
  assert.deepEqual(codes(r), ['unknown_type']);
  assert.ok(r.error.includes('需人工確認'), r.error);
});

test('選填與填空沒有標準答案 → 擋', () => {
  assert.ok(codes(checkPublish(ok({
    type: 'FILL_SLOT', options: [], answerKeys: [], answerSlots: ['  ', ''],
  }))).includes('no_answer'));
  assert.equal(checkPublish(ok({
    type: 'FILL_SLOT', options: [], answerKeys: [], answerSlots: ['3', '5'],
  })).ok, true);
  // Json 欄位，格位編號當鍵的形狀也要吃得下（見 grading.mjs 的 slotList）。
  assert.equal(checkPublish(ok({
    type: 'FILL_SLOT', options: [], answerKeys: [], answerSlots: { 13: '1', 14: '2' },
  })).ok, true);
  assert.ok(codes(checkPublish(ok({
    type: 'FILL_SLOT', options: [], answerKeys: [], answerSlots: { 13: '', 14: ' ' },
  }))).includes('no_answer'));

  assert.ok(codes(checkPublish(ok({
    type: 'FILL_TEXT', options: [], answerKeys: [], answerText: '  ',
  }))).includes('no_answer'));
  assert.equal(checkPublish(ok({
    type: 'FILL_TEXT', options: [], answerKeys: [], answerText: '1/2|0.5',
  })).ok, true);
});

test('作文、翻譯、簡答沒有標準答案是正常的 → 不擋', () => {
  // 這三種本來就是人工或 AI 閱卷（lib/grading.mjs 的 MANUAL_TYPES）。
  // 拿「沒填標準答案」擋住它們，等於這三種題型永遠發布不了。
  for (const type of ['ESSAY', 'TRANSLATION', 'SHORT_ANSWER']) {
    const r = checkPublish(ok({ type, options: [], answerKeys: [], answerText: null }));
    assert.equal(r.ok, true, `${type}：${r.error}`);
  }
});

test('內容引用的附圖對不到 → 擋，那一題無法作答', () => {
  const fig = { id: 'f1', key: 'k/f1.png' };
  // 題幹
  let r = checkPublish(ok({ content: '如右圖 ![[a:f1]]', assets: null }));
  assert.deepEqual(codes(r), ['missing_asset']);
  assert.ok(r.error.includes('題幹'), r.error);
  // 有圖就過
  assert.equal(checkPublish(ok({ content: '如右圖 ![[a:f1]]', assets: [fig] })).ok, true);

  // 選項——三個欄位各存各的，所以要逐欄比對
  r = checkPublish(ok({
    options: [
      { order: 1, label: '(1)', content: '![[a:o1]]', assets: [{ id: 'o1', key: 'k/o1.png' }] },
      { order: 2, label: '(2)', content: '![[a:o2]]', assets: null },
    ],
  }));
  assert.deepEqual(codes(r), ['missing_asset']);
  assert.ok(r.error.includes('選項 ((2))') || r.error.includes('(2)'), r.error);
  assert.ok(r.error.includes('o2'), r.error);

  // 題組素材
  r = checkPublish(ok({ stimulus: '下表 ![[a:t1]]', stimulusAssets: null }));
  assert.ok(r.error.includes('題組前導敘述'), r.error);
  assert.equal(
    checkPublish(ok({ stimulus: '下表 ![[a:t1]]', stimulusAssets: [{ id: 't1', key: 'k/t.png' }] })).ok,
    true,
  );
});

test('擋下來的時候一次說完，不是修一個冒一個', () => {
  // 老師修一條、按一次、又被擋，是最快消磨耐心的互動。
  const r = checkPublish({ type: 'SINGLE_CHOICE', content: '', options: [], answerKeys: [] });
  assert.ok(r.blocking.length >= 3, JSON.stringify(codes(r)));
  for (const b of r.blocking) assert.ok(r.error.includes(b.detail), b.code);
});

// ── 提醒（不擋） ─────────────────────────────────────────────────

test('沒標知識點只是提醒——擋住它等於要老師先整理完知識點樹', () => {
  const r = checkPublish(ok({ knowledgePointCount: 0 }));
  assert.equal(r.ok, true, '沒有知識點不影響作答與計分，不該擋住老師出考卷');
  assert.deepEqual(warns(r), ['no_knowledge_point']);
  // 但要說出代價：能力分析算不到這一題。
  assert.ok(r.warnings[0].detail.includes('能力分析'), r.warnings[0].detail);
});

test('配分 0 只是提醒——組卷時會自動變成 1 分', () => {
  // lib/paper.ts：`question.score > 0 ? question.score : 1`，
  // 所以不會出現「答對了得 0 分」。
  const r = checkPublish(ok({ score: 0 }));
  assert.equal(r.ok, true);
  assert.deepEqual(warns(r), ['zero_score']);
  assert.ok(r.warnings[0].detail.includes('1 分'), r.warnings[0].detail);
});

test('沒有解析只是提醒——權利未確認時本來就刻意不建', () => {
  const r = checkPublish(ok({ explanationCount: 0 }));
  assert.equal(r.ok, true);
  assert.deepEqual(warns(r), ['no_explanation']);
});

test('被擋的時候提醒也一起帶回來，讓畫面自己決定怎麼排', () => {
  const r = checkPublish(ok({ answerKeys: [], knowledgePointCount: 0, score: 0 }));
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ['no_answer']);
  assert.deepEqual(warns(r).sort(), ['no_knowledge_point', 'zero_score']);
});

test('什麼都沒給的時候不會爆，而且是擋住而不是放行', () => {
  // fail closed：這一支的回傳值決定「要不要拿去考學生」。
  const r = checkPublish(undefined);
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('empty_content'));
  assert.ok(codes(r).includes('unknown_type'));
});
