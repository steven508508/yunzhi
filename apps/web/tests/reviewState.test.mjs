/**
 * 校對介面的三條判斷：選項編輯、存檔佇列、校對用時。
 *
 * # 這一支測的是「改完之後畫面看起來對，資料庫裡是錯的」
 *
 * 三組的共同點是**錯了不會有任何跡象**：
 *
 *   · 刪掉一個選項而答案鍵沒跟著搬 —— 題目入庫，每個答對的學生被判錯
 *   · 存檔連續失敗而標頭寫「已儲存」 —— 老師照著它關掉分頁
 *   · 校對用時累加錯 —— 業主驗收看的那個數字是假的
 *
 * 沒有一種會讓端對端測試變紅，也不會在主控台留下痕跡。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addOption,
  answerKeysForType,
  commitBlocked,
  fmtDuration,
  moveOption,
  nextOptionLabel,
  optionIssues,
  paceEstimate,
  removeOption,
  reviewSecondsDelta,
  reviewSummary,
  saveBatchSize,
  saveIndicator,
  saveRetryDelay,
  setOptionContent,
  toggleAnswerKey,
} from '../lib/reviewState.mjs';

const opts = (...contents) =>
  contents.map((content, i) => ({ order: i + 1, label: String(i + 1), content }));

// ─────────────────────────────────────────────────────────────────
// 一、選項增刪之後的答案鍵對映
// ─────────────────────────────────────────────────────────────────

test('刪掉答案前面的選項，答案鍵要往前挪一格', () => {
  // 原稿 (1)60元 (2)70元 (3)80元 (4)90元，答案是 (4)90元。
  // 老師發現 (2) 是掃描重複抽到的，刪掉它——答案還是「90元」，
  // 但它現在是第 3 個。沒有搬的話學生選 90 元會被判錯。
  const r = removeOption(opts('60元', '70元', '80元', '90元'), [4], 2);
  assert.deepEqual(r.options.map((o) => o.content), ['60元', '80元', '90元']);
  assert.deepEqual(r.options.map((o) => o.order), [1, 2, 3]);
  assert.deepEqual(r.answerKeys, [3]);
  assert.equal(r.options[2].content, '90元', '答案鍵指的還是同一個內容');
});

test('刪掉答案後面的選項，答案鍵不動', () => {
  const r = removeOption(opts('a', 'b', 'c', 'd'), [2], 4);
  assert.deepEqual(r.answerKeys, [2]);
  assert.equal(r.options[1].content, 'b');
});

test('刪掉的就是答案那一個，要說出來而不是安靜清掉', () => {
  const r = removeOption(opts('a', 'b', 'c'), [2], 2);
  assert.deepEqual(r.answerKeys, []);
  assert.deepEqual(r.dropped, [2], '呼叫端要拿得到「答案被弄掉了」這件事');
});

test('多選題刪掉中間的選項，兩個答案鍵各自搬到對的位置', () => {
  const r = removeOption(opts('a', 'b', 'c', 'd', 'e'), [2, 5], 3);
  assert.deepEqual(r.options.map((o) => o.content), ['a', 'b', 'd', 'e']);
  assert.deepEqual(r.answerKeys, [2, 4]);
});

test('新增選項不會被當成空選項丟掉', () => {
  // normalizeOptions 對空內容的選項是「丟掉」，那是入庫時該有的行為。
  // 編輯途中丟掉的話，老師按下「新增選項」之後那一列直接消失。
  const r = addOption(opts('a', 'b'), [1]);
  assert.equal(r.options.length, 3);
  assert.equal(r.options[2].content, '');
  assert.equal(r.options[2].order, 3);
  assert.deepEqual(r.answerKeys, [1]);
});

test('新增之後打字，答案鍵一路都沒有被動到', () => {
  let r = addOption(opts('60元', '70元', '80元'), [3]);
  r = setOptionContent(r.options, r.answerKeys, 4, '90元');
  assert.deepEqual(r.options.map((o) => o.content), ['60元', '70元', '80元', '90元']);
  assert.deepEqual(r.answerKeys, [3]);
});

test('新增的選項標籤要接得上前面的寫法', () => {
  assert.equal(nextOptionLabel([{ label: 'A' }, { label: 'B' }]), 'C');
  assert.equal(nextOptionLabel([{ label: '1' }, { label: '2' }, { label: '3' }]), '4');
  assert.equal(nextOptionLabel([{ label: '甲' }, { label: '乙' }]), '丙');
  assert.equal(nextOptionLabel([]), '1');
  // 混用時不要猜，用序號
  assert.equal(nextOptionLabel([{ label: 'A' }, { label: '2' }]), '3');
});

test('往下移一格，答案跟著內容走而不是留在原位', () => {
  // 標籤與序號屬於位置（答案卡上的 (1) 永遠是第一格），搬的是內容。
  const r = moveOption(opts('a', 'b', 'c'), [2], 2, 1);
  assert.deepEqual(r.options.map((o) => o.content), ['a', 'c', 'b']);
  assert.deepEqual(r.options.map((o) => o.label), ['1', '2', '3'], '標籤不跟著跑');
  assert.deepEqual(r.answerKeys, [3], '答案 b 現在在第 3 格');
});

test('往上移一格，同樣', () => {
  const r = moveOption(opts('a', 'b', 'c'), [3], 3, -1);
  assert.deepEqual(r.options.map((o) => o.content), ['a', 'c', 'b']);
  assert.deepEqual(r.answerKeys, [2]);
});

test('移動與答案無關的選項時，答案鍵不動', () => {
  const r = moveOption(opts('a', 'b', 'c', 'd'), [1], 3, 1);
  assert.deepEqual(r.options.map((o) => o.content), ['a', 'b', 'd', 'c']);
  assert.deepEqual(r.answerKeys, [1]);
});

test('多選題把兩個都是答案的相鄰選項對調，答案鍵不變', () => {
  const r = moveOption(opts('a', 'b', 'c'), [1, 2], 1, 1);
  assert.deepEqual(r.options.map((o) => o.content), ['b', 'a', 'c']);
  assert.deepEqual(r.answerKeys, [1, 2]);
});

test('移到邊界外就什麼都不做', () => {
  const r = moveOption(opts('a', 'b'), [1], 1, -1);
  assert.deepEqual(r.options.map((o) => o.content), ['a', 'b']);
  assert.deepEqual(r.answerKeys, [1]);
});

test('多選改單選只留第一個答案', () => {
  // 留兩個的話那一題有兩個「唯一解」，而計分照第一個算——看不出來。
  assert.deepEqual(answerKeysForType('SINGLE_CHOICE', [3, 1]), [1]);
  assert.deepEqual(answerKeysForType('MULTI_CHOICE', [3, 1]), [1, 3]);
  assert.deepEqual(answerKeysForType('ESSAY', [1]), [], '非選擇題不留答案鍵');
});

test('單選題點第二個選項是換答案，不是加答案', () => {
  assert.deepEqual(toggleAnswerKey('SINGLE_CHOICE', [1], 2), [2]);
  assert.deepEqual(toggleAnswerKey('MULTI_CHOICE', [1], 2), [1, 2]);
  assert.deepEqual(toggleAnswerKey('MULTI_CHOICE', [1, 2], 2), [1], '再點一次取消');
});

test('入庫會被退回的毛病，在編輯當下就說', () => {
  const dup = optionIssues(opts('$\\vec{v}$', '$v$', '$v$'), [1], 'SINGLE_CHOICE');
  assert.ok(dup.some((i) => i.code === 'duplicate_option'));

  const blank = optionIssues(opts('a', ''), [1], 'SINGLE_CHOICE');
  assert.ok(blank.some((i) => i.code === 'blank_option'));

  const none = optionIssues(opts('a', 'b'), [], 'SINGLE_CHOICE');
  assert.ok(none.some((i) => i.code === 'no_answer'));

  const orphan = optionIssues(opts('a', 'b'), [5], 'SINGLE_CHOICE');
  assert.ok(orphan.some((i) => i.code === 'answer_orphan'));

  assert.deepEqual(optionIssues(opts('a', 'b'), [1], 'SINGLE_CHOICE'), []);
});

// ─────────────────────────────────────────────────────────────────
// 二、存檔佇列的狀態機
// ─────────────────────────────────────────────────────────────────

test('一開始什麼都還沒存，指示器不說話', () => {
  const s = saveIndicator({});
  assert.equal(s.kind, 'idle');
  assert.equal(s.label, '');
});

test('全部送完了才是已儲存，而且要帶時刻', () => {
  const s = saveIndicator({ pendingCount: 0, savedAtLabel: '09:12' });
  assert.equal(s.kind, 'saved');
  assert.match(s.label, /09:12/);
});

test('佇列裡還有東西就不可以說已儲存', () => {
  const s = saveIndicator({ pendingCount: 3, savedAtLabel: '09:12' });
  assert.equal(s.kind, 'saving');
});

test('存檔失敗過就不可以再退回「已儲存」——這是校對介面的那個 bug', () => {
  // 舊版失敗路徑一個 UI 狀態都沒有：savedAt 保持上一次成功的值，
  // 畫面繼續寫「已儲存」，而老師照著它決定關掉分頁。
  const s = saveIndicator({ pendingCount: 4, failures: 2, savedAtLabel: '09:12' });
  assert.equal(s.kind, 'failing');
  assert.equal(s.urgent, true);
  assert.match(s.label, /未儲存 4 題/);
  assert.match(s.detail, /不要關掉/);
});

test('失敗但佇列剛好是空的，也不可以說「未儲存 0 題」', () => {
  const s = saveIndicator({ pendingCount: 0, failures: 1 });
  assert.match(s.label, /未儲存 1 題/);
});

test('401 要說得出是登入過期，而不是叫他一直等重試', () => {
  const s = saveIndicator({ pendingCount: 6, failures: 3, lastStatus: 401 });
  assert.match(s.detail, /登入過期/);
  assert.match(s.detail, /不要關掉/);
});

test('連續失敗時批次越切越小，最後一筆一筆送', () => {
  // saveReviews 是單一交易，一筆壞資料會讓整批回滾。切小之後
  // 壞的那一筆自己被隔離出來，其餘的存得進去。
  assert.equal(saveBatchSize(0), 100);
  assert.ok(saveBatchSize(1) < saveBatchSize(0));
  assert.ok(saveBatchSize(2) < saveBatchSize(1));
  assert.equal(saveBatchSize(3), 1);
  assert.equal(saveBatchSize(9), 1);
});

test('重試間隔會往後退，但不會退到永遠不試', () => {
  assert.equal(saveRetryDelay(0), 8_000);
  assert.ok(saveRetryDelay(4) > saveRetryDelay(1));
  assert.equal(saveRetryDelay(99), saveRetryDelay(4), '超過表尾就維持最後一格');
});

test('存檔失敗時擋住入庫，並說得出為什麼', () => {
  const b = commitBlocked({ failures: 2, pendingCount: 7, ready: 30 });
  assert.equal(b.blocked, true);
  assert.match(b.reason, /7 題/);

  assert.equal(commitBlocked({ failures: 0, ready: 30 }).blocked, false);
  assert.equal(commitBlocked({ failures: 0, ready: 0 }).blocked, true);
  assert.equal(commitBlocked({ failures: 1, ready: 30 }).blocked, false, '偶發一次不擋');
});

// ─────────────────────────────────────────────────────────────────
// 三、校對用時
// ─────────────────────────────────────────────────────────────────

test('回報的是增量，跨場次才接得起來', () => {
  assert.equal(reviewSecondsDelta(0, 30), 30);
  assert.equal(reviewSecondsDelta(30, 95), 65);
  assert.equal(reviewSecondsDelta(95, 95), 0);
});

test('倒退或壞值一律當成 0，不可以讓總時數變短', () => {
  assert.equal(reviewSecondsDelta(100, 40), 0);
  assert.equal(reviewSecondsDelta(NaN, 40), 40);
  assert.equal(reviewSecondsDelta(0, NaN), 0);
});

test('分頁掛了一整晚，第一次回報不可以送四萬秒', () => {
  // 那個數字正好是業主驗收要看的那一個。
  assert.equal(reviewSecondsDelta(10, 40_000, 900), 900);
});

test('推估的分子分母都只算本次工作階段', () => {
  // 昨天校了 30 題，今天開頁後 60 秒內校了 10 題 → 每題 6 秒，
  // 而不是「60 秒除以 40 題」的 1.5 秒。
  const p = paceEstimate({ doneNow: 40, doneAtMount: 30, elapsedSec: 60, total: 50 });
  assert.equal(p.per, 6);
  assert.equal(p.est, 300);
  assert.equal(p.remaining, 60);
  assert.equal(p.ok, true);
});

test('樣本太少就不顯示推估', () => {
  // 第一題花 90 秒讀完，舊版會跳出「推估 75:00」把人嚇跑。
  assert.equal(paceEstimate({ doneNow: 1, doneAtMount: 0, elapsedSec: 90, total: 50 }), null);
  assert.equal(paceEstimate({ doneNow: 31, doneAtMount: 30, elapsedSec: 2, total: 50 }), null);
});

test('超過 20 分鐘的節奏要標成沒達標', () => {
  const p = paceEstimate({ doneNow: 10, doneAtMount: 0, elapsedSec: 300, total: 50 });
  assert.equal(p.est, 1500);
  assert.equal(p.ok, false);
});

test('完成時說得出「N 題花了 M 分鐘」，並換算成 50 題', () => {
  const s = reviewSummary({ total: 50, seconds: 1020 });
  assert.match(s.text, /50 題/);
  assert.match(s.text, /17 分/);
  assert.equal(Math.round(s.projectedFifty), 1020);

  const small = reviewSummary({ total: 12, seconds: 600 });
  assert.equal(Math.round(small.projectedFifty), 2500, '12 題 10 分鐘換算成 50 題是超標的');
  assert.equal(reviewSummary({ total: 0, seconds: 100 }), null);
});

test('用時的寫法對老師是可讀的', () => {
  assert.equal(fmtDuration(45), '45 秒');
  assert.equal(fmtDuration(120), '2 分');
  assert.equal(fmtDuration(125), '2 分 5 秒');
});
