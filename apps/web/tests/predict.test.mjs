/**
 * 級分預測與校準。
 *
 * # 這一支在防什麼
 *
 * 級分預測的失效方式與這個專案裡其他東西不同：**它不會當機，它會給出
 * 一個看起來很專業的數字。** 一位學生看到「數學 A 預估 11 至 13 級分，
 * 信心 70%」會照著它決定要不要填某個志願，而那是一個不可逆的決定。
 *
 * 所以這裡測的不是「函式回了東西」，而是幾條**方向性的不變量**：
 *
 *   · 資料不足時**不給區間**（不是給一個寬一點的區間）
 *   · 成績波動大 → 區間一定更寬
 *   · 趨勢向上 → 區間一定往上，但不會外插到荒謬
 *   · 距考試越遠 → 區間越寬，而且**往上的空間比往下多**
 *   · 區間**永遠不是一個級分**，信心**永遠小於 1**
 *   · 校準曲線在小樣本時**不告警**
 *
 * 每一條都是「算得出數字但方向錯了」的那種錯，而它們在畫面上全都
 * 看起來正常。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CALIB_ALERT_MARGIN,
  DEFAULT_CONFIDENCE,
  GRADE_MAX,
  MAX_CONFIDENCE,
  SOURCE_UNCERTAINTY,
  THIN_MIN_RECORDS,
  calibrationCurve,
  discretize,
  gsatDateOf,
  gsatPassed,
  intervalOf,
  marginalsFor,
  normalCdf,
  predictAll,
  predictGrade,
  splitNormalCdf,
  upcomingGsatYear,
  wilsonInterval,
} from '../lib/predict.mjs';

/** 115 學年度的學測在民國 116 年（西元 2027）1 月。 */
const EXAM = new Date('2027-01-20T00:00:00.000Z');
const NOW = new Date('2026-09-01T00:00:00.000Z');

/** 一次模考。日期用「距離 `EXAM` 幾個月」表示，讀起來比絕對日期清楚。 */
function mock(monthsBeforeExam, grade, source = 'EXTERNAL_MOCK') {
  const d = new Date(EXAM.getTime() - monthsBeforeExam * 30.4375 * 86_400_000);
  return {
    subjectCode: 'MATH_A',
    examName: `模考 ${monthsBeforeExam} 個月前`,
    examDate: d,
    grade,
    source,
  };
}

const predict = (records, over = {}) =>
  predictGrade({ subjectCode: 'MATH_A', records, examDate: EXAM, now: NOW, ...over });

const width = (p) => p.interval.high - p.interval.low;

// ═════════════════════════════════════════════════════════════════
// §1 常態分布的兩支
// ═════════════════════════════════════════════════════════════════

test('normalCdf 對得上幾個已知值', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-9);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-4);
  assert.ok(Math.abs(normalCdf(-1.96) - 0.025) < 1e-4);
  assert.ok(Math.abs(normalCdf(1) - 0.8413) < 1e-4);
});

test('兩片式常態：眾數以下的機率就是 σ_down/(σ_down+σ_up)', () => {
  // 這一行是「分布偏向上方」在數字上的意思。σ_up 大於 σ_down 時，
  // 眾數以下的總機率小於一半——右尾比左尾厚。
  const below = splitNormalCdf(10, 10, 1, 2);
  assert.ok(Math.abs(below - 1 / 3) < 1e-9, `眾數以下應該是 1/3，得到 ${below}`);
  // 兩片相等時退化成普通常態。
  assert.ok(Math.abs(splitNormalCdf(10, 10, 1.5, 1.5) - 0.5) < 1e-9);
  assert.ok(splitNormalCdf(-99, 10, 1, 2) < 1e-9);
  assert.ok(splitNormalCdf(99, 10, 1, 2) > 1 - 1e-9);
});

test('離散化之後總機率是 1，而且兩端把尾巴收進端點', () => {
  const d = discretize(14.6, 1.2, 1.5);
  const sum = d.reduce((a, x) => a + x.p, 0);
  assert.ok(Math.abs(sum - 1) < 1e-5, `總和是 ${sum}`);
  assert.equal(d.length, 16);
  // 期望值 14.6 的學生**很有機會考 15**，而他不可能考 16。切掉再正規化
  // 會把那份機率攤回中間，於是高分群的區間被往下拉——而受影響的正是
  // 最可能拿這個數字去填志願的那幾個學生。
  assert.ok(d[15].p > 0.35, `15 級分只有 ${d[15].p}`);
});

// ═════════════════════════════════════════════════════════════════
// §2 樣本不足
// ═════════════════════════════════════════════════════════════════

test('完全沒有記錄時不是「預測失敗」，是「還沒有東西可以預測」', () => {
  const p = predict([]);
  assert.equal(p.available, false);
  assert.equal(p.interval, null);
  assert.equal(p.distribution, null);
  assert.match(p.reason, /還沒有任何級分記錄/);
  // 訊息要說得出下一步是什麼。「無法預測」是一條死路。
  assert.match(p.reason, /模考成績單|輸入/);
});

test('★ 只考過一次：標成 thin，而且**不給區間**', () => {
  const p = predict([mock(3, 12)]);
  assert.equal(p.thin, true);
  assert.equal(p.interval, null, '樣本不足時硬給一個區間，那個寬度來自預設值而不是他的成績');
  assert.equal(p.distribution, null);
  assert.match(p.reason, /資料不足/);
  assert.match(p.reason, /不可靠/);
});

test('★ 兩次剛好同分不會變成一個寬度 0 的區間', () => {
  // 這是門檻設在 3 的直接理由：兩次都考 12，觀測到的離散是 0，
  // 於是區間會窄到只有一級——一個看起來極精確的錯誤。
  const p = predict([mock(4, 12), mock(2, 12)]);
  assert.equal(p.thin, true);
  assert.equal(p.interval, null);
});

test(`${THIN_MIN_RECORDS} 次之後才開始給區間`, () => {
  const p = predict([mock(5, 11), mock(3, 12), mock(1, 12)]);
  assert.equal(p.thin, false);
  assert.ok(p.interval);
  assert.ok(p.distribution.length === 16);
});

test('級分填成百分制的那一筆被丟掉並記下來', () => {
  const bad = { ...mock(3, 12), grade: 78 };
  const p = predict([mock(5, 11), mock(4, 12), mock(2, 12), bad]);
  assert.equal(p.basis.records, 3, '78 那一筆不該進來');
  assert.equal(p.basis.rejected.length, 1);
  assert.equal(p.basis.rejected[0].grade, 78);
});

// ═════════════════════════════════════════════════════════════════
// §3 四個不確定性來源，每一個都要看得出效果
// ═════════════════════════════════════════════════════════════════

test('四個來源在 basis 裡各有自己的數字（合成一個 σ 就分不出誰估錯了）', () => {
  const p = predict([mock(6, 10), mock(4, 11), mock(2, 12)]);
  assert.deepEqual(Object.keys(p.basis.variance).sort(), ['diff', 'disp', 'drift', 'scale']);
  for (const [k, v] of Object.entries(p.basis.variance)) {
    assert.ok(Number.isFinite(v) && v >= 0, `${k} 是 ${v}`);
  }
  assert.ok(p.basis.variance.disp > 0, '離散程度那一項不可能是 0（有先驗）');
});

test('★ 成績波動大 → 區間更寬', () => {
  const steady = predict([mock(5, 11), mock(4, 11), mock(3, 11), mock(2, 11), mock(1, 11)]);
  const swingy = predict([mock(5, 8), mock(4, 14), mock(3, 8), mock(2, 14), mock(1, 11)]);
  assert.ok(
    width(swingy) > width(steady),
    `波動大的應該更寬：${width(swingy)} vs ${width(steady)}`,
  );
  assert.ok(swingy.basis.variance.disp > steady.basis.variance.disp);
});

test('★ 全部是校內模考時區間更寬（級距本身不可靠，文件 A.2）', () => {
  const grades = [11, 12, 11, 12, 11];
  const external = predict(grades.map((g, i) => mock(5 - i, g, 'EXTERNAL_MOCK')));
  const internal = predict(grades.map((g, i) => mock(5 - i, g, 'INTERNAL_MOCK')));
  assert.ok(internal.basis.variance.scale > external.basis.variance.scale);
  assert.ok(internal.basis.sdDown > external.basis.sdDown);
  // 而且畫面上要說得出為什麼，不然學生只會看到一個比同學寬的區間。
  assert.ok(internal.notes.some((n) => /校內/.test(n) && /級距/.test(n)));
  assert.ok(!external.notes.some((n) => /級距本身就不可靠/.test(n)));
});

test('真正的學測成績不帶難度差異也不帶級距誤差', () => {
  assert.equal(SOURCE_UNCERTAINTY.OFFICIAL_GSAT.difficulty, 0);
  assert.equal(SOURCE_UNCERTAINTY.OFFICIAL_GSAT.scale, 0);
  const real = predict([
    mock(5, 12, 'OFFICIAL_GSAT'),
    mock(4, 12, 'OFFICIAL_GSAT'),
    mock(3, 12, 'OFFICIAL_GSAT'),
  ]);
  assert.equal(real.basis.variance.diff, 0);
  assert.equal(real.basis.variance.scale, 0);
});

test('認不出來的來源當成最不可靠的，不是當成中等', () => {
  const known = predict([
    mock(3, 12, 'EXTERNAL_MOCK'),
    mock(2, 12, 'EXTERNAL_MOCK'),
    mock(1, 12, 'EXTERNAL_MOCK'),
  ]);
  const weird = predict([mock(3, 12, 'WHO_KNOWS'), mock(2, 12, 'WHO_KNOWS'), mock(1, 12, 'WHO_KNOWS')]);
  assert.ok(weird.basis.sdDown > known.basis.sdDown);
});

test('★ 趨勢向上 → 區間往上，而且不會外插到荒謬', () => {
  const flat = predict([mock(5, 11), mock(4, 11), mock(3, 11), mock(2, 11), mock(1, 11)]);
  const rising = predict([mock(5, 9), mock(4, 10), mock(3, 11), mock(2, 12), mock(1, 13)]);
  assert.ok(rising.basis.slopePerMonth > 0.5, `斜率是 ${rising.basis.slopePerMonth}`);
  assert.ok(
    rising.interval.high > flat.interval.high || rising.interval.low > flat.interval.low,
    `向上的趨勢要反映在區間上：${JSON.stringify(rising.interval)} vs ${JSON.stringify(flat.interval)}`,
  );
  // 但**上界仍然在級分的範圍內**。三次連續進步乘上剩餘時間會算出 17，
  // 而那個數字在數學上是斜率外插的結果，在現實裡不存在。
  assert.ok(rising.interval.high <= GRADE_MAX);
  assert.ok(Math.abs(rising.basis.improvement) <= 3.0001, `進步幅度 ${rising.basis.improvement}`);
});

test('趨勢向下也要跟著往下（只往上調的話那不是預測，是鼓勵）', () => {
  const falling = predict([mock(5, 13), mock(4, 12), mock(3, 11), mock(2, 10), mock(1, 9)]);
  const flat = predict([mock(5, 11), mock(4, 11), mock(3, 11), mock(2, 11), mock(1, 11)]);
  assert.ok(falling.basis.slopePerMonth < 0);
  assert.ok(falling.basis.center < flat.basis.center);
});

test('斜率的權重隨樣本數上升（三個點的斜率不值得完全相信）', () => {
  const few = predict([mock(6, 9), mock(5, 10), mock(4, 11)]);
  const many = predict([
    mock(8, 8),
    mock(7, 9),
    mock(6, 9),
    mock(5, 10),
    mock(4, 11),
    mock(3, 11),
    mock(2, 12),
    mock(1, 12),
  ]);
  assert.ok(many.basis.slopeWeight > few.basis.slopeWeight);
  assert.ok(few.basis.slopeWeight < 1, '三個點不該完全採用他自己的斜率');
});

test('★ 距考試越遠 → 區間越寬，而且分布偏向上方', () => {
  const records = [mock(9, 11), mock(8, 11), mock(7, 11)];
  // 同一批成績，一份離考試一個月、一份離考試十個月。
  const near = predictGrade({
    subjectCode: 'MATH_A',
    records,
    examDate: new Date(records[2].examDate.getTime() + 30 * 86_400_000),
    now: NOW,
  });
  const far = predictGrade({
    subjectCode: 'MATH_A',
    records,
    examDate: new Date(records[2].examDate.getTime() + 300 * 86_400_000),
    now: NOW,
  });

  assert.ok(far.basis.monthsToExam > near.basis.monthsToExam);
  assert.ok(far.basis.variance.drift > near.basis.variance.drift);
  assert.ok(width(far) > width(near), `遠的應該更寬：${width(far)} vs ${width(near)}`);
  // 偏向上方：σ_up 比 σ_down 大，而區間在中心之上留的空間也比之下多。
  assert.ok(far.basis.sdUp > far.basis.sdDown);
  assert.ok(far.basis.skew > near.basis.skew);
  const up = far.interval.high - far.basis.center;
  const down = far.basis.center - far.interval.low;
  assert.ok(up > down, `往上的空間要比往下多：上 ${up}、下 ${down}`);
  // 而且中心本身也往上（剩下的時間裡通常是進步）。
  assert.ok(far.basis.center > near.basis.center);
  assert.ok(far.notes.some((n) => /往上的空間比往下多/.test(n)));
});

test('掌握度趨勢只微調進步幅度，不改變區間寬度', () => {
  const records = [mock(6, 10), mock(5, 11), mock(4, 11)];
  const plain = predict(records);
  const improving = predict(records, { abilityTrend: 0.5 });
  assert.ok(improving.basis.center >= plain.basis.center);
  assert.equal(improving.basis.sdDown, plain.basis.sdDown, '掌握度與級分不同尺度，不該影響寬度');
});

// ═════════════════════════════════════════════════════════════════
// §4 區間與信心：介面上不存在單一級分
// ═════════════════════════════════════════════════════════════════

test('★ 區間永遠不是一個級分（「預估 12 至 12」就是一個數字換了寫法）', () => {
  // 一個極度集中的分布：足以讓單一個級分就達到 70% 的覆蓋率。
  const iv = intervalOf(discretize(12, 0.3, 0.3), 0.7);
  assert.ok(iv.high > iv.low, `區間是 ${JSON.stringify(iv)}`);
  assert.equal(iv.widened, true);
  // 加寬之後信心跟著提高——兩個數字仍然是同一件事的兩面，沒有任何
  // 東西被美化。
  assert.ok(iv.confidence > DEFAULT_CONFIDENCE);
});

test('集中在 15 級分時只能往下加寬（往上沒有級分了）', () => {
  const iv = intervalOf(discretize(15.4, 0.3, 0.3), 0.7);
  assert.equal(iv.widened, true);
  assert.equal(iv.high, GRADE_MAX);
  assert.equal(iv.low, GRADE_MAX - 1);
});

test('★ 任何一種輸入下，`predictGrade` 的區間都不是單一級分', () => {
  const scenarios = [
    [mock(5, 15), mock(4, 15), mock(3, 15)],
    [mock(5, 0), mock(4, 0), mock(3, 0)],
    [mock(9, 3), mock(6, 9), mock(3, 15)],
    [mock(2, 8), mock(1.5, 8), mock(1, 8), mock(0.5, 8)],
  ];
  for (const records of scenarios) {
    for (const c of [0.5, 0.7, 0.9]) {
      const p = predict(records, { confidence: c });
      assert.ok(
        p.interval.high > p.interval.low,
        `${JSON.stringify(records.map((r) => r.grade))} 在信心 ${c} 下給了 ${JSON.stringify(p.interval)}`,
      );
      assert.ok(p.interval.confidence < 1 && p.interval.confidence > 0);
    }
  }
});

test('★ 信心水準永遠小於 1（1 代表保證，資料庫的 CHECK 也擋這件事）', () => {
  const d = discretize(7.5, 0.05, 0.05); // 幾乎全部機率壓在一格
  const iv = intervalOf(d, 0.99);
  assert.ok(iv.confidence < 1, `信心是 ${iv.confidence}`);
  assert.ok(iv.confidence <= MAX_CONFIDENCE);
  assert.ok(iv.confidence > 0);
});

test('區間是**連續**的，而且是達到目標覆蓋率的最短那一個', () => {
  const d = discretize(11, 1.4, 1.4);
  const iv = intervalOf(d, 0.7);
  const cov = d.filter((x) => x.grade >= iv.low && x.grade <= iv.high).reduce((a, x) => a + x.p, 0);
  assert.ok(cov >= 0.7 - 1e-9, `覆蓋率 ${cov} 不到 0.7`);
  // 再窄一級就不夠——這是「最短」的定義。
  const narrower = d
    .filter((x) => x.grade >= iv.low + 1 && x.grade <= iv.high)
    .reduce((a, x) => a + x.p, 0);
  assert.ok(narrower < 0.7, '再窄一級居然還夠，那上面那個就不是最短的');
});

test('目標信心越高，區間越寬', () => {
  const records = [mock(5, 10), mock(4, 11), mock(3, 12), mock(2, 11)];
  const a = predict(records, { confidence: 0.6 });
  const b = predict(records, { confidence: 0.9 });
  assert.ok(width(b) >= width(a));
  assert.ok(b.interval.confidence > a.interval.confidence);
});

test('六科一次算：沒有記錄的科目也要回一列，不是靜靜不見', () => {
  const records = [
    { subjectCode: 'MATH_A', examName: 'A', examDate: mock(4, 11).examDate, grade: 11, source: 'EXTERNAL_MOCK' },
    { subjectCode: 'MATH_A', examName: 'B', examDate: mock(3, 12).examDate, grade: 12, source: 'EXTERNAL_MOCK' },
    { subjectCode: 'MATH_A', examName: 'C', examDate: mock(2, 12).examDate, grade: 12, source: 'EXTERNAL_MOCK' },
    { subjectCode: 'ENGLISH', examName: 'A', examDate: mock(4, 13).examDate, grade: 13, source: 'EXTERNAL_MOCK' },
  ];
  const all = predictAll({
    records,
    subjectCodes: ['CHINESE', 'ENGLISH', 'MATH_A'],
    examDate: EXAM,
    now: NOW,
  });
  assert.equal(all.length, 3);
  assert.equal(all.find((p) => p.subjectCode === 'CHINESE').available, false);
  assert.equal(all.find((p) => p.subjectCode === 'ENGLISH').thin, true);
  assert.equal(all.find((p) => p.subjectCode === 'MATH_A').thin, false);
});

test('★ 給落點模擬的邊際分布**排除 thin 的科目**', () => {
  // 用一個先驗寬度的假分布去抽樣，會算出一個看起來正常的機率。
  const records = [
    ...[5, 4, 3].map((m) => ({ ...mock(m, 11), subjectCode: 'MATH_A' })),
    { ...mock(4, 13), subjectCode: 'ENGLISH' },
  ];
  const marg = marginalsFor(predictAll({ records, examDate: EXAM, now: NOW }));
  assert.ok(marg.MATH_A, '有三次記錄的科目要在');
  assert.equal(marg.ENGLISH, undefined, '只有一次記錄的科目不該有分布');
  // 而且回傳裡**沒有任何一個「預估級分」欄位可以被誤用**。
  assert.ok(Array.isArray(marg.MATH_A));
  assert.ok(marg.MATH_A.every((x) => 'grade' in x && 'p' in x));
});

test('學測日期：115 學年度的學測在西元 2027 年 1 月', () => {
  assert.equal(gsatDateOf(115).toISOString().slice(0, 7), '2027-01');
  assert.equal(gsatDateOf(116).toISOString().slice(0, 7), '2028-01');
  // 西元年填進來時不組日期。差一年的後果是剩餘時間差 12 個月，
  // 於是整份預測的區間寬度差一倍，而畫面上只是一個偏寬的區間。
  assert.equal(gsatDateOf(2026), null);
  assert.equal(gsatDateOf(null), null);
});

// ═════════════════════════════════════════════════════════════════
// §4.5 已經考完的那一場
//
// 學年度自 8 月起算而學測在 1 月，所以**每年 1/20 到 7/31**，
// `admissionYearOf()` 指的那一場學測已經考完了——半年的長度。
// 那半年裡若拿它當預測目標，剩餘時間是負的，而三個地方會一起
// 往錯的方向跑（進步幅度往回外插、drift 歸零、skew 歸零）：
// 區間同時**往下移**又**變窄**。
//
// 這一組是那半年的護欄。
// ═════════════════════════════════════════════════════════════════

/** 2026-07-30：114 學年度的學測（2026-01-20）已經過去半年。 */
const AFTER_GSAT = new Date('2026-07-30T00:00:00.000Z');

/** 三次模考 10 → 11 → 12，都在 114 那場學測之後。 */
const RISING_AFTER_EXAM = [
  { subjectCode: 'MATH_A', examName: '3 月', examDate: new Date('2026-03-10T00:00:00.000Z'), grade: 10, source: 'EXTERNAL_MOCK' },
  { subjectCode: 'MATH_A', examName: '4 月', examDate: new Date('2026-04-15T00:00:00.000Z'), grade: 11, source: 'EXTERNAL_MOCK' },
  { subjectCode: 'MATH_A', examName: '6 月', examDate: new Date('2026-06-10T00:00:00.000Z'), grade: 12, source: 'EXTERNAL_MOCK' },
];

test('★ 目標日在資料之前時，進步幅度不可以被往回外插', () => {
  const p = predictGrade({
    subjectCode: 'MATH_A',
    records: RISING_AFTER_EXAM,
    targetYear: 114, // 這一場在 2026-01-20，已經考完
    now: AFTER_GSAT,
  });

  // 帶號的月數仍然留在 basis 裡（稽核要看得出目標日在錨點之前），
  // 但真正進到公式裡的是夾成 0 的那一個。
  assert.ok(p.basis.monthsToExam < 0, '這個情境的前提就是剩餘時間為負');
  assert.equal(p.basis.monthsAhead, 0);
  assert.equal(p.basis.improvement, 0, '負月數乘上斜率就是往回外插，那不是更保守，是方向錯了');

  // 一位**正在進步**的學生，預測不可以低於他的加權平均。
  assert.ok(
    p.interval.low <= p.basis.weightedMean && p.basis.weightedMean <= p.interval.high,
    `加權平均 ${p.basis.weightedMean} 要落在區間 ${p.interval.low}–${p.interval.high} 裡`,
  );
  assert.ok(p.interval.high >= 12, '最近一次考 12 級分，區間上緣不該低於它');
});

test('★ 考完了的那一場要說「已經考完」，不是只顯示「約 0 個月」', () => {
  const p = predictGrade({
    subjectCode: 'MATH_A',
    records: RISING_AFTER_EXAM,
    targetYear: 114,
    now: AFTER_GSAT,
  });
  assert.equal(p.basis.examPassed, true);
  assert.ok(
    p.notes.some((n) => /已經考完/.test(n)),
    '畫面唯一的線索是這句話——少了它，「距學測約 0 個月」讀起來像「就快考了」',
  );
  assert.ok(p.notes.some((n) => /真正的學測/.test(n)), '要接到「去輸入正式級分」那個動作');
});

test('還沒考的那一場不會被誤標成考完了', () => {
  const p = predictGrade({
    subjectCode: 'MATH_A',
    records: RISING_AFTER_EXAM,
    targetYear: 115, // 2027-01-20
    now: AFTER_GSAT,
  });
  assert.equal(p.basis.examPassed, false);
  assert.ok(p.basis.monthsAhead > 8);
  assert.ok(p.basis.improvement > 0, '真的還有時間時，進步幅度照樣要往上');
  assert.ok(!p.notes.some((n) => /已經考完/.test(n)));
});

test('★ 預測的目標是「下一場還沒考的學測」，不是當下的學年度', () => {
  // 這一條就是那半年的窗：2026-07-30 的學年度是 114，而 114 那場
  // 學測在 2026-01-20 已經考完，所以還沒考的是 115。
  assert.equal(upcomingGsatYear(AFTER_GSAT), 115);
  assert.equal(gsatPassed(114, AFTER_GSAT), true);
  assert.equal(gsatPassed(115, AFTER_GSAT), false);

  // 窗外的每一個時點都要對：
  assert.equal(upcomingGsatYear(new Date('2026-01-10T00:00:00.000Z')), 114, '學測前十天還是這一場');
  assert.equal(upcomingGsatYear(new Date('2026-01-20T00:00:00.000Z')), 114, '考試當天仍算這一場');
  assert.equal(upcomingGsatYear(new Date('2026-09-01T00:00:00.000Z')), 115, '八月之後學年度與下一場一致');
  assert.equal(upcomingGsatYear(new Date('2027-02-01T00:00:00.000Z')), 116);

  assert.equal(gsatPassed(2026, AFTER_GSAT), false, '西元年不合法時不要宣稱它考完了');
});

// ═════════════════════════════════════════════════════════════════
// §5 校準（規格書 §6.2）
//
// 「一個不追蹤自己準確度的預測系統只是在製造好看的數字。」
// ═════════════════════════════════════════════════════════════════

/** n 筆預測，其中 hit 筆命中。 */
function rows(n, hit, confidence = 0.7) {
  return Array.from({ length: n }, (_, i) => ({
    intervalLow: 10,
    intervalHigh: 12,
    confidence,
    actualGrade: i < hit ? 11 : 5,
    subjectCode: 'MATH_A',
  }));
}

test('Wilson 區間：小樣本要寬，k=0 與 k=n 不會退化成寬度 0', () => {
  const small = wilsonInterval(5, 10);
  const big = wilsonInterval(50, 100);
  assert.ok(small.high - small.low > big.high - big.low);
  assert.ok(wilsonInterval(0, 10).high > 0.2, '0/10 的上界不該是 0');
  assert.ok(wilsonInterval(10, 10).low < 1, '10/10 的下界不該是 1');
});

test('★ 校準曲線：70% 的區間實際只命中 45% 時要告警', () => {
  // 規格書 §6.3 的例子：70% 信心區間的實際命中率低於 55% 時告警。
  const c = calibrationCurve(rows(40, 18, 0.7));
  assert.equal(c.scored, 40);
  assert.equal(c.pending, 0);
  const band = c.bands.find((b) => b.label === '70–80%');
  assert.equal(band.n, 40);
  assert.equal(band.hit, 18);
  assert.ok(Math.abs(band.hitRate - 0.45) < 1e-9);
  assert.ok(Math.abs(band.expected - 0.7) < 1e-9);
  assert.ok(band.alert, '應該告警');
  assert.equal(band.alert.severity, 'OVERCONFIDENT');
  assert.match(band.alert.text, /區間開得太窄/);
  assert.equal(c.alerts.length, 1);
  assert.match(c.verdict, /過度自信/);
});

test('剛好在門檻上（命中 56%）不告警，低於門檻（54%）才告警', () => {
  const margin = CALIB_ALERT_MARGIN;
  assert.equal(margin, 0.15, '規格書寫的是 70% 對 55%，也就是 0.15');
  const ok = calibrationCurve(rows(100, 56, 0.7));
  const bad = calibrationCurve(rows(100, 54, 0.7));
  assert.equal(ok.bands.find((b) => b.label === '70–80%').alert, null);
  assert.ok(bad.bands.find((b) => b.label === '70–80%').alert);
});

test('★ 樣本少於門檻時不告警，而且標成「還下不了結論」', () => {
  // 8 筆裡命中 3 筆＝37.5%，看起來比上面那個 45% 更糟——但八次拋硬幣
  // 出現這種結果一點都不奇怪。這裡就告警的話，第一屆會天天紅字，
  // 然後這個告警會被關掉——而它是這整套東西唯一的品質訊號。
  const c = calibrationCurve(rows(8, 3, 0.7));
  const band = c.bands.find((b) => b.label === '70–80%');
  assert.ok(band.hitRate < 0.45);
  assert.equal(band.thin, true);
  assert.equal(band.alert, null, '8 筆就告警的話，這個功能會在第一屆被關掉');
  assert.match(c.verdict, /還下不了結論/);
});

test('★ 樣本剛好到門檻但差距在統計噪音之內時也不告警（Wilson 上界）', () => {
  // 10 筆命中 5 筆＝50%，低於 70% − 15% = 55%，也就是**點估計已經越線**。
  // 但 10 筆的 Wilson 上界仍然在 70% 之上，代表這完全可能只是運氣。
  // 少了這一條，告警會靠一個點估計在小樣本上亂跳。
  const c = calibrationCurve(rows(10, 5, 0.7));
  const band = c.bands.find((b) => b.label === '70–80%');
  assert.equal(band.n, 10);
  assert.ok(band.hitRate < 0.55, `命中率 ${band.hitRate} 應該已經越線`);
  assert.ok(band.wilsonHigh > 0.7, `Wilson 上界是 ${band.wilsonHigh}`);
  assert.equal(band.alert, null);
});

test('區間開太寬也要報，只是它不會害到人', () => {
  const c = calibrationCurve(rows(100, 98, 0.7));
  const band = c.bands.find((b) => b.label === '70–80%');
  assert.equal(band.alert.severity, 'OVERCAUTIOUS');
  assert.match(band.alert.text, /區間開得太寬/);
});

test('★ 還沒回填實際成績的筆數要數出來，而且不算進曲線', () => {
  const c = calibrationCurve([
    ...rows(20, 14, 0.7),
    ...Array.from({ length: 120 }, () => ({
      intervalLow: 10,
      intervalHigh: 12,
      confidence: 0.7,
      actualGrade: null,
    })),
  ]);
  assert.equal(c.scored, 20);
  assert.equal(c.pending, 120, '「還有 120 筆在等成績」與「只有 8 筆」是兩件完全不同的事');
  assert.equal(c.bands.find((b) => b.label === '70–80%').n, 20);
});

test('完全沒有資料時說得出「要等學測成績公布」，不是印一條空曲線', () => {
  const none = calibrationCurve([]);
  assert.equal(none.scored, 0);
  assert.match(none.verdict, /還沒有任何預測記錄/);
  const waiting = calibrationCurve([
    { intervalLow: 10, intervalHigh: 12, confidence: 0.7, actualGrade: null },
  ]);
  assert.match(waiting.verdict, /等學測成績公布/);
});

test('「應該命中幾成」用的是這一組實際的信心平均，不是組的中點', () => {
  // 一組裡全部是 0.71 時，拿 0.75 去比就是拿一個不存在的承諾去比一個
  // 真的結果。這一條分得出兩種實作。
  const c = calibrationCurve(rows(40, 28, 0.71));
  const band = c.bands.find((b) => b.label === '70–80%');
  assert.ok(Math.abs(band.expected - 0.71) < 1e-9, `expected 是 ${band.expected}`);
  assert.ok(Math.abs(band.gap - (0.7 - 0.71)) < 1e-9);
});

test('信心水準壞掉的列要被數出來（資料庫有 CHECK，所以不是 0 就要查）', () => {
  const c = calibrationCurve([
    { intervalLow: 12, intervalHigh: 10, confidence: 0.7, actualGrade: 11 }, // 上下界反了
    { intervalLow: 10, intervalHigh: 12, confidence: 1, actualGrade: 11 }, // 信心是 1
    { intervalLow: 10, intervalHigh: 12, confidence: 0.7, actualGrade: 11 },
  ]);
  assert.equal(c.malformed, 2);
  assert.equal(c.scored, 1);
});

test('各組分開算，不會把 90% 的區間混進 70% 那一組', () => {
  const c = calibrationCurve([...rows(30, 12, 0.7), ...rows(30, 29, 0.95)]);
  assert.equal(c.bands.find((b) => b.label === '70–80%').n, 30);
  assert.equal(c.bands.find((b) => b.label === '90% 以上').n, 30);
  assert.equal(c.totals.n, 60);
});
