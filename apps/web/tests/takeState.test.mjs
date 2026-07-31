/**
 * 作答畫面的四條判斷：答案送出去了沒、有沒有少、題幹在哪、還剩多久。
 *
 * # 這一支測的是「畫面說了一件假話」
 *
 * 這幾條的共同點是：**判斷錯了畫面不會壞，只會安靜地說錯話。**
 *
 *   · 存檔失敗之後仍然寫「已存檔」——學生據此決定關掉分頁
 *   · 伺服器只收到 22 題而畫面寫 25 題——要到隔天檢討頁才會發現
 *   · 題組第二小題找不到題幹——學生以為卷子印漏了
 *   · 剩五分鐘沒有人告訴他——後面五題全部空白
 *
 * 四種都不會在瀏覽器主控台留下任何痕跡，也不會讓任何一支
 * 端對端測試變紅。所以它們必須在這裡被釘住。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  answeredGap,
  groupRange,
  listUnanswered,
  saveIndicator,
  stimulusFor,
  submitCheck,
  submitRetryDelay,
  SUBMIT_RETRY_MS,
  TIME_ALERTS,
  timeAlert,
  unsentAnswers,
} from '../lib/takeState.mjs';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(WEB, rel), 'utf8');

// ─────────────────────────────────────────────────────────────────
// 一、待送出佇列的狀態機
// ─────────────────────────────────────────────────────────────────

test('一開始什麼都還沒存，指示器不說話', () => {
  const s = saveIndicator({});
  assert.equal(s.kind, 'idle');
  assert.equal(s.label, '');
  assert.equal(s.urgent, false);
});

test('送出中就說送出中', () => {
  const s = saveIndicator({ inFlight: true, pendingCount: 2 });
  assert.equal(s.kind, 'saving');
});

test('佇列裡還有東西但還沒開始送，也算存檔中——不可以說已存檔', () => {
  const s = saveIndicator({ inFlight: false, pendingCount: 3, savedAtLabel: '09:12' });
  assert.equal(s.kind, 'saving');
});

test('全部送完了才是已存檔，而且要帶時刻', () => {
  const s = saveIndicator({ inFlight: false, pendingCount: 0, savedAtLabel: '09:12' });
  assert.equal(s.kind, 'saved');
  assert.match(s.label, /09:12/);
  assert.equal(s.urgent, false);
});

test('送失敗過就不可以再退回「已存檔」——這是 v0.21.0 的那個 bug', () => {
  // 舊版：savedAt 全檔只被寫過一次、從不重設，所以第一次成功之後
  // 「已存檔」永遠掛著，之後每一次失敗都不改變它。
  const s = saveIndicator({
    inFlight: false,
    pendingCount: 4,
    failures: 3,
    savedAtLabel: '09:12',
  });
  assert.equal(s.kind, 'retrying');
  assert.equal(s.urgent, true);
  assert.match(s.label, /4/, '要說得出還有幾題沒送出去');
  assert.match(s.detail, /4 題/);
  assert.match(s.detail, /3 次/, '要說得出重試了幾次');
  assert.match(s.detail, /不要關掉/, '要說得出學生現在該做什麼');
});

test('重試中就算佇列空了也不說「未送出 0 題」', () => {
  const s = saveIndicator({ pendingCount: 0, failures: 2 });
  assert.equal(s.kind, 'retrying');
  assert.match(s.label, /1 題/);
});

test('恢復連線送出成功之後回到正常狀態', () => {
  const bad = saveIndicator({ pendingCount: 4, failures: 3, savedAtLabel: '09:12' });
  assert.equal(bad.kind, 'retrying');
  // flush 成功時把 failures 歸零、佇列清空、記下新的時刻。
  const good = saveIndicator({ pendingCount: 0, failures: 0, savedAtLabel: '09:40' });
  assert.equal(good.kind, 'saved');
  assert.equal(good.urgent, false);
});

// ─────────────────────────────────────────────────────────────────
// 二、本機與伺服器答題數的比對
// ─────────────────────────────────────────────────────────────────

test('伺服器收到的不比本機少就沒事', () => {
  assert.equal(answeredGap({ local: 13, server: 13 }).kind, 'ok');
  // 換裝置續考時伺服器可能比本機多，那不是遺失。
  assert.equal(answeredGap({ local: 9, server: 13 }).kind, 'ok');
});

test('差額落在待送出佇列裡是正常的，不要嚇學生', () => {
  const g = answeredGap({ local: 13, server: 11, pendingCount: 2 });
  assert.equal(g.kind, 'pending');
  assert.equal(g.detail, null);
});

test('差額比佇列還多就是真的少了', () => {
  const g = answeredGap({ local: 13, server: 9, pendingCount: 1 });
  assert.equal(g.kind, 'lost');
  assert.equal(g.gap, 4);
  assert.match(g.detail, /13 題/);
  assert.match(g.detail, /9 題/);
  assert.match(g.detail, /不要關掉/);
});

test('伺服器沒給數字時不假裝比對過', () => {
  assert.equal(answeredGap({ local: 13, server: undefined }).kind, 'unknown');
  assert.equal(answeredGap({ local: 13, server: null }).kind, 'unknown');
});

/** 待送出佇列的一筆。只有 `questionId` 有意義，其餘欄位在這裡不參與判斷。 */
const p = (id, text = null) => ({ questionId: id, answerText: text });

test('正在飛的那一批也算「還沒送出去」——否則會冒出一句假的遺失警告', () => {
  // 學生在熱點上連答四題 → 防抖觸發 flushOnce → 它**先清空佇列**再送出，
  // 於是請求在網路上的那 6 秒 `pending.size` 是 0。這期間 30 秒一次的
  // 校時回來說「伺服器收到 9 題」。
  const inFlight = [p('q1'), p('q2'), p('q3'), p('q4')];
  const pending = new Map();
  const g = answeredGap({
    local: 13,
    server: 9,
    pendingCount: unsentAnswers(inFlight, pending).length,
  });
  assert.equal(
    g.kind,
    'pending',
    '什麼都沒掉，而這一句硃砂色的警告會讓一個沒事的學生在考試中舉手',
  );
  assert.equal(g.detail, null, '不要在畫面上說話');
});

test('兩堆都空了還對不起來，就是真的少了——這時候一定要吵', () => {
  // 這一條與上一條是一組：修「假警報」不可以順手把真的警報關掉。
  const g = answeredGap({
    local: 13,
    server: 9,
    pendingCount: unsentAnswers([], new Map()).length,
  });
  assert.equal(g.kind, 'lost');
  assert.match(g.detail, /舉手/);
});

test('同一題在兩堆裡只算一次，而且佇列裡的那一份比較新', () => {
  // 學生在請求飛的那幾秒又改了同一題：要送的是新的那一份，
  // 而它只能算一題（算兩題會讓 pendingCount 高到蓋掉真的遺失）。
  const out = unsentAnswers([p('q1', '舊')], new Map([['q1', p('q1', '新')]]));
  assert.equal(out.length, 1);
  assert.equal(out[0].answerText, '新');
});

test('沒有東西在飛、也沒有東西在等的時候是空的（beacon 據此不送）', () => {
  assert.deepEqual(unsentAnswers([], new Map()), []);
  assert.deepEqual(unsentAnswers(null, null), [], '兩個參數都可能還沒初始化');
  assert.deepEqual(unsentAnswers(undefined, undefined), []);
});

test('beacon 與校時用的是同一份合併規則', () => {
  // 這兩處合併規則不一致，正是 v0.26.0 那個假警報的成因：
  // beacon 合併了、校時沒有。靜態盯著它們呼叫同一支函式。
  const src = read('app/(app)/take/[assignmentId]/page.tsx');
  const calls = src.match(/unsentAnswers\(inFlightBatch\.current, pending\.current\)/g) ?? [];
  assert.ok(
    calls.length >= 2,
    `只找到 ${calls.length} 處合併。beacon 與 answeredGap 兩邊都要用 unsentAnswers，` +
      '各寫各的遲早會再分岐一次。',
  );
  // 存檔指示器那幾處的 `pending.current.size` 是對的（它另外有一個
  // `inFlight` 旗標），這裡只盯 answeredGap 的那一個參數。
  const gap = /answeredGap\(\{([\s\S]{0,300}?)\}\)/.exec(src);
  assert.ok(gap, '找不到 answeredGap 的呼叫');
  assert.match(
    gap[1],
    /pendingCount:\s*unsentAnswers\(/,
    'answeredGap 又拿 pending.current.size 當「還沒送出去」了——正在飛的那一批不在裡面。',
  );
});

test('交卷時兩個數字一致而且寫滿了：不出聲', () => {
  const c = submitCheck({ local: 25, server: 25, total: 25 });
  assert.equal(c.kind, 'ok');
});

test('交卷時兩邊一致但有空題：要列出來，但不是遺失', () => {
  const c = submitCheck({ local: 22, server: 22, total: 25 });
  assert.equal(c.kind, 'short');
  assert.equal(c.blank, 3);
  assert.equal(c.missing, 0);
});

test('交卷時伺服器比本機少：這是遺失，要講重話', () => {
  // 卡點 28：確認框上寫「全部 25 題都作答了」，已交卷頁寫「作答 22 / 25」，
  // 兩個數字就在同一行程式碼裡而沒有人比較。
  const c = submitCheck({ local: 25, server: 22, total: 25 });
  assert.equal(c.kind, 'mismatch');
  assert.equal(c.missing, 3);
  assert.equal(c.local, 25);
  assert.equal(c.server, 22);
});

test('交卷時伺服器沒回答題數：不能說「都收到了」', () => {
  const c = submitCheck({ local: 25, total: 25 });
  assert.equal(c.kind, 'unknown');
  assert.equal(c.server, null);
});

// ─────────────────────────────────────────────────────────────────
// 三、題組素材的回頭查找
// ─────────────────────────────────────────────────────────────────

/** 37–39 為題組，素材只掛在 37 上（lib/attempt.ts 為了省頻寬）。 */
const FIG = [{ id: 'fig1', key: 't/x/import/j/fig1.png', width: 400, height: 300 }];
const GROUPED = [
  { order: 36, groupId: null, stimulus: null, stimulusLabel: null },
  {
    order: 37,
    groupId: 'g1',
    stimulus: '下圖為某實驗裝置……',
    stimulusLabel: '37–39 題組',
    stimulusAssets: FIG,
  },
  { order: 38, groupId: 'g1', stimulus: null, stimulusLabel: null },
  { order: 39, groupId: 'g1', stimulus: null, stimulusLabel: null },
  { order: 40, groupId: 'g2', stimulus: '另一篇閱讀素材……', stimulusLabel: null },
];

test('題組第一題：用自己的素材，連圖一起', () => {
  const s = stimulusFor(GROUPED, 1);
  assert.equal(s.inherited, false);
  assert.match(s.stimulus, /實驗裝置/);
  assert.equal(s.label, '37–39 題組');
  assert.deepEqual(s.assets, FIG);
});

test('題組第二、三小題：往回找得到同一段素材，**圖也要跟著**', () => {
  // 前半是阻斷級的卡點 15（修之前這兩題的畫面上什麼都沒有）。
  // 後半是它的第二半：文字帶到了而圖沒帶，畫面上寫著「下圖為某實驗
  // 裝置」而沒有圖——那一題的條件就在圖裡。
  for (const i of [2, 3]) {
    const s = stimulusFor(GROUPED, i);
    assert.ok(s, `第 ${GROUPED[i].order} 題應該找得到素材`);
    assert.match(s.stimulus, /實驗裝置/);
    assert.equal(s.inherited, true);
    assert.equal(s.label, '37–39 題組');
    assert.deepEqual(s.assets, FIG, '圖要取自提供這段素材的那一題，不是自己的');
  }
});

test('沒有圖的題組回 null 而不是 undefined——那是兩件不同的事', () => {
  // MathText：`assets` 沒傳（undefined）＝「這個畫面不畫圖」，標記排成
  // 〔附圖〕；傳 null ＝「這一段真的沒有圖」，題幹裡有標記時會明講
  // 找不到它。作答中的學生要分得出「這裡本來就沒圖」與「圖掉了」。
  assert.equal(stimulusFor(GROUPED, 4).assets, null);
});

test('題組共用的附圖從資料庫一路帶得到畫面上', () => {
  // 這一條是一條**管線**：DB 有這一欄、select 查了它、型別帶得動它、
  // 畫面把它交給 MathText。斷在中間任何一節的症狀都一樣——
  // 學生看到「如圖所示」而畫面上什麼都沒有，沒有任何錯誤。
  const attempt = read('lib/attempt.ts');
  assert.match(attempt, /stimulusAssets: true/, 'select 沒有查這一欄');
  assert.match(attempt, /stimulusAssets: Prisma\.JsonValue \| null/, 'TakeQuestion 上沒有這一欄');
  assert.match(
    attempt,
    /stimulusAssets: firstOfGroup \?/,
    'loadAttemptForStudent 查了卻沒有帶出去',
  );

  const page = read('app/(app)/take/[assignmentId]/page.tsx');
  assert.match(page, /assets=\{stim\.assets\}/, '作答頁沒有把題組的圖交給 MathText');
  assert.ok(
    !/白名單\s*\n?\s*只帶 `group\.stimulus`/.test(page),
    '那句「拿不到」的註解已經不是事實了，要跟著改掉',
  );
});

test('不屬於任何題組的題目不會撿到別人的素材', () => {
  assert.equal(stimulusFor(GROUPED, 0), null);
});

test('下一個題組不會撿到上一個題組的素材', () => {
  const s = stimulusFor(GROUPED, 4);
  assert.match(s.stimulus, /另一篇/);
  assert.equal(s.inherited, false);
});

test('題組裡一段素材都沒有時回 null，而不是丟出例外', () => {
  const broken = [
    { order: 1, groupId: 'g9', stimulus: null, stimulusLabel: null },
    { order: 2, groupId: 'g9', stimulus: null, stimulusLabel: null },
  ];
  assert.equal(stimulusFor(broken, 1), null);
});

test('索引超出範圍不會爆炸', () => {
  assert.equal(stimulusFor(GROUPED, 99), null);
  assert.equal(stimulusFor(null, 0), null);
});

test('題組涵蓋的題號範圍', () => {
  assert.deepEqual(groupRange(GROUPED, 2), { from: 37, to: 39, count: 3 });
  // 單題不算題組，畫面上不必寫「第 40–40 題共用」。
  assert.equal(groupRange(GROUPED, 4), null);
  assert.equal(groupRange(GROUPED, 0), null);
});

// ─────────────────────────────────────────────────────────────────
// 四、剩餘時間的提醒門檻
// ─────────────────────────────────────────────────────────────────

test('跨過五分鐘的那一刻提醒一次', () => {
  assert.equal(timeAlert(301, 300).threshold, 300);
  assert.equal(timeAlert(320, 299).threshold, 300);
});

test('同一個門檻不會每半秒跳一次', () => {
  assert.equal(timeAlert(300, 299), null);
  assert.equal(timeAlert(299, 298), null);
  assert.equal(timeAlert(120, 119), null);
});

test('跨過一分鐘再提醒一次', () => {
  assert.equal(timeAlert(61, 60).threshold, 60);
  assert.equal(timeAlert(70, 59).threshold, 60);
});

test('剩很多時間不提醒', () => {
  assert.equal(timeAlert(3600, 3599), null);
  assert.equal(timeAlert(null, 3599), null);
});

test('續考的人一進來就只剩三分鐘：報最緊的那一個門檻，不報過期的', () => {
  // prev 是 null（還沒有上一次的值）。這時挑的必須是「還沒跨過的最小門檻」，
  // 而訊息由呼叫端用真正的秒數寫（「剩下不到 5 分鐘（03:20）」），
  // 所以不會出現「剩下 5 分鐘」這句假話。
  const a = timeAlert(null, 200);
  assert.equal(a.threshold, 300);
  const b = timeAlert(null, 30);
  assert.equal(b.threshold, 60, '剩不到一分鐘的人不需要先聽「剩五分鐘」');
});

test('沒有時限的卷子沒有倒數，也就沒有提醒', () => {
  assert.equal(timeAlert(null, null), null);
  assert.equal(timeAlert(300, undefined), null);
});

test('門檻由大到小排，五分鐘與一分鐘各一次', () => {
  assert.deepEqual([...TIME_ALERTS].sort((a, b) => b - a), [300, 60]);
});

// ─────────────────────────────────────────────────────────────────
// 五、哪幾題還沒寫
// ─────────────────────────────────────────────────────────────────

const ITEMS = (flags) => flags.map((answered, i) => ({ order: i + 1, answered }));

test('列出未作答的題號', () => {
  const u = listUnanswered(ITEMS([true, false, true, false, false]));
  assert.equal(u.count, 3);
  assert.deepEqual(u.orders, [2, 4, 5]);
  assert.equal(u.text, '2、4、5');
});

test('全部寫完了就沒有東西可以列', () => {
  const u = listUnanswered(ITEMS([true, true, true]));
  assert.equal(u.count, 0);
  assert.equal(u.text, '');
});

test('太多題就收尾——一串二十個數字沒有人記得住', () => {
  const u = listUnanswered(ITEMS(new Array(20).fill(false)), 8);
  assert.equal(u.count, 20);
  assert.equal(u.orders.length, 20, 'orders 仍然是完整的，收尾只影響那一句話');
  assert.match(u.text, /等 20 題$/);
  assert.equal(u.text.split('、').length, 8);
});

// ─────────────────────────────────────────────────────────────────
// 六、自動交卷的重試
// ─────────────────────────────────────────────────────────────────

test('沒有失敗就不排重試', () => {
  assert.equal(submitRetryDelay(0), null);
  assert.equal(submitRetryDelay(-1), null);
});

test('退避：5s、15s、30s、60s', () => {
  assert.deepEqual(
    [1, 2, 3, 4].map(submitRetryDelay),
    SUBMIT_RETRY_MS,
  );
});

test('失敗再多次也不放棄，停在最長的間隔', () => {
  // 舊版只試一次（effect 的相依是恆為 0 的 left，Object.is(0,0) 為真
  // 所以不重跑），時間到那一刻剛好斷線的人卷子就永遠停在 IN_PROGRESS。
  assert.equal(submitRetryDelay(9), 60_000);
  assert.equal(submitRetryDelay(100), 60_000);
});

// ─────────────────────────────────────────────────────────────────
// 七、任務清單與檢討頁看到的必須是同一個答案
//
// 這一節是靜態檢查，因為要守的是**兩支不同的函式餵給同一條規則的
// 資料一不一樣**——`maySeeResult` 本身已經被 release.test.mjs 釘住了，
// 而它算錯的唯一方式是有人少傳一個參數。那種錯不會讓任何測試變紅：
// 兩個畫面各自都很正常，只是說的話不一樣。
// ─────────────────────────────────────────────────────────────────

test('清單頁算放行等級時也要帶同卷任務，否則會寫「看檢討」卻打不開', () => {
  // 忠孝兩班考同一份卷子、截止日不同。清單只看自己的 dueAt 就判成 FULL
  // → 按鈕寫「看檢討」；點進去檢討頁帶了同卷任務 → SCORE_ONLY
  // →「逐題檢討還沒開放」。兩個畫面都不覺得自己壞了。
  const src = read('lib/attempt.ts');
  const call = /maySeeResult\(([\s\S]{0,160}?)\)/.exec(src.replace(/\/\/[^\n]*/g, ''));
  assert.ok(call, '找不到 listStudentTasks 裡的 maySeeResult 呼叫');
  assert.match(
    call[1],
    /paperCohort/,
    'listStudentTasks 沒有把同卷任務傳進 maySeeResult，' +
      '而 lib/result.ts 有——同一條規則收到兩份不同的資料。',
  );
  // 自己不可以出現在自己的同卷清單裡：留著的話 cohortGate 會把自己的
  // 截止時間當成「別的班還沒考完」，訊息就變成一句假話。
  assert.match(src, /filter\(\(o\) => o\.id !== a\.id\)/, '同卷任務要把自己排掉');
});
