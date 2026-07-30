/**
 * 個人申請落點模擬。
 *
 * # 這一支裡最重要的三組
 *
 * **一、篩選機制。** 規格書 §8.1 記著它第一版寫錯的地方：個申的篩選
 * 標準不是全國百分位門檻，而是「篩選科目的順序與倍率」，門檻級分由
 * 當年報名者池內生決定。所以模擬的基準是**學生查來的歷年實際門檻**，
 * 而倍率與名額不進入計算。順序錯了的症狀很具體：一位在第 1 關就被
 * 篩掉的學生會看到「你在第 3 關被篩掉」，那句話暗示他過了前兩關。
 *
 * **二、跨科相關性。** 六科獨立抽樣會**嚴重低估多科組合的變異**，而
 * 個申的篩選常常用到多科總級分。這裡有一條測試把同一組邊際分布分別
 * 用獨立與相關抽樣跑一次，然後斷言兩者的通過率**明顯不同**——如果
 * 有人日後把 copula 拿掉，那一條會紅。
 *
 * **三、可重現。** 學生會重整頁面。同樣的輸入給出不同的數字，比給出
 * 一個保守的數字更糟——他會一直重整到看到喜歡的那個。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { discretize } from '../lib/predict.mjs';
import {
  APPLY_WISH_LIMIT,
  CORR_FALLBACK_PENALTY,
  DEFAULT_CORRELATION,
  MIN_PAIRS_FOR_CORR,
  RELIABILITY_FLOOR,
  RELIABILITY_GOOD,
  STAGE_TWO_NOTE,
  TIER_HIGH_UNCERTAINTY,
  TIER_NORMAL,
  TIER_NO_ESTIMATE,
  buildWishSpecs,
  describeQualifyRule,
  estimateCorrelation,
  evaluateWish,
  mulberry32,
  parseQualifyText,
  parseSieveSubject,
  placementAdvicePayload,
  reliabilityOf,
  seedFrom,
  sieveRatioMaxOf,
  simulatePlacement,
} from '../lib/placement.mjs';
import { adviceFacts, checkAdvice } from '../lib/adviceGuard.mjs';

const YEAR = 115;
const NOW = new Date('2026-09-01T00:00:00.000Z');
const CODES = ['CHINESE', 'ENGLISH', 'MATH_A', 'SCIENCE'];

/** 一科的邊際分布，中心 `c`、標準差 `sd`。 */
const dist = (c, sd = 1.5) => discretize(c, sd, sd);

/** 六科都一樣的邊際分布。 */
const marginalsAt = (c, sd = 1.5, codes = CODES) =>
  Object.fromEntries(codes.map((k) => [k, dist(c, sd)]));

/** 相關性物件。`rho` 是各科共同因子解釋的變異比例。 */
const corr = (rho, codes = CODES, source = 'OWN') => ({
  loadings: Object.fromEntries(codes.map((k) => [k, Math.sqrt(rho)])),
  source,
  note: '',
  matrix: null,
  pairs: null,
});

/** 一個可靠度很好的志願規格（三年官方門檻）。 */
const goodReliability = () =>
  reliabilityOf({
    thresholds: [YEAR - 1, YEAR - 2, YEAR - 3].map((y) => ({
      year: y,
      staleAfterYear: y,
      sourceKind: 'OFFICIAL_DOC',
      lookedUpAt: '2026-08-20',
      grades: [12, 12],
    })),
    currentYear: YEAR,
    now: NOW,
  });

/** 一個志願規格。`stages` 與 `qualify` 直接給，繞過解析那一段。 */
const spec = (over = {}) => ({
  wishId: over.wishId ?? 'w1',
  rank: over.rank ?? 1,
  institutionName: over.institutionName ?? '臺灣大學',
  programName: over.programName ?? '資訊工程學系',
  stages: over.stages ?? [
    { label: '國文', subjects: ['CHINESE'], combo: false, threshold: 12, multiple: 3, raw: '國文' },
  ],
  qualify: over.qualify ?? [],
  reliability: over.reliability ?? goodReliability(),
  thresholdYears: over.thresholdYears ?? [YEAR - 1, YEAR - 2, YEAR - 3],
  thresholdRefs: over.thresholdRefs ?? [],
  problems: over.problems ?? [],
});

const run = (over = {}) =>
  simulatePlacement({
    marginals: marginalsAt(11),
    specs: [spec()],
    correlation: corr(0.4),
    draws: 4000,
    year: YEAR,
    now: NOW,
    ...over,
  });

// ═════════════════════════════════════════════════════════════════
// §1 科目文字的解析
// ═════════════════════════════════════════════════════════════════

test('單科的全稱與簡寫都認得', () => {
  assert.deepEqual(parseSieveSubject('國文').subjects, ['CHINESE']);
  assert.deepEqual(parseSieveSubject('數學A').subjects, ['MATH_A']);
  assert.deepEqual(parseSieveSubject('數A').subjects, ['MATH_A']);
  assert.deepEqual(parseSieveSubject('數學B').subjects, ['MATH_B']);
  assert.deepEqual(parseSieveSubject(' 自然 ').subjects, ['SCIENCE']);
  assert.equal(parseSieveSubject('數學A').combo, false);
});

test('★ 組合的科目是一個「總級分」，不是好幾關', () => {
  // 個申常寫「國英數A自四科總級分」。把它當成四關的話，每一科都要
  // 個別達到那個總分門檻——通過率會算成接近 0，而畫面上看起來正常。
  const p = parseSieveSubject('國英數A自四科總級分');
  assert.deepEqual(p.subjects, ['CHINESE', 'ENGLISH', 'MATH_A', 'SCIENCE']);
  assert.equal(p.combo, true);
  assert.deepEqual(parseSieveSubject('國＋英＋數A').subjects, ['CHINESE', 'ENGLISH', 'MATH_A']);
  assert.deepEqual(parseSieveSubject('國文、英文、數學B 總級分').subjects, [
    'CHINESE',
    'ENGLISH',
    'MATH_B',
  ]);
});

test('★ 只寫「數」的時候回「分不出來」，而不是猜一個', () => {
  // 數 A 與數 B 是兩份不同的卷子、兩個不同的級分。猜一個的話，一位
  // 只考數 B 的學生會被拿去比數 A 的門檻，而畫面上看不出任何異常。
  const p = parseSieveSubject('數');
  assert.equal(p.ambiguous, true);
  assert.deepEqual(p.subjects, []);
  // 「國英數自」這種常見的簡寫**同樣分不出來**，而它更危險：整格看起來
  // 完全正常，只有中間那一個字是歧義的。這一格必須被學生改成「數A」或
  // 「數B」，而不是由系統挑一個。
  const combo = parseSieveSubject('國英數自');
  assert.equal(combo.ambiguous, true);
  assert.deepEqual(combo.subjects, []);
});

test('看不懂的科目回空陣列，不會硬湊', () => {
  assert.deepEqual(parseSieveSubject('術科').subjects, []);
  assert.deepEqual(parseSieveSubject('').subjects, []);
  // 重複的科目代表抄錯了，不要靜靜去重。
  assert.deepEqual(parseSieveSubject('國國英').subjects, []);
});

// ═════════════════════════════════════════════════════════════════
// §2 檢定標準（五標換算）
// ═════════════════════════════════════════════════════════════════

test('檢定標準：五標加括號裡的級分', () => {
  const { rules } = parseQualifyText('數學A 均標(10)、英文 前標(12)');
  assert.equal(rules.length, 2);
  assert.deepEqual(
    rules.map((r) => [r.subjectCode, r.standard, r.grade]),
    [
      ['MATH_A', 'AVERAGE', 10],
      ['ENGLISH', 'FRONT', 12],
    ],
  );
  assert.match(describeQualifyRule(rules[0]), /數學A 均標（10 級分以上）/);
});

test('★ 只寫「數A均標」而沒有級分時標成無法判定，**不是當成通過**', () => {
  // 五標是全國百分位，換算成級分要查當年度大考中心的統計，而系統沒有
  // 那份表也不會去抓。靜靜當成通過的話，一位數 A 只有 7 級分的學生會
  // 看到一個含著「已通過檢定」的通過率，而他連報名資格都沒有。
  const { rules } = parseQualifyText('數學A均標');
  assert.equal(rules.length, 1);
  assert.equal(rules[0].grade, null);
  assert.equal(rules[0].standard, 'AVERAGE');
  assert.match(describeQualifyRule(rules[0]), /級分不明/);
});

test('在校成績的百分比門檻不是學測檢定標準，要跳過', () => {
  const { rules, unparsed } = parseQualifyText('在校成績前 20%、數學A 均標(10)');
  assert.equal(rules.length, 1);
  assert.equal(rules[0].subjectCode, 'MATH_A');
  assert.equal(unparsed.length, 0, '在校百分比不該被報成「看不懂」');
});

test('檢定標準寫成百分制的那一次，級分被丟掉而不是當成 78 級分', () => {
  const { rules } = parseQualifyText('數學A 均標(78)');
  assert.equal(rules[0].grade, null);
});

test('檢定標準只寫「數均標」時列進 ambiguous', () => {
  const { ambiguous, rules } = parseQualifyText('數均標(10)');
  assert.equal(rules.length, 0);
  assert.equal(ambiguous.length, 1);
});

// ═════════════════════════════════════════════════════════════════
// §3 判定：先檢定，再依序篩選
// ═════════════════════════════════════════════════════════════════

test('★ 檢定標準沒過就出局，而且理由不是「在第幾關被篩掉」', () => {
  // 制度上檢定在篩選之前：沒過檢定連報名資格都沒有。倒過來寫的話，
  // 一位檢定沒過的學生會看到「你在第 2 關被篩掉」，那句話暗示他過了檢定。
  const s = spec({
    qualify: [{ subjectCode: 'MATH_A', subjectLabel: '數學A', standard: 'FRONT', standardLabel: '前標', grade: 13, raw: '' }],
    stages: [{ label: '國文', subjects: ['CHINESE'], combo: false, threshold: 5, multiple: 3, raw: '國文' }],
  });
  const fail = evaluateWish({ CHINESE: 15, MATH_A: 8 }, s);
  assert.equal(fail.passed, false);
  assert.equal(fail.why, 'QUALIFY');
  assert.equal(fail.stage, null, '檢定不通過時不該指向任何一關篩選');
  assert.equal(evaluateWish({ CHINESE: 15, MATH_A: 13 }, s).passed, true);
});

test('★ 檢定標準過不了時，模擬的通過率是 0 而且說得出是檢定卡住', () => {
  const out = run({
    marginals: marginalsAt(8, 1),
    specs: [
      spec({
        qualify: [
          { subjectCode: 'MATH_A', subjectLabel: '數學A', standard: 'TOP', standardLabel: '頂標', grade: 14, raw: '' },
        ],
        stages: [{ label: '國文', subjects: ['CHINESE'], combo: false, threshold: 3, multiple: 3, raw: '國文' }],
      }),
    ],
  });
  const w = out.wishes[0];
  assert.ok(w.passRate < 0.02, `通過率是 ${w.passRate}`);
  assert.ok(w.qualifyFailRate > 0.95, `檢定不通過率是 ${w.qualifyFailRate}`);
  assert.ok(w.stages.every((s) => s.failRate < 0.05), '不該把責任推給篩選那幾關');
});

test('★ 篩選是**依序**的：擋掉的責任要記在第一個不過的那一關', () => {
  const stages = [
    { label: '國文', subjects: ['CHINESE'], combo: false, threshold: 14, multiple: 3, raw: '國文' },
    { label: '數學A', subjects: ['MATH_A'], combo: false, threshold: 3, multiple: 2, raw: '數學A' },
  ];
  const out = run({ marginals: marginalsAt(10, 1.2), specs: [spec({ stages })] });
  const w = out.wishes[0];
  assert.ok(w.stages[0].failRate > 0.9, `第 1 關應該擋掉大部分：${w.stages[0].failRate}`);
  assert.ok(w.stages[1].failRate < 0.02, `第 2 關幾乎不該擋到人：${w.stages[1].failRate}`);

  // 把順序倒過來，責任就換一關——這一條分得出「依序」與「全部一起看」。
  const swapped = run({
    marginals: marginalsAt(10, 1.2),
    specs: [spec({ stages: [stages[1], stages[0]] })],
  });
  assert.ok(swapped.wishes[0].stages[0].failRate < 0.02);
  assert.ok(swapped.wishes[0].stages[1].failRate > 0.9);
  // 通過率本身當然一樣（是同一組條件的交集）。
  assert.ok(Math.abs(swapped.wishes[0].passRate - w.passRate) < 0.03);
});

test('倍率不進計算，但超過學年度上限時要報出來', () => {
  // 門檻是查來的實際結果，倍率已經包在裡面了。倍率唯一的用途是偵測
  // 「抄的時候看錯了分則的哪一欄」。
  assert.equal(sieveRatioMaxOf(115), 3);
  assert.equal(sieveRatioMaxOf(116), 3);
  assert.equal(sieveRatioMaxOf(117), 4);

  const { specs } = buildWishSpecs({
    wishes: [{ id: 'w1', rank: 1, channel: 'APPLY', institutionName: '臺灣大學' }],
    references: [
      {
        kind: 'SIEVE_THRESHOLD',
        year: YEAR - 1,
        institutionName: '臺灣大學',
        value: { subjects: ['國文'], grades: [13], multiples: [6] },
        sourceKind: 'OFFICIAL_DOC',
        lookedUpAt: '2026-08-20',
        staleAfterYear: YEAR - 1,
      },
    ],
    year: YEAR,
    now: NOW,
  });
  assert.ok(specs[0].problems.some((p) => /倍率 6/.test(p) && /上限 3/.test(p)));
  // 但那一關仍然照樣進模擬——倍率抄錯不代表門檻也錯。
  assert.equal(specs[0].stages.length, 1);
});

// ═════════════════════════════════════════════════════════════════
// §4 跨科相關性（規格書 §8.2）
// ═════════════════════════════════════════════════════════════════

test('相關性從同一場考試的科目間殘差估出來', () => {
  // 五場考試，兩科同進同退 → 相關係數接近 1。
  const records = [];
  for (const [i, d] of [-2, -1, 0, 1, 2].entries()) {
    records.push({ subjectCode: 'CHINESE', examName: `模考${i}`, grade: 11 + d });
    records.push({ subjectCode: 'ENGLISH', examName: `模考${i}`, grade: 12 + d });
  }
  const c = estimateCorrelation({ records });
  assert.equal(c.source, 'OWN');
  assert.equal(c.estimatedPairs, 1);
  assert.ok(c.pairs[0].observed > 0.99, `相關係數 ${c.pairs[0].observed}`);
  assert.ok(c.loadings.CHINESE > 0.9);
  assert.match(c.note, /你自己/);
});

test('★ 配對用 examName 而不是日期（兩天考完的模考不該被拆成兩場）', () => {
  const records = [];
  for (let i = 0; i < 5; i += 1) {
    // 同一場模考，兩科在不同日期考。
    records.push({
      subjectCode: 'CHINESE',
      examName: `全模${i}`,
      examDate: new Date(2026, 3, 1 + i * 30),
      grade: 10 + i,
    });
    records.push({
      subjectCode: 'ENGLISH',
      examName: `全模${i}`,
      examDate: new Date(2026, 3, 2 + i * 30),
      grade: 10 + i,
    });
  }
  const c = estimateCorrelation({ records });
  assert.equal(c.pairs[0].commonExams, 5, '用日期配對的話這裡會是 0');
  assert.equal(c.source, 'OWN');
});

test('★ 場次不足時退回保守的預設值，而預設值刻意是正數不是 0', () => {
  // ρ 填 0 會把多科總和的變異數壓到最小，於是門檻在平均之上時通過率
  // 被低估——那是假的精確，而且方向對學生不利。
  assert.ok(DEFAULT_CORRELATION > 0);
  const records = [];
  for (let i = 0; i < MIN_PAIRS_FOR_CORR - 1; i += 1) {
    records.push({ subjectCode: 'CHINESE', examName: `模考${i}`, grade: 10 + i });
    records.push({ subjectCode: 'ENGLISH', examName: `模考${i}`, grade: 12 - i });
  }
  const c = estimateCorrelation({ records });
  assert.equal(c.source, 'DEFAULT');
  assert.equal(c.pairs[0].fallback, true);
  assert.equal(c.pairs[0].used, DEFAULT_CORRELATION);
  assert.match(c.note, /低估/);
  assert.match(c.note, /可靠度/);
});

test('某一科級分完全沒變時回「算不出來」，不是回 0', () => {
  const records = [];
  for (let i = 0; i < 5; i += 1) {
    records.push({ subjectCode: 'CHINESE', examName: `模考${i}`, grade: 11 });
    records.push({ subjectCode: 'ENGLISH', examName: `模考${i}`, grade: 10 + i });
  }
  const c = estimateCorrelation({ records });
  assert.equal(c.pairs[0].observed, null);
  assert.equal(c.pairs[0].fallback, true);
});

test('負相關被夾到 0（單因子表達不出負相關，硬塞會變成 NaN）', () => {
  const records = [];
  for (const [i, d] of [-2, -1, 0, 1, 2].entries()) {
    records.push({ subjectCode: 'CHINESE', examName: `模考${i}`, grade: 11 + d });
    records.push({ subjectCode: 'ENGLISH', examName: `模考${i}`, grade: 11 - d });
  }
  const c = estimateCorrelation({ records });
  assert.ok(c.pairs[0].observed < -0.9);
  assert.equal(c.loadings.CHINESE, 0);
  assert.ok(Number.isFinite(c.loadings.ENGLISH));
});

test('★ 獨立抽樣與相關抽樣在多科組合上看得出差別（§8.2 的核心）', () => {
  // 四科總級分，門檻設在平均之上。四科獨立時總和的標準差是 2σ，
  // 完全相關時是 4σ——同一個門檻算出來的通過率會差好幾倍。
  const stages = [
    {
      label: '國＋英＋數A＋自然 總級分',
      subjects: CODES,
      combo: true,
      threshold: 50,
      multiple: null,
      raw: '國英數自總級分',
    },
  ];
  const shared = { marginals: marginalsAt(11, 1.5), specs: [spec({ stages })], draws: 20_000 };
  const independent = run({ ...shared, correlation: corr(0) });
  const correlated = run({ ...shared, correlation: corr(0.6) });

  const a = independent.wishes[0].passRate;
  const b = correlated.wishes[0].passRate;
  assert.ok(a > 0 && b > 0, `兩邊都要抽得到：獨立 ${a}、相關 ${b}`);
  assert.ok(
    b > a * 1.5,
    `相關抽樣的尾巴要明顯更厚（獨立 ${a}、相關 ${b}）——差不出來就是 copula 沒有生效`,
  );
});

test('★ 「至少通過一個」從抽樣直接數，不是 1 − Π(1 − p)', () => {
  // 六個志願共用同一組級分：數學考壞的那一天，用到數學的志願會一起
  // 失手。獨立公式會**高估**「至少通過一個」，而那正是學生最想聽到的
  // 方向。兩個數字都回報，差距本身就是相關性的份量。
  const stages = (t) => [
    { label: '數學A', subjects: ['MATH_A'], combo: false, threshold: t, multiple: 3, raw: '數學A' },
  ];
  const specs = [12, 12, 12, 12, 12, 12].map((t, i) =>
    spec({ wishId: `w${i}`, rank: i + 1, institutionName: `大學${i}`, stages: stages(t) }),
  );
  const out = run({ marginals: marginalsAt(11, 1.5), specs, correlation: corr(0.9), draws: 20_000 });
  assert.ok(out.combo.atLeastOne < out.combo.independentAtLeastOne - 0.1);
  // 六個一模一樣的志願共用同一科：實際上要嘛全過要嘛全不過。
  assert.ok(Math.abs(out.combo.atLeastOne - out.wishes[0].passRate) < 0.02);
});

// ═════════════════════════════════════════════════════════════════
// §5 可靠度三檔（規格書 §8.4）
// ═════════════════════════════════════════════════════════════════

test('沒有任何門檻資料時可靠度是 0，而且說得出去哪裡查', () => {
  const r = reliabilityOf({ thresholds: [], currentYear: YEAR, now: NOW });
  assert.equal(r.score, 0);
  assert.equal(r.tier, TIER_NO_ESTIMATE);
  assert.ok(r.notes.some((n) => /歷年篩選標準查詢/.test(n)));
});

test('★ 三年官方門檻且穩定 → 正常呈現', () => {
  const r = goodReliability();
  assert.ok(r.score > RELIABILITY_GOOD, `可靠度 ${r.score}`);
  assert.equal(r.tier, TIER_NORMAL);
  // 第四個因子小於 1，而它小於 1 的理由就是跨年度難度校正沒做。
  assert.equal(r.factors.yearCalibration, 0.9);
});

test('★ 只有一年的官方門檻 → 進模擬但標「不確定性較高」', () => {
  const r = reliabilityOf({
    thresholds: [
      { year: YEAR - 1, staleAfterYear: YEAR - 1, sourceKind: 'OFFICIAL_DOC', lookedUpAt: '2026-08-20', grades: [12] },
    ],
    currentYear: YEAR,
    now: NOW,
  });
  assert.ok(r.score >= RELIABILITY_FLOOR && r.score < RELIABILITY_GOOD, `可靠度 ${r.score}`);
  assert.equal(r.tier, TIER_HIGH_UNCERTAINTY);
  assert.ok(r.notes.some((n) => /一年看不出/.test(n)));
});

test('★ 聽同學說的一筆 → 低於 0.4，不進模擬', () => {
  const r = reliabilityOf({
    thresholds: [
      { year: YEAR - 2, staleAfterYear: YEAR - 2, sourceKind: 'HEARSAY', lookedUpAt: '2026-08-20', grades: [12] },
    ],
    currentYear: YEAR,
    now: NOW,
  });
  assert.ok(r.score < RELIABILITY_FLOOR, `可靠度 ${r.score}`);
  assert.equal(r.tier, TIER_NO_ESTIMATE);
});

test('門檻年年在跳的校系，可靠度要降下來', () => {
  const stable = goodReliability();
  const jumpy = reliabilityOf({
    thresholds: [
      { year: YEAR - 1, staleAfterYear: YEAR - 1, sourceKind: 'OFFICIAL_DOC', lookedUpAt: '2026-08-20', grades: [14] },
      { year: YEAR - 2, staleAfterYear: YEAR - 2, sourceKind: 'OFFICIAL_DOC', lookedUpAt: '2026-08-20', grades: [10] },
      { year: YEAR - 3, staleAfterYear: YEAR - 3, sourceKind: 'OFFICIAL_DOC', lookedUpAt: '2026-08-20', grades: [13] },
    ],
    currentYear: YEAR,
    now: NOW,
  });
  assert.ok(jumpy.score < stable.score);
  assert.ok(jumpy.notes.some((n) => /跳動/.test(n)));
});

test('★ 相關性退回預設值時，可靠度要跟著折扣（§8.2 要求反映在信心標示）', () => {
  const own = goodReliability();
  const fallback = reliabilityOf({
    thresholds: [YEAR - 1, YEAR - 2, YEAR - 3].map((y) => ({
      year: y,
      staleAfterYear: y,
      sourceKind: 'OFFICIAL_DOC',
      lookedUpAt: '2026-08-20',
      grades: [12, 12],
    })),
    currentYear: YEAR,
    now: NOW,
    correlationSource: 'DEFAULT',
  });
  assert.ok(Math.abs(fallback.score - own.score * CORR_FALLBACK_PENALTY) < 0.002);
  assert.ok(fallback.notes.some((n) => /相關性/.test(n)));
});

test('★ 可靠度低於 0.4 的志願不進模擬，但已知的門檻要列出來', () => {
  const weak = reliabilityOf({
    thresholds: [
      { year: YEAR - 2, staleAfterYear: YEAR - 2, sourceKind: 'HEARSAY', lookedUpAt: '2026-08-20', grades: [12] },
    ],
    currentYear: YEAR,
    now: NOW,
  });
  const out = run({
    specs: [
      spec({
        reliability: weak,
        thresholdYears: [YEAR - 2],
        thresholdRefs: [{ year: YEAR - 2, subjects: ['國文'], grades: [12], sourceLabel: '聽同學說的、網路論壇、坊間工具', lookedUpAt: '2026-08-20' }],
      }),
    ],
  });
  const w = out.wishes[0];
  assert.equal(w.passRate, null, '無法估計時不可以有數字');
  assert.equal(w.tier, TIER_NO_ESTIMATE);
  assert.equal(w.tierLabel, '無法估計');
  assert.ok(w.thresholdRefs.length === 1, '已知的門檻仍然要列出來供學生自行判斷');
  assert.ok(w.notes.some((n) => /不會拿相近校系的數字推估/.test(n)));
});

test('★ 用到的科目級分資料不足時也是「無法估計」，而不是給一個假分布', () => {
  const out = run({
    // 只有國文有分布；志願用到數學A。
    marginals: { CHINESE: dist(11) },
    specs: [
      spec({
        stages: [
          { label: '數學A', subjects: ['MATH_A'], combo: false, threshold: 10, multiple: 3, raw: '數學A' },
        ],
      }),
    ],
  });
  const w = out.wishes[0];
  assert.equal(w.passRate, null);
  assert.equal(w.tier, TIER_NO_ESTIMATE);
  assert.ok(w.notes.some((n) => /資料不足/.test(n) && /數學A/.test(n)));
  assert.deepEqual(out.missingSubjects, ['MATH_A']);
});

test('沒有任何篩選門檻的志願也是「無法估計」', () => {
  const out = run({ specs: [spec({ stages: [], reliability: goodReliability() })] });
  assert.equal(out.wishes[0].passRate, null);
  assert.ok(out.wishes[0].notes.some((n) => /沒有可用的篩選門檻/.test(n)));
});

// ═════════════════════════════════════════════════════════════════
// §6 可重現
// ═════════════════════════════════════════════════════════════════

test('PRNG 是確定性的，而且兩個種子給不同的序列', () => {
  const a = mulberry32(seedFrom('abc'));
  const b = mulberry32(seedFrom('abc'));
  const c = mulberry32(seedFrom('abd'));
  const first = [a(), a(), a()];
  assert.deepEqual(first, [b(), b(), b()]);
  assert.notDeepEqual(first, [c(), c(), c()]);
  for (const v of first) assert.ok(v >= 0 && v < 1);
});

test('★ 同樣的輸入給同樣的結果（學生會重整頁面）', () => {
  const input = {
    marginals: marginalsAt(11),
    specs: [spec(), spec({ wishId: 'w2', rank: 2, institutionName: '清華大學' })],
    correlation: corr(0.5),
    draws: 3000,
    year: YEAR,
    now: NOW,
  };
  const a = simulatePlacement(input);
  const b = simulatePlacement(input);
  assert.deepEqual(a, b);
  // 種子由輸入本身推出來，所以不必依賴呼叫端記得傳同一個種子。
  assert.ok(Number.isInteger(a.seed));
  // 而把種子傳回去照樣重現得出來。
  const c = simulatePlacement({ ...input, seed: a.seed });
  assert.equal(c.wishes[0].passRate, simulatePlacement({ ...input, seed: a.seed }).wishes[0].passRate);
});

test('★ 輸入變了結果才會變，而且變的是哪一項說得出來', () => {
  const base = {
    marginals: marginalsAt(11),
    specs: [spec()],
    correlation: corr(0.5),
    draws: 3000,
    year: YEAR,
    now: NOW,
  };
  const a = simulatePlacement(base);
  // 門檻改了一級 → 種子與通過率都跟著變。這就是「上週 60%、現在 45%」
  // 的答案：不是程式在跳，是輸入不一樣了。
  const b = simulatePlacement({
    ...base,
    specs: [spec({ stages: [{ label: '國文', subjects: ['CHINESE'], combo: false, threshold: 13, multiple: 3, raw: '國文' }] })],
  });
  assert.notEqual(a.seed, b.seed);
  assert.ok(b.wishes[0].passRate < a.wishes[0].passRate);
});

// ═════════════════════════════════════════════════════════════════
// §7 組合分析（規格書 §8.3）
// ═════════════════════════════════════════════════════════════════

/** 六個志願，門檻都是 `t`。 */
const sixAt = (t) =>
  Array.from({ length: 6 }, (_, i) =>
    spec({
      wishId: `w${i}`,
      rank: i + 1,
      institutionName: `大學${i}`,
      stages: [{ label: '國文', subjects: ['CHINESE'], combo: false, threshold: t, multiple: 3, raw: '國文' }],
    }),
  );

test('★ 六個志願全在衝刺區時要主動提示', () => {
  const out = run({ marginals: marginalsAt(9, 1.2), specs: sixAt(13), draws: 8000 });
  assert.equal(out.combo.estimated, 6);
  assert.equal(out.combo.tiers.sprint.length, 6);
  assert.equal(out.combo.tiers.safe.length, 0);
  const codes = out.combo.warnings.map((w) => w.code);
  assert.ok(codes.includes('ALL_SPRINT'), `警告是 ${codes.join('、')}`);
  const all = out.combo.warnings.find((w) => w.code === 'ALL_SPRINT');
  assert.match(all.text, /至少通過一個/);
  // 「六個都沒過」的機率要說出來，而不是只說「全部都是衝刺」。
  assert.ok(out.combo.passCountDistribution[0].p > 0);
});

test('風險分層照 30% 與 70% 切', () => {
  const easy = run({ marginals: marginalsAt(13, 1.2), specs: sixAt(9), draws: 8000 });
  assert.equal(easy.combo.tiers.safe.length, 6);
  assert.ok(easy.combo.atLeastOne > 0.9);
  assert.ok(!easy.combo.warnings.some((w) => w.code === 'ALL_SPRINT'));
  assert.ok(!easy.combo.warnings.some((w) => w.code === 'NO_SAFE'));
});

test('「至少通過一個」低於一半時要提示', () => {
  const out = run({ marginals: marginalsAt(8, 1), specs: sixAt(13), draws: 8000 });
  assert.ok(out.combo.atLeastOne < 0.5);
  assert.ok(out.combo.warnings.some((w) => w.code === 'LOW_AT_LEAST_ONE'));
});

test('★ 無法估計的志願不算成 0，也不算成保底', () => {
  const weak = reliabilityOf({
    thresholds: [{ year: YEAR - 2, staleAfterYear: YEAR - 2, sourceKind: 'HEARSAY', lookedUpAt: '2026-08-20', grades: [12] }],
    currentYear: YEAR,
    now: NOW,
  });
  const specs = [...sixAt(9).slice(0, 3), ...sixAt(9).slice(3).map((s) => ({ ...s, reliability: weak }))];
  const out = run({ marginals: marginalsAt(13, 1.2), specs, draws: 6000 });
  assert.equal(out.combo.estimated, 3);
  assert.equal(out.combo.excluded, 3);
  // 期望通過數只加算得出機率的那幾個。
  assert.ok(out.combo.expectedPasses <= 3.001);
  const note = out.combo.warnings.find((w) => w.code === 'EXCLUDED');
  assert.ok(note, '要明說有幾個志願沒有進模擬');
  assert.match(note.text, /當成 0/);
});

test('超過六個志願要提示（制度上只能送六個）', () => {
  const out = run({ marginals: marginalsAt(11), specs: sixAt(10).concat(sixAt(10)[0]), draws: 2000 });
  assert.equal(APPLY_WISH_LIMIT, 6);
  assert.ok(out.combo.warnings.some((w) => w.code === 'OVER_LIMIT'));
});

test('★ 每一次模擬都帶著「通過第一階段 ≠ 錄取」', () => {
  const out = run();
  assert.equal(out.stageTwoNote, STAGE_TWO_NOTE);
  assert.match(out.stageTwoNote, /不是錄取機率/);
  assert.match(out.stageTwoNote, /第二階段本系統不做任何機率預測/);
});

// ═════════════════════════════════════════════════════════════════
// §8 從志願與參考資料組出規格
// ═════════════════════════════════════════════════════════════════

const sieveRef = (over = {}) => ({
  kind: 'SIEVE_THRESHOLD',
  year: YEAR - 1,
  institutionName: '臺灣大學',
  programName: '資訊工程學系',
  value: { subjects: ['國文', '數學A'], grades: [13, 12] },
  sourceKind: 'OFFICIAL_DOC',
  lookedUpAt: '2026-08-20',
  staleAfterYear: YEAR - 1,
  ...over,
});

test('門檻掛到對應的志願上，異體字算同一所', () => {
  const { specs } = buildWishSpecs({
    wishes: [{ id: 'w1', rank: 1, channel: 'APPLY', institutionName: '台灣大學', programName: '資訊工程學系' }],
    references: [sieveRef()],
    year: YEAR,
    now: NOW,
  });
  assert.equal(specs.length, 1);
  assert.equal(specs[0].stages.length, 2);
  assert.deepEqual(specs[0].stages.map((s) => s.subjects[0]), ['CHINESE', 'MATH_A']);
  assert.deepEqual(specs[0].stages.map((s) => s.threshold), [13, 12]);
});

test('★ 篩選科目的順序與門檻取**最新那一年**，不平均', () => {
  // 把三年的級分平均起來會產生一個沒有任何一年真的長這樣的門檻，
  // 而那個數字看起來比三個真實的數字更精確。
  const { specs } = buildWishSpecs({
    wishes: [{ id: 'w1', rank: 1, channel: 'APPLY', institutionName: '臺灣大學', programName: '資訊工程學系' }],
    references: [
      sieveRef({ year: YEAR - 3, value: { subjects: ['國文', '數學A'], grades: [10, 9] } }),
      sieveRef({ year: YEAR - 1, value: { subjects: ['國文', '數學A'], grades: [13, 12] } }),
      sieveRef({ year: YEAR - 2, value: { subjects: ['國文', '數學A'], grades: [11, 11] } }),
    ],
    year: YEAR,
    now: NOW,
  });
  assert.deepEqual(specs[0].stages.map((s) => s.threshold), [13, 12]);
  assert.deepEqual(specs[0].thresholdYears, [YEAR - 1, YEAR - 2, YEAR - 3]);
  // 但三年都算進可靠度（穩定度靠它們）。
  assert.equal(specs[0].reliability.years.length, 3);
});

test('★ 對不上任何志願的門檻要列出來，不是靜靜吞掉', () => {
  // 最常見的原因是他在比較一個還沒填成志願的校系（那是好事），
  // 第二常見的是校名打錯。吞掉的症狀是「我輸入的資料不見了」。
  const { specs, unmatched } = buildWishSpecs({
    wishes: [{ id: 'w1', rank: 1, channel: 'APPLY', institutionName: '清華大學' }],
    references: [sieveRef()],
    year: YEAR,
    now: NOW,
  });
  assert.equal(specs[0].stages.length, 0);
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].institutionName, '臺灣大學');
});

test('只看個人申請的志願，繁星那幾個不進來', () => {
  const { specs } = buildWishSpecs({
    wishes: [
      { id: 'w1', rank: 1, channel: 'STAR', institutionName: '臺灣大學' },
      { id: 'w2', rank: 1, channel: 'APPLY', institutionName: '臺灣大學', programName: '資訊工程學系' },
    ],
    references: [sieveRef()],
    year: YEAR,
    now: NOW,
  });
  assert.equal(specs.length, 1);
  assert.equal(specs[0].wishId, 'w2');
});

test('門檻抄成百分比時那一關被擋掉並報出來', () => {
  const { specs } = buildWishSpecs({
    wishes: [{ id: 'w1', rank: 1, channel: 'APPLY', institutionName: '臺灣大學' }],
    references: [sieveRef({ value: { subjects: ['國文'], grades: [65] } })],
    year: YEAR,
    now: NOW,
  });
  assert.equal(specs[0].stages.length, 0);
  assert.ok(specs[0].problems.some((p) => /不是一個合理的級分/.test(p)));
});

test('組合的門檻上限是科目數乘 15，不是 15', () => {
  const { specs } = buildWishSpecs({
    wishes: [{ id: 'w1', rank: 1, channel: 'APPLY', institutionName: '臺灣大學' }],
    references: [sieveRef({ value: { subjects: ['國英數A自'], grades: [50] } })],
    year: YEAR,
    now: NOW,
  });
  assert.equal(specs[0].problems.length, 0, specs[0].problems.join('；'));
  assert.equal(specs[0].stages[0].combo, true);
  assert.equal(specs[0].stages[0].threshold, 50);
  assert.match(specs[0].stages[0].label, /總級分/);
});

test('★ 同一科有兩條檢定標準時取最嚴的那一條', () => {
  // 兩筆資料寫了不同的檢定標準，代表其中一筆抄錯或年度不同。往嚴的
  // 方向倒不會讓學生誤以為自己過了一個其實沒過的門檻。
  const { specs } = buildWishSpecs({
    wishes: [{ id: 'w1', rank: 1, channel: 'APPLY', institutionName: '臺灣大學' }],
    references: [
      sieveRef(),
      { ...sieveRef(), kind: 'QUALIFY', value: { rules: '數學A 均標(10)' } },
      { ...sieveRef(), kind: 'QUALIFY', value: { rules: '數學A 前標(12)' } },
    ],
    year: YEAR,
    now: NOW,
  });
  assert.equal(specs[0].qualify.length, 1);
  assert.equal(specs[0].qualify[0].grade, 12);
});

test('檢定標準沒有級分時列成 problem，說得出去哪裡查', () => {
  const { specs } = buildWishSpecs({
    wishes: [{ id: 'w1', rank: 1, channel: 'APPLY', institutionName: '臺灣大學' }],
    references: [sieveRef(), { ...sieveRef(), kind: 'QUALIFY', value: { rules: '數學A均標' } }],
    year: YEAR,
    now: NOW,
  });
  assert.ok(specs[0].problems.some((p) => /無法判定/.test(p) && /大考中心/.test(p)));
});

// ═════════════════════════════════════════════════════════════════
// §9 與 adviceGuard 的共存
//
// 機率只走確定性的那條路，AI 的文字裡永遠不出現機率。
// ═════════════════════════════════════════════════════════════════

test('★ 即使把模擬算出來的數字加進白名單，AI 寫「通過機率 68%」照樣被擋', () => {
  // 這一條是整個共存設計的支點。`checkAdvice` 的 ODDS_PREDICTION 擋的是
  // 「機率詞 + 數字」這個**句型**，與那個數字有沒有來源無關——所以
  // 「把模擬的數字加進白名單就可以讓 AI 講」這條路走不通。
  //
  // 那不是閘門的缺陷，是它的設計：一段由模型寫出來、含著機率的句子，
  // 讀者沒有辦法分辨它是抄來的還是編的。
  const facts = adviceFacts({ numbers: ['68'], references: [], thresholds: [] });
  const verdict = checkAdvice('依這次的模擬，你通過第一階段的機率是 68%。', facts);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.fabricated, true);
  assert.ok(verdict.violations.some((v) => v.code === 'ODDS_PREDICTION'));
});

test('★ 要送給 AI 的落點脈絡裡沒有任何機率', () => {
  const out = run({ marginals: marginalsAt(9, 1.2), specs: sixAt(13), draws: 4000 });
  const payload = placementAdvicePayload(out);
  const json = JSON.stringify(payload);

  for (const key of ['passRate', 'atLeastOne', 'expectedPasses', 'failRate', 'risk', 'reliability']) {
    assert.ok(!json.includes(key), `脈絡裡出現了 ${key}`);
  }
  // 逐志願的通過率一個都不能出現（連字串形式也不行）。
  for (const w of out.wishes) {
    if (w.passRate === null) continue;
    assert.ok(!json.includes(String(w.passRate)), `${w.institutionName} 的通過率洩漏到脈絡裡了`);
  }
  // 該有的東西要在：資料的樣子、缺什麼、以及第二階段的界線。
  assert.equal(payload.wishes.length, 6);
  assert.ok(payload.wishes.every((w) => typeof w.data_tier === 'string'));
  assert.ok(payload.wishes.every((w) => Array.isArray(w.sieve_subjects)));
  assert.equal(payload.stage_two_note, STAGE_TWO_NOTE);
});

test('落點的機率是一個數字，而且旁邊一定有它的資料基礎', () => {
  // 確定性通道帶著自己的脈絡：哪幾年、什麼來源、可靠度分數、查詢日期。
  // 那幾樣東西是計算的一部分，不是文案。
  const out = run({
    specs: [
      spec({
        thresholdRefs: [
          { year: YEAR - 1, subjects: ['國文'], grades: [12], sourceLabel: '官方文件', lookedUpAt: '2026-08-20' },
        ],
      }),
    ],
  });
  const w = out.wishes[0];
  assert.equal(typeof w.passRate, 'number');
  assert.equal(typeof w.reliability.score, 'number');
  assert.ok(w.thresholdYears.length > 0);
  assert.ok(w.thresholdRefs[0].sourceLabel);
  assert.ok(w.thresholdRefs[0].lookedUpAt);
  // 而且輸入快照重現得出同一個數字（種子在結果裡）。
  assert.ok(Number.isInteger(out.seed));
});
