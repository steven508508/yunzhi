/**
 * 組卷的三個純判斷。
 *
 * # 為什麼這一份的每一格都值得寫下來
 *
 * 因為這三件事錯了**都不會有錯誤訊息**，而且都要等到考完才看得出來：
 *
 *   · 配分分完加起來不是 100 → 卷頭印 100 分，成績頁的得分率用另一個
 *     數字當分母。老師要自己把 25 個數字加起來才會發現。
 *   · 同一題的兩個版本進了同一份卷子 → 資料庫的唯一鍵擋不住（不同列），
 *     學生在同一張卷子上看到兩題只差一個字的題目。
 *   · 移動一題算錯位置 → 送出去的是完整的新順序，伺服器照收。
 *
 * 所以每一個測試的註解寫的是**錯了會怎樣**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  alreadyPicked,
  moveTo,
  spreadScores,
  sumScores,
  uniformScores,
  usageByQuestion,
} from '../lib/paperPlan.mjs';

// ─────────────────────────────────────────────────────────────────
// 平均分配到 100 分
// ─────────────────────────────────────────────────────────────────

test('除得盡時每一題同分', () => {
  // 25 題 100 分是最常見的段考卷。這一格錯了，最常見的那一份就錯了。
  assert.deepEqual(spreadScores(25, 100), Array.from({ length: 25 }, () => 4));
});

test('除不盡時餘數落在最後幾題，而且總和剛好等於總分', () => {
  // 24 題 100 分：前 20 題 4 分、後 4 題 5 分。餘數散在中間的話，
  // 老師就寫不出卷頭那句「前 20 題各 4 分」。
  const got = spreadScores(24, 100);
  assert.equal(sumScores(got), 100);
  assert.deepEqual(got.slice(0, 20), Array.from({ length: 20 }, () => 4));
  assert.deepEqual(got.slice(20), [5, 5, 5, 5]);
});

test('題數是質數也湊得回總分', () => {
  // 3 題 100 分 → 33、33、34。硬取整會變成 33×3 = 99，
  // 而少的那 1 分不會有任何提示。
  assert.deepEqual(spreadScores(3, 100), [33, 33, 34]);
  for (const n of [7, 11, 13, 17, 19, 23, 29]) {
    assert.equal(sumScores(spreadScores(n, 100)), 100, `${n} 題湊不回 100`);
  }
});

test('總分不到題數時退到 0.5 分，而不是讓某些題變成 0 分', () => {
  // 25 題 20 分。用 1 分當單位會分出 5 題 0 分，而 0 分的題目在
  // 作答畫面上與其他題長得一模一樣——學生寫完發現「我明明對了」。
  const got = spreadScores(25, 20);
  assert.equal(sumScores(got), 20);
  assert.ok(
    got.every((s) => s > 0),
    `不該有 0 分的題目：${got.join('、')}`,
  );
  assert.deepEqual(new Set(got), new Set([0.5, 1]));
});

test('總分連 0.5 都不夠分時退到 0.01', () => {
  // 25 題 10 分（小考）。仍然不可以有 0 分的題目。
  const got = spreadScores(25, 10);
  assert.equal(sumScores(got), 10);
  assert.ok(got.every((s) => s > 0));
  assert.deepEqual(got, Array.from({ length: 25 }, () => 0.4));
});

test('總分帶小數時用 0.5 為單位，湊得回原本的數字', () => {
  // 100.5 用 1 分當單位會湊出 101——多出來的那一分會進到卷頭。
  const got = spreadScores(25, 100.5);
  assert.equal(sumScores(got), 100.5);
});

test('浮點數的尾巴不會漏到配分上', () => {
  // 每一格都要是乾淨的兩位小數，否則 4.999999999999999 會被印在卷面上。
  for (const [n, total] of [
    [3, 10],
    [7, 100],
    [24, 100],
    [25, 20],
    [40, 100],
  ]) {
    for (const s of spreadScores(n, total)) {
      assert.equal(s, Math.round(s * 100) / 100, `${n} 題 ${total} 分分出了 ${s}`);
    }
  }
});

test('0 題與 0 分不會爆，也不會分出負數', () => {
  assert.deepEqual(spreadScores(0, 100), []);
  assert.deepEqual(spreadScores(3, 0), [0, 0, 0]);
  assert.throws(() => spreadScores(-1, 100), /題數/);
  assert.throws(() => spreadScores(3, -5), /總分/);
});

test('全部設成同一個分數時，加總是老師按下去之前該看到的數字', () => {
  assert.deepEqual(uniformScores(4, 2.5), [2.5, 2.5, 2.5, 2.5]);
  assert.equal(sumScores(uniformScores(20, 2.5)), 50);
  // 25 題各 0.4 分：直接相加是 10.000000000000004，而那個數字會被
  // 印在卷頭上、拿去當得分率的分母。這一格是在確認浮點數真的會漏，
  // 收尾函式不是白寫的。
  assert.notEqual(
    uniformScores(25, 0.4).reduce((a, b) => a + b, 0),
    10,
    '浮點數不漏了？那 sumScores 的存在理由要重寫',
  );
  assert.equal(sumScores(uniformScores(25, 0.4)), 10);
});

// ─────────────────────────────────────────────────────────────────
// 重複加題的偵測
// ─────────────────────────────────────────────────────────────────

const onPaper = [
  { questionId: 'q1', familyId: 'f1', order: 1 },
  { questionId: 'q2', familyId: 'f2', order: 2 },
];

test('同一列題目再加一次要認得出來，而且說得出在第幾題', () => {
  assert.deepEqual(alreadyPicked(onPaper, { questionId: 'q2', familyId: 'f2' }), {
    kind: 'same',
    order: 2,
  });
});

test('同一題的另一個版本也是重複——資料庫的唯一鍵擋不住這一種', () => {
  // q2 改過一次生出 q2v2：questionId 不同（所以 UNIQUE(paperId, questionId)
  // 放行），familyId 相同。放行的結果是同一張卷子上兩題只差一個字。
  assert.deepEqual(alreadyPicked(onPaper, { questionId: 'q2v2', familyId: 'f2' }), {
    kind: 'version',
    order: 2,
  });
});

test('沒加過的題目回 null', () => {
  assert.equal(alreadyPicked(onPaper, { questionId: 'q9', familyId: 'f9' }), null);
});

test('familyId 是空的時候不當成重複', () => {
  // 空字串對空字串會把所有沒有 familyId 的題目判成同一題，
  // 症狀是老師在題庫裡點什麼都被說「已經在卷子上了」。
  const odd = [{ questionId: 'qa', familyId: '', order: 1 }];
  assert.equal(alreadyPicked(odd, { questionId: 'qb', familyId: '' }), null);
});

test('「這一題用過幾次」依卷子分組、去重、並算出還有幾份沒列', () => {
  const rows = [
    { questionId: 'q1', paperId: 'p9', paperTitle: '113上第二次段考' },
    { questionId: 'q1', paperId: 'p8', paperTitle: '113上小考三' },
    { questionId: 'q1', paperId: 'p7', paperTitle: '112下複習卷' },
    // 同一份卷子重複送進來（join 出來的列有可能重複）
    { questionId: 'q1', paperId: 'p9', paperTitle: '113上第二次段考' },
    { questionId: 'q2', paperId: 'p9', paperTitle: '113上第二次段考' },
  ];
  const usage = usageByQuestion(rows, 2);
  assert.equal(usage.get('q1').count, 3, '去重之後是三份卷子，不是四份');
  assert.deepEqual(
    usage.get('q1').papers.map((p) => p.title),
    ['113上第二次段考', '113上小考三'],
  );
  assert.equal(usage.get('q1').more, 1);
  assert.equal(usage.get('q2').count, 1);
  assert.equal(usage.get('q2').more, 0);
  assert.equal(usage.get('q3'), undefined);
});

// ─────────────────────────────────────────────────────────────────
// 排序
// ─────────────────────────────────────────────────────────────────

const five = ['a', 'b', 'c', 'd', 'e'];

test('往後移：中間的題目不會被吃掉', () => {
  // 送出去的是一份完整的新順序，伺服器照收。少一個 id 會被擋，
  // 但**順序錯了不會**——那才是這裡真正要守的事。
  assert.deepEqual(moveTo(five, 0, 2), ['b', 'c', 'a', 'd', 'e']);
});

test('往前移', () => {
  assert.deepEqual(moveTo(five, 4, 1), ['a', 'e', 'b', 'c', 'd']);
});

test('移到自己的位置就是原地不動', () => {
  assert.deepEqual(moveTo(five, 2, 2), five);
});

test('目標超出範圍夾到兩端，不丟錯', () => {
  // 25 題的卷子上打「99」意思是「移到最後」，不是「我打錯了」。
  assert.deepEqual(moveTo(five, 0, 99), ['b', 'c', 'd', 'e', 'a']);
  assert.deepEqual(moveTo(five, 4, -3), ['e', 'a', 'b', 'c', 'd']);
});

test('任何一次移動之後，題目的集合都不會變', () => {
  // 集合變了伺服器會擋（reorderPaperItems 的兩道檢查），而老師看到的
  // 是「有人同時在改同一份卷子」——一句與真正原因無關的話。
  for (let from = 0; from < five.length; from++) {
    for (let to = -2; to < five.length + 2; to++) {
      const got = moveTo(five, from, to);
      assert.equal(got.length, five.length);
      assert.deepEqual([...got].sort(), [...five].sort(), `${from} → ${to} 弄丟了題目`);
    }
  }
});

test('來源不在卷子上就丟錯', () => {
  assert.throws(() => moveTo(five, 9, 0), /不在這份卷子上/);
  assert.throws(() => moveTo(five, -1, 0), /不在這份卷子上/);
  assert.throws(() => moveTo(five, 0, NaN), /第幾題/);
});
