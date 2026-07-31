/**
 * 通知：去重、節流、免打擾，以及「哪些通知關不掉」。
 *
 * # 這一支測的全部是「送錯了不會有錯誤訊息」的失敗
 *
 * 通知模組每一種壞法都長得像正常運作：
 *
 *   · 去重鍵算錯 → 學生每 15 分鐘收到一則「作業快到期」。系統上
 *     一切正常，而他兩天之後把整個功能當成噪音——**連作廢通知
 *     一起忽略**，而那一則是他唯一會知道自己成績出事的管道。
 *   · 節流沒作用 → 一秒鐘六則。同上。
 *   · 免打擾算成「丟掉」而不是「延後」→ 半夜產生的通知全部消失，
 *     而資料庫裡查不到任何痕跡（那一列從來沒有被建立）。
 *   · 「關不掉」的清單漏一則 → 學生關掉之後永遠不知道卷子被作廢，
 *     而畫面上他的設定完全正常。
 *   · 未接的渠道留在 QUEUED → 老師以為家長收到了成績通知。
 *
 * 所以每一個測試的註解寫的是**錯了會怎樣**。
 *
 * 跨越資料庫邊界之後還對不對（真的只寫進一列、worker 重跑不重複送、
 * 租戶隔離、家長看不到不該看的）由 `tools/e2e-notify.mjs` 對真的
 * Postgres 驗。那幾件事在這裡驗不到，而它們是這個功能的核心。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { countByAssignment } from '../lib/scope.mjs';
import {
  MAX_PER_WINDOW,
  NOTIFICATION_RETENTION_DAYS,
  RECHECKED,
  THROTTLE_WINDOW_MS,
  UNREAD_HORIZON_DAYS,
  UNREADY_REASON,
  agreesWithCount,
  buildChannels,
  channelReady,
  dedupeKey,
  deliverDue,
  inQuietHours,
  isDuplicate,
  parseQuietHours,
  purgeOldNotifications,
  quietUntil,
  recipientsByAssignment,
  scheduleFor,
  staleReason,
  subjectOf,
  taipeiDay,
  taipeiMinutes,
  throttle,
  turnedOff,
} from '../lib/notify.mjs';
import {
  AUDIENCE,
  GUARDIAN_PAYLOAD_KEYS,
  MANDATORY,
  TEMPLATES,
  TEMPLATE_KEYS,
  mayTurnOff,
  render,
} from '../lib/notifyTemplates.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, '..');
const read = (rel) => readFileSync(path.join(WEB, rel), 'utf8');

/** 台灣時間的某一刻。`utc(2026, 9, 8, 6, 0)` = 台灣 14:00。 */
const utc = (y, m, d, h, min = 0) => new Date(Date.UTC(y, m - 1, d, h, min));

// ─────────────────────────────────────────────────────────────────
// 一、去重鍵
// ─────────────────────────────────────────────────────────────────

test('去重鍵三段都在：樣板、收件人、事件', () => {
  // 少了樣板 → 同一份任務的「快到期」與「逾期未交」互相吃掉。
  // 少了收件人 → 一份任務放行時只有第一個學生收到，其餘 29 個人的
  //              通知**安靜地消失**（撞到唯一鍵而被當成「已經有了」）。
  // 少了事件   → 這個人一生只收得到一則通知。
  assert.equal(dedupeKey('grade.released', 'u1', 'asg1'), 'grade.released:u1:asg1');
  assert.notEqual(
    dedupeKey('assignment.due_soon', 'u1', '2026-09-08'),
    dedupeKey('assignment.overdue', 'u1', '2026-09-08'),
  );
  assert.notEqual(
    dedupeKey('grade.released', 'u1', 'asg1'),
    dedupeKey('grade.released', 'u2', 'asg1'),
  );
});

test('去重鍵缺任何一段一律丟錯，不是回一個湊出來的字串', () => {
  // 靜靜地產生 `grade.released:u1:` 的話，那個鍵會被這位使用者的
  // 每一則放行通知共用——第二份考試放行時他不會收到任何東西。
  for (const bad of [
    ['', 'u1', 'a1'],
    ['k', '', 'a1'],
    ['k', 'u1', ''],
    ['k', 'u1', undefined],
  ]) {
    assert.throws(() => dedupeKey(...bad), /去重鍵不完整/);
  }
});

test('掃描型的通知一天一則：同一天十次掃描算出同一個鍵', () => {
  // 這是「同一事件跑十次只產生一則」的機制本身。工作者每 15 分鐘跑
  // 一次、一天 96 輪，而鍵一樣就只有第一次寫得進去。
  const keys = new Set();
  for (let i = 0; i < 10; i++) {
    // 一天之內的十個不同時刻（含跨過 UTC 午夜的那幾個）
    const at = utc(2026, 9, 8, (i * 2 + 1) % 24);
    keys.add(dedupeKey('assignment.due_soon', 'u1', taipeiDay(at)));
  }
  assert.equal(keys.size, 2, '台灣的一天橫跨兩個 UTC 日期時應該只有兩個鍵');

  // 同一個台灣日期內的任何時刻都是同一個鍵。
  const morning = dedupeKey('assignment.due_soon', 'u1', taipeiDay(utc(2026, 9, 8, 1)));
  const evening = dedupeKey('assignment.due_soon', 'u1', taipeiDay(utc(2026, 9, 8, 13)));
  assert.equal(morning, evening);
});

test('台灣的日期不是 UTC 的日期', () => {
  // 用 UTC 判「同一天」的話，台灣晚上八點（UTC 12:00）與隔天早上
  // 七點（UTC 23:00 前一天）會落在同一個 UTC 日期——於是**晚上收到
  // 過提醒的學生，隔天早上不會再收到**，而那正是最該提醒他的時候。
  assert.equal(taipeiDay(utc(2026, 9, 8, 16, 30)), '2026-09-09', '台灣 9/9 00:30');
  assert.equal(taipeiDay(utc(2026, 9, 8, 15, 30)), '2026-09-08', '台灣 9/8 23:30');
});

test('撞到唯一鍵的三種寫法都認得', () => {
  // 只認 Prisma 的 P2002 的話，pg-shim（端到端測試）那一條走的是
  // Postgres 的 23505 —— 於是「已經有了」被當成真的失敗，
  // 工作者每一輪印一次錯誤，而事情其實是對的。
  assert.equal(isDuplicate({ code: 'P2002' }), true);
  assert.equal(isDuplicate({ code: '23505' }), true);
  assert.equal(
    isDuplicate(new Error('duplicate key value violates unique constraint "x"')),
    true,
  );
  assert.equal(isDuplicate(new Error('Unique constraint failed on the fields')), true);
  // 別的錯誤不可以被吞掉：連線斷了被當成「已經有了」的話，
  // 那一則通知永遠不會被建立，而日誌上什麼都沒有。
  assert.equal(isDuplicate(new Error('connection terminated')), false);
  assert.equal(isDuplicate({ code: '42703' }), false, '欄位不存在不是重複');
  assert.equal(isDuplicate(null), false);
});

// ─────────────────────────────────────────────────────────────────
// 二、免打擾：延後而不是丟掉
// ─────────────────────────────────────────────────────────────────

const NIGHT = { start: '22:00', end: '07:00' };

test('免打擾時段讀得懂，而且跨午夜是常態', () => {
  const q = parseQuietHours(NIGHT);
  assert.deepEqual(q, { startMin: 22 * 60, endMin: 7 * 60 });
  // 只寫「start < end」那一種的話，最常見的設定完全沒有作用。
  assert.equal(inQuietHours(q, utc(2026, 9, 8, 19)), true, '台灣 03:00 在時段內');
  assert.equal(inQuietHours(q, utc(2026, 9, 8, 14)), true, '台灣 22:00 在時段內（含起點）');
  assert.equal(inQuietHours(q, utc(2026, 9, 7, 23)), false, '台灣 07:00 不在時段內（不含終點）');
  assert.equal(inQuietHours(q, utc(2026, 9, 8, 6)), false, '台灣 14:00 不在時段內');
});

test('同一天之內的免打擾時段也要對', () => {
  const q = parseQuietHours({ start: '13:00', end: '15:00' });
  assert.equal(inQuietHours(q, utc(2026, 9, 8, 6)), true, '台灣 14:00');
  assert.equal(inQuietHours(q, utc(2026, 9, 8, 19)), false, '台灣 03:00');
});

test('讀不懂的免打擾時段一律當成沒有設定，不猜', () => {
  // 猜錯的症狀是通知全部消失而畫面上沒有任何跡象；
  // 「設定沒生效」是會被回報的。
  for (const bad of [
    null,
    {},
    { start: '22:00' },
    { start: '25:00', end: '07:00' },
    { start: '2:0', end: '07:00' },
    { start: 2200, end: 700 },
    ['22:00', '07:00'],
  ]) {
    assert.equal(parseQuietHours(bad), null, `${JSON.stringify(bad)} 應該讀成沒有設定`);
  }
});

test('開始與結束相同的免打擾時段當成沒有設定', () => {
  // 那寫下去的意思是「一整天都不要打擾」，而它的實際效果是每一則
  // 通知被排到 24 小時後、再排到 24 小時後——**一則都不會出現**，
  // 而那不該被靜靜地接受。API 那一層也會擋，訊息說得出原因。
  assert.equal(parseQuietHours({ start: '08:00', end: '08:00' }), null);
});

test('免打擾時段內的通知延到結束那一刻，不是丟掉', () => {
  // **丟掉的那一則永遠不會回來**，而它可能是六則裡唯一重要的
  // 那一則。這裡驗的是它真的還在，只是晚一點。
  const q = parseQuietHours(NIGHT);
  const at = utc(2026, 9, 8, 19, 13); // 台灣 9/9 03:13
  const when = scheduleFor({ nowMs: at.getTime(), recent: [], quiet: q });
  assert.ok(when > at, '應該往後排');
  assert.equal(taipeiMinutes(when), 7 * 60, '排到台灣早上七點整');
  assert.equal(taipeiDay(when), '2026-09-09');
  assert.equal(inQuietHours(q, when), false, '排完之後不可以還在時段內');
});

test('免打擾時段外的通知立刻出現', () => {
  const q = parseQuietHours(NIGHT);
  const at = utc(2026, 9, 8, 6); // 台灣 14:00
  assert.equal(+scheduleFor({ nowMs: at.getTime(), recent: [], quiet: q }), +at);
});

test('沒有設免打擾的人一律立刻出現', () => {
  const at = utc(2026, 9, 8, 19); // 台灣 03:00
  assert.equal(+scheduleFor({ nowMs: at.getTime(), recent: [], quiet: null }), +at);
});

test('剛好落在免打擾結束那一刻的不延後', () => {
  // 邊界寫錯（用 <= 而不是 <）的話，早上七點整產生的通知會被排到
  // 隔天早上七點——晚 24 小時，而且看起來像通知不見了。
  const q = parseQuietHours(NIGHT);
  const at = utc(2026, 9, 7, 23); // 台灣 9/8 07:00
  assert.equal(+scheduleFor({ nowMs: at.getTime(), recent: [], quiet: q }), +at);
});

// ─────────────────────────────────────────────────────────────────
// 三、節流
// ─────────────────────────────────────────────────────────────────

test('一分鐘內最多三則，第四則往後排而不是被丟掉', () => {
  // schema 自己的註解就寫著「避免家長在一分鐘內收到五則相同的
  // 到班通知」。沒有這一段的話，一輪逾期掃描會讓一個學生同時多出
  // 六列，而收件匣從那一刻起不再是一份可以讀的清單。
  const now = 1_000_000;
  const recent = [];
  const times = [];
  for (let i = 0; i < 6; i++) {
    const at = throttle(recent, now);
    recent.push(at);
    times.push(at);
  }
  assert.deepEqual(times.slice(0, MAX_PER_WINDOW), Array(MAX_PER_WINDOW).fill(now));
  for (let i = MAX_PER_WINDOW; i < 6; i++) {
    assert.ok(times[i] > now, `第 ${i + 1} 則應該往後排`);
    assert.equal(times[i], now + THROTTLE_WINDOW_MS, '排到視窗空出來的那一刻');
  }
  // **一則都不能少。** 這是「延後而不是丟掉」在節流這一側的樣子。
  assert.equal(times.length, 6);
});

test('視窗是滑動的，不是整分鐘的格子', () => {
  // 用固定格子的話，59 秒與 61 秒屬於不同視窗，於是六則可以在
  // 兩秒內全部出現——節流看起來有做，實際上沒有。
  const now = 1_000_000;
  const justInside = [now - 1_000, now - 2_000, now - 3_000];
  assert.ok(throttle(justInside, now) > now, '一分鐘內已經三則了，第四則要等');
});

test('已經離開視窗的不算', () => {
  const now = 1_000_000;
  const old = [now - 120_000, now - 90_000, now - 61_000];
  assert.equal(throttle(old, now), now, '都超過一分鐘了，不該擋');
});

test('節流與免打擾一起生效：半夜累積的通知不會在七點一次湧出', () => {
  // 只做「先節流、再避開時段」兩步的話，半夜的五則各自被推到早上
  // 七點，而在七點那一刻它們是**同時出現的**——免打擾一結束，
  // 累積一整夜的通知一次湧出，而那正是節流要防的事。
  // 所以 `scheduleFor` 求的是兩者的不動點。
  const q = parseQuietHours(NIGHT);
  const at = utc(2026, 9, 8, 19); // 台灣 03:00，在時段內
  const recent = [];
  const out = [];
  for (let i = 0; i < 5; i++) {
    const when = scheduleFor({ nowMs: at.getTime(), recent, quiet: q });
    recent.push(when.getTime());
    out.push(when);
  }
  // 全部都在時段外
  for (const w of out) assert.equal(inQuietHours(q, w), false);
  // 而且不是五則同時出現在七點整
  const distinct = new Set(out.map((w) => +w));
  assert.ok(distinct.size >= 2, '五則不可以全部落在同一刻');
});

// ─────────────────────────────────────────────────────────────────
// 四、必收：關不掉的那幾則
// ─────────────────────────────────────────────────────────────────

test('必收清單就是「別人動了你的成績」那幾件事', () => {
  // 這一格是整支測試最重要的一格。任一則從清單上掉下來，症狀是
  // 學生關掉之後**永遠不知道自己的卷子出了事**，而他的設定畫面
  // 看起來完全正常。
  //
  // `grade.changed` 是後來補上的，而它原本不在清單裡**不是一個決定**：
  // `regradeAssignment` 真的改寫了學生的分數（老師改標準答案、送分），
  // 卻連一則可關可不關的通知都沒有——他下次自己點進去才會發現 78
  // 變成 72。那條規則自己說得出口的東西漏掉了一項。
  assert.deepEqual(
    [...MANDATORY].sort(),
    [
      'attempt.finalized_by_teacher',
      'attempt.unvoided',
      'attempt.voided',
      'grade.changed',
    ].sort(),
  );
});

test('分數被改寫的那幾則通知都存在，而且都關不掉', () => {
  // 「別人動了你的成績」在系統裡有四條路徑，而每一條都要有一則
  // 通知。少了任何一則，學生會在成績單上看到一個他無法解釋的數字，
  // 而系統裡沒有任何一條路徑能讓他知道「有事發生過」。
  for (const key of [
    'attempt.voided', // 作廢
    'attempt.unvoided', // 撤銷作廢
    'attempt.finalized_by_teacher', // 代為結算
    'grade.changed', // 改標準答案／送分之後重算
  ]) {
    assert.ok(TEMPLATES[key], `${key} 這一則不見了`);
    assert.equal(mayTurnOff(key), false, `${key} 關得掉`);
  }
  // 重算那一則**不可以把新舊分數寫進內文**：收件人裡有一種人現在
  // 還不該看到分數（MANUAL／ON_DUE 尚未放行），而放行時機是老師的
  // 決定。觸發那一端會再擋一次，這裡擋的是文案本身。
  const v = render('grade.changed', { title: '第三次模擬考', from: 78, to: 72 });
  assert.ok(!v.body.includes('78') && !v.body.includes('72'), '重算通知把分數寫進內文了');
  assert.match(v.body, /重新算過|重算/);
});

test('必收的關不掉，其餘的關得掉', () => {
  for (const key of MANDATORY) {
    assert.equal(mayTurnOff(key), false, `${key} 不該關得掉`);
    // 就算 `channels` 裡寫著關閉也不算——**畫面上停用一個核取方塊
    // 不是保護**，直接打 API 一樣送得進來。
    assert.equal(turnedOff({ [key]: { IN_APP: false } }, key, 'IN_APP'), false);
  }
  const optional = TEMPLATE_KEYS.filter((k) => !MANDATORY.includes(k));
  assert.ok(optional.length >= 5, '可關閉的類別太少，是不是清單寫錯了');
  for (const key of optional) {
    assert.equal(mayTurnOff(key), true, `${key} 應該關得掉`);
    assert.equal(turnedOff({ [key]: { IN_APP: false } }, key, 'IN_APP'), true);
  }
});

test('存偏好時必收的一律不寫入', () => {
  // 直接對 API 送 `{"attempt.voided": false}` 是一次合法的請求，
  // 而它不可以生效。判斷在這裡（純函式）而不是在路由裡，
  // 因為路由會有第二支、第三支。
  const built = buildChannels({
    'attempt.voided': false,
    'assignment.due_soon': false,
    'grade.released': true,
  });
  assert.deepEqual(built, { 'assignment.due_soon': { IN_APP: false } });
});

test('偏好只記關掉的，開著的不記', () => {
  // 若記的是白名單，日後新增一則通知類別時，既有的每一個帳號對它
  // 都是關閉的——而沒有人會發現，因為那一類從來沒有出現過。
  assert.deepEqual(buildChannels({ 'grade.released': true }), {});
  assert.deepEqual(buildChannels({}), {});
});

test('認不得的樣板代號不會被寫進偏好', () => {
  // 否則任何人都可以往 `channels` 這個 JSON 裡塞任意鍵值，
  // 而那一欄之後每一次讀取都要處理未知的形狀。
  assert.deepEqual(buildChannels({ 'made.up.key': false }), {});
});

test('沒有偏好記錄的人一律收得到', () => {
  // 預設值必須往「收得到」倒：一張空的偏好表（每一個新帳號都是）
  // 若被讀成「全部關閉」，症狀是通知功能整個不存在，而畫面完全正常。
  for (const raw of [null, undefined, {}, 'oops', [], { 'grade.released': 'yes' }]) {
    assert.equal(turnedOff(raw, 'grade.released', 'IN_APP'), false);
  }
});

// ─────────────────────────────────────────────────────────────────
// 五、未接的渠道
// ─────────────────────────────────────────────────────────────────

test('只有站內通知是真的送得出去的', () => {
  assert.equal(channelReady('IN_APP'), true);
  for (const c of ['EMAIL', 'LINE', 'SMS']) {
    assert.equal(channelReady(c), false, `${c} 還沒有接`);
    // **每一個未接的渠道都要說得出原因**，而那句話會被原封不動寫進
    // `failReason`。少了它，老師問「為什麼家長沒收到」時，
    // 資料庫裡那一列只有一個 SUPPRESSED，沒有任何線索。
    assert.ok(
      typeof UNREADY_REASON[c] === 'string' && UNREADY_REASON[c].length > 10,
      `${c} 沒有寫原因`,
    );
  }
  assert.equal(channelReady('CARRIER_PIGEON'), false, '認不得的渠道一律不送');
});

test('enqueueMany 對未接的渠道不會留在 QUEUED', () => {
  // 這一條用原始碼檢查，因為它是**這個功能最危險的一種失敗**：
  // 一則卡在 QUEUED 的通知是在說「排隊中，等一下就送」，而它永遠
  // 不會被送出——老師會以為家長收到了成績通知。
  //
  // 真的寫進資料庫之後長什麼樣由 tools/e2e-notify.mjs 驗。
  const src = read('lib/notify.mjs');
  const body = src.slice(src.indexOf('export async function enqueueMany'));
  const branch = body.slice(body.indexOf('if (!channelReady(channel))'));
  const stop = branch.indexOf('} else');
  const inside = branch.slice(0, stop > 0 ? stop : 400);
  assert.match(inside, /SUPPRESSED/, '未接的渠道要立刻標成 SUPPRESSED');
  assert.match(inside, /failReason\s*=/, '而且要寫下原因');
});

// ─────────────────────────────────────────────────────────────────
// 六、一份任務派給了誰：與 lib/scope.mjs 的口徑一致
// ─────────────────────────────────────────────────────────────────

test('展開出來的名單與 countByAssignment 算出的人數一致', () => {
  // 兩份實作對同一組輸入必須給出同一個答案。不一致的症狀是
  // 派卷頁寫著「派給 63 人」而催繳只發給 61 個人，
  // 而**沒有人說得出哪一個是對的**。
  const members = new Map([
    ['c1', ['s1', 's2', 's3']],
    ['c2', ['s3', 's4']], // s3 同時在兩個班（重補修很常見）
    ['c3', ['s5', 'ta1']], // ta1 是助教，不在 valid 裡
  ]);
  const valid = new Set(['s1', 's2', 's3', 's4', 's5']);
  const cases = [
    [{ assignmentId: 'a1', classId: 'c1', userId: null }],
    [
      { assignmentId: 'a1', classId: 'c1', userId: null },
      { assignmentId: 'a1', classId: 'c2', userId: null },
    ],
    [{ assignmentId: 'a1', classId: 'c1', userId: 's4' }], // 一列兩邊都有值
    [
      { assignmentId: 'a1', classId: 'c3', userId: null },
      { assignmentId: 'a2', classId: null, userId: 's1' },
      { assignmentId: 'a2', classId: null, userId: 'ghost' },
    ],
    [],
  ];
  for (const targets of cases) {
    assert.equal(
      agreesWithCount(targets, members, valid),
      true,
      `這一組對不起來：${JSON.stringify(targets)}`,
    );
  }
});

test('同一位學生在兩個被派到的班上只算一個人', () => {
  const members = new Map([
    ['c1', ['s1', 's3']],
    ['c2', ['s3']],
  ]);
  const valid = new Set(['s1', 's3']);
  const sets = recipientsByAssignment(
    [
      { assignmentId: 'a1', classId: 'c1', userId: null },
      { assignmentId: 'a1', classId: 'c2', userId: null },
    ],
    members,
    valid,
  );
  assert.deepEqual([...sets.get('a1')].sort(), ['s1', 's3']);
  assert.equal(countByAssignment(
    [
      { assignmentId: 'a1', classId: 'c1', userId: null },
      { assignmentId: 'a1', classId: 'c2', userId: null },
    ],
    members,
    valid,
  ).get('a1'), 2);
});

test('不是學生的帳號不進名單', () => {
  // 助教與已軟刪除的帳號進了名單的話，催繳清單上會有一個永遠交不出
  // 東西的人，而老師會一直去找他。
  const sets = recipientsByAssignment(
    [{ assignmentId: 'a1', classId: 'c1', userId: 'ta1' }],
    new Map([['c1', ['s1', 'ta1']]]),
    new Set(['s1']),
  );
  assert.deepEqual([...sets.get('a1')], ['s1']);
});

test('退出班級的學生收不到那個班的通知', () => {
  // `leftAt` 不是 null 的成員不會出現在 membersOfClass 裡（查詢就
  // 帶了那個條件，見 lib/notify.mjs 的 pendingByStudent）。這裡驗的是
  // 展開這一段本身不會憑空把人加回來——例如從 assignment_targets 的
  // userId 那一側。
  const sets = recipientsByAssignment(
    [{ assignmentId: 'a1', classId: 'c1', userId: null }],
    new Map([['c1', ['s1']]]), // s2 已離班，所以不在這裡
    new Set(['s1', 's2']),
  );
  assert.deepEqual([...sets.get('a1')], ['s1']);
  assert.equal(sets.get('a1').has('s2'), false, '離班的學生不可以出現在名單裡');
});

// ─────────────────────────────────────────────────────────────────
// 七、文案：每一則都要有下一步
// ─────────────────────────────────────────────────────────────────

test('每一則通知都說得出「下一步去哪裡」', () => {
  // **這是這個功能的規格。** 做不到下一步的通知只是噪音，
  // 而「你的作答被作廢了」沒有下一步的話，那則通知只會製造一通電話。
  for (const key of TEMPLATE_KEYS) {
    const t = TEMPLATES[key];
    assert.ok(t.label && t.label.length >= 2, `${key} 沒有名稱`);
    assert.ok(t.why && t.why.length >= 8, `${key} 沒有說明什麼時候會收到`);
    assert.ok(t.action && t.action.length >= 2, `${key} 沒有下一步的按鈕文字`);
    const v = render(key, {});
    assert.ok(v.known, `${key} render 不出來`);
    assert.ok(v.title.length >= 4, `${key} 的標題太短`);
    assert.ok(v.body.length >= 20, `${key} 的內文沒有說明狀況與下一步`);
    // 連結一定要是站內的絕對路徑。相對路徑在收件匣（/inbox）底下
    // 會解析成 /inbox/xxx，而那是一個 404。
    assert.match(v.href, /^\//, `${key} 的連結不是站內絕對路徑：${v.href}`);
  }
});

test('作廢通知不替人下結論，也不含理由', () => {
  // 作廢的原因有兩種（誠信事件與系統故障），而**系統分不出來**。
  // 把老師寫給稽核看的那一句推到學生面前，等於讓系統代替老師說出
  // 一句指控，而猜錯的那一次是指控一個沒有作弊的孩子。
  const v = render('attempt.voided', {
    title: '第三次模擬考',
    // 就算呼叫端誤傳了 reason，文案也不可以用它。
    reason: '監考記錄顯示作答中使用手機',
  });
  for (const word of ['作弊', '違規', '手機', '監考', 'reason']) {
    assert.ok(!v.body.includes(word), `作廢通知不該出現「${word}」`);
  }
  // 但一定要說得出去找誰——沒有這一句，這則通知就是一通電話。
  assert.match(v.body, /老師/);
  assert.match(v.body, /不會計分|不算/);
});

test('家長的通知只吃白名單裡的欄位', () => {
  // 家長那一份是**學生那一份的投影，欄位只減不加**（見
  // lib/guardian.ts 的檔頭）。而一則通知是把資料推出去，比一個頁面
  // 更難收回來——所以逐題作答、智慧老師的對話、考試行為偵測
  // 一個字都不可以進來。
  const guardianKeys = TEMPLATE_KEYS.filter(
    (k) => TEMPLATES[k].audience === AUDIENCE.GUARDIAN,
  );
  assert.ok(guardianKeys.length >= 1, '家長至少要有一則通知');

  // 餵一份「什麼都有」的 payload，看文案會不會把不該用的欄位印出來。
  const poisoned = {
    childName: '王大明',
    studentId: 's1',
    count: 2,
    titles: ['數學小考'],
    dueAt: '2026-09-08T07:59:00.000Z',
    canStillSubmit: false,
    // 以下是絕對不可以出現在畫面上的東西
    answerKeys: [3],
    answerText: '我不會寫',
    tutorMessage: '老師我這題不懂',
    proctorEvent: 'TAB_SWITCH',
    totalScore: 42,
  };
  for (const key of guardianKeys) {
    const v = render(key, poisoned);
    for (const secret of ['我不會寫', '我這題不懂', 'TAB_SWITCH', '42']) {
      assert.ok(
        !v.title.includes(secret) && !v.body.includes(secret),
        `${key} 把「${secret}」印出來了`,
      );
    }
  }
});

test('家長的樣板原始碼只讀白名單裡的欄位', () => {
  // 上一格是行為檢查，這一格是靜態檢查——它擋的是三個月後有人
  // 「順手」在家長的文案裡多讀一個 payload 欄位，因為那看起來
  // 只是多一句話。與 tests/guardian.test.mjs 的手法相同。
  const src = read('lib/notifyTemplates.mjs');
  const guardianKeys = TEMPLATE_KEYS.filter(
    (k) => TEMPLATES[k].audience === AUDIENCE.GUARDIAN,
  );
  for (const key of guardianKeys) {
    const at = src.indexOf(`'${key}': {`);
    assert.ok(at > 0, `原始碼裡找不到 ${key}`);
    // 到下一個樣板為止（或檔尾）。
    const rest = src.slice(at + key.length);
    const end = rest.search(/\n {2}(?:\/\*\*|'[\w.]+': \{|\}\);)/);
    const block = rest.slice(0, end > 0 ? end : rest.length);
    for (const m of block.matchAll(/\bp\.(\w+)/g)) {
      assert.ok(
        GUARDIAN_PAYLOAD_KEYS.includes(m[1]),
        `${key} 讀了 payload.${m[1]}，而它不在家長的白名單裡。` +
          `要新增欄位請先確認它不是逐題作答、智慧老師或監考的資料，` +
          `然後加進 GUARDIAN_PAYLOAD_KEYS。`,
      );
    }
  }
});

test('認不得的樣板代號不會讓收件匣壞掉', () => {
  // 資料庫裡的 templateKey 是一個字串，而程式會改版。丟出例外的話
  // **整個收件匣變成錯誤頁**，而使用者失去的不是那一列，是全部。
  const v = render('some.old.key', { anything: 1 });
  assert.equal(v.known, false);
  assert.ok(v.title.length > 0 && v.body.length > 0);
  assert.match(v.href, /^\//);
});

test('payload 缺欄位、型別不對都畫得出東西，而且不印 [object Object]', () => {
  for (const payload of [null, undefined, {}, [], 'oops', { title: { a: 1 } }, { count: 'x' }]) {
    for (const key of TEMPLATE_KEYS) {
      const v = render(key, payload);
      assert.ok(!v.title.includes('[object'), `${key} 的標題印出了物件`);
      assert.ok(!v.body.includes('[object'), `${key} 的內文印出了物件`);
      assert.ok(!v.title.includes('undefined'), `${key} 的標題印出了 undefined`);
      assert.ok(!v.body.includes('undefined'), `${key} 的內文印出了 undefined`);
    }
  }
});

test('摘要的文案講得出份數，六份不會變成一句沒有數字的話', () => {
  const v = render('assignment.due_soon', {
    count: 6,
    titles: ['數學小考', '英文週考', '國文默寫'],
    dueAt: '2026-09-08T07:59:00.000Z',
  });
  assert.match(v.title, /6/);
  assert.match(v.body, /數學小考/);
  assert.match(v.body, /等 6 份/);
});

test('逾期未交的下一步分兩種，而且差很多', () => {
  // 把兩種寫成同一句的話，其中一半的人會照著做一件做不到的事，
  // 然後認為系統在騙他。
  const late = render('assignment.overdue', { count: 1, titles: ['數學小考'], canStillSubmit: true });
  const closed = render('assignment.overdue', { count: 1, titles: ['數學小考'], canStillSubmit: false });
  assert.notEqual(late.body, closed.body);
  assert.match(late.body, /遲交/);
  assert.match(closed.body, /老師/);
});

// ─────────────────────────────────────────────────────────────────
// 八、與 lib/guardian.ts 的「誰收得到通知」是同一條規則
// ─────────────────────────────────────────────────────────────────

/**
 * 「哪一位成年人收得到一個孩子的資料」**只可以有一份實作**。
 *
 * 這條規則放寬的後果是把成績推給一個沒有被確認過的信箱，也就是
 * 陌生人。而它原本有兩份：`lib/notify.mjs` 的 `notifiableGuardianIds`
 * （工作者的，工作者是純 node、import 不了 .ts）與 `lib/guardian.ts`
 * 的 `notifiableGuardians`（網頁端的）。這一格原本逐條比對兩支的
 * where 條件，而那擋得住「改了一邊忘了另一邊」，擋不住現況：
 * **正式環境跑的一直只有工作者那一份**，網頁端那一支除了端到端
 * 測試沒有任何呼叫端——一份沒有人在跑的規則遲早與真的在跑的那一份
 * 不一樣。
 *
 * 所以現在驗的是更強的一件事：只有一份實作，另一支是它的殼。
 */
const GUARDIAN_REQUIRED = ['verifiedAt', 'not', 'systemRole', 'status', 'deletedAt'];

/** 抽出一支函式的內文（到下一個 top-level `export ` 或檔尾）。 */
function bodyOf(src, signature) {
  const at = src.indexOf(signature);
  assert.ok(at > 0, `找不到 ${signature}`);
  const rest = src.slice(at);
  const end = rest.indexOf('\nexport ', 1);
  return rest.slice(0, end > 0 ? end : rest.length);
}

test('家長收不收得到通知：規則寫在 notify.mjs，而且四個條件都在', () => {
  const body = bodyOf(read('lib/notify.mjs'), 'export async function notifiableGuardianIds(');
  const keys = new Set([...body.matchAll(/(\w+):/g)].map((m) => m[1]));
  for (const need of GUARDIAN_REQUIRED) {
    assert.ok(
      keys.has(need),
      `notifiableGuardianIds 少了 ${need} 這個條件。` +
        `未驗證、停權或已刪除的家長帳號會開始收到孩子的成績通知。`,
    );
  }
});

test('lib/guardian.ts 沒有第二份「誰收得到通知」', () => {
  const body = bodyOf(read('lib/guardian.ts'), 'export async function notifiableGuardians(');
  assert.match(
    body,
    /notifiableGuardianIds\(/,
    'notifiableGuardians 要委派給 notify.mjs 那一支，不是自己再查一次',
  );
  // 殼裡那一句查詢只挑顯示欄位。出現 `verifiedAt` 或 `systemRole`
  // 就代表又長出了一份平行的規則——而兩份規則遲早會不一樣，
  // 不一樣的方向是一位沒有被確認過的成年人開始收到孩子的成績。
  for (const dup of ['verifiedAt', 'systemRole', 'status']) {
    assert.ok(
      !new RegExp(`${dup}\\s*:`).test(body),
      `notifiableGuardians 又自己判了 ${dup}。這條規則只可以有一份實作。`,
    );
  }
});

test('每一支送給家長的通知都經過 notifiableGuardianIds', () => {
  // 家長那一側的收件人**不可以**用「查一下 guardianLink」湊出來：
  // 那樣會漏掉 `verifiedAt`，而那一欄擋的正是「把成績寄給陌生人」。
  // 通知模組裡任何一處查 guardianLink 都要就是那一支本身。
  for (const file of ['lib/notify.mjs', 'lib/notifyDb.ts']) {
    const src = read(file);
    const hits = [...src.matchAll(/(prisma|tx)\s*\.\s*guardianLink\b/g)];
    if (file === 'lib/notifyDb.ts') {
      assert.equal(hits.length, 0, 'notifyDb.ts 自己查了 guardianLink，繞過了那道確認');
      assert.match(src, /notifiableGuardianIds\(/, 'notifyDb.ts 沒有用那一支算收件人');
      continue;
    }
    // notify.mjs 裡唯一一處必須落在 `notifiableGuardianIds` 內。
    const body = bodyOf(src, 'export async function notifiableGuardianIds(');
    assert.equal(hits.length, 1, 'notify.mjs 有第二處查 guardianLink');
    assert.match(body, /guardianLink/, '那一處不在 notifiableGuardianIds 裡');
  }
});

test('通知模組完全不碰逐題作答、智慧老師與監考的資料', () => {
  // 與 tests/guardian.test.mjs 同一條規則、同一個手法。**畫面層漏畫
  // 一個 if 是很平常的事，漏查一個查詢不是**——所以直接禁止這幾個
  // 字出現在通知模組與收件匣裡。
  const files = [
    'lib/notify.mjs',
    'lib/notifyDb.ts',
    'lib/notifyTemplates.mjs',
    'app/(app)/inbox/page.tsx',
    'app/(app)/inbox/MarkRead.tsx',
  ];
  const banned = ['tutorSession', 'tutorMessage', 'attemptAnswer', 'proctorEvent'];
  for (const f of files) {
    const src = read(f);
    for (const word of banned) {
      // `attemptAnswer` 這個字在 notify.mjs 的註解裡出現過（說明為什麼
      // 不去數它），所以只檢查非註解的行。
      const code = src
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      assert.ok(
        !code.includes(word),
        `${f} 出現了 ${word}。通知是把資料推出去的，比一個頁面更難收回來。`,
      );
    }
  }
});

// ─────────────────────────────────────────────────────────────────
// 九、未讀數的地平線
// ─────────────────────────────────────────────────────────────────

test('未讀數有一個地平線，紅點不會永遠掛著', () => {
  // 一個永遠不歸零的紅點，一週之後就被完全忽略了——而那時它連
  // 「有新的事情」都不再表示。這是三道機制裡的第三道（另外兩道
  // 在收件匣頁：打開就標成已讀、以及沒有未讀時完全不畫那個數字）。
  assert.ok(UNREAD_HORIZON_DAYS >= 7 && UNREAD_HORIZON_DAYS <= 90);
  const src = read('lib/notify.mjs');
  const body = bodyOf(src, 'export function unreadCount(');
  assert.match(body, /UNREAD_HORIZON_DAYS/, '未讀數要套用地平線');
  assert.match(body, /readAt: null/, '只算沒讀過的');
  assert.match(body, /status: 'SENT'/, "只算已經送出的——QUEUED 的還沒出現在收件匣裡");
});

test('導覽列沒有未讀時完全不畫那個數字', () => {
  // 一個寫著 0 的紅點是最快被學會忽略的東西。
  const src = read('components/Nav.tsx');
  assert.match(src, /unread > 0 &&/, '未讀為 0 時不可以畫 badge');
});

test('標成已讀一定同時比對收件人', () => {
  // 只用 id 的話，任何人送一串別人的 id 就把別人的通知標成讀過了。
  // RLS 擋得住別家補習班，擋不住同一間補習班的隔壁同學。
  const body = bodyOf(read('lib/notify.mjs'), 'export async function markRead(');
  // 每一個 `where:` 到它後面的 `data:` 之間就是這一次更新的條件。
  // 用括號配對太脆（巢狀的 `{ in: ids }`），而這兩個關鍵字之間的
  // 那一段一定包含全部條件。
  const wheres = [...body.matchAll(/where:\s*([\s\S]*?)data:/g)].map((m) => m[1]);
  assert.ok(wheres.length >= 2, 'markRead 應該有兩條路徑（指定幾則、全部）');
  for (const w of wheres) {
    assert.match(w, /recipientId/, `這一條 where 沒有比對收件人：${w}`);
  }
});

// ─────────────────────────────────────────────────────────────────
// 十、送出前的重新確認
//
// 產生與送出之間可以隔八個小時（免打擾 22:00–07:00），而通知的內容
// 在**產生**的那一刻就寫死了。這一節驗的是「排隊期間事實變了」的
// 那幾種，而它們的共同症狀是：家長早上讀到一件已經不成立的事，
// 然後去做一件白做的事。
// ─────────────────────────────────────────────────────────────────

const overdueRow = (over = {}) => ({
  id: 'n1',
  templateKey: 'assignment.overdue',
  recipientId: 'stu_1',
  channel: 'IN_APP',
  status: 'QUEUED',
  retryCount: 0,
  scheduledAt: utc(2026, 9, 9, 23, 0),
  createdAt: utc(2026, 9, 8, 15, 10),
  payload: { count: 1, titles: ['數學小考'], assignmentIds: ['asg_1'] },
  ...over,
});

test('補交了就不再送那一則催繳', () => {
  // 23:10 判定逾期、排到隔天 07:00；23:40 補交了。07:00 照樣送出去的話，
  // 家長讀到的是一件已經不成立的事，而她的下一步（去催孩子）是白做的。
  const row = overdueRow();
  assert.equal(staleReason(row, new Set()), null, '還沒交就該照送');
  const why = staleReason(row, new Set(['asg_1|stu_1']));
  assert.ok(why, '補交之後還是送出去了');
  assert.match(why, /不成立/);
});

test('三份裡補交一份，催繳照送——下一步仍然成立', () => {
  // 「2 份」配上三個名稱比原來那句更糟（payload 只留了前三個名稱，
  // 重算不出一句準確的話），而還有一份沒交時，「去問孩子」完全成立。
  const row = overdueRow({ payload: { count: 3, assignmentIds: ['a1', 'a2', 'a3'] } });
  assert.equal(staleReason(row, new Set(['a1|stu_1'])), null);
  assert.ok(staleReason(row, new Set(['a1|stu_1', 'a2|stu_1', 'a3|stu_1'])));
});

test('家長那一則看的是孩子交了沒，不是家長自己', () => {
  // 收件人是媽媽，而事實是王小美的。拿 recipientId 去比對的話，
  // 永遠找不到作答記錄，於是每一則都會被判成「還成立」——
  // 這個錯誤的方向是催繳照樣送出，而且完全沒有症狀。
  const row = overdueRow({
    templateKey: 'assignment.overdue.guardian',
    recipientId: 'mom_1',
    payload: { count: 1, assignmentIds: ['asg_1'], studentId: 'stu_1', childName: '王小美' },
  });
  assert.equal(subjectOf(row), 'stu_1');
  assert.ok(staleReason(row, new Set(['asg_1|stu_1'])), '孩子補交了，媽媽還是收到催繳');
  assert.equal(staleReason(row, new Set(['asg_1|mom_1'])), null, '比對到了錯的人');
});

test('已經發生過的事件不重新確認', () => {
  // 作廢、代為結算、放行不會因為時間過去而變成沒發生。給它們加一道
  // 重新確認只是多一個會出錯的地方。
  for (const key of ['attempt.voided', 'grade.released', 'import.ready', 'grade.changed']) {
    assert.equal(RECHECKED[key], undefined, `${key} 不該被重新確認`);
    assert.equal(staleReason({ templateKey: key, recipientId: 'u', payload: {} }, new Set()), null);
  }
});

test('舊格式（沒有 assignmentIds）一律照送', () => {
  // 這一欄是後來才加的，佇列裡可能躺著上一版產生的列。驗不了就照送——
  // 把驗不了的通通擋下來，等於在改版那一天讓所有排隊中的催繳消失。
  const row = overdueRow({ payload: { count: 1, titles: ['數學小考'] } });
  assert.equal(staleReason(row, new Set(['asg_1|stu_1'])), null);
});

test('催繳的 payload 真的帶得出要重新確認的那幾份', () => {
  // 上面那幾格驗的是判斷，這一格驗的是**判斷用得到的資料真的在**。
  // 少了它，重新確認永遠走到「舊格式，照送」那一條，而每一格都是綠的。
  const src = read('lib/notify.mjs');
  const body = src.slice(src.indexOf('function digestPayload('));
  assert.match(body.slice(0, 500), /assignmentIds/, '摘要 payload 沒有帶 assignmentIds');
});

/**
 * 一個小小的假資料庫。
 *
 * 為什麼不是真的 Postgres：這一支是單元測試，跑在沒有資料庫的地方
 * （`npm test`）。真的跨越資料庫邊界之後還對不對由 `tools/e2e-notify.mjs`
 * 驗。這裡要驗的是 `deliverDue` 的**分支**：撿起來之後有沒有先問
 * 一次「這件事還成不成立」，而那件事與 SQL 無關。
 */
function fakeDb({ notifications = [], attempts = [] }) {
  const rows = notifications.map((n) => ({ ...n }));
  const hit = (row, where) =>
    Object.entries(where ?? {}).every(([k, cond]) => {
      const v = row[k];
      if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
        if ('in' in cond) return cond.in.includes(v);
        if ('lt' in cond) return v != null && new Date(v) < new Date(cond.lt);
        if ('gt' in cond) return v != null && new Date(v) > new Date(cond.gt);
        if ('not' in cond) return v !== cond.not;
      }
      return v === cond;
    });
  return {
    rows,
    notification: {
      async findMany({ where, take }) {
        const out = rows.filter((r) => hit(r, where));
        return (take ? out.slice(0, take) : out).map((r) => ({ ...r }));
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const r of rows) {
          if (!hit(r, where)) continue;
          Object.assign(r, data);
          count++;
        }
        return { count };
      },
      async deleteMany({ where }) {
        const doomed = rows.filter((r) => hit(r, where));
        for (const d of doomed) rows.splice(rows.indexOf(d), 1);
        return { count: doomed.length };
      },
    },
    attempt: {
      async findMany({ where }) {
        return attempts.filter((a) => hit(a, where)).map((a) => ({ ...a }));
      },
    },
  };
}

test('deliverDue 送出前真的問過一次，不成立的標成 SUPPRESSED 而不是刪掉', async () => {
  const db = fakeDb({
    notifications: [
      overdueRow({ id: 'stale' }),
      overdueRow({ id: 'fresh', recipientId: 'stu_2', payload: { assignmentIds: ['asg_1'] } }),
      overdueRow({ id: 'event', templateKey: 'attempt.voided', payload: {} }),
    ],
    // stu_1 已經補交了，stu_2 沒有。
    attempts: [{ assignmentId: 'asg_1', userId: 'stu_1', status: 'SUBMITTED' }],
  });
  const r = await deliverDue(db, { now: utc(2026, 9, 10, 0, 0) });

  assert.equal(r.suppressed, 1, '已經不成立的那一則還是送出去了');
  assert.equal(r.sent, 2, '還成立的與事件型的都該照送');
  const byId = new Map(db.rows.map((x) => [x.id, x]));
  assert.equal(byId.get('stale').status, 'SUPPRESSED');
  // **不刪掉**：查得到才答得出「為什麼那天早上沒有收到催繳」。
  assert.match(byId.get('stale').failReason, /不成立/);
  assert.equal(byId.get('fresh').status, 'SENT');
  assert.equal(byId.get('event').status, 'SENT');
});

// ─────────────────────────────────────────────────────────────────
// 十一、家長也收得到「成績開放了」
// ─────────────────────────────────────────────────────────────────

test('成績開放的通知有家長那一份，而且不含分數', () => {
  // 家長端那一頁在放行之前寫的是「老師還沒有開放成績」，而**開放的
  // 那一刻沒有任何跡象**——這是學生那一則自己寫下的理由，一個字
  // 不必改就適用於家長。少了它，那一頁等於要她每天回來按一次。
  const t = TEMPLATES['grade.released.guardian'];
  assert.ok(t, '家長沒有「成績開放」的通知');
  assert.equal(t.audience, AUDIENCE.GUARDIAN);
  const v = render('grade.released.guardian', {
    childName: '王大明',
    studentId: 's1',
    title: '第三次模擬考',
    // 就算呼叫端誤傳，文案也不可以用它——分數要在 /guardian 那一頁上
    // 看，那裡才有「人數太少就不給班級平均」那道防線。
    totalScore: 68,
    answerKeys: [3],
  });
  assert.match(v.title, /王大明/);
  assert.ok(!v.body.includes('68'), '把分數推到家長手機上了');
  assert.match(v.href, /^\/guardian/, '家長的連結不可以指向作答或檢討');
});

test('放行的觸發點真的把家長算進去', () => {
  const body = bodyOf(read('lib/notifyDb.ts'), 'export async function notifyGradeReleased(');
  assert.match(body, /grade\.released\.guardian/, '放行只通知了學生');
  assert.match(body, /notifiableGuardianIds\(/, '家長的收件人沒有走那道確認');
  // 一位家長兩個孩子時要兩則，所以去重鍵要帶 studentId；
  // 少了它，第二個孩子的那一則會被第一個吃掉。
  assert.match(body, /scope: `\$\{assignmentId\}:\$\{studentId\}`/, '去重鍵沒有帶孩子的 id');
});

// ─────────────────────────────────────────────────────────────────
// 十二、保存期限
// ─────────────────────────────────────────────────────────────────

test('過了保存期限的通知會被刪掉，沒過的不會', async () => {
  // 這張表只進不出：逾期未交一天一則，三年之後每個帳號都拖著幾百列
  // 沒有人會讀的歷史。文件 01 §16 定了保存期限卻沒有實作。
  const old = new Date(Date.UTC(2024, 0, 1));
  const recent = new Date(Date.UTC(2026, 6, 1));
  const db = fakeDb({
    notifications: [
      { id: 'old_sent', status: 'SENT', createdAt: old },
      { id: 'old_suppressed', status: 'SUPPRESSED', createdAt: old },
      { id: 'old_failed', status: 'FAILED', createdAt: old },
      { id: 'old_queued', status: 'QUEUED', createdAt: old },
      { id: 'recent', status: 'SENT', createdAt: recent },
    ],
  });
  const r = await purgeOldNotifications(db, { now: utc(2026, 7, 30, 0, 0) });
  assert.equal(r.deleted, 3);
  const left = db.rows.map((x) => x.id).sort();
  // **卡在佇列裡一年的那一列留著**：那是一個症狀，刪掉它等於把唯一
  // 的線索清乾淨，而卡住的原因會繼續存在。
  assert.deepEqual(left, ['old_queued', 'recent']);
});

test('清理有筆數上限，剩下的下一輪再刪', async () => {
  // 第一次跑的時候表裡可能躺著三年份，而一次刪幾十萬列的交易
  // 會跟考試搶同一個資料庫。
  const old = new Date(Date.UTC(2024, 0, 1));
  const db = fakeDb({
    notifications: Array.from({ length: 5 }, (_, i) => ({
      id: `n${i}`,
      status: 'SENT',
      createdAt: old,
    })),
  });
  const r = await purgeOldNotifications(db, { now: utc(2026, 7, 30, 0, 0), limit: 2 });
  assert.equal(r.deleted, 2);
  assert.equal(r.more, true, '沒有說出還沒清完');
  assert.equal(db.rows.length, 3);
});

test('保存期限有一個合理的長度，而且工作者真的會去跑', () => {
  // 三十天太短（家長在期末問「你們有沒有通知我」時要撈得出來），
  // 而沒有上限就是沒有實作。
  assert.ok(
    NOTIFICATION_RETENTION_DAYS >= 180 && NOTIFICATION_RETENTION_DAYS <= 1095,
    '保存期限不合理',
  );
  const worker = read('scripts/worker.mjs');
  assert.match(worker, /registerJob\('notify-cleanup'/, '工作者沒有註冊清理工作');
  assert.match(worker, /purgeOldNotifications/, '清理工作沒有真的呼叫那一支');
});

// ─────────────────────────────────────────────────────────────────
// 十三、未接的渠道：說法要與現況一致
// ─────────────────────────────────────────────────────────────────

test('沒有任何呼叫端傳 channel，所以那段保證的說明要講清楚這件事', () => {
  // 「未接的渠道不會安靜地卡在 QUEUED」這條保證是對的，但它在正式
  // 環境**一列都產生不出來**——每一則都是預設的 IN_APP。櫃檯真的被
  // 問「為什麼家長沒收到 email」時，資料庫裡撈不到任何線索，
  // 而那個答案是「系統從來沒有嘗試過寄信」。
  //
  // 這一格盯著兩件事：說明有沒有講出這件事，以及第一個接上 EMAIL
  // 的人會不會被叫回來改那段說明。
  const files = ['lib/notify.mjs', 'lib/notifyDb.ts', 'lib/guardian.ts', 'lib/scoring.ts'];
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/channel:\s*'(\w+)'/g)) {
      assert.equal(
        m[1],
        'IN_APP',
        `${f} 開始送 ${m[1]} 了——回去把 READY_CHANNELS 那段「今天走不到這裡」的說明改成現況。`,
      );
    }
  }
  const doc = read('lib/notify.mjs');
  const at = doc.indexOf('export const READY_CHANNELS');
  const head = doc.slice(Math.max(0, at - 2600), at);
  assert.match(head, /沒有任何呼叫端傳/, 'READY_CHANNELS 的說明沒有講出「現在走不到」');
});

test('全班重新計分之後真的會發出通知', () => {
  // 沒有這一行的話，`Regrade.tsx` 那個確認視窗上的承諾只兌現了一半：
  // 分數確實「立刻反映在他們自己看得到的成績上」，而學生要下一次
  // 自己點進去才會發現 78 變成 72——沒有任何線索說明為什麼。
  const src = read('lib/scoring.ts');
  const body = src.slice(
    src.indexOf('export async function regradeAssignment'),
    src.indexOf('// ─────────────────────────────────────────────────────────────\n// 逐題人工給分'),
  );
  assert.match(body, /notifyGradeChanged\(/, '重算完沒有通知任何人');
  // 收件人是分數真的變了的那幾位。全班都通知的話，沒變的那些人
  // 會去確認一個沒有變化的數字，而下一次真的變了時他已經學會忽略。
  assert.match(body, /deltas\.map/, '通知了不該通知的人（分數沒變的）');
  assert.match(read('lib/scoring.ts'), /import \{ notifyGradeChanged, notifyVoided \}/);

  // 觸發那一端要擋放行：MANUAL／ON_DUE 還沒放行時，學生自己的畫面上
  // 只有一句「老師還沒有開放」，這時告訴他分數變了等於繞過放行時機。
  const trigger = bodyOf(read('lib/notifyDb.ts'), 'export async function notifyGradeChanged(');
  assert.match(trigger, /maySeeResult\(/, '沒有問過「他現在看得到分數嗎」');
  assert.match(trigger, /from != null/, '第一次算出分數不是「別人動了你的成績」');
});
