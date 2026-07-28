/**
 * 知識點前置圖譜的環路偵測。
 *
 * 環不是有人故意加的，是三位老師各自加了一條邊之後湊出來的：
 *
 *     甲：三角函數 需要 弧度
 *     乙：弧度 需要 圓的方程式
 *     丙：圓的方程式 需要 三角函數     ← 這一條把環閉合了
 *
 * 丙老師看不到前兩條的組合效果，所以偵測必須在加邊的當下做。
 *
 * 有環的代價很具體：智慧老師往回找前置觀念、能力分析往下傳學分，
 * 兩者都是遞迴，**都會無限迴圈**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { allCycles, findCycle, topoSort } from '../lib/graph.mjs';

/** edges: kp → 它的前置 */
const g = (o) => new Map(Object.entries(o));

test('自己不能是自己的前置', () => {
  assert.deepEqual(findCycle(g({}), 'a', 'a'), ['a', 'a']);
});

test('直接互為前置擋得住', () => {
  // 已有 a 需要 b，現在要加 b 需要 a
  assert.ok(findCycle(g({ a: ['b'] }), 'b', 'a'));
});

test('三個人各加一條邊湊出來的環', () => {
  // 甲：三角 需要 弧度／乙：弧度 需要 圓方程／丙要加：圓方程 需要 三角
  const edges = g({ 三角: ['弧度'], 弧度: ['圓方程'] });
  const cycle = findCycle(edges, '圓方程', '三角');
  assert.ok(cycle, '第三條邊沒被擋下來');
  // 訊息要指出整條環路，只說「不能加」的話老師會覺得系統壞了
  assert.ok(cycle.includes('三角') && cycle.includes('弧度') && cycle.includes('圓方程'), cycle);
});

test('不成環的邊要放行', () => {
  const edges = g({ 三角: ['弧度'], 弧度: ['圓方程'] });
  assert.equal(findCycle(edges, '圓方程', '座標'), null);
  assert.equal(findCycle(edges, '微分', '三角'), null);
});

test('鑽石形狀不是環', () => {
  // d 需要 b 與 c，兩者都需要 a。常見且完全合法。
  const edges = g({ d: ['b', 'c'], b: ['a'], c: ['a'] });
  assert.equal(findCycle(edges, 'd', 'a'), null);
});

test('長鏈也走得完，不會誤判', () => {
  const edges = new Map();
  for (let i = 0; i < 200; i++) edges.set(`n${i}`, [`n${i + 1}`]);
  assert.equal(findCycle(edges, 'n0', 'n199'), null, '長鏈被誤判成環');
  assert.ok(findCycle(edges, 'n199', 'n0'), '長鏈的閉合沒被抓到');
});

test('拓樸排序給出教學順序', () => {
  // 邊的方向是「kp 需要 prereq」，排序要從最基礎排到最進階
  const order = topoSort(['乘法公式', '因式分解', '二次方程'], g({
    因式分解: ['乘法公式'],
    二次方程: ['因式分解'],
  }));
  assert.deepEqual(order, ['乘法公式', '因式分解', '二次方程']);
});

test('有環時拓樸排序回 null，而不是給一個錯的順序', () => {
  assert.equal(topoSort(['a', 'b'], g({ a: ['b'], b: ['a'] })), null);
});

test('掃得出既有資料裡的環', () => {
  // 環路偵測是後來才加的。在那之前建的資料可能已經有環，
  // 而那些環會在智慧老師第一次往回走時變成無限迴圈。
  const cycles = allCycles(g({ a: ['b'], b: ['c'], c: ['a'], d: ['a'] }));
  assert.equal(cycles.length, 1);
  assert.equal(new Set(cycles[0]).size, 3, `環路內容不對：${cycles[0]}`);
});

test('沒有環時掃出來是空的', () => {
  assert.deepEqual(allCycles(g({ a: ['b'], b: ['c'] })), []);
});
