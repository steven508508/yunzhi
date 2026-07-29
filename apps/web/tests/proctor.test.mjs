/**
 * 考試行為的合併與去抖動。
 *
 * # 這一支測的是「一場考試留下四百筆噪音」
 *
 * 這裡每一條規則要處理的情況，開發機上一個都重現不出來：
 *
 *   · 手機切輸入法連續送出 blur/focus——桌機不會
 *   · 切分頁同時送出 blur 與 visibilitychange——分開記就變成兩次
 *   · 學生把系統時間往回調——正式環境每一場考試都可能發生
 *   · 分頁被系統回收時那一段離開還沒結束——最值得記的一種
 *
 * 而且它們全部**不會讓任何東西壞掉**：畫面正常、API 回 200、
 * 資料庫裡有列。壞的只是那些列沒有意義——噪音把訊號蓋掉了，
 * 而蓋掉之後的症狀是「老師看了一眼就不再看這個功能」。
 *
 * 另外一半測的是老師端的整理：**沒有任何一個函式可以回傳判斷。**
 * 全班都有大量事件時不可以標任何人，「切走之後沒有回來」不可以
 * 被算成 0 秒。這兩條錯了的代價是一個沒有作弊的學生被找去談話。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classBaseline,
  createProctorTracker,
  durationText,
  eventText,
  PROCTOR,
  PROCTOR_TYPES,
  rankStudents,
  summarizeEvents,
  toProctorPayload,
} from '../lib/proctor.mjs';

/** 一個好讀的時間軸起點。單位是毫秒，與 `performance.now()` 一致。 */
const T0 = 100_000;

// ─────────────────────────────────────────────────────────────────
// 一、切走再切回：一段離開只留一列
// ─────────────────────────────────────────────────────────────────

test('切走再切回是一列，不是兩列', () => {
  const t = createProctorTracker();
  t.hidden(T0);
  t.visible(T0 + 5_000);
  const out = t.drain();
  assert.equal(out.length, 1, '切走與切回是同一件事的兩端');
  assert.equal(out[0].type, 'TAB_VISIBLE');
  assert.equal(out[0].durationMs, 5_000);
});

test('離開的時刻可以從 at 減 durationMs 還原', () => {
  const t = createProctorTracker();
  t.hidden(T0);
  t.visible(T0 + 12_345);
  const [e] = t.drain();
  assert.equal(e.at - e.durationMs, T0, '少了這個等式，老師端畫不出時間軸');
});

test('記下當時在第幾題——老師要判斷他是不是在難題上離開的', () => {
  const t = createProctorTracker();
  t.setQuestion(14);
  t.hidden(T0);
  // 離開期間換題不影響：事件屬於離開的那一刻。
  t.setQuestion(15);
  t.visible(T0 + 4_000);
  const [e] = t.drain();
  assert.equal(e.questionOrder, 14);
});

test('沒有題號時是 null，不是 0——第 0 題不存在', () => {
  const t = createProctorTracker();
  t.hidden(T0);
  t.visible(T0 + 4_000);
  assert.equal(t.drain()[0].questionOrder, null);
});

test('視窗失焦（沒有切分頁）記成 WINDOW_FOCUS，與切分頁分得出來', () => {
  const t = createProctorTracker();
  t.blur(T0);
  t.focus(T0 + 3_000);
  const [e] = t.drain();
  assert.equal(e.type, 'WINDOW_FOCUS', '開另一個視窗與切到別的分頁不是同一件事');
});

// ─────────────────────────────────────────────────────────────────
// 二、去抖動：連續的 blur/focus
// ─────────────────────────────────────────────────────────────────

test('短於門檻的離開直接丟掉——那是輸入法、通知、旋轉螢幕', () => {
  const t = createProctorTracker();
  t.blur(T0);
  t.focus(T0 + 300);
  assert.equal(t.drain().length, 0);
});

test('手機切輸入法的連續抖動不可以變成一堆列', () => {
  const t = createProctorTracker();
  // blur/focus × 5，每一次都只有幾百毫秒，中間間隔也很短。
  // 這是 Android 上按一次切換鍵的樣子。
  let at = T0;
  for (let i = 0; i < 5; i++) {
    t.blur(at);
    t.focus(at + 400);
    at += 900;
  }
  const out = t.drain();
  // 全部合併成同一段，而那一段（從第一次 blur 到最後一次 focus）
  // 是 4 秒——超過門檻，所以留下**一列**而不是五列，也不是零列。
  assert.equal(out.length, 1, `合併之後應該只有一列，實際 ${out.length} 列`);
  assert.equal(out[0].meta.bursts, 5, '要說得出這一列是幾次抖動合起來的');
});

test('抖動全部很短而且總長也很短時，一列都不留', () => {
  const t = createProctorTracker();
  t.blur(T0);
  t.focus(T0 + 200);
  t.blur(T0 + 500);
  t.focus(T0 + 700);
  assert.equal(t.drain().length, 0, '一次輸入法切換不該在老師的畫面上出現');
});

test('回來夠久之後又離開，是兩段不是一段——次數本身是資訊', () => {
  const t = createProctorTracker();
  t.hidden(T0);
  t.visible(T0 + 5_000);
  // 隔了遠大於合併窗的時間才又離開。
  t.hidden(T0 + 5_000 + PROCTOR.MERGE_GAP_MS + 10_000);
  t.visible(T0 + 5_000 + PROCTOR.MERGE_GAP_MS + 18_000);
  const out = t.drain();
  assert.equal(out.length, 2, '「切走 14 次」與「切走 3 次」對老師是不同的資訊');
});

test('已經送出去的那一列不會被後來的合併改到', () => {
  const t = createProctorTracker();
  t.hidden(T0);
  t.visible(T0 + 5_000);
  const first = t.drain(); // 送出去了
  // 送出去之後 1 秒又離開——落在合併窗裡，但那一列已經不在我們手上。
  t.hidden(T0 + 5_500);
  t.visible(T0 + 9_000);
  const second = t.drain();
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(first[0].durationMs, 5_000, '送出去的那一列不可以被改寫');
  assert.equal(second[0].durationMs, 3_500);
});

test('抖動中間剛好碰上定時送出，合併仍然接得起來', () => {
  const t = createProctorTracker();
  // 前兩次抖動太短，什麼都沒有留下。
  t.blur(T0);
  t.focus(T0 + 300);
  // 每 4 秒的定時送出剛好在這裡跑了一次。它沒有東西可送，
  // **但不可以順手把合併窗關掉**——關掉的話下面那一段會從頭算，
  // 而一次輸入法切換就變成一列。
  assert.equal(t.drain().length, 0);
  t.blur(T0 + 800);
  t.focus(T0 + 1_100);
  t.blur(T0 + 1_600);
  t.focus(T0 + 4_000);
  const out = t.drain();
  assert.equal(out.length, 1);
  assert.equal(out[0].meta.bursts, 3);
});

test('離開還沒結束時送出，那一段不會被切成兩半', () => {
  const t = createProctorTracker();
  t.paste(10, T0);
  t.hidden(T0 + 1_000);
  // 定時送出在離開期間跑（分頁在背景時計時器仍然會跑，只是被節流）。
  const first = t.drain();
  assert.equal(first.length, 1);
  assert.equal(first[0].type, 'PASTE');
  t.visible(T0 + 61_000);
  const second = t.drain();
  assert.equal(second.length, 1);
  assert.equal(second[0].durationMs, 60_000, '中途送出不可以讓離開的長度縮水');
});

// ─────────────────────────────────────────────────────────────────
// 三、分頁與視窗是同一個狀態
// ─────────────────────────────────────────────────────────────────

test('切分頁同時送出 blur 與 visibilitychange，只算一次離開', () => {
  const t = createProctorTracker();
  // 真實瀏覽器的順序：blur 先到，visibilitychange 隨後。
  t.blur(T0);
  t.hidden(T0 + 5);
  t.visible(T0 + 8_000);
  t.focus(T0 + 8_005);
  const out = t.drain();
  assert.equal(out.length, 1, '一個動作不可以在老師的畫面上變成兩次離開');
  assert.equal(out[0].type, 'TAB_VISIBLE', '看過 hidden 就升級成分頁層級的說法');
});

test('順序相反（visibilitychange 先到）也是一次', () => {
  const t = createProctorTracker();
  t.hidden(T0);
  t.blur(T0 + 5);
  t.focus(T0 + 8_000);
  t.visible(T0 + 8_005);
  assert.equal(t.drain().length, 1);
});

test('分頁回來了但焦點還在別的視窗，不算回來', () => {
  const t = createProctorTracker();
  t.blur(T0);
  t.hidden(T0 + 5);
  t.visible(T0 + 3_000);
  // 焦點還沒回來 → 這一段還沒結束。
  assert.equal(t.pending(), 0);
  t.focus(T0 + 9_000);
  const [e] = t.drain();
  assert.equal(e.durationMs, 9_000);
});

test('重複的同一個訊號不會開新的一段', () => {
  const t = createProctorTracker();
  t.hidden(T0);
  t.hidden(T0 + 1_000);
  t.hidden(T0 + 2_000);
  t.visible(T0 + 6_000);
  assert.equal(t.drain().length, 1);
});

// ─────────────────────────────────────────────────────────────────
// 四、切走很久
// ─────────────────────────────────────────────────────────────────

test('超過門檻的離開換一個類型——三秒與四分鐘不是同一件事', () => {
  const t = createProctorTracker();
  t.hidden(T0);
  t.visible(T0 + 4 * 60_000);
  const [e] = t.drain();
  assert.equal(e.type, 'LONG_ABSENCE');
  assert.equal(e.durationMs, 240_000);
});

test('門檻上下各一格：29 秒還是一般的，31 秒是長時間', () => {
  const t = createProctorTracker();
  t.hidden(T0);
  t.visible(T0 + PROCTOR.LONG_ABSENCE_MS - 1_000);
  t.hidden(T0 + 200_000);
  t.visible(T0 + 200_000 + PROCTOR.LONG_ABSENCE_MS + 1_000);
  const out = t.drain();
  assert.equal(out[0].type, 'TAB_VISIBLE');
  assert.equal(out[1].type, 'LONG_ABSENCE');
});

// ─────────────────────────────────────────────────────────────────
// 五、關閉分頁時未結束的事件
// ─────────────────────────────────────────────────────────────────

test('切走之後沒有回來就把分頁關掉，那一段要留下來', () => {
  const t = createProctorTracker();
  t.setQuestion(21);
  t.hidden(T0);
  t.close(T0 + 30_000);
  const out = t.drain();
  assert.equal(out.length, 1, '這是最值得記下來的一種，不可以掉');
  assert.equal(out[0].type, 'TAB_HIDDEN', '離開的那一刻，不是回來的那一刻');
  assert.equal(out[0].at, T0);
  assert.equal(out[0].questionOrder, 21);
});

test('未結束的那一列 durationMs 是 null 而不是 0', () => {
  const t = createProctorTracker();
  t.blur(T0);
  t.close(T0 + 100);
  const [e] = t.drain();
  assert.equal(e.type, 'WINDOW_BLUR');
  assert.equal(e.durationMs, null, '寫 0 是在說一件我們不知道的事');
});

test('未結束的離開即使很短也要留——長度不明不等於很短', () => {
  const t = createProctorTracker();
  t.hidden(T0);
  t.close(T0 + 50);
  assert.equal(t.drain().length, 1);
});

test('人還在考卷上時關閉分頁，不留下任何東西', () => {
  const t = createProctorTracker();
  t.close(T0);
  assert.equal(t.drain().length, 0, '正常交完卷關掉頁面不是一個事件');
});

test('close 之後分頁又活過來（bfcache），同一段不會記兩次', () => {
  const t = createProctorTracker();
  t.hidden(T0);
  t.close(T0 + 10_000);
  const first = t.drain();
  // 分頁從 bfcache 復原，visibilitychange 送出 visible。
  t.visible(T0 + 60_000);
  const second = t.drain();
  assert.equal(first.length, 1);
  assert.equal(second.length, 0, '同一段離開留下兩列，老師會以為他切走了兩次');
});

test('close 之後復原，下一次離開仍然記得起來', () => {
  const t = createProctorTracker();
  t.hidden(T0);
  t.close(T0 + 10_000);
  t.drain();
  t.visible(T0 + 60_000);
  t.hidden(T0 + 90_000);
  t.visible(T0 + 95_000);
  const out = t.drain();
  assert.equal(out.length, 1);
  assert.equal(out[0].durationMs, 5_000);
});

// ─────────────────────────────────────────────────────────────────
// 六、時鐘往回跳
// ─────────────────────────────────────────────────────────────────

test('時鐘往回跳時不產生負的持續時間', () => {
  const t = createProctorTracker();
  t.hidden(T0);
  // 回來的時刻比離開還早。單調時鐘不該這樣，但降級用的 Date.now()
  // 會——而改系統時間正是這個功能會遇到的事。
  t.visible(T0 - 60_000);
  const out = t.drain();
  // 夾成 0 → 低於門檻 → 丟掉。**不可以留下一列「離開 −1 分鐘」。**
  assert.equal(out.length, 0);
  for (const e of out) assert.ok(e.durationMs >= 0);
});

test('時鐘往回跳之後，接下來的離開仍然算得對', () => {
  const t = createProctorTracker();
  t.hidden(T0);
  t.visible(T0 - 60_000);
  t.drain();
  const t1 = T0 + 10_000;
  t.hidden(t1);
  t.visible(t1 + 8_000);
  const [e] = t.drain();
  assert.equal(e.durationMs, 8_000, '一次時鐘異常不可以讓之後的記錄全部失準');
});

test('往回跳落在合併窗的判斷裡也不會把兩段接錯', () => {
  const t = createProctorTracker();
  t.hidden(T0);
  t.visible(T0 + 5_000);
  // 下一次離開的時刻比「剛回來」還早：`at >= endedAt` 那一關擋住，
  // 不可以合併出一段負長度的離開。
  t.hidden(T0 + 1_000);
  t.visible(T0 + 20_000);
  const out = t.drain();
  assert.equal(out.length, 2);
  for (const e of out) assert.ok(e.durationMs >= 0, '合併不可以算出負的長度');
});

test('送出去的時刻換算：時鐘往回跳時 offset 夾成 0', () => {
  const wire = toProctorPayload(
    [{ type: 'TAB_VISIBLE', at: T0 + 5_000, durationMs: 1_000, questionOrder: 3, meta: null }],
    T0, // 現在比事件還早
  );
  assert.equal(wire[0].atOffsetMs, 0, '負的 offset 會讓伺服器把事件寫到未來');
});

// ─────────────────────────────────────────────────────────────────
// 七、全螢幕
// ─────────────────────────────────────────────────────────────────

test('離開全螢幕當下就記一列，不必等他回來', () => {
  const t = createProctorTracker();
  t.fullscreen(true, T0);
  t.drain();
  t.fullscreen(false, T0 + 10_000);
  const out = t.drain();
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'FULLSCREEN_EXIT');
  assert.equal(out[0].durationMs, null);
});

test('回到全螢幕帶著離開了多久', () => {
  const t = createProctorTracker();
  t.fullscreen(true, T0);
  t.fullscreen(false, T0 + 10_000);
  t.fullscreen(true, T0 + 70_000);
  const out = t.drain();
  assert.deepEqual(
    out.map((e) => e.type),
    ['FULLSCREEN_ENTER', 'FULLSCREEN_EXIT', 'FULLSCREEN_ENTER'],
  );
  assert.equal(out[2].durationMs, 60_000);
});

test('第一次進全螢幕也記——否則分不出「進不去」與「一直待著」', () => {
  const t = createProctorTracker();
  t.fullscreen(true, T0);
  const out = t.drain();
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'FULLSCREEN_ENTER');
  assert.equal(out[0].durationMs, null);
});

test('沒進過全螢幕的裝置不會被記上一筆「離開全螢幕」', () => {
  const t = createProctorTracker();
  // iPad 上 requestFullscreen 失敗，狀態一直是 false。
  t.fullscreen(false, T0);
  t.fullscreen(false, T0 + 1_000);
  assert.equal(t.drain().length, 0, 'iPad 的學生不該因為裝置限制而被記一筆');
});

test('瞬間的進出（iPad 上的假訊號）兩邊都不記', () => {
  const t = createProctorTracker();
  t.fullscreen(true, T0);
  t.drain();
  t.fullscreen(false, T0 + 1_000);
  t.fullscreen(true, T0 + 1_200);
  assert.equal(t.drain().length, 0, '那不是行為，是瀏覽器');
});

test('假訊號的撤回只在那一列還沒送出去時成立', () => {
  const t = createProctorTracker();
  t.fullscreen(true, T0);
  t.fullscreen(false, T0 + 1_000);
  t.drain(); // EXIT 已經送出去了
  t.fullscreen(true, T0 + 1_200);
  const out = t.drain();
  // 撤不回來就要補上對應的 ENTER，否則老師端看到一個永遠沒有結束的
  // 「離開全螢幕」。
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'FULLSCREEN_ENTER');
});

// ─────────────────────────────────────────────────────────────────
// 八、貼上
// ─────────────────────────────────────────────────────────────────

test('貼上只記字元數', () => {
  const t = createProctorTracker();
  t.setQuestion(9);
  t.paste(412, T0);
  const [e] = t.drain();
  assert.equal(e.type, 'PASTE');
  assert.equal(e.meta.chars, 412);
  assert.equal(e.questionOrder, 9);
  // **內容一個欄位都沒有。** 那可能是學生自己打的草稿。
  assert.deepEqual(Object.keys(e.meta).sort(), ['chars', 'count']);
});

test('連續兩次貼上合成一列', () => {
  const t = createProctorTracker();
  t.paste(100, T0);
  t.paste(50, T0 + 500);
  const out = t.drain();
  assert.equal(out.length, 1);
  assert.equal(out[0].meta.chars, 150);
  assert.equal(out[0].meta.count, 2);
});

test('隔很久的兩次貼上是兩列', () => {
  const t = createProctorTracker();
  t.paste(100, T0);
  t.paste(50, T0 + PROCTOR.MERGE_GAP_MS + 5_000);
  assert.equal(t.drain().length, 2);
});

test('貼上不影響離開的合併', () => {
  const t = createProctorTracker();
  t.hidden(T0);
  t.visible(T0 + 5_000);
  t.paste(30, T0 + 5_100);
  t.hidden(T0 + 5_200);
  t.visible(T0 + 12_000);
  const out = t.drain();
  const away = out.filter((e) => e.type !== 'PASTE');
  assert.equal(away.length, 1, '中間插一次貼上不該把合併窗打斷');
});

// ─────────────────────────────────────────────────────────────────
// 九、佇列的上限
// ─────────────────────────────────────────────────────────────────

test('佇列滿了就不再收——考試中的記憶體屬於學生的答案', () => {
  const t = createProctorTracker();
  for (let i = 0; i < PROCTOR.MAX_QUEUE + 50; i++) {
    t.paste(1, T0 + i * (PROCTOR.MERGE_GAP_MS + 1_000));
  }
  assert.equal(t.pending(), PROCTOR.MAX_QUEUE);
  assert.equal(t.stats().dropped, 50, '丟掉幾筆要說得出來');
});

test('drain 之後佇列是空的', () => {
  const t = createProctorTracker();
  t.paste(10, T0);
  assert.equal(t.pending(), 1);
  t.drain();
  assert.equal(t.pending(), 0);
});

// ─────────────────────────────────────────────────────────────────
// 十、送出去的形狀
// ─────────────────────────────────────────────────────────────────

test('送的是「幾毫秒之前」而不是時刻——前端的時鐘不可信', () => {
  const wire = toProctorPayload(
    [{ type: 'TAB_VISIBLE', at: T0, durationMs: 5_000, questionOrder: 3, meta: null }],
    T0 + 2_500,
  );
  assert.equal(wire[0].atOffsetMs, 2_500);
  assert.equal(wire[0].durationMs, 5_000);
  assert.equal(wire[0].questionOrder, 3);
  assert.equal(wire[0].meta, null);
});

test('一次最多送一批，多的留到下一輪', () => {
  const records = [];
  for (let i = 0; i < PROCTOR.MAX_BATCH + 20; i++) {
    records.push({ type: 'PASTE', at: T0, durationMs: null, questionOrder: null, meta: null });
  }
  assert.equal(toProctorPayload(records, T0).length, PROCTOR.MAX_BATCH);
});

test('offset 有上限，不可以送一個六小時以前的時刻', () => {
  const wire = toProctorPayload(
    [{ type: 'PASTE', at: 0, durationMs: null, questionOrder: null, meta: null }],
    999 * 60 * 60 * 1000,
  );
  assert.equal(wire[0].atOffsetMs, PROCTOR.MAX_OFFSET_MS);
});

test('產生的每一種類型都在 schema 的列舉裡', () => {
  const t = createProctorTracker();
  t.fullscreen(true, T0);
  t.fullscreen(false, T0 + 10_000);
  t.fullscreen(true, T0 + 40_000);
  t.hidden(T0 + 50_000);
  t.visible(T0 + 55_000);
  t.blur(T0 + 70_000);
  t.focus(T0 + 75_000);
  t.hidden(T0 + 90_000);
  t.visible(T0 + 150_000);
  t.paste(20, T0 + 160_000);
  t.hidden(T0 + 170_000);
  t.close(T0 + 180_000);
  const out = t.drain();
  const kinds = new Set(out.map((e) => e.type));
  for (const k of kinds) {
    assert.ok(PROCTOR_TYPES.includes(k), `${k} 不在 ProctorEventType 裡，寫進去會被資料庫擋掉`);
  }
  // 這一段走過的路要涵蓋大部分類型，否則這個測試等於沒測。
  assert.ok(kinds.size >= 6, `只產生了 ${kinds.size} 種類型`);
});

// ─────────────────────────────────────────────────────────────────
// 十一、老師端：摘要
// ─────────────────────────────────────────────────────────────────

test('摘要把離開、全螢幕、貼上分開算', () => {
  const s = summarizeEvents([
    { type: 'TAB_VISIBLE', durationMs: 5_000 },
    { type: 'LONG_ABSENCE', durationMs: 240_000 },
    { type: 'WINDOW_FOCUS', durationMs: 3_000 },
    { type: 'FULLSCREEN_EXIT', durationMs: null },
    { type: 'FULLSCREEN_ENTER', durationMs: 60_000 },
    { type: 'PASTE', durationMs: null, meta: { chars: 412, count: 2 } },
  ]);
  assert.equal(s.awayCount, 3);
  assert.equal(s.awayMs, 248_000);
  assert.equal(s.longestMs, 240_000);
  assert.equal(s.fullscreenExits, 1);
  assert.equal(s.pastes, 1);
  assert.equal(s.pasteChars, 412);
});

test('「切走之後沒有回來」算一次離開，但不算成 0 秒', () => {
  const s = summarizeEvents([
    { type: 'TAB_VISIBLE', durationMs: 5_000 },
    { type: 'TAB_HIDDEN', durationMs: null },
  ]);
  assert.equal(s.awayCount, 2);
  assert.equal(s.awayMs, 5_000, '量不到的長度不可以被當成 0 加進總數');
  assert.equal(s.unfinished, 1, '畫面上要說得出「另有一次長度不明」');
});

test('回全螢幕那一列的時間不算進離開時間', () => {
  const s = summarizeEvents([{ type: 'FULLSCREEN_ENTER', durationMs: 600_000 }]);
  assert.equal(s.awayMs, 0, '不在全螢幕不等於不在考卷上');
  assert.equal(s.awayCount, 0);
});

test('沒有事件時每一個數字都是 0，不是 undefined', () => {
  const s = summarizeEvents([]);
  assert.deepEqual(s, {
    awayCount: 0,
    awayMs: 0,
    longestMs: 0,
    unfinished: 0,
    fullscreenExits: 0,
    pastes: 0,
    pasteChars: 0,
    total: 0,
  });
});

test('壞掉的資料不會讓摘要當掉', () => {
  const s = summarizeEvents([null, {}, { type: 'TAB_VISIBLE', durationMs: 'x' }, undefined]);
  assert.equal(s.awayCount, 1);
  assert.equal(s.awayMs, 0);
});

// ─────────────────────────────────────────────────────────────────
// 十二、老師端：全班基準線
// ─────────────────────────────────────────────────────────────────

test('中位數要把 0 次的人算進去，否則永遠找得到一個最可疑的人', () => {
  // 28 位 0 次、2 位 4 次。中位數必須是 0。
  const rows = [];
  for (let i = 0; i < 28; i++) rows.push({ awayCount: 0 });
  rows.push({ awayCount: 4 }, { awayCount: 4 });
  const base = classBaseline(rows);
  assert.equal(base.medianCount, 0);
  assert.equal(base.students, 30);
  assert.equal(base.withEvents, 2);
  assert.equal(base.widespread, false);
});

test('全班都有大量事件時看得出來——那多半是環境', () => {
  const rows = [];
  for (let i = 0; i < 24; i++) rows.push({ awayCount: 12 });
  for (let i = 0; i < 4; i++) rows.push({ awayCount: 0 });
  const base = classBaseline(rows);
  assert.equal(base.widespread, true);
  assert.equal(base.busy, 24);
});

test('人太少不談「全班」——3 個人裡有 2 個不叫全班', () => {
  const base = classBaseline([{ awayCount: 12 }, { awayCount: 9 }, { awayCount: 0 }]);
  assert.equal(base.widespread, false);
});

// ─────────────────────────────────────────────────────────────────
// 十三、老師端：浮出來的那幾位
// ─────────────────────────────────────────────────────────────────

const summaryOf = (over) => ({ ...summarizeEvents([]), ...over });

test('明顯多於全班的那一位會被標出來，理由是一句可以核對的話', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ id: `q${i}`, summary: summaryOf({}) });
  rows.push({ id: 'x', summary: summaryOf({ awayCount: 14, awayMs: 300_000, total: 14 }) });
  const { rows: ranked } = rankStudents(rows);
  assert.equal(ranked[0].id, 'x', '最多的要排在最前面');
  assert.equal(ranked[0].standsOut, true);
  assert.match(ranked[0].why.join(''), /14 次/);
  assert.match(ranked[0].why.join(''), /中位數/, '理由要說得出對照的基準');
  assert.equal(ranked[1].standsOut, false);
});

test('全班都這樣的時候一個人都不標——突出的只是網路最差的那位', () => {
  const rows = [];
  for (let i = 0; i < 24; i++) {
    rows.push({ id: `q${i}`, summary: summaryOf({ awayCount: 12, awayMs: 60_000, total: 12 }) });
  }
  rows.push({ id: 'x', summary: summaryOf({ awayCount: 30, awayMs: 900_000, total: 30 }) });
  const { rows: ranked, baseline } = rankStudents(rows);
  assert.equal(baseline.widespread, true);
  assert.equal(
    ranked.filter((r) => r.standsOut).length,
    0,
    '全班一致時標記任何一位就是在製造冤案',
  );
});

test('切走兩次不標記——1、2 次什麼都不是', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ id: `q${i}`, summary: summaryOf({}) });
  rows.push({ id: 'x', summary: summaryOf({ awayCount: 2, awayMs: 6_000, total: 2 }) });
  const { rows: ranked } = rankStudents(rows);
  assert.equal(ranked[0].standsOut, false);
});

test('次數不多但有一次離開很久，也要浮出來', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ id: `q${i}`, summary: summaryOf({}) });
  rows.push({
    id: 'x',
    summary: summaryOf({ awayCount: 1, awayMs: 300_000, longestMs: 300_000, total: 1 }),
  });
  const { rows: ranked } = rankStudents(rows);
  const x = ranked.find((r) => r.id === 'x');
  assert.equal(x.standsOut, true);
  assert.match(x.why.join(''), /5 分鐘/);
});

test('切走之後沒有回來，本身就是要說出來的一件事', () => {
  const rows = [{ id: 'x', summary: summaryOf({ awayCount: 1, unfinished: 1, total: 1 }) }];
  const { rows: ranked } = rankStudents(rows);
  assert.equal(ranked[0].standsOut, true);
  assert.match(ranked[0].why.join(''), /沒有回到/);
});

test('沒有任何人有事件時，排序不會爆掉也不會標人', () => {
  const { rows: ranked, baseline } = rankStudents([]);
  assert.deepEqual(ranked, []);
  assert.equal(baseline.students, 0);
  assert.equal(baseline.widespread, false);
});

test('回傳的每一列都沒有分數、等級或「可疑」這種欄位', () => {
  const rows = [{ id: 'x', summary: summaryOf({ awayCount: 14, awayMs: 300_000, total: 14 }) }];
  const { rows: ranked } = rankStudents(rows);
  const keys = Object.keys(ranked[0]);
  for (const banned of ['score', 'risk', 'level', 'suspicious', 'cheating']) {
    assert.ok(!keys.includes(banned), `${banned} 是判斷，而系統沒有判斷`);
  }
});

// ─────────────────────────────────────────────────────────────────
// 十四、給人看的說法
// ─────────────────────────────────────────────────────────────────

test('長度說得出單位，而且分得出 4 分 12 秒與 4 分鐘', () => {
  assert.equal(durationText(0), '0 秒');
  assert.equal(durationText(47_000), '47 秒');
  assert.equal(durationText(252_000), '4 分 12 秒');
  assert.equal(durationText(240_000), '4 分鐘');
  assert.equal(durationText(3_900_000), '1 小時 5 分');
});

test('長度不明時說「不知道多久」，不說 0 秒', () => {
  assert.equal(durationText(null), '不知道多久');
  assert.equal(durationText(undefined), '不知道多久');
});

test('事件的說法描述動作，不描述動機', () => {
  const text = [
    { type: 'TAB_VISIBLE', durationMs: 47_000 },
    { type: 'LONG_ABSENCE', durationMs: 240_000 },
    { type: 'TAB_HIDDEN', durationMs: null },
    { type: 'FULLSCREEN_EXIT', durationMs: null },
    { type: 'PASTE', durationMs: null, meta: { chars: 412, count: 2 } },
  ]
    .map(eventText)
    .join('｜');
  for (const banned of ['作弊', '可疑', '查資料', '抄']) {
    assert.ok(!text.includes(banned), `說法裡出現了「${banned}」——我們不知道他去做了什麼`);
  }
  assert.match(text, /47 秒/);
  assert.match(text, /沒有再回到這個畫面/);
});

test('貼上的說法要講明系統沒有記錄內容', () => {
  const s = eventText({ type: 'PASTE', meta: { chars: 412, count: 2 } });
  assert.match(s, /412 個字/);
  assert.match(s, /不記錄貼上的內容/);
});

test('沒見過的類型不會讓畫面爆掉', () => {
  assert.equal(eventText({ type: 'SOMETHING_NEW' }), 'SOMETHING_NEW');
  assert.equal(eventText(null), '');
});
