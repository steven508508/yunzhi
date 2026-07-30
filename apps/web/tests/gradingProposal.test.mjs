/**
 * 非選題 AI 閱卷的閘門：擋的是「看起來很有道理，但沒有讀過那份答案」。
 *
 * # 這一支測的錯誤與另外兩個閘門都不一樣
 *
 * `tutorGuard.test.mjs` 測洩漏答案——學生看完就知道答案，傷害立刻發生。
 * `adviceGuard.test.mjs` 測假的精確度——一個編出來的百分比，沒有症狀。
 *
 * 這裡測的是第三種，而它是三種裡最容易通過人工審查的：**一段
 * 「文句通順、結構完整、論述清楚」的評語配一個看起來合理的分數。**
 * 它沒有錯，它只是沒有讀過那篇作文。老師改到第十四份的時候，
 * 他會直接按採用——而那一刻，這個系統就從「AI 提出、人類決定」
 * 變成「AI 決定、人類按鈕」，而畫面上完全看不出差別。
 *
 * # 為什麼壞掉的樣本要二十幾種
 *
 * 因為它們壞的地方在**不同的層次**，而每一層漏掉都有自己的後果：
 *
 *   · 算術層（加總不對、面向超分）——分數本身就是錯的，而它有兩個
 *     互相矛盾的數字，老師只會看到其中一個
 *   · 內容層（通用評語、編出來的引用）——分數也許對，但沒有任何
 *     依據，而它讀起來與有依據的一模一樣
 *   · 界線層（評價學生本人、照抄規準原文）——這兩種不是評得準不準
 *     的問題，是這段文字不該存在
 *
 * # 反例比正例重要
 *
 * 誤擋的代價是那一題退回純人工閱卷（也就是這個功能存在之前的樣子），
 * 所以誤擋不會壞掉任何東西——但**誤擋一整類**會讓功能實質上不存在。
 * 所以後半段有一整組必須通過的輸出，包含幾個長得很像違規的：
 * 一句正確的「學生沒有回答第二小題」、一段只有一句套語但引用得很具體
 * 的評語、以及一篇剛好在談「能力」的作文（引用它會撞上「評價學生
 * 本人」那一條）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLICHE_LIMIT,
  LEAK_SPAN,
  MIN_ACCURACY_SAMPLE,
  QUOTE_MIN,
  QUOTE_MIN_LATIN,
  RUBRIC_MODES,
  accuracyReport,
  aggregateSamples,
  checkDecision,
  checkGradeProposal,
  checkRubricDraft,
  composeDecisionNote,
  condense,
  decideState,
  describeGradeViolations,
  gradingFacts,
  normalizeForGrading,
  parseDecisionNote,
  quoteMatch,
  readSample,
  reviewPriority,
  rubricTemplates,
  sortForReview,
  verifiedQuotes,
} from '../lib/gradingProposal.mjs';

// ─────────────────────────────────────────────────────────────────
// 固定樣本
//
// 一題國寫（25 分，等第制），一位學生寫的一段真的有具體內容的答案。
// 「具體」在這裡有嚴格的意思：**它含有題幹與規準裡都沒有的字串**，
// 所以「理由裡有沒有引用到它」是一個可以機械判定的問題。
// ─────────────────────────────────────────────────────────────────

const STEM = '閱讀上文之後，請以自己的經驗說明你對「準備」這兩個字的理解，文長不限。';

const ANSWER =
  '我認為最能說明這件事的是魚市場的清晨。' +
  '凌晨三點，攤販把冰塊鋪在木箱上，燈泡一盞一盞亮起來，那時候還沒有任何客人。' +
  '他們做的每一件事都不是為了自己，而是為了幾個小時之後才會出現的人。' +
  '我在那裡站了一個早上，忽然覺得所謂的準備，就是替一個還沒來的人把位置留好。';

/** 等第制的規準。descriptor 刻意寫得夠長，照抄才驗得出來。 */
const BAND_RUBRIC = {
  id: 'r1',
  name: '國寫情意題評分原則',
  totalScore: 25,
  mode: 'BAND',
  internalOnly: true,
  dimensions: [],
  bands: [
    {
      grade: 'A+',
      scoreMin: 22,
      scoreMax: 25,
      descriptor: '經驗寫得具體而且看得出是自己的事，感受與經驗對得起來，敘述有層次而不只是把事情講完。',
    },
    {
      grade: 'B',
      scoreMin: 10,
      scoreMax: 21,
      descriptor: '有經驗也有感受，但兩者之間的連結偏弱，或者經驗停在概括的層面而沒有落到細節。',
    },
    { grade: '0', scoreMin: 0, scoreMax: 0, descriptor: '空白、文不對題、或完全與題目無關。' },
  ],
};

/** 分面向的規準。英文作文四個面向各 5 分。 */
const DIM_RUBRIC = {
  id: 'r2',
  name: '英文作文評分面向',
  totalScore: 20,
  mode: 'DIMENSION',
  internalOnly: true,
  bands: [],
  dimensions: [
    { id: 'd1', name: '內容', maxScore: 5, descriptor: '是否切合題目要求、要點是否完整。' },
    { id: 'd2', name: '組織', maxScore: 5, descriptor: '段落安排與句子之間的連接。' },
    { id: 'd3', name: '文法句構', maxScore: 5, descriptor: '時態、主動詞一致、句型的正確與變化。' },
    { id: 'd4', name: '字彙拼字', maxScore: 5, descriptor: '用字恰當、拼字正確、有無重複使用同一組字。' },
  ],
};

const bandFacts = (over = {}) =>
  gradingFacts({
    question: { stem: STEM, score: 25 },
    rubric: BAND_RUBRIC,
    answer: ANSWER,
    ...over,
  });

const noRubricFacts = () =>
  gradingFacts({ question: { stem: STEM, score: 25 }, rubric: null, answer: ANSWER });

/** 一段真的引用了答案的理由。壞樣本只換掉要測的那一項。 */
const GOOD_REASON =
  '你寫「攤販把冰塊鋪在木箱上，燈泡一盞一盞亮起來」，這個細節把「還沒有任何客人」的時間點交代得很清楚，' +
  '而且最後把準備定義成「替一個還沒來的人把位置留好」，是從自己的經驗長出來的判斷，不是套一句現成的話。' +
  '扣分的地方在第三段只用一句話帶過感受，沒有回到魚市場那個場景。';

const sample = (over = {}) =>
  readSample({ score: 20, dimensions: [], rationale: GOOD_REASON, confidence: 0.7, ...over });

const codes = (res) => res.violations.map((v) => v.code);
const run = (s, f = bandFacts(), opts) => checkGradeProposal(s, f, opts);

// ─────────────────────────────────────────────────────────────────
// 正規化與引用比對
// ─────────────────────────────────────────────────────────────────

test('折疊：標點與空白拿掉，全形折半形，英文折小寫', () => {
  assert.equal(condense('魚市場的清晨，燈泡'), '魚市場的清晨燈泡');
  assert.equal(condense('ＡＢＣ　１２３'), 'abc123');
  assert.equal(condense('The Fish Market!'), 'thefishmarket');
});

test('折疊之後標點不同的引用仍然對得上', () => {
  const f = bandFacts();
  // 模型引用時重新標點過：原文是「冰塊鋪在木箱上，」
  assert.notEqual(quoteMatch(f, '他寫的是「把冰塊鋪在木箱上」', QUOTE_MIN), '');
});

test('題幹裡也有的字串不算引用', () => {
  const f = gradingFacts({
    question: { stem: '請說明你對準備這兩個字的理解', score: 25 },
    rubric: null,
    answer: '我對準備這兩個字的理解是要先做好功課',
  });
  // 「準備這兩個字的理解」整段都在題幹裡——把題目重述一次不是引用。
  assert.equal(quoteMatch(f, '學生說明了對準備這兩個字的理解', QUOTE_MIN), '');
});

test('引號裡確認過的內容才算證據', () => {
  const f = bandFacts();
  assert.deepEqual(verifiedQuotes(f, '他寫「魚市場的清晨」很好'), ['魚市場的清晨']);
  assert.deepEqual(verifiedQuotes(f, '他寫「陽明山的日落」很好'), []);
});

// ─────────────────────────────────────────────────────────────────
// 一、算術層：兩個互相矛盾的數字
// ─────────────────────────────────────────────────────────────────

test('壞 01：逐面向加起來不等於總分', () => {
  const f = gradingFacts({ question: { stem: STEM, score: 20 }, rubric: DIM_RUBRIC, answer: ANSWER });
  const s = sample({
    score: 16,
    dimensions: [
      { dimensionId: 'd1', name: '內容', score: 4, max: 5, reason: '要點完整' },
      { dimensionId: 'd2', name: '組織', score: 3, max: 5, reason: '段落清楚' },
      { dimensionId: 'd3', name: '文法句構', score: 3, max: 5, reason: '時態有錯' },
      { dimensionId: 'd4', name: '字彙拼字', score: 3, max: 5, reason: '用字重複' },
    ],
  });
  assert.ok(codes(run(s, f)).includes('SUM_MISMATCH'));
  assert.equal(run(s, f).unusable, true);
});

test('壞 02：某一個面向超過它的滿分', () => {
  const f = gradingFacts({ question: { stem: STEM, score: 20 }, rubric: DIM_RUBRIC, answer: ANSWER });
  const s = sample({
    score: 18,
    dimensions: [
      { dimensionId: 'd1', name: '內容', score: 7, max: 5, reason: '要點完整' },
      { dimensionId: 'd2', name: '組織', score: 4, max: 5, reason: '段落清楚' },
      { dimensionId: 'd3', name: '文法句構', score: 4, max: 5, reason: '時態正確' },
      { dimensionId: 'd4', name: '字彙拼字', score: 3, max: 5, reason: '用字重複' },
    ],
  });
  assert.ok(codes(run(s, f)).includes('DIM_OVER_MAX'));
});

test('壞 03：面向給了負分', () => {
  const f = gradingFacts({ question: { stem: STEM, score: 20 }, rubric: DIM_RUBRIC, answer: ANSWER });
  const s = sample({
    score: 8,
    dimensions: [
      { dimensionId: 'd1', name: '內容', score: 5, max: 5, reason: '要點完整' },
      { dimensionId: 'd2', name: '組織', score: 5, max: 5, reason: '段落清楚' },
      { dimensionId: 'd3', name: '文法句構', score: -2, max: 5, reason: '錯很多' },
      { dimensionId: 'd4', name: '字彙拼字', score: 0, max: 5, reason: '拼字錯' },
    ],
  });
  assert.ok(codes(run(s, f)).includes('DIM_NEGATIVE'));
});

test('壞 04：面向的滿分被寫成另一個數（照著別的配分在評）', () => {
  const f = gradingFacts({ question: { stem: STEM, score: 20 }, rubric: DIM_RUBRIC, answer: ANSWER });
  const s = sample({
    score: 16,
    dimensions: [
      { dimensionId: 'd1', name: '內容', score: 4, max: 10, reason: '要點完整' },
      { dimensionId: 'd2', name: '組織', score: 4, max: 5, reason: '段落清楚' },
      { dimensionId: 'd3', name: '文法句構', score: 4, max: 5, reason: '時態正確' },
      { dimensionId: 'd4', name: '字彙拼字', score: 4, max: 5, reason: '用字恰當' },
    ],
  });
  assert.ok(codes(run(s, f)).includes('DIM_MAX_MISMATCH'));
});

test('壞 05：評了一個規準裡沒有的面向', () => {
  const f = gradingFacts({ question: { stem: STEM, score: 20 }, rubric: DIM_RUBRIC, answer: ANSWER });
  const s = sample({
    score: 16,
    dimensions: [
      { dimensionId: 'd1', name: '內容', score: 4, max: 5, reason: '要點完整' },
      { dimensionId: 'd2', name: '組織', score: 4, max: 5, reason: '段落清楚' },
      { dimensionId: 'd3', name: '文法句構', score: 4, max: 5, reason: '時態正確' },
      { dimensionId: 'dX', name: '創意', score: 4, max: 5, reason: '很有創意' },
    ],
  });
  const got = codes(run(s, f));
  assert.ok(got.includes('UNKNOWN_DIMENSION'));
  // 少評的那一個也要一起報出來，否則老師只會看到「多了一個」。
  assert.ok(got.includes('MISSING_DIMENSION'));
});

test('壞 06：規準有四個面向，只評了兩個', () => {
  const f = gradingFacts({ question: { stem: STEM, score: 20 }, rubric: DIM_RUBRIC, answer: ANSWER });
  const s = sample({
    score: 8,
    dimensions: [
      { dimensionId: 'd1', name: '內容', score: 4, max: 5, reason: '要點完整' },
      { dimensionId: 'd2', name: '組織', score: 4, max: 5, reason: '段落清楚' },
    ],
  });
  assert.ok(codes(run(s, f)).includes('MISSING_DIMENSION'));
});

test('壞 07：總分超過這一題的配分', () => {
  assert.ok(codes(run(sample({ score: 27 }))).includes('OVER_TOTAL'));
});

test('壞 08：總分是負的', () => {
  assert.ok(codes(run(sample({ score: -3 }))).includes('NEGATIVE_TOTAL'));
});

test('壞 09：分數不是一個數字', () => {
  assert.ok(codes(run(sample({ score: '大約二十分' }))).includes('BAD_SCORE'));
});

test('壞 10：沒有規準卻自己發明了面向', () => {
  const s = sample({
    score: 20,
    dimensions: [{ dimensionId: '', name: '內容', score: 20, max: 25, reason: '內容不錯' }],
  });
  assert.ok(codes(run(s, noRubricFacts())).includes('DIMS_WITHOUT_RUBRIC'));
});

// ─────────────────────────────────────────────────────────────────
// 二、內容層：沒有讀過那份答案
// ─────────────────────────────────────────────────────────────────

test('壞 11：理由是空的', () => {
  assert.ok(codes(run(sample({ rationale: '' }))).includes('EMPTY_RATIONALE'));
});

test('壞 12：理由只有「尚可」兩個字', () => {
  const got = codes(run(sample({ rationale: '尚可' })));
  assert.ok(got.includes('EMPTY_RATIONALE'));
});

test('壞 13：通用評語——沒有引用答案裡的任何一句', () => {
  const s = sample({
    rationale: '這篇作文回應了題目的要求，內容有具體的例子，敘述完整，值得肯定的地方不少，' +
      '不過在感受的部分還可以再深入一些，整體來說是一篇中上程度的作品。',
  });
  const got = codes(run(s));
  assert.ok(got.includes('GENERIC_RATIONALE'));
});

test('壞 14：三句以上的套語，即使夾了一句引用也擋', () => {
  const s = sample({
    rationale: '他寫到魚市場的清晨。文句通順，結構完整，論述清楚，情感真摯，是一篇好作品。',
  });
  const got = codes(run(s));
  assert.ok(got.includes('CLICHE_HEAVY'));
  assert.ok(CLICHE_LIMIT === 3);
});

test('壞 15：編出來的引用——引號裡的句子答案裡沒有', () => {
  const s = sample({
    rationale:
      '你寫「攤販把冰塊鋪在木箱上」很具體，' +
      '但後面「我終於明白父親當年的辛苦與那些沒有說出口的話」這一段太概括，扣兩分。',
  });
  const got = codes(run(s));
  assert.ok(got.includes('FABRICATED_QUOTE'));
  // 它同時引用了真的句子，所以**不會**被判成通用評語——兩條規則要分得開。
  assert.ok(!got.includes('GENERIC_RATIONALE'));
});

test('壞 16：滿分卻沒有指出具體內容', () => {
  const s = sample({ score: 25, rationale: '這一篇寫得很好，各方面都達到最高等第的要求，給滿分。' });
  const got = codes(run(s));
  assert.ok(got.includes('EXTREME_NO_REASON'));
});

test('壞 17：零分卻沒有指出具體內容', () => {
  const s = sample({ score: 0, rationale: '這一篇不符合題目要求，因此不給分，請老師確認。' });
  assert.ok(codes(run(s)).includes('EXTREME_NO_REASON'));
});

test('壞 18：空白卷卻給了分數', () => {
  const f = bandFacts({ answer: '' });
  const s = sample({ score: 12, rationale: '雖然沒有寫很多，但看得出有想法，給一半的分數。' });
  assert.ok(codes(run(s, f)).includes('BLANK_BUT_SCORED'));
});

test('壞 19：評文采而不是評給分要點', () => {
  const f = gradingFacts({ question: { stem: STEM, score: 20 }, rubric: DIM_RUBRIC, answer: ANSWER });
  const s = sample({
    score: 16,
    rationale:
      '文筆流暢，用字遣詞很細膩，寫到攤販把冰塊鋪在木箱上那一段特別生動，讀起來很有畫面，' +
      '整篇的意境掌握得不錯。',
    dimensions: [
      { dimensionId: 'd1', name: '內容', score: 4, max: 5, reason: '很生動' },
      { dimensionId: 'd2', name: '組織', score: 4, max: 5, reason: '很流暢' },
      { dimensionId: 'd3', name: '文法句構', score: 4, max: 5, reason: '很優美' },
      { dimensionId: 'd4', name: '字彙拼字', score: 4, max: 5, reason: '很細膩' },
    ],
  });
  // 逐面向的 reason 裡有面向名稱時就不算——所以這一筆的理由刻意都不提名稱。
  const got = codes(run(s, f));
  assert.ok(got.includes('STYLE_OVER_RUBRIC'), got.join(','));
});

// ─────────────────────────────────────────────────────────────────
// 三、界線層：這段文字不該存在
// ─────────────────────────────────────────────────────────────────

test('壞 20：評價學生本人——「這位學生程度不錯」', () => {
  const s = sample({
    rationale: `${GOOD_REASON}整體來說這位學生的程度不錯，作文能力在班上算前段。`,
  });
  assert.ok(codes(run(s)).includes('JUDGES_STUDENT'));
});

test('壞 21：評價學生本人——用代名詞（「他的表達能力」）', () => {
  const s = sample({ rationale: `${GOOD_REASON}他的表達能力還不夠成熟。` });
  assert.ok(codes(run(s)).includes('JUDGES_STUDENT'));
});

test('壞 22：評價學生本人——沒有主詞的斷語（「基礎不好」）', () => {
  const s = sample({ rationale: `${GOOD_REASON}看得出來基礎不好，需要從頭補。` });
  assert.ok(codes(run(s)).includes('JUDGES_STUDENT'));
});

test('壞 23：替學生預測級分', () => {
  const s = sample({ rationale: `${GOOD_REASON}這樣的程度應該可以拿到 A 級分。` });
  assert.ok(codes(run(s)).includes('JUDGES_STUDENT'));
});

test('壞 24：照抄規準的描述原文', () => {
  const leak = BAND_RUBRIC.bands[0].descriptor.slice(0, LEAK_SPAN + 6);
  const s = sample({ rationale: `${GOOD_REASON}依規準：${leak}` });
  assert.ok(codes(run(s)).includes('RUBRIC_LEAK'));
});

test('壞 25：照抄規準——即使夾在引號裡也算（引號不是授權）', () => {
  const leak = BAND_RUBRIC.bands[1].descriptor.slice(2, LEAK_SPAN + 8);
  const s = sample({ rationale: `${GOOD_REASON}這一篇屬於「${leak}」那一級。` });
  assert.ok(codes(run(s)).includes('RUBRIC_LEAK'));
});

test('壞 26：面向有分數但沒有理由（體例，不必重來）', () => {
  const f = gradingFacts({ question: { stem: STEM, score: 20 }, rubric: DIM_RUBRIC, answer: ANSWER });
  const s = sample({
    score: 16,
    dimensions: [
      { dimensionId: 'd1', name: '內容', score: 4, max: 5, reason: '' },
      { dimensionId: 'd2', name: '組織', score: 4, max: 5, reason: '段落清楚' },
      { dimensionId: 'd3', name: '文法句構', score: 4, max: 5, reason: '時態正確' },
      { dimensionId: 'd4', name: '字彙拼字', score: 4, max: 5, reason: '用字恰當' },
    ],
  });
  const res = run(s, f);
  assert.ok(codes(res).includes('NO_DIM_REASON'));
  // STYLE 不阻擋。**這個區別很重要**：為了一個沒寫理由的面向把整份
  // 建議丟掉重生成，換來的是老師多等三秒看同一份東西。
  assert.equal(res.unusable, false);
});

test('壞 27：理由寫太長（體例）', () => {
  const s = sample({ rationale: `${GOOD_REASON}${'另外還有一些細節要說明。'.repeat(60)}` });
  const res = run(s);
  assert.ok(codes(res).includes('TOO_LONG'));
  assert.equal(res.unusable, false);
});

test('壞 28：英文作文的通用評語不會因為六個字母對上就過關', () => {
  const answer =
    'I visited the fish market before dawn. The vendors were putting ice on the wooden boxes ' +
    'and turning on the lights one by one. Nobody was there to buy anything yet.';
  const f = gradingFacts({ question: { stem: 'Write about preparation.', score: 20 }, rubric: null, answer });
  // 「market」「before」都是答案裡的六個字母，但這一段沒有引用任何片語。
  const s = sample({
    score: 14,
    rationale: 'The content is clear and the organization is acceptable before we consider the market of ideas.',
  });
  assert.ok(codes(run(s, f)).includes('GENERIC_RATIONALE'));
  assert.equal(QUOTE_MIN_LATIN > QUOTE_MIN, true);
});

test('違規清單折成一行，每一項帶得出代號', () => {
  const line = describeGradeViolations(run(sample({ score: 27, rationale: '尚可' })).violations);
  assert.match(line, /OVER_TOTAL/);
  assert.match(line, /EMPTY_RATIONALE/);
  assert.equal(describeGradeViolations([]), '');
});

// ─────────────────────────────────────────────────────────────────
// 反例：這些一律不可以被擋
// ─────────────────────────────────────────────────────────────────

test('好 01：引用了具體文句的等第制評分', () => {
  const res = run(sample());
  assert.deepEqual(res.violations, []);
  assert.equal(res.ok, true);
});

test('好 02：分面向的評分，加總正確、逐面向都有理由', () => {
  const f = gradingFacts({ question: { stem: STEM, score: 20 }, rubric: DIM_RUBRIC, answer: ANSWER });
  const s = sample({
    score: 15,
    rationale: '你寫「攤販把冰塊鋪在木箱上」這個細節很好，但第三段的感受只有一句話。',
    dimensions: [
      { dimensionId: 'd1', name: '內容', score: 4, max: 5, reason: '魚市場那個場景寫得具體' },
      { dimensionId: 'd2', name: '組織', score: 4, max: 5, reason: '三段的順序清楚' },
      { dimensionId: 'd3', name: '文法句構', score: 4, max: 5, reason: '句型有變化' },
      { dimensionId: 'd4', name: '字彙拼字', score: 3, max: 5, reason: '「準備」重複出現五次' },
    ],
  });
  assert.deepEqual(run(s, f).violations, []);
});

test('好 03：「學生沒有回答第二小題」是對答案的陳述，不是對人的評價', () => {
  const s = sample({
    rationale: `${GOOD_REASON}另外，學生沒有回答第二小題所要求的比較。`,
  });
  assert.deepEqual(run(s).violations, []);
});

test('好 04：一句套語配上具體引用不算套語', () => {
  const s = sample({
    rationale: '結構完整。你寫「凌晨三點，攤販把冰塊鋪在木箱上」，這個時間點交代得很清楚。',
  });
  assert.deepEqual(run(s).violations, []);
});

test('好 05：作文本身在談「能力」時，引用它不會被當成評價學生本人', () => {
  const answer =
    '我一直覺得自己的能力不足，直到那天在球場上把最後一球投進去，' +
    '才知道所謂的能力其實是準備好的次數夠多。';
  const f = gradingFacts({ question: { stem: STEM, score: 25 }, rubric: BAND_RUBRIC, answer });
  const s = sample({
    score: 18,
    rationale:
      '你寫「我一直覺得自己的能力不足」，然後用最後一球把這個感受翻轉過來，這個轉折是這一篇的重點。' +
      '扣分在轉折之後只有一句結論，沒有回頭說明準備的過程。',
  });
  assert.deepEqual(run(s, f).violations, []);
});

test('好 06：空白卷給零分，理由只說明它是空白的', () => {
  const f = bandFacts({ answer: '   \n  ' });
  const s = sample({ score: 0, rationale: '這一題整題空白，沒有任何作答內容可以評分。' });
  assert.deepEqual(run(s, f).violations, []);
});

test('好 07：把規準改寫成自己的話不算照抄', () => {
  const s = sample({
    rationale:
      '照規準，A+ 要求經驗具體而且感受與經驗對得起來。你寫「攤販把冰塊鋪在木箱上」是具體的，' +
      '但感受那一段還沒有回到這個場景，所以落在 B 的上緣。',
  });
  assert.deepEqual(run(s).violations, []);
});

test('好 08：沒有規準時，dimensions 是空陣列而且理由具體', () => {
  const res = run(sample({ score: 18 }), noRubricFacts());
  assert.deepEqual(res.violations, []);
  assert.equal(noRubricFacts().hasRubric, false);
  assert.deepEqual(noRubricFacts().dimensions, []);
});

test('好 09：很短的翻譯題——整句答案就是唯一可以引用的東西', () => {
  const f = gradingFacts({
    question: { stem: '請將下列中文翻譯成英文：他昨天把窗戶關上了。', score: 2 },
    rubric: null,
    answer: 'He closed the window yesterday.',
  });
  const s = sample({
    score: 2,
    rationale: '你寫 He closed the window yesterday，時態與詞序都正確，給滿分。',
  });
  assert.deepEqual(run(s, f).violations, []);
});

test('好 10：滿分而且引用得夠長', () => {
  const s = sample({
    score: 25,
    rationale:
      '你寫「凌晨三點，攤販把冰塊鋪在木箱上，燈泡一盞一盞亮起來」，' +
      '再用「替一個還沒來的人把位置留好」收束，經驗與感受完全對得起來，落在最高等第。',
  });
  assert.deepEqual(run(s).violations, []);
});

test('好 11：零分而且指出了具體內容（文不對題）', () => {
  const answer = '我最喜歡的手機遊戲是傳說對決，我打了三年，最高的段位是鑽石五。';
  const f = bandFacts({ answer });
  const s = sample({
    score: 0,
    rationale: '整篇在講「傳說對決」的段位，與題目要求說明的「準備」沒有任何關係，屬於文不對題。',
  });
  assert.deepEqual(run(s, f).violations, []);
});

test('好 12：談文采但同時提到面向名稱，不算評文采', () => {
  const f = gradingFacts({ question: { stem: STEM, score: 20 }, rubric: DIM_RUBRIC, answer: ANSWER });
  const s = sample({
    score: 16,
    rationale:
      '「內容」上你寫到攤販把冰塊鋪在木箱上，細膩而且具體；「組織」上三段的順序清楚，文筆也穩。',
    dimensions: [
      { dimensionId: 'd1', name: '內容', score: 4, max: 5, reason: '場景具體' },
      { dimensionId: 'd2', name: '組織', score: 4, max: 5, reason: '順序清楚' },
      { dimensionId: 'd3', name: '文法句構', score: 4, max: 5, reason: '句型正確' },
      { dimensionId: 'd4', name: '字彙拼字', score: 4, max: 5, reason: '用字恰當' },
    ],
  });
  assert.deepEqual(run(s, f).violations, []);
});

// ─────────────────────────────────────────────────────────────────
// 穩定性
// ─────────────────────────────────────────────────────────────────

test('三次評分一致時，離散度是 0、信心不打折', () => {
  const s = [sample({ score: 18 }), sample({ score: 18 }), sample({ score: 18 })];
  const agg = aggregateSamples(s, { maxScore: 25 });
  assert.equal(agg.median, 18);
  assert.equal(agg.spread, 0);
  assert.equal(agg.unstable, false);
  assert.equal(agg.confidence, 0.7);
});

test('三次評分差很多時標成不穩，而且信心被壓下來', () => {
  const s = [sample({ score: 9 }), sample({ score: 14 }), sample({ score: 20 })];
  const agg = aggregateSamples(s, { maxScore: 25 });
  assert.equal(agg.median, 14);
  assert.equal(agg.spread, 11);
  assert.equal(agg.unstable, true);
  assert.ok(agg.confidence <= 0.4, `信心沒有被壓下來：${agg.confidence}`);
  assert.match(agg.note, /不穩/);
});

test('取的是離中位數最近的那一份完整評分，不是逐面向的中位數', () => {
  const mk = (score, mark) =>
    readSample({
      score,
      rationale: `第 ${mark} 次：你寫「攤販把冰塊鋪在木箱上」。`,
      dimensions: [],
      confidence: 0.6,
    });
  const agg = aggregateSamples([mk(20, 'a'), mk(14, 'b'), mk(15, 'c')], { maxScore: 25 });
  assert.equal(agg.median, 15);
  // 取到的那一份的理由與分數是同一次的產物——**逐面向取中位數會產生
  // 一份沒有任何一次真的長成那樣的建議**，而它連自己的加總都過不了。
  assert.equal(agg.pick.suggestedScore, 15);
  assert.match(agg.pick.rationale, /第 c 次/);
});

test('只評一次時信心一律打折——那時候離散度是未知，不是零', () => {
  const one = aggregateSamples([sample({ score: 18, confidence: 0.8 })], { maxScore: 25 });
  const three = aggregateSamples(
    [sample({ score: 18, confidence: 0.8 }), sample({ score: 18, confidence: 0.8 }), sample({ score: 18, confidence: 0.8 })],
    { maxScore: 25 },
  );
  assert.ok(one.confidence < three.confidence, `${one.confidence} 應該低於 ${three.confidence}`);
  assert.match(one.note, /只評了一次/);
});

test('一份都算不出來時回 null，不回一個假的 0 分', () => {
  assert.equal(aggregateSamples([], { maxScore: 25 }), null);
  assert.equal(aggregateSamples([readSample({ score: 'x' })], { maxScore: 25 }), null);
});

test('同樣的輸入，聚合的結果每次都一樣（順序不影響挑選）', () => {
  const mk = (score) => readSample({ score, rationale: `分數 ${score}`, confidence: 0.5 });
  const a = aggregateSamples([mk(10), mk(12), mk(14)], { maxScore: 25 });
  const b = aggregateSamples([mk(14), mk(10), mk(12)], { maxScore: 25 });
  assert.equal(a.pick.suggestedScore, b.pick.suggestedScore);
  assert.equal(a.confidence, b.confidence);
});

// ─────────────────────────────────────────────────────────────────
// 待閱順序
// ─────────────────────────────────────────────────────────────────

test('被擋下的排最前面，然後是不穩的，然後才照信心排', () => {
  const rows = [
    { sortKey: 'S05', state: 'PENDING', proposal: { confidence: 0.9, unstable: false } },
    { sortKey: 'S01', state: 'PENDING', proposal: { confidence: 0.3, unstable: false } },
    { sortKey: 'S03', state: 'BLOCKED', proposal: null },
    { sortKey: 'S04', state: 'PENDING', proposal: { confidence: 0.8, unstable: true } },
    { sortKey: 'S02', state: 'ACCEPTED', proposal: { confidence: 0.2, unstable: false } },
  ];
  assert.deepEqual(
    sortForReview(rows).map((r) => r.sortKey),
    ['S03', 'S04', 'S01', 'S05', 'S02'],
  );
});

test('沒有建議（還沒請 AI 評）也排在前面——不改就沒有分數', () => {
  assert.ok(reviewPriority({ state: 'PENDING', proposal: null }) < 0);
  assert.ok(reviewPriority({ state: 'ACCEPTED', proposal: { confidence: 0 } }) > 1);
});

test('排序不改動輸入的陣列', () => {
  const rows = [
    { sortKey: 'B', state: 'PENDING', proposal: { confidence: 0.1 } },
    { sortKey: 'A', state: 'PENDING', proposal: { confidence: 0.9 } },
  ];
  sortForReview(rows);
  assert.equal(rows[0].sortKey, 'B');
});

// ─────────────────────────────────────────────────────────────────
// 老師的決定
// ─────────────────────────────────────────────────────────────────

test('打了與建議一樣的分數算「照建議給分」，不算「改了分數」', () => {
  assert.equal(decideState({ suggested: 18, final: 18 }), 'ACCEPTED');
  assert.equal(decideState({ suggested: 18, final: 15 }), 'ADJUSTED');
  assert.equal(decideState({ suggested: 18, final: 18, dismissed: true }), 'REJECTED');
  // 被擋下的建議沒有分數可以比，老師的分數一律算「不採用」。
  assert.equal(decideState({ suggested: null, final: 15 }), 'REJECTED');
});

test('改分與不採用要填理由，照建議給分不用', () => {
  assert.equal(checkDecision({ state: 'ACCEPTED', finalScore: 18 }).ok, true);
  assert.equal(checkDecision({ state: 'ADJUSTED', finalScore: 15 }).ok, false);
  assert.match(checkDecision({ state: 'ADJUSTED', finalScore: 15 }).error, /為什麼/);
  assert.equal(checkDecision({ state: 'ADJUSTED', finalScore: 15, note: '第三段其實有回應' }).ok, true);
  assert.equal(checkDecision({ state: 'REJECTED', finalScore: 15, note: '' }).ok, false);
  // 只標了面向、沒有寫字也算填了——那一筆對「哪個面向不準」的統計有用。
  assert.equal(checkDecision({ state: 'REJECTED', finalScore: 15, dimensions: ['組織'] }).ok, true);
});

test('已決定的狀態一定要有分數（與資料庫的 CHECK 同一條規則）', () => {
  assert.equal(checkDecision({ state: 'ACCEPTED', finalScore: null }).ok, false);
  assert.equal(checkDecision({ state: 'PENDING' }).ok, true);
  assert.equal(checkDecision({ state: '亂填' }).ok, false);
});

test('「哪個面向評不準」記在理由開頭，寫得進去也讀得回來', () => {
  const note = composeDecisionNote({ dimensions: ['組織', '字彙拼字'], note: '第二段有主題句' });
  const back = parseDecisionNote(note);
  assert.deepEqual(back.dimensions, ['組織', '字彙拼字']);
  assert.equal(back.note, '第二段有主題句');
});

test('沒有標面向時，理由原樣進出', () => {
  assert.equal(composeDecisionNote({ note: '算錯了' }), '算錯了');
  assert.deepEqual(parseDecisionNote('算錯了'), { dimensions: [], note: '算錯了' });
  assert.deepEqual(parseDecisionNote(null), { dimensions: [], note: '' });
});

test('面向名稱裡有分隔字元時丟掉那一個，不要把記法弄壞', () => {
  const note = composeDecisionNote({ dimensions: ['內容／組織', '文法'], note: 'x' });
  assert.deepEqual(parseDecisionNote(note).dimensions, ['文法']);
});

// ─────────────────────────────────────────────────────────────────
// 這個功能到底準不準
// ─────────────────────────────────────────────────────────────────

const decided = (state, suggested, final, note = '') => ({
  state,
  suggestedScore: suggested,
  finalScore: final,
  maxScore: 25,
  decisionNote: note,
});

test('採用率、平均誤差、被改最多的面向都算得出來', () => {
  const rows = [
    ...Array.from({ length: 12 }, () => decided('ACCEPTED', 18, 18)),
    ...Array.from({ length: 5 }, () =>
      decided('ADJUSTED', 18, 21, composeDecisionNote({ dimensions: ['組織'], note: '有主題句' })),
    ),
    ...Array.from({ length: 3 }, () =>
      decided('REJECTED', 10, 16, composeDecisionNote({ dimensions: ['組織', '內容'], note: '評錯了' })),
    ),
    { state: 'PENDING', suggestedScore: 12, finalScore: null, maxScore: 25 },
    { state: 'BLOCKED', suggestedScore: 12, finalScore: null, maxScore: 25, decisionNote: null },
  ];
  const r = accuracyReport(rows);
  assert.equal(r.decided, 20);
  assert.equal(r.PENDING, 1);
  assert.equal(r.BLOCKED, 1);
  assert.equal(r.adoptionRate, 0.6);
  // 誤差：5 筆差 3 分、3 筆差 6 分，其餘 0 → (15 + 18) / 20
  assert.equal(r.mae, 1.65);
  assert.equal(r.maeWhenChanged, 4.13);
  assert.equal(r.worstDimensions[0].name, '組織');
  assert.equal(r.worstDimensions[0].count, 8);
  assert.equal(r.untaggedChanges, 0);
  assert.equal(r.enough, true);
});

test('有號誤差看得出 AI 是偏嚴還是偏寬', () => {
  const strict = accuracyReport(Array.from({ length: 4 }, () => decided('ADJUSTED', 10, 14, 'x')));
  assert.ok(strict.bias > 0, 'AI 給得比老師低時，bias 應該是正的');
  const loose = accuracyReport(Array.from({ length: 4 }, () => decided('ADJUSTED', 20, 14, 'x')));
  assert.ok(loose.bias < 0);
});

test('樣本不足時不下判斷', () => {
  const r = accuracyReport([decided('ACCEPTED', 18, 18)]);
  assert.equal(r.enough, false);
  assert.match(r.verdict, /還看不出/);
  assert.ok(MIN_ACCURACY_SAMPLE >= 20);
});

test('採用率低時，判斷語要說出「建議關掉」', () => {
  const rows = [
    ...Array.from({ length: 6 }, () => decided('ACCEPTED', 18, 18)),
    ...Array.from({ length: 24 }, () => decided('ADJUSTED', 18, 10, 'x')),
  ];
  const r = accuracyReport(rows);
  assert.equal(r.adoptionRate, 0.2);
  assert.match(r.verdict, /關掉/);
});

test('老師沒標面向時，未標的筆數要一起回報', () => {
  const rows = Array.from({ length: 4 }, () => decided('ADJUSTED', 18, 12, '就是不對'));
  const r = accuracyReport(rows);
  assert.deepEqual(r.worstDimensions, []);
  assert.equal(r.untaggedChanges, 4);
});

test('一筆都沒有時不會炸，也不會回 0% 採用率', () => {
  const r = accuracyReport([]);
  assert.equal(r.total, 0);
  assert.equal(r.adoptionRate, null);
  assert.equal(r.mae, null);
});

// ─────────────────────────────────────────────────────────────────
// 規準本身
// ─────────────────────────────────────────────────────────────────

test('面向的滿分加起來要等於總分', () => {
  const bad = checkRubricDraft({
    name: '英文作文',
    totalScore: 20,
    mode: 'DIMENSION',
    dimensions: [
      { name: '內容', maxScore: 5 },
      { name: '組織', maxScore: 5 },
      { name: '文法', maxScore: 5 },
    ],
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /加起來是 15/.test(e)));
});

test('等第的分數帶不可以重疊，最高等第要接到總分，最低要從 0 起算', () => {
  const overlap = checkRubricDraft({
    name: '國寫',
    totalScore: 25,
    mode: 'BAND',
    bands: [
      { grade: 'A', scoreMin: 18, scoreMax: 25, descriptor: 'a' },
      { grade: 'B', scoreMin: 10, scoreMax: 19, descriptor: 'b' },
      { grade: '0', scoreMin: 0, scoreMax: 9, descriptor: 'c' },
    ],
  });
  assert.ok(overlap.errors.some((e) => /重疊/.test(e)));

  const short = checkRubricDraft({
    name: '國寫',
    totalScore: 25,
    mode: 'BAND',
    bands: [{ grade: 'A', scoreMin: 0, scoreMax: 20, descriptor: 'a' }],
  });
  assert.ok(short.errors.some((e) => /沒有人拿得到滿分/.test(e)));

  const noZero = checkRubricDraft({
    name: '國寫',
    totalScore: 25,
    mode: 'BAND',
    bands: [
      { grade: 'A', scoreMin: 10, scoreMax: 25, descriptor: 'a' },
      { grade: 'B', scoreMin: 1, scoreMax: 9, descriptor: 'b' },
    ],
  });
  assert.ok(noZero.errors.some((e) => /0 分起算/.test(e)));
});

test('沒有描述的等第要被擋下來——AI 與老師都用不到它', () => {
  const r = checkRubricDraft({
    name: '國寫',
    totalScore: 25,
    mode: 'BAND',
    bands: [{ grade: 'A', scoreMin: 0, scoreMax: 25, descriptor: '' }],
  });
  assert.ok(r.errors.some((e) => /沒有描述/.test(e)));
});

test('一次回全部的錯誤，不是只回第一個', () => {
  const r = checkRubricDraft({ name: '', totalScore: 0, mode: 'X' });
  assert.ok(r.errors.length >= 3, r.errors.join('｜'));
});

test('內建的每一個範本都通得過自己的驗證', () => {
  const templates = rubricTemplates();
  assert.ok(templates.length >= 3);
  for (const t of templates) {
    const r = checkRubricDraft(t.draft);
    assert.equal(r.ok, true, `${t.key}：${r.errors.join('｜')}`);
    assert.ok(RUBRIC_MODES.includes(t.draft.mode));
    // 每一個等第與面向都要有描述——範本的用途就是讓老師照著改，
    // 沒有描述的範本等於沒有範本。
    for (const b of t.draft.bands) assert.ok(b.descriptor.length > 8, `${t.key} 的 ${b.grade}`);
    for (const d of t.draft.dimensions) assert.ok(d.descriptor.length > 8, `${t.key} 的 ${d.name}`);
  }
});

test('範本的描述文字不可以與任何一份出版社原文一字不差——所以它們是自己寫的', () => {
  // 這一項驗不了「有沒有抄」，它驗的是**範本自己過得了照抄規準那一條**：
  // 一段照著範本的 descriptor 寫出來的理由會被 RUBRIC_LEAK 擋下，
  // 所以範本的文字確實有進到 leakSpans 裡——那是這個機制在運作的證據。
  const t = rubricTemplates()[0];
  const f = gradingFacts({
    question: { stem: STEM, score: 25 },
    rubric: { ...t.draft, dimensions: [], bands: t.draft.bands },
    answer: ANSWER,
  });
  assert.ok(f.leakSpans.length > 0);
  const leak = t.draft.bands[0].descriptor.slice(0, LEAK_SPAN + 2);
  const s = sample({ rationale: `${GOOD_REASON}${leak}` });
  assert.ok(codes(checkGradeProposal(s, f)).includes('RUBRIC_LEAK'));
});

test('正規化匯出得出來（折錯了的症狀是某一類永遠擋不到）', () => {
  assert.equal(normalizeForGrading('  ａｂｃ　'), 'abc');
  assert.equal(normalizeForGrading(null), '');
});
