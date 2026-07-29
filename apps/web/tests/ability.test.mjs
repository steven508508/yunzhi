/**
 * 掌握度公式。
 *
 * # 這一支測的是一種完全沒有症狀的錯誤
 *
 * 能力分析算錯的結果不是當機，是**一個看起來很正常的小數**。
 * 學生照著 0.72 決定不複習、老師照著它決定不重講、家長約談時看著它
 * 點頭——而沒有任何人有辦法察覺那個數字是錯的。
 *
 * 所以每一條規則都要在這裡被釘住，特別是三件最容易寫錯的事：
 *
 *   **一、衰減會不會被自己抵銷。** 掌握度若寫成 `Σ(w·對)/Σw`，
 *   全部的權重在分子分母裡同時縮小然後互相抵銷——一位三個月沒碰的
 *   學生，掌握度一個小數點都不會動，而每一行程式看起來都是對的。
 *
 *   **二、樣本太少時敢不敢說不知道。** 一題答對算成 100% 掌握，
 *   是這類系統最常見的謊言。
 *
 *   **三、時鐘跑掉。** 答題時間落在未來時，指數的符號會反過來，
 *   一題的權重就能蓋過其他二十題。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DIFF_SPAN,
  MIN_ITEMS,
  PRIOR_WEIGHT,
  SOLID,
  STALE_FLOOR,
  STUCK_STREAK,
  WEAK,
  classWeakness,
  computeSnapshots,
  decayWeight,
  difficultyFactor,
  masteryOf,
  nextStep,
  typeBreakdown,
  weakestFirst,
} from '../lib/ability.mjs';

const NOW = new Date('2026-08-03T09:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

/** 幾天前。 */
const daysAgo = (n) => new Date(NOW.getTime() - n * DAY);

/** 幾題一模一樣的作答。預設是剛剛答的、中等難度。 */
function items(n, isCorrect, extra = {}) {
  return Array.from({ length: n }, () => ({
    isCorrect,
    answeredAt: extra.answeredAt ?? NOW,
    difficulty: extra.difficulty ?? null,
    linkWeight: extra.linkWeight ?? 1,
  }));
}

const close = (a, b, eps = 1e-4, msg) =>
  assert.ok(Math.abs(a - b) <= eps, msg ?? `${a} 與 ${b} 相差超過 ${eps}`);

// ─────────────────────────────────────────────────────────────────
// 一、時間衰減
// ─────────────────────────────────────────────────────────────────

test('剛答完的權重是 1，時間過去就往下掉', () => {
  close(decayWeight(NOW, NOW, 0.05), 1);
  assert.ok(decayWeight(daysAgo(30), NOW, 0.05) < 1);
  assert.ok(decayWeight(daysAgo(90), NOW, 0.05) < decayWeight(daysAgo(30), NOW, 0.05));
});

test('預設衰減率的半衰期是 97 天（一個暑假剩一半）', () => {
  // 每週 0.05 → 半衰期 7·ln2/0.05。這個數字是公式的承諾，
  // 改動它等於改了「三個月沒碰會掉多少」，所以釘在這裡。
  const halfLife = (7 * Math.LN2) / 0.05;
  close(halfLife, 97.04, 0.01);
  close(decayWeight(daysAgo(halfLife), NOW, 0.05), 0.5);
});

test('衰減率愈大掉得愈快，設 0 就完全不衰減', () => {
  assert.ok(decayWeight(daysAgo(60), NOW, 0.3) < decayWeight(daysAgo(60), NOW, 0.05));
  close(decayWeight(daysAgo(3650), NOW, 0), 1, 1e-9, '設 0 的知識點永遠不衰減');
});

test('三個月沒碰，掌握度真的會下降', () => {
  // 這是整個檔案存在的理由：同一批作答，只有時間不同。
  const fresh = masteryOf(items(8, true), { decayRate: 0.05, now: NOW });
  const stale = masteryOf(items(8, true, { answeredAt: daysAgo(90) }), {
    decayRate: 0.05,
    now: NOW,
  });
  close(fresh.mastery, 0.8);
  close(stale.mastery, 0.6777);
  assert.ok(stale.mastery < fresh.mastery, '三個月前的八題不該與今天的八題等值');
  // 原始計數不會因為時間而改變——老師問「他到底做對幾題」時，
  // 那是一個事實，不是一個估計。
  assert.equal(stale.correct, 8);
  assert.equal(stale.total, 8);
});

test('衰減不會被分子分母互相抵銷', () => {
  // 這一條是回歸測試。`Σ(w·對)/Σw` 的寫法在這個案例上會給出
  // 一模一樣的兩個數字，而那正是最容易寫出來的版本。
  const a = masteryOf(items(6, true, { answeredAt: daysAgo(1) }), { decayRate: 0.05, now: NOW });
  const b = masteryOf(items(6, true, { answeredAt: daysAgo(200) }), { decayRate: 0.05, now: NOW });
  assert.notEqual(a.mastery, b.mastery);
  assert.ok(a.mastery - b.mastery > 0.2, '兩百天的差距要看得出來');
});

test('半對半錯時，時間不會憑空把比例改成別的方向', () => {
  // 衰減只該讓掌握度往「還沒學會」靠，不該讓它反過來上升。
  const fresh = masteryOf(
    [...items(3, true), ...items(3, false)],
    { decayRate: 0.05, now: NOW },
  );
  const stale = masteryOf(
    [...items(3, true, { answeredAt: daysAgo(120) }), ...items(3, false, { answeredAt: daysAgo(120) })],
    { decayRate: 0.05, now: NOW },
  );
  assert.ok(stale.mastery < fresh.mastery);
  assert.ok(stale.mastery >= 0);
});

// ─────────────────────────────────────────────────────────────────
// 二、樣本量門檻
// ─────────────────────────────────────────────────────────────────

test('低於門檻題數就不標成可靠', () => {
  for (let n = 1; n < MIN_ITEMS; n++) {
    assert.equal(
      masteryOf(items(n, true), { now: NOW }).reliable,
      false,
      `${n} 題不足以下結論`,
    );
  }
  assert.equal(masteryOf(items(MIN_ITEMS, true), { now: NOW }).reliable, true);
});

test('題數夠但資料太舊，一樣不可靠', () => {
  const old = masteryOf(items(6, true, { answeredAt: daysAgo(365) }), {
    decayRate: 0.05,
    now: NOW,
  });
  assert.equal(old.total, 6, '題數是夠的');
  assert.ok(old.evidence < STALE_FLOOR, '但有效證據掉到門檻以下了');
  assert.equal(old.reliable, false, '「他不會」與「不知道他現在會不會」是兩件事');
});

test('題目只有一小部分在講這個知識點時，證據跟著打折', () => {
  const weakLink = masteryOf(items(5, true, { linkWeight: 0.3 }), { now: NOW });
  assert.equal(weakLink.total, 5);
  assert.equal(weakLink.reliable, false, '五題各只有三成份量，撐不起結論');
  const fullLink = masteryOf(items(5, true, { linkWeight: 1 }), { now: NOW });
  assert.equal(fullLink.reliable, true);
  assert.ok(weakLink.mastery < fullLink.mastery);
});

test('資料不足時給的是一個低估的數字，不是一個樂觀的數字', () => {
  // 猜對一題的學生不該看到「完全掌握」。
  const one = masteryOf(items(1, true), { now: NOW });
  close(one.mastery, 1 / (1 + PRIOR_WEIGHT));
  assert.ok(one.mastery < WEAK);
  assert.equal(one.reliable, false);
});

// ─────────────────────────────────────────────────────────────────
// 三、難度
// ─────────────────────────────────────────────────────────────────

test('難度係數的四個方向', () => {
  // difficulty 的慣例是 1 = 最難（lib/commit.ts 用 1 − 全國答對率）。
  assert.ok(difficultyFactor(1, true) > 1, '答對難題是強證據');
  assert.ok(difficultyFactor(0, true) < 1, '答對送分題說明不了什麼');
  assert.ok(difficultyFactor(0, false) > 1, '答錯送分題是強證據');
  assert.ok(difficultyFactor(1, false) < 1, '答錯難題，全國一半的人也錯');
  close(difficultyFactor(1, true), 1 + DIFF_SPAN / 2);
  close(difficultyFactor(0, false), 1 + DIFF_SPAN / 2);
});

test('沒有難度資料時，難度完全不起作用', () => {
  close(difficultyFactor(null, true), 1);
  close(difficultyFactor(null, false), 1);
  close(difficultyFactor(undefined, true), 1);
  close(difficultyFactor(Number.NaN, true), 1, 1e-9);
  // 超出範圍的值（資料有問題）夾回 0 到 1，不會放大成離譜的係數。
  close(difficultyFactor(7, true), difficultyFactor(1, true));
  close(difficultyFactor(-3, true), difficultyFactor(0, true));
});

test('五題全對，難的那一組掌握度比較高', () => {
  const hard = masteryOf(items(5, true, { difficulty: 0.9 }), { now: NOW });
  const easy = masteryOf(items(5, true, { difficulty: 0.1 }), { now: NOW });
  assert.ok(hard.mastery > easy.mastery);
  assert.equal(hard.correct, easy.correct, '原始計數一樣，差別只在權重');
});

test('五題全錯，錯在送分題的掉得比較兇——但兩邊都是 0', () => {
  // 全錯時分子是 0，難度改變的是「這個 0 有多可信」，
  // 而那件事表現在 evidence 上，不在掌握度上。
  const easy = masteryOf(items(5, false, { difficulty: 0.1 }), { now: NOW });
  const hard = masteryOf(items(5, false, { difficulty: 0.9 }), { now: NOW });
  assert.equal(easy.mastery, 0);
  assert.equal(hard.mastery, 0);
  assert.ok(easy.evidence > hard.evidence, '答錯送分題是比較強的證據');
});

test('答對難題、答錯送分題，好過答對送分題、答錯難題', () => {
  const strong = masteryOf(
    [
      { isCorrect: true, answeredAt: NOW, difficulty: 1 },
      { isCorrect: false, answeredAt: NOW, difficulty: 0 },
    ],
    { now: NOW },
  );
  const weak = masteryOf(
    [
      { isCorrect: true, answeredAt: NOW, difficulty: 0 },
      { isCorrect: false, answeredAt: NOW, difficulty: 1 },
    ],
    { now: NOW },
  );
  assert.ok(strong.mastery > weak.mastery, '解得出難題的人比較強，即使答對題數一樣');
});

test('加一題答對一定往上，加一題答錯一定往下', () => {
  const base = masteryOf(items(3, true), { now: NOW });
  for (const d of [0, 0.5, 1, null]) {
    const up = masteryOf([...items(3, true), { isCorrect: true, answeredAt: NOW, difficulty: d }], {
      now: NOW,
    });
    const down = masteryOf(
      [...items(3, true), { isCorrect: false, answeredAt: NOW, difficulty: d }],
      { now: NOW },
    );
    assert.ok(up.mastery > base.mastery, `難度 ${d} 答對要往上`);
    assert.ok(down.mastery < base.mastery, `難度 ${d} 答錯要往下`);
  }
});

// ─────────────────────────────────────────────────────────────────
// 四、邊界
// ─────────────────────────────────────────────────────────────────

test('零作答不是零分，是沒有資料', () => {
  const none = masteryOf([], { now: NOW });
  assert.deepEqual(
    { correct: none.correct, total: none.total, mastery: none.mastery, reliable: none.reliable },
    { correct: 0, total: 0, mastery: 0, reliable: false },
  );
  assert.equal(none.lastAnsweredAt, null);
  assert.equal(masteryOf(null, { now: NOW }).total, 0);
  assert.equal(masteryOf(undefined, { now: NOW }).total, 0);
});

test('全對不會是 1.00', () => {
  const many = masteryOf(items(50, true), { now: NOW });
  assert.ok(many.mastery < 1, '證據永遠不完備，不能宣稱他不可能再錯');
  assert.ok(many.mastery > SOLID);
  close(many.mastery, 50 / (50 + PRIOR_WEIGHT));
});

test('全錯是 0，而且掌握度不會變成負的', () => {
  const all = masteryOf(items(9, false), { now: NOW });
  assert.equal(all.mastery, 0);
  assert.equal(all.correct, 0);
  assert.equal(all.total, 9);
  assert.equal(all.reliable, true, '九題全錯是一個可靠的結論');
  assert.equal(all.streakWrong, 9);
});

test('只有一題', () => {
  const right = masteryOf(items(1, true), { now: NOW });
  const wrong = masteryOf(items(1, false), { now: NOW });
  assert.equal(right.total, 1);
  assert.equal(wrong.mastery, 0);
  assert.equal(right.reliable, false);
  assert.equal(wrong.reliable, false);
  assert.equal(wrong.streakWrong, 1);
});

test('時間戳在未來（時鐘跑掉）不會讓權重超過 1', () => {
  const future = new Date(NOW.getTime() + 30 * DAY);
  close(decayWeight(future, NOW, 0.05), 1, 1e-9);
  const skewed = masteryOf(items(5, true, { answeredAt: future }), { decayRate: 0.05, now: NOW });
  const normal = masteryOf(items(5, true), { decayRate: 0.05, now: NOW });
  assert.equal(skewed.mastery, normal.mastery, '未來的一題只當成「剛剛」，不能加倍');
  assert.ok(skewed.evidence <= 5 + 1e-9);
});

test('壞掉的時間戳不會讓整個結果變成 NaN', () => {
  const broken = masteryOf(
    [{ isCorrect: true, answeredAt: new Date('不是日期') }, ...items(4, true)],
    { now: NOW },
  );
  assert.ok(Number.isFinite(broken.mastery));
  assert.equal(broken.total, 5);
});

test('連續答錯是從最近的一題往回數，答對就歸零', () => {
  const seq = [
    { isCorrect: false, answeredAt: daysAgo(9) },
    { isCorrect: false, answeredAt: daysAgo(8) },
    { isCorrect: true, answeredAt: daysAgo(5) },
    { isCorrect: false, answeredAt: daysAgo(2) },
    { isCorrect: false, answeredAt: daysAgo(1) },
  ];
  // 故意打亂順序丟進去：資料庫回來的列不保證照時間排。
  const shuffled = [seq[3], seq[0], seq[4], seq[2], seq[1]];
  const s = masteryOf(shuffled, { now: NOW });
  assert.equal(s.streakWrong, 2);
  assert.equal(s.correct, 1);
  assert.equal(s.lastAnsweredAt.getTime(), daysAgo(1).getTime());

  const recovered = masteryOf([...seq, { isCorrect: true, answeredAt: NOW }], { now: NOW });
  assert.equal(recovered.streakWrong, 0, '答對一題就不算卡住了');
});

test('衰減率超出範圍時夾回 0 到 1', () => {
  const wild = masteryOf(items(5, true, { answeredAt: daysAgo(30) }), {
    decayRate: 99,
    now: NOW,
  });
  assert.ok(Number.isFinite(wild.mastery));
  assert.ok(wild.mastery >= 0 && wild.mastery <= 1);
});

// ─────────────────────────────────────────────────────────────────
// 五、從原始列算出快照
// ─────────────────────────────────────────────────────────────────

const ROWS = {
  answers: [
    { questionId: 'q1', isCorrect: true, answeredAt: daysAgo(3) },
    { questionId: 'q2', isCorrect: false, answeredAt: daysAgo(2) },
    // 非選題還沒改完
    { questionId: 'q3', isCorrect: null, answeredAt: daysAgo(1) },
  ],
  links: [
    { questionId: 'q1', knowledgePointId: 'kpA', weight: 1 },
    // 一題掛兩個知識點是常態
    { questionId: 'q2', knowledgePointId: 'kpA', weight: 1 },
    { questionId: 'q2', knowledgePointId: 'kpB', weight: 0.5 },
    { questionId: 'q3', knowledgePointId: 'kpB', weight: 1 },
  ],
  questions: [
    { id: 'q1', difficulty: 0.8 },
    { id: 'q2', difficulty: null },
    { id: 'q3', difficulty: 0.4 },
  ],
  points: [
    { id: 'kpA', decayRate: 0.05 },
    { id: 'kpB', decayRate: 0.4 },
  ],
};

test('一題掛兩個知識點時，兩邊都拿到這一題的證據', () => {
  const out = computeSnapshots(ROWS, NOW);
  const byId = new Map(out.map((o) => [o.knowledgePointId, o]));
  assert.equal(byId.get('kpA').total, 2);
  assert.equal(byId.get('kpA').correct, 1);
  assert.equal(byId.get('kpB').total, 1, 'q3 還沒改完，不算證據');
  assert.equal(byId.get('kpB').correct, 0);
});

test('還沒評分的題目不算進去', () => {
  // 把作文算成答錯，等於在老師改完之前先扣他的掌握度。
  const only = computeSnapshots(
    { ...ROWS, answers: [{ questionId: 'q3', isCorrect: null, answeredAt: NOW }] },
    NOW,
  );
  assert.deepEqual(only, [], '沒有判過對錯的作答不產生任何快照');
});

test('只算指定範圍內的知識點', () => {
  const out = computeSnapshots({ ...ROWS, points: [{ id: 'kpA', decayRate: 0.05 }] }, NOW);
  assert.deepEqual(out.map((o) => o.knowledgePointId), ['kpA']);
});

test('每個知識點用自己的衰減率', () => {
  const answers = [
    { questionId: 'qx', isCorrect: true, answeredAt: daysAgo(60) },
    { questionId: 'qy', isCorrect: true, answeredAt: daysAgo(60) },
  ];
  const out = computeSnapshots(
    {
      answers,
      links: [
        { questionId: 'qx', knowledgePointId: 'slow', weight: 1 },
        { questionId: 'qy', knowledgePointId: 'slow', weight: 1 },
        { questionId: 'qx', knowledgePointId: 'fast', weight: 1 },
        { questionId: 'qy', knowledgePointId: 'fast', weight: 1 },
      ],
      questions: [{ id: 'qx', difficulty: null }, { id: 'qy', difficulty: null }],
      // 程序性知識（計算技巧）忘得快，概念性的慢
      points: [{ id: 'slow', decayRate: 0.02 }, { id: 'fast', decayRate: 0.5 }],
    },
    NOW,
  );
  const byId = new Map(out.map((o) => [o.knowledgePointId, o]));
  assert.ok(byId.get('fast').mastery < byId.get('slow').mastery);
});

test('沒有任何資料時回空陣列，不是回一堆 0', () => {
  assert.deepEqual(computeSnapshots({}, NOW), []);
  assert.deepEqual(
    computeSnapshots({ answers: [], links: [], questions: [], points: [] }, NOW),
    [],
  );
  // 有作答但一題都沒標知識點——上線初期的常態
  assert.deepEqual(
    computeSnapshots(
      { answers: ROWS.answers, links: [], questions: ROWS.questions, points: ROWS.points },
      NOW,
    ),
    [],
  );
});

test('輸出順序穩定，兩次算出來的可以逐列比對', () => {
  const a = computeSnapshots(ROWS, NOW);
  const b = computeSnapshots({ ...ROWS, links: [...ROWS.links].reverse() }, NOW);
  assert.deepEqual(a.map((x) => x.knowledgePointId), b.map((x) => x.knowledgePointId));
  assert.deepEqual(a, b, '列的順序不該影響任何一個數字');
});

// ─────────────────────────────────────────────────────────────────
// 六、排序與下一步
// ─────────────────────────────────────────────────────────────────

const pt = (over) => ({
  id: 'x',
  name: '某知識點',
  mastery: 0.5,
  reliable: true,
  correct: 5,
  total: 10,
  streakWrong: 0,
  ...over,
});

test('弱的排前面，資料不足的一律排最後', () => {
  const sorted = weakestFirst([
    pt({ id: 'ok', mastery: 0.9 }),
    pt({ id: 'thin', mastery: 0.1, reliable: false }),
    pt({ id: 'bad', mastery: 0.2 }),
    pt({ id: 'mid', mastery: 0.55 }),
  ]);
  assert.deepEqual(sorted.map((p) => p.id), ['bad', 'mid', 'ok', 'thin']);
});

test('同樣的掌握度，題數多的排前面', () => {
  const sorted = weakestFirst([
    pt({ id: 'few', mastery: 0.4, total: 5 }),
    pt({ id: 'many', mastery: 0.4, total: 20 }),
  ]);
  assert.deepEqual(sorted.map((p) => p.id), ['many', 'few']);
});

test('下一步：資料不足時不給建議，只說還不知道', () => {
  const s = nextStep(pt({ reliable: false, total: 2, correct: 1 }), []);
  assert.equal(s.kind, 'UNKNOWN');
  assert.match(s.text, /2 題/);
});

test('下一步：連續錯三題即使樣本不足也要講出來', () => {
  // `streakWrong` 是數出來的，不是估出來的——樣本量門檻管的是
  // 「掌握度這個估計站不住」，管不到一個真實發生過的計數。
  const s = nextStep(pt({ reliable: false, total: 3, correct: 0, streakWrong: 3 }), []);
  assert.equal(s.kind, 'STUCK');
});

test('下一步：連續錯三題是卡住了，不是要多練', () => {
  const s = nextStep(pt({ mastery: 0.3, streakWrong: STUCK_STREAK }), [
    pt({ id: 'p', name: '前置', mastery: 0.2 }),
  ]);
  assert.equal(s.kind, 'STUCK', '卡住優先於前置——再多練也是繼續錯');
  assert.match(s.text, /連續錯/);
});

test('下一步：前置弱就先補前置，而且要說出是哪一個', () => {
  const s = nextStep(pt({ name: '機率統計', mastery: 0.35, correct: 2, total: 7 }), [
    pt({ id: 'a', name: '排列組合', mastery: 0.4 }),
    pt({ id: 'b', name: '集合', mastery: 0.85 }),
  ]);
  assert.equal(s.kind, 'PREREQ');
  assert.equal(s.prereq.name, '排列組合', '要挑最弱的那一個前置');
  assert.match(s.text, /排列組合/);
  assert.match(s.text, /7 題錯 5 題/, '要說得出可以自己驗證的數字');
});

test('下一步：前置沒有資料時，說的是「先確認底子」而不是「前置沒問題」', () => {
  const s = nextStep(pt({ mastery: 0.3 }), [
    pt({ id: 'a', name: '排列組合', reliable: false, total: 1, correct: 0 }),
  ]);
  assert.equal(s.kind, 'PREREQ');
  assert.match(s.text, /1 題的紀錄/);
});

test('下一步：前置都穩了才叫他練這一個', () => {
  const s = nextStep(pt({ mastery: 0.4, correct: 4, total: 10 }), [
    pt({ id: 'a', name: '排列組合', mastery: 0.8 }),
  ]);
  assert.equal(s.kind, 'PRACTICE');
  assert.equal(s.prereq, null);
  assert.match(s.text, /10 題錯 6 題/);
});

test('下一步：沒有任何前置關係時也給得出建議', () => {
  // 知識點圖譜上線初期只有節點、沒有邊，這是常態。
  const s = nextStep(pt({ mastery: 0.3 }), []);
  assert.equal(s.kind, 'PRACTICE');
});

// ─────────────────────────────────────────────────────────────────
// 七、班級
// ─────────────────────────────────────────────────────────────────

const snap = (kp, mastery, reliable = true, over = {}) => ({
  knowledgePointId: kp,
  mastery,
  reliable,
  correct: over.correct ?? 3,
  total: over.total ?? 8,
});

test('全班都不會的排前面，看的是「多少人是弱的」而不是平均', () => {
  const out = classWeakness([
    // 兩極化：平均看起來還好，但一半的人完全不會
    snap('split', 0.1), snap('split', 0.15), snap('split', 0.2),
    snap('split', 0.95), snap('split', 0.9), snap('split', 0.92),
    // 全班平均低一點，但沒有人掉到 WEAK 以下
    snap('even', 0.55), snap('even', 0.52), snap('even', 0.58),
  ]);
  assert.equal(out[0].knowledgePointId, 'split');
  assert.equal(out[0].weakStudents, 3);
  assert.equal(out[0].reliableStudents, 6);
});

test('樣本不夠的知識點標成「還沒有結論」，不是「沒問題」', () => {
  const out = classWeakness([snap('thin', 0.1), snap('thin', 0.2)]);
  assert.equal(out[0].enough, false);
  assert.equal(out[0].reliableStudents, 2);
});

test('資料不足的學生不進平均，但人數要算得出來', () => {
  const out = classWeakness([
    snap('kp', 0.8), snap('kp', 0.8), snap('kp', 0.8),
    snap('kp', 0.05, false),
  ]);
  assert.equal(out[0].students, 4);
  assert.equal(out[0].reliableStudents, 3);
  close(out[0].meanMastery, 0.8);
  assert.equal(out[0].weakStudents, 0, '不可靠的那一位不該被算成「不會」');
});

test('原始計數會累加，老師才驗算得了', () => {
  const out = classWeakness([
    snap('kp', 0.5, true, { correct: 2, total: 5 }),
    snap('kp', 0.5, true, { correct: 4, total: 5 }),
  ]);
  assert.equal(out[0].correct, 6);
  assert.equal(out[0].total, 10);
});

test('沒有任何快照時回空陣列', () => {
  assert.deepEqual(classWeakness([]), []);
  assert.deepEqual(classWeakness(undefined), []);
});

// ─────────────────────────────────────────────────────────────────
// 八、題型
// ─────────────────────────────────────────────────────────────────

test('依題型的答對率，低的排前面', () => {
  const out = typeBreakdown([
    { type: 'SINGLE_CHOICE', isCorrect: true },
    { type: 'SINGLE_CHOICE', isCorrect: true },
    { type: 'SINGLE_CHOICE', isCorrect: false },
    { type: 'MULTI_CHOICE', isCorrect: false },
    { type: 'MULTI_CHOICE', isCorrect: false },
  ]);
  assert.equal(out[0].type, 'MULTI_CHOICE');
  assert.equal(out[0].rate, 0);
  close(out[1].rate, 2 / 3);
});

test('還沒改完的非選題單獨算，不混進答對率', () => {
  const out = typeBreakdown([
    { type: 'ESSAY', isCorrect: null },
    { type: 'ESSAY', isCorrect: null },
    { type: 'ESSAY', isCorrect: true },
  ]);
  assert.equal(out[0].pending, 2);
  assert.equal(out[0].answered, 1);
  assert.equal(out[0].rate, 1);
});

test('一題都還沒改的題型沒有答對率，而且排最後', () => {
  const out = typeBreakdown([
    { type: 'ESSAY', isCorrect: null },
    { type: 'SINGLE_CHOICE', isCorrect: true },
  ]);
  assert.equal(out[out.length - 1].type, 'ESSAY');
  assert.equal(out[out.length - 1].rate, null, '空的不能顯示成 0%');
});

test('題型是空字串時歸到 UNKNOWN，不會整批消失', () => {
  const out = typeBreakdown([{ type: '', isCorrect: false }]);
  assert.equal(out[0].type, 'UNKNOWN');
});

// ─────────────────────────────────────────────────────────────────
// 九、門檻本身
// ─────────────────────────────────────────────────────────────────

test('門檻之間的關係要說得通', () => {
  assert.ok(WEAK < SOLID, '「要補」的線一定在「穩了」的線下面');
  assert.ok(STALE_FLOOR <= MIN_ITEMS, '證據總量的門檻不該比題數門檻嚴');
  assert.ok(PRIOR_WEIGHT > 0, '先驗是 0 的話，一題答對就會變成完全掌握');
  assert.ok(DIFF_SPAN < 2, '難度係數不能大到讓權重變成負的');
});

test('剛好在 SOLID 之上要花掉多少題', () => {
  // 這是給改門檻的人看的：SOLID 不是一個抽象的數字，
  // 它等於「六題份量的新證據而且全對」。
  assert.ok(masteryOf(items(6, true), { now: NOW }).mastery >= SOLID);
  assert.ok(masteryOf(items(5, true), { now: NOW }).mastery < SOLID);
});
