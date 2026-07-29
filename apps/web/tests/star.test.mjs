/**
 * 繁星推薦的校內賽局。
 *
 * # 這一支測的是兩種完全不同的失敗
 *
 * **第一種是算錯。** 最容易寫錯的是「第 1 至 3 類合計錄取 1 名」
 * 這一條：它是**結果端**的約束，不是參賽端的。若把它實作成參賽篩選、
 * 在模擬階段就剔除同校同大學的另一位推薦序 1，系統會告訴那位學生
 * 「你進不了第一輪」——而他實際上完全可能就是錄取的那一個。這個錯誤
 * 沒有任何症狀：畫面正常、數字合理、學生照著改了志願。
 *
 * **第二種是洩漏。** 在校成績百分比是全校最敏感的資料。學生端只該
 * 看到自己的序位這一個整數，而「不小心多回一個欄位」在 JSON API 上
 * 是最容易發生的事——加一個 `cohort` 讓畫面好寫一點，全校的百分比
 * 分布就出去了。所以這裡有一組測試直接對**序列化後的字串**下斷言：
 * 任何一個別人的 id 或百分比只要出現在輸出裡，不管藏在哪一層，
 * 都會被抓到。
 *
 * 推論攻擊也算在第二種裡：某個位置只有 2 個人時，排第 2 的那位
 * 只要看到「我排第 2」就能推知排第 1 的是誰（那個位置只有他們兩個）。
 * 所以人數少於 `MIN_COHORT` 時連名次都不能給。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CROSS_GROUP_SETS,
  FIRST_ROUND_ORDER,
  MIN_COHORT,
  PER_POSITION_QUOTA,
  SECOND_ROUND_MAX_ORDER,
  coordinatorReport,
  crossGroupSetOf,
  positionKey,
  sensitivityOf,
  simulate,
  studentView,
} from '../lib/star.mjs';

const NOW = new Date('2027-02-20T01:00:00Z');

/**
 * 一位參賽者。`percentile` 越小越好。
 *
 * `starGroup` 用 `in` 判斷而不是 `??`——測試要餵 `null` 與 `undefined`
 * 進去，用 `??` 的話它們會被預設值吃掉，於是「沒填學群」那一條測試
 * 其實從來沒有跑到。
 */
const who = (userId, percentile, extra = {}) => ({
  userId,
  percentile,
  institutionName: extra.institutionName ?? '臺灣大學',
  starGroup: 'starGroup' in extra ? extra.starGroup : 2,
  wishRank: extra.wishRank ?? 1,
});

const run = (participants, opts = {}) => simulate({ participants, now: NOW, ...opts });

/** 某個位置的模擬結果。 */
const posOf = (sim, institutionName, starGroup) =>
  sim.positions.find((p) => p.institutionName === institutionName && p.starGroup === starGroup);

// ═════════════════════════════════════════════════════════════════
// §1 第 1 步：校內推薦序分配與兩條硬限制
// ═════════════════════════════════════════════════════════════════

test('推薦序依在校百分比排，越小越前面', () => {
  const sim = run([who('c', 8.0), who('a', 1.5), who('b', 4.2)]);
  const pos = posOf(sim, '臺灣大學', 2);
  assert.deepEqual(
    pos.entries.map((e) => e.userId),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    pos.entries.map((e) => e.order),
    [1, 2, 3],
  );
});

test('硬限制一：每校對同一大學同一學群至多推薦 2 名', () => {
  const sim = run([who('a', 1), who('b', 2), who('c', 3), who('d', 4), who('e', 5)]);
  const pos = posOf(sim, '臺灣大學', 2);
  assert.equal(PER_POSITION_QUOTA, 2);
  assert.equal(pos.cohort, 5, '五個人都在排序裡');
  assert.deepEqual(
    pos.entries.filter((e) => e.nominated).map((e) => e.userId),
    ['a', 'b'],
    '只有前 2 名獲得校內推薦',
  );
  assert.equal(sim.totals.nominated, 2);
});

test('硬限制二：每生限一校一學群，多填的那幾個不成立', () => {
  // 同一位學生填了兩個繁星志願。實際成立的只有志願序最前面的那一個，
  // 後面那個**不是備選**——若讓他同時進兩個位置的排序，他會在兩邊
  // 各佔掉一位同學的名額，而那兩位同學看到的名次都是錯的。
  const sim = run([
    who('a', 1, { wishRank: 1, starGroup: 2 }),
    who('a', 1, { wishRank: 2, institutionName: '成功大學', starGroup: 3 }),
    who('b', 5, { starGroup: 2 }),
  ]);
  assert.equal(sim.totals.students, 1 + 1, 'a 只算一個人');
  assert.equal(posOf(sim, '臺灣大學', 2).cohort, 2);
  assert.equal(posOf(sim, '成功大學', 3), undefined, '第二個繁星志願不進模擬');
  assert.deepEqual(sim.dropped, [{ userId: 'a', institutionName: '成功大學', starGroup: 3 }]);
});

test('一校一學群：留下的是志願序最前面的，不是先遇到的', () => {
  // 輸入順序刻意顛倒。若實作成「先到先留」，這裡會留下志願序 2。
  const sim = run([
    who('a', 1, { wishRank: 3, institutionName: '清華大學', starGroup: 5 }),
    who('a', 1, { wishRank: 1, institutionName: '臺灣大學', starGroup: 2 }),
  ]);
  assert.equal(posOf(sim, '臺灣大學', 2).cohort, 1);
  assert.equal(sim.dropped.length, 1);
  assert.equal(sim.dropped[0].institutionName, '清華大學');
});

test('不同大學、不同學群各自是獨立的位置', () => {
  const sim = run([
    who('a', 1, { institutionName: '臺灣大學', starGroup: 1 }),
    who('b', 2, { institutionName: '臺灣大學', starGroup: 2 }),
    who('c', 3, { institutionName: '成功大學', starGroup: 1 }),
  ]);
  assert.equal(sim.positions.length, 3);
  for (const p of sim.positions) {
    assert.equal(p.cohort, 1);
    assert.equal(p.entries[0].order, 1, '各自都是自己位置的第 1 位');
  }
});

test('位置鍵不會因為大學名稱裡的符號而撞在一起', () => {
  // 「國立臺北大學」＋學群 12 與「國立臺北大學1」＋學群 2 若用字串
  // 直接相接會是同一個鍵，兩群學生會被排進同一份名次。
  assert.notEqual(positionKey('大學', 12), positionKey('大學1', 2));
});

// ═════════════════════════════════════════════════════════════════
// §2 第 2 步與第 3 步：參賽端 vs 結果端
//
// 整個檔案最重要的一組。
// ═════════════════════════════════════════════════════════════════

test('只有推薦序 1 參加第一輪', () => {
  const sim = run([who('a', 1), who('b', 2), who('c', 3)]);
  const pos = posOf(sim, '臺灣大學', 2);
  assert.equal(FIRST_ROUND_ORDER, 1);
  assert.deepEqual(
    pos.entries.filter((e) => e.firstRound).map((e) => e.userId),
    ['a'],
  );
});

test('第 1 至 3 類的跨學群排擠是結果端：兩位推薦序 1 都要進第一輪', () => {
  // 同一所高中在臺大第 1 類與第 2 類各推薦一位推薦序 1 的學生。
  // 這是本檔最容易寫錯的一條——若實作成參賽篩選，其中一位會被剔除，
  // 系統就會告訴他「你進不了第一輪」，而他實際上完全可能就是上榜的
  // 那一個（他與全國其他高中的推薦序 1 競爭，不是與同校的那位競爭）。
  const sim = run([
    who('a', 3.0, { starGroup: 1 }),
    who('b', 6.0, { starGroup: 2 }),
  ]);

  assert.equal(sim.totals.firstRound, 2, '兩人都在第一輪');
  assert.equal(posOf(sim, '臺灣大學', 1).entries[0].firstRound, true);
  assert.equal(posOf(sim, '臺灣大學', 2).entries[0].firstRound, true);

  // 排擠是被**指出來**，不是被執行。
  assert.equal(sim.squeeze.length, 1);
  assert.equal(sim.squeeze[0].institutionName, '臺灣大學');
  assert.equal(sim.squeeze[0].set, '第 1 至 3 類');
  assert.equal(sim.squeeze[0].admitLimit, 1);
  assert.deepEqual(
    sim.squeeze[0].members.map((m) => m.userId).sort(),
    ['a', 'b'],
  );

  // 而且百分比較差的那一位（b）沒有被降級成非第一輪。
  const bView = studentView(sim, 'b');
  assert.equal(bView.positions[0].firstRound, true, '不能因為同校有人比他好就說他沒資格');
});

test('三個學群各一位推薦序 1：三人都在第一輪，合計錄取上限仍是 1', () => {
  const sim = run([
    who('a', 2, { starGroup: 1 }),
    who('b', 4, { starGroup: 2 }),
    who('c', 6, { starGroup: 3 }),
  ]);
  assert.equal(sim.totals.firstRound, 3);
  assert.equal(sim.squeeze.length, 1);
  assert.equal(sim.squeeze[0].members.length, 3);
  assert.equal(sim.squeeze[0].admitLimit, 1);
});

test('跨學群排擠依組別分開算：第 1-3 類與第 4-7 類互不相干', () => {
  const sim = run([
    who('a', 2, { starGroup: 2 }),
    who('b', 4, { starGroup: 3 }),
    who('c', 6, { starGroup: 5 }),
    who('d', 8, { starGroup: 6 }),
  ]);
  const labels = sim.squeeze.map((s) => s.set).sort();
  assert.deepEqual(labels, ['第 1 至 3 類', '第 4 至 7 類']);
});

test('第 8 類（醫牙）自己一組，不與第 1-7 類合併', () => {
  // 第 8 類的甄試流程與第 1 至 7 類分開處理，排擠也是分開的。
  const sim = run([who('a', 2, { starGroup: 3 }), who('b', 4, { starGroup: 8 })]);
  assert.equal(sim.squeeze.length, 0, '一個在第 1-3 類、一個在第 8 類，沒有排擠');
  assert.equal(crossGroupSetOf(8).label, '第 8 類');
  assert.equal(crossGroupSetOf(8).admitLimit, 1);
});

test('不同大學之間沒有跨學群排擠', () => {
  const sim = run([
    who('a', 2, { institutionName: '臺灣大學', starGroup: 1 }),
    who('b', 4, { institutionName: '成功大學', starGroup: 2 }),
  ]);
  assert.equal(sim.squeeze.length, 0, '一校一名是「在每一所大學」，不是跨大學');
});

test('只有一位推薦序 1 時不算排擠', () => {
  const sim = run([who('a', 2, { starGroup: 1 }), who('b', 4, { starGroup: 1 })]);
  assert.equal(sim.squeeze.length, 0);
  assert.deepEqual(
    CROSS_GROUP_SETS.map((s) => s.admitLimit),
    [1, 1, 1],
  );
});

// ═════════════════════════════════════════════════════════════════
// §3 第 4 步：第二輪。不是零。
// ═════════════════════════════════════════════════════════════════

test('5 人競爭、第一輪 1 個名額，排第 4 的人看到的是位置與第二輪，不是「你沒機會」', () => {
  // 規格書 §7.6 點名的驗收案例。
  const sim = run([who('a', 1), who('b', 2), who('c', 3), who('d', 4), who('e', 5)]);
  const v = studentView(sim, 'd');

  assert.equal(v.positions.length, 1);
  const p = v.positions[0];
  assert.equal(p.order, 4, '校內排序第 4');
  assert.equal(p.hidden, false, '五個人，超過門檻，給得出具體名次');
  assert.equal(p.isFirst, false);
  assert.equal(p.nominated, false, '第 4 位拿不到校內推薦（名額 2）');
  assert.equal(p.firstRound, false, '只有推薦序 1 進第一輪');

  // **第二輪不能被當成零。** 把它當零是系統性的悲觀偏誤。
  assert.match(p.secondRoundNote, /不估第二輪的機率/);
  assert.match(p.secondRoundNote, /絕對不是零/);
  assert.match(p.secondRoundNote, /922 名/);

  // 而且不能出現「有相當把握」這類措辭——官方公布的只有最後一名
  // 錄取者的百分比，每年只有一個極值資料點。
  const text = JSON.stringify(v);
  for (const banned of ['有相當把握', '機率約', '把握', '穩上', '沒機會']) {
    assert.ok(!text.includes(banned), `學生端出現了 ${banned}`);
  }
});

test('獲得校內推薦的人都有第二輪的路（推薦序 1 未錄取也回到第二輪）', () => {
  const sim = run([who('a', 1), who('b', 2), who('c', 3)]);
  const pos = posOf(sim, '臺灣大學', 2);
  assert.equal(pos.entries[0].secondRound, true, '推薦序 1 第一輪未錄取仍有第二輪');
  assert.equal(pos.entries[1].secondRound, true, '推薦序 2 直接參加第二輪');
  assert.equal(pos.entries[2].secondRound, false, '沒獲得校內推薦就沒有任何一輪');
  assert.equal(SECOND_ROUND_MAX_ORDER, 6);
});

// ═════════════════════════════════════════════════════════════════
// §4 推論攻擊：人少的時候連名次都不能給
// ═════════════════════════════════════════════════════════════════

test('參與人數少於 3 人時不顯示具體名次', () => {
  // 兩個人的位置：排第 2 的那位只要看到「我排第 2」，就知道排第 1 的
  // 是另外那一位——而那個位置只有他們兩個，所以他直接推知了同學的
  // 相對百分比。
  assert.equal(MIN_COHORT, 3);
  const sim = run([who('a', 3), who('b', 7)]);

  const second = studentView(sim, 'b').positions[0];
  assert.equal(second.hidden, true);
  assert.equal(second.order, null, '不能給名次，也不能給任何替代值');
  assert.equal(second.isFirst, false, '「是不是第 1 位」還是給——這一項推不出別人是誰');
  assert.equal(second.sensitivity, null, '敏感度會洩漏人數，一起關掉');

  const first = studentView(sim, 'a').positions[0];
  assert.equal(first.hidden, true);
  assert.equal(first.order, null);
  assert.equal(first.isFirst, true);
});

test('剛好 3 人時開始給名次', () => {
  const sim = run([who('a', 1), who('b', 2), who('c', 3)]);
  const v = studentView(sim, 'c').positions[0];
  assert.equal(v.hidden, false);
  assert.equal(v.order, 3);
});

test('單一參與者：他是第 1 位，但同樣不給名次', () => {
  const sim = run([who('a', 4)]);
  const v = studentView(sim, 'a').positions[0];
  assert.equal(v.hidden, true);
  assert.equal(v.order, null);
  assert.equal(v.isFirst, true);
  assert.equal(v.nominated, true);
});

test('學生端的輸出不含任何其他學生的 id、百分比或人數', () => {
  // 這一條是這個功能能不能上線的關鍵，所以它對**序列化後的字串**
  // 下斷言而不是逐欄檢查——多回一個欄位（例如為了畫面好寫而加的
  // `cohort`）在逐欄檢查裡看不出來，在這裡會立刻炸。
  const sim = run([
    who('me', 40),
    who('classmate-1', 1.11),
    who('classmate-2', 2.22),
    who('classmate-3', 3.33),
    who('classmate-4', 4.44),
  ]);
  const text = JSON.stringify(studentView(sim, 'me'));

  for (const id of ['classmate-1', 'classmate-2', 'classmate-3', 'classmate-4']) {
    assert.ok(!text.includes(id), `洩漏了同學的 id：${id}`);
  }
  for (const pctl of ['1.11', '2.22', '3.33', '4.44']) {
    assert.ok(!text.includes(pctl), `洩漏了同學的百分比：${pctl}`);
  }
  // 連自己的百分比都不從賽局結果流出來——它由學生自己那一列
  // AcademicRank 另外給，兩條路徑分開才擋得住「順手一起回」。
  assert.ok(!text.includes('40'), '賽局結果不該帶百分比');
  assert.ok(!text.includes('percentile'), '不該有 percentile 這個欄位');
  assert.ok(!text.includes('cohort'), '不該回參與人數');
  assert.ok(text.includes('"order":5'), '自己的序位要在裡面');
});

test('學生端只會拿到自己的位置，不會拿到別人的', () => {
  const sim = run([
    who('me', 5, { starGroup: 2 }),
    who('other', 6, { institutionName: '成功大學', starGroup: 4 }),
  ]);
  const v = studentView(sim, 'me');
  assert.equal(v.positions.length, 1);
  assert.equal(v.positions[0].institutionName, '臺灣大學');
});

test('沒有填繁星志願的人拿到空清單，不是錯誤', () => {
  const sim = run([who('a', 1)]);
  const v = studentView(sim, 'nobody');
  assert.deepEqual(v.positions, []);
  assert.equal(v.unranked, false);
  assert.equal(v.droppedCount, 0);
});

test('結果端排擠對學生只講制度，不講校內有誰', () => {
  const sim = run([
    who('me', 6, { starGroup: 2 }),
    who('rival', 3, { starGroup: 1 }),
    who('x', 9, { starGroup: 3 }),
  ]);
  const v = studentView(sim, 'me').positions[0];
  assert.match(v.crossGroupNote, /第 1 至 3 類學群\*\*合計只錄取 1 名\*\*/);
  assert.match(v.crossGroupNote, /不影響你參加第一輪/);
  // 「校內還有兩位推薦序 1」是別人的資料。承辦人那一側才看得到。
  const text = JSON.stringify(v);
  assert.ok(!text.includes('rival') && !text.includes('"x"'));
  assert.ok(!/還有 \d+ 位/.test(text), '不能透露同校有幾個人');
});

test('非第一輪的學生不拿跨學群的說明（那一條對他還不相干）', () => {
  const sim = run([who('a', 1), who('b', 2), who('c', 3)]);
  assert.equal(studentView(sim, 'c').positions[0].crossGroupNote, null);
  assert.notEqual(studentView(sim, 'a').positions[0].crossGroupNote, null);
});

// ═════════════════════════════════════════════════════════════════
// §5 敏感度：精確但脆弱的數字要說出它有多脆弱
// ═════════════════════════════════════════════════════════════════

test('「若有一位排在你前面的同學改變志願，你會變成第 3」', () => {
  const sim = run([who('a', 1), who('b', 2), who('c', 3), who('d', 4), who('e', 5)]);
  const s = studentView(sim, 'd').positions[0].sensitivity;
  assert.equal(s.ifOneAheadLeaves.order, 3);
  assert.match(s.ifOneAheadLeaves.text, /你會變成第 3 位/);
  assert.equal(s.ifOneAheadLeaves.nominated, false, '第 3 位還是進不了推薦名單');
});

test('敏感度兩個方向都要說，不能只說對自己有利的那一邊', () => {
  const sim = run([who('a', 1), who('b', 2), who('c', 3)]);
  const s = studentView(sim, 'b').positions[0].sensitivity;
  // 往上：從第 2 變第 1，取得第一輪資格。
  assert.equal(s.ifOneAheadLeaves.order, 1);
  assert.match(s.ifOneAheadLeaves.text, /取得第一輪資格/);
  // 往下：從第 2 變第 3，掉出推薦名單。
  assert.equal(s.ifOneBetterJoins.order, 3);
  assert.equal(s.ifOneBetterJoins.nominated, false);
  assert.match(s.ifOneBetterJoins.text, /落到校內推薦名單之外/);
});

test('第 1 位沒有「往上」的敏感度，但有「往下」的', () => {
  const sim = run([who('a', 1), who('b', 2), who('c', 3)]);
  const s = studentView(sim, 'a').positions[0].sensitivity;
  assert.equal(s.ifOneAheadLeaves, null);
  assert.equal(s.ifOneBetterJoins.order, 2);
  assert.match(s.ifOneBetterJoins.text, /第一輪資格會換人/);
});

test('sensitivityOf 在 hidden 時一律回 null', () => {
  assert.equal(sensitivityOf(2, 2, true), null);
  assert.notEqual(sensitivityOf(2, 2, false), null);
});

// ═════════════════════════════════════════════════════════════════
// §6 邊界
// ═════════════════════════════════════════════════════════════════

test('零參與者：回一份空的結果，不是丟錯', () => {
  const sim = run([]);
  assert.deepEqual(sim.positions, []);
  assert.deepEqual(sim.squeeze, []);
  assert.equal(sim.totals.students, 0);
  const r = coordinatorReport(sim);
  assert.deepEqual(r.crowded, []);
  assert.deepEqual(r.empty, [], '沒有任何大學被關注時，不列「無人問津」');
});

test('同百分比：順序穩定，而且同分的人被標出來', () => {
  // 真的同分時是學校用推薦辦法的 tiebreak 決定，不是系統決定。
  // 系統若靜靜挑一個，承辦人會以為那就是答案。
  const a = run([who('b', 5), who('a', 5), who('c', 9)]);
  const b = run([who('a', 5), who('c', 9), who('b', 5)]);
  assert.deepEqual(
    posOf(a, '臺灣大學', 2).entries.map((e) => e.userId),
    posOf(b, '臺灣大學', 2).entries.map((e) => e.userId),
    '兩次跑要一樣，否則承辦人每按一次重算名單就變',
  );
  const entries = posOf(a, '臺灣大學', 2).entries;
  assert.equal(entries[0].tied, true);
  assert.equal(entries[1].tied, true);
  assert.equal(entries[2].tied, false);
  assert.equal(studentView(a, 'a').positions[0].tied, true);
});

test('沒有在校百分比的學生不排序，也不當成最後一名', () => {
  // 當成 100%（最差）處理會讓他看到一個「你排最後」的假結論，
  // 而真正的問題是教務處少匯了一列。
  const sim = run([who('a', 1), who('b', 2), who('nopct', null)]);
  assert.equal(posOf(sim, '臺灣大學', 2).cohort, 2);
  assert.deepEqual(sim.unranked, [
    { userId: 'nopct', institutionName: '臺灣大學', starGroup: 2 },
  ]);
  const v = studentView(sim, 'nopct');
  assert.equal(v.unranked, true);
  assert.deepEqual(v.positions, []);
});

test('繁星志願沒填學群：不猜一個，直接標出來', () => {
  // 繁星的整個競爭結構就是「大學 × 學群」。猜錯學群等於把這位學生
  // 放進別人的隊伍裡排序，而畫面上一切正常。
  for (const bad of [null, undefined, 0, 9, 'x']) {
    const sim = run([who('a', 1, { starGroup: bad }), who('b', 2, { starGroup: 2 })]);
    assert.equal(sim.positions.length, 1, `starGroup=${bad} 不該產生位置`);
    assert.deepEqual(sim.noGroup, [{ userId: 'a', institutionName: '臺灣大學' }]);
    assert.equal(studentView(sim, 'a').noGroup, true);
  }
});

test('quota 可以調整，硬限制跟著動', () => {
  // 校內推薦辦法是可設定的（`StarNominationRule`），所以名額不能寫死。
  const sim = run([who('a', 1), who('b', 2), who('c', 3)], { quota: 1 });
  const pos = posOf(sim, '臺灣大學', 2);
  assert.deepEqual(
    pos.entries.filter((e) => e.nominated).map((e) => e.userId),
    ['a'],
  );
  assert.equal(studentView(sim, 'b').positions[0].nominated, false);
});

test('模擬結果帶計算時間（志願一改就過期）', () => {
  // 這個功能的存在本身會改變它的輸入：學生看到「改推成大你是第 1 位」
  // 就會去改，上一輪的結論隨即失效。所以每一份結果都要標時間。
  const sim = run([who('a', 1)]);
  assert.equal(sim.computedAt, NOW.toISOString());
  assert.equal(studentView(sim, 'a').computedAt, NOW.toISOString());
  assert.equal(coordinatorReport(sim).computedAt, NOW.toISOString());
});

// ═════════════════════════════════════════════════════════════════
// §7 承辦人端：哪裡會出事
// ═════════════════════════════════════════════════════════════════

test('競爭過度集中的位置列得出來', () => {
  const sim = run([
    who('a', 1),
    who('b', 2),
    who('c', 3),
    who('d', 4),
    who('e', 5),
    who('z', 9, { institutionName: '成功大學', starGroup: 4 }),
  ]);
  const r = coordinatorReport(sim);
  assert.equal(r.crowded.length, 1);
  assert.equal(r.crowded[0].institutionName, '臺灣大學');
  assert.equal(r.crowded[0].cohort, 5);
  assert.equal(r.crowded[0].squeezedOut, 3, '5 人搶 2 個推薦名額，3 人擠不進去');
});

test('名額沒用完與完全無人推薦的位置都列得出來', () => {
  // 校內沒人推薦等於白白放棄一個機會，而且不會有人來反映——
  // 沒有人受害，所以沒有人知道。
  const sim = run([who('a', 1, { starGroup: 2 })]);
  const r = coordinatorReport(sim);
  assert.deepEqual(r.unused, [
    { institutionName: '臺灣大學', starGroup: 2, cohort: 1, unusedSlots: 1 },
  ]);
  assert.equal(r.empty.length, 1);
  assert.deepEqual(r.empty[0], {
    institutionName: '臺灣大學',
    starGroup: [1, 3, 4, 5, 6, 7, 8],
  });
});

test('承辦人看得到跨學群排擠的當事人（學生端看不到）', () => {
  const sim = run([who('a', 2, { starGroup: 1 }), who('b', 4, { starGroup: 2 })]);
  const r = coordinatorReport(sim);
  assert.equal(r.squeeze.length, 1);
  assert.deepEqual(r.squeeze[0].members.map((m) => m.userId).sort(), ['a', 'b']);
  // 這正是兩側的分野：同一份模擬，承辦人拿到事實，學生拿到制度。
  assert.ok(!JSON.stringify(studentView(sim, 'a')).includes('b'));
});

test('承辦人看得到「填了志願但沒有百分比」與「沒填學群」的名單', () => {
  const sim = run([
    who('nopct', null),
    who('nogrp', 3, { starGroup: null }),
    who('ok', 1),
  ]);
  const r = coordinatorReport(sim);
  assert.deepEqual(r.unranked.map((u) => u.userId), ['nopct']);
  assert.deepEqual(r.noGroup.map((u) => u.userId), ['nogrp']);
});

test('全校總計對得起來', () => {
  const sim = run([
    who('a', 1, { starGroup: 1 }),
    who('b', 2, { starGroup: 1 }),
    who('c', 3, { starGroup: 1 }),
    who('d', 4, { starGroup: 2 }),
  ]);
  const r = coordinatorReport(sim);
  assert.equal(r.totals.students, 4);
  assert.equal(r.totals.positions, 2);
  assert.equal(r.totals.nominated, 3, '第 1 類推 2 名、第 2 類推 1 名');
  assert.equal(r.totals.firstRound, 2, '兩個位置各一位推薦序 1');
});

test('300 位學生的全校模擬跑得完（規格書 §7.6 要求 10 秒內）', () => {
  const participants = Array.from({ length: 300 }, (_, i) =>
    who(`s${i}`, (i % 97) + 0.5, {
      institutionName: `大學${i % 12}`,
      starGroup: (i % 8) + 1,
    }),
  );
  const t0 = Date.now();
  const sim = simulate({ participants, now: NOW });
  const report = coordinatorReport(sim);
  const ms = Date.now() - t0;
  assert.equal(sim.totals.students, 300);
  assert.ok(ms < 2000, `跑了 ${ms}ms`);
  assert.ok(report.positions.length > 0);
  // 每位學生都查得到自己那一片，而且都不含別人的 id。
  const v = studentView(sim, 's7');
  assert.equal(v.positions.length, 1);
  assert.ok(!JSON.stringify(v).includes('s8'));
});
