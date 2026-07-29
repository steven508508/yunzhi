/**
 * 家長端的界線。
 *
 * # 這一支測的是「看不到」，而看不到很難測
 *
 * 「看得到」測起來很直覺：呼叫一次、比對結果。「看不到」不是——
 * 一個回傳空陣列的函式與一個根本沒被呼叫的函式，在斷言上長得一樣。
 * 所以這裡分成兩層：
 *
 *   **一、投影規則。** 家長那一份任務清單是學生那一份挑欄位挑出來的，
 *   而白名單本身就是規格。多一個欄位就會有一條紅的。
 *
 *   **二、原始碼的靜態檢查。** 家長端的每一個檔案都不可以出現
 *   `tutorSession` / `tutorMessage` / `attemptAnswer` / `proctorEvent`
 *   這幾個字。這一條看起來很粗暴，但它擋的正是最可能發生的那件事：
 *   三個月後有人「順手」在家長頁加一段 join，因為那看起來只是多一欄。
 *   註解攔不住那個人，紅色的測試攔得住。
 *
 * 跨越資料庫邊界之後還對不對——尤其「家長直接打 API 拿不拿得到
 * 別人的資料」——由 `tools/e2e-guardian.mjs` 對真的 Postgres 驗。
 * 那件事在這裡驗不到，而它是這個功能的核心。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  GUARDIAN_TASK_FIELDS,
  NOISE_BAND,
  PEER_FLOOR,
  compareToClass,
  noDataReason,
  projectTask,
  summarizeChild,
} from '../lib/guardianView.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, '..');
const read = (rel) => readFileSync(path.join(WEB, rel), 'utf8');

/** 一份完整的學生任務。欄位與 `StudentTask` 一致。 */
const fullTask = {
  assignmentId: 'asg_1',
  title: '第三次模擬考',
  paperTitle: '115 學測模擬卷',
  subjectName: '數學A',
  mode: 'EXAM',
  openAt: '2026-09-01T00:00:00.000Z',
  dueAt: '2026-09-08T15:59:00.000Z',
  timeLimitMin: 100,
  allowLate: false,
  maxAttempts: 1,
  questionCount: 25,
  state: 'DONE',
  attemptsUsed: 1,
  openAttemptId: 'att_9',
  openRemainingSeconds: 1200,
  lastSubmittedAt: '2026-09-05T06:00:00.000Z',
  lastLate: false,
  score: 68,
  maxScore: 100,
  resultLevel: 'FULL',
  resultVisible: true,
  resultNote: '已經過了截止時間，全班同時開放檢討。',
};

// ── 投影：家長拿得到哪幾個欄位 ───────────────────────────────

test('家長那一份只有白名單上的欄位，一個都不多', () => {
  const out = projectTask(fullTask);
  assert.deepEqual(
    Object.keys(out).sort(),
    [...GUARDIAN_TASK_FIELDS].sort(),
    '投影出來的欄位與白名單對不上——多的那一個就是家長多看到的東西',
  );
});

test('作答與檢討的把手不會被帶出去', () => {
  const out = projectTask(fullTask);
  // 這四個是「點得進去」的入口與作答的操作資訊。家長端沒有任何一個
  // 連結需要它們，而少一個 id 就少一次「把網址上的 id 換掉試試看」。
  for (const leak of ['assignmentId', 'openAttemptId', 'openRemainingSeconds', 'attemptsUsed']) {
    assert.equal(out[leak], undefined, `${leak} 被帶到家長那一份上了`);
  }
});

test('作廢的作答不會把「已作廢」推到家長手機上', () => {
  // `resultNote` 在作答被作廢時寫的是「這一份作答已經作廢，不會計分」。
  // 作廢多半是誠信事件或系統故障的結果，而那種事一定要由人來說明——
  // 由系統推給家長，等於讓它替老師下了一個它沒有能力下的判斷。
  const out = projectTask({
    ...fullTask,
    score: null,
    resultVisible: false,
    resultNote: '這一份作答已經作廢，不會計分。要知道原因或申請重考，請直接找老師。',
  });
  assert.equal(out.resultNote, undefined, '作廢的理由被送到家長那裡了');
  assert.ok(!JSON.stringify(out).includes('作廢'));
});

test('學生的任務多一個欄位時，家長那一份不會自動跟著多', () => {
  // 白名單的整個用途就是這一條。日後 `StudentTask` 加一個
  // 「這一份的逐題對錯」，黑名單的寫法會安靜地把它送出去。
  const out = projectTask({ ...fullTask, perQuestionVerdicts: ['CORRECT', 'WRONG'] });
  assert.equal(out.perQuestionVerdicts, undefined);
});

test('沒有的欄位補成 null，布林欄位補成 false', () => {
  // `lastLate == null` 在畫面上與 false 長得一樣，但讀起來是
  // 「不知道有沒有遲交」——而家長會照著這一句去問孩子。
  const out = projectTask({ title: 'x', subjectName: '國文', state: 'OPEN' });
  assert.equal(out.dueAt, null);
  assert.equal(out.lastLate, false);
  assert.equal(out.resultVisible, false);
});

// ── 班級平均：人數太少就不給 ─────────────────────────────────

test('交卷人數不到門檻時不顯示平均，而且說得出為什麼', () => {
  const c = compareToClass({ score: 68, maxScore: 100, mean: 70, peers: PEER_FLOOR - 1 });
  assert.equal(c.show, false, '人數不足還是把平均給出去了');
  assert.equal(c.mean, null);
  assert.ok(c.why.includes(`${PEER_FLOOR - 1} 位`), '沒有說出目前幾位交卷');
  assert.ok(c.why.length > 10, '空白的欄位會被讀成「系統壞了」');
});

test('兩個人的平均一定不給——另一位的分數等於平均乘二減自己', () => {
  const c = compareToClass({ score: 80, maxScore: 100, mean: 70, peers: 2 });
  assert.equal(c.show, false);
  assert.equal(c.mean, null, '把 60 分那一位的成績交給另一個家長了');
});

test('人數夠了才給平均與差距', () => {
  const c = compareToClass({ score: 68, maxScore: 100, mean: 74.25, peers: PEER_FLOOR });
  assert.equal(c.show, true);
  assert.equal(c.mean, 74.3, '平均要四捨五入到一位小數');
  assert.equal(c.delta, -6.3);
  assert.equal(c.label, '低於班級平均');
});

test('差距在雜訊帶之內講「差不多」，不講高於或低於', () => {
  // 一百分的卷子上差兩分是雜訊。把雜訊講成「低於班級平均」，
  // 家長會對著一個不存在的問題採取行動。
  const c = compareToClass({ score: 72, maxScore: 100, mean: 70, peers: 12 });
  assert.equal(c.label, '與班級平均差不多');
  assert.ok(NOISE_BAND > 0 && NOISE_BAND < 0.2, '雜訊帶的比例不合理');
});

test('剛好踩在雜訊帶邊緣算高於／低於', () => {
  const hi = compareToClass({ score: 75, maxScore: 100, mean: 70, peers: 9 });
  assert.equal(hi.label, '高於班級平均');
  const lo = compareToClass({ score: 65, maxScore: 100, mean: 70, peers: 9 });
  assert.equal(lo.label, '低於班級平均');
});

test('還沒有分數時不比較，也不說人數的事', () => {
  const c = compareToClass({ score: null, maxScore: 100, mean: 70, peers: 30 });
  assert.equal(c.show, false);
  assert.ok(c.why.includes('分數'), '這一份還沒有分數，不該說「人數太少」');
});

test('滿分是 0 的卷子不會除以零', () => {
  // 沒有配分的卷子存在（老師還沒設定）。除以零會讓比較變成 NaN，
  // 而畫面上那是一個空格。
  const c = compareToClass({ score: 0, maxScore: 0, mean: 0, peers: 30 });
  assert.equal(c.show, false);
});

// ── 摘要 ─────────────────────────────────────────────────────

test('摘要數得出「還可以寫的」與「已經錯過的」', () => {
  const s = summarizeChild([
    { state: 'OPEN', lastLate: false, lastSubmittedAt: null, resultVisible: false, score: null },
    { state: 'IN_PROGRESS', lastLate: false, lastSubmittedAt: null, resultVisible: false, score: null },
    { state: 'MISSED', lastLate: false, lastSubmittedAt: null, resultVisible: false, score: null },
    { state: 'DONE', lastLate: true, lastSubmittedAt: '2026-09-01', resultVisible: true, score: 88 },
    { state: 'DONE', lastLate: false, lastSubmittedAt: '2026-09-02', resultVisible: false, score: null },
  ]);
  assert.equal(s.total, 5);
  assert.equal(s.pending, 2, '寫到一半的也算「還可以寫」');
  assert.equal(s.missed, 1);
  assert.equal(s.late, 1);
  assert.equal(s.scored, 1);
  // 交了但看不到分數的那一份。畫面上要說出來，否則它看起來像沒考。
  assert.equal(s.waiting, 1);
});

test('交了但老師還沒放行，不會被算成「沒有成績」而消失', () => {
  const s = summarizeChild([
    { state: 'DONE', lastLate: false, lastSubmittedAt: '2026-09-02', resultVisible: false, score: null },
  ]);
  assert.equal(s.waiting, 1);
  assert.equal(s.scored, 0);
});

// ── 空狀態：四種原因，四種下一步 ─────────────────────────────

test('空的四種原因分得開', () => {
  const base = { inClass: true, taskCount: 3, submittedCount: 2, scoredCount: 1 };
  assert.equal(noDataReason({ ...base, inClass: false }), 'NO_CLASS');
  assert.equal(noDataReason({ ...base, taskCount: 0 }), 'NO_TASK');
  assert.equal(noDataReason({ ...base, submittedCount: 0 }), 'NOT_SUBMITTED');
  assert.equal(noDataReason({ ...base, scoredCount: 0 }), 'NOT_RELEASED');
  assert.equal(noDataReason(base), null, '有東西可以看的時候不該顯示空狀態');
});

test('沒有班級排最前面——後面每一項都是它的後果', () => {
  // 沒編班就收不到任務，所以 taskCount 一定是 0。這時候說
  // 「老師還沒派作業」是錯的：要做的事在櫃檯，不是等老師。
  assert.equal(
    noDataReason({ inClass: false, taskCount: 0, submittedCount: 0, scoredCount: 0 }),
    'NO_CLASS',
  );
});

// ── 靜態檢查：家長端不可以碰那幾張表 ─────────────────────────

/**
 * 家長端的每一個檔案。**新增檔案時要記得加進來**——漏掉一個的
 * 症狀是這一條測試仍然是綠的，而那個檔案裡可以寫任何東西。
 */
const GUARDIAN_SOURCES = [
  'lib/guardian.ts',
  'lib/guardianView.mjs',
  'app/(app)/guardian/page.tsx',
  'app/api/guardians/route.ts',
  'app/api/guardians/[linkId]/route.ts',
  'app/api/guardians/[linkId]/password/route.ts',
];

/**
 * 這幾張表家長端一個字都不可以提。
 *
 * 不是「查了不顯示」——是**連查詢都不可以發出去**。畫面層漏畫一個
 * `if` 是很平常的事，漏查一個查詢不是。與 `lib/result.ts` 檔頭
 * 第三條（`rawBody` 用白名單而不是查出來再刪）同一個道理。
 */
const FORBIDDEN = [
  ['tutorSession', '智慧老師的對話是學生求助的紀錄，比答錯本身更私人'],
  ['tutorMessage', '同上'],
  ['attemptAnswer', '逐題的作答內容是學習過程，家長要看應該透過學生或老師'],
  ['proctorEvent', '考試行為事件是給老師判斷用的證據，不是給家長的指控'],
];

for (const file of GUARDIAN_SOURCES) {
  test(`${file} 不查智慧老師、逐題作答與考試行為`, () => {
    const src = read(file);
    for (const [table, why] of FORBIDDEN) {
      // 註解裡提到表名是可以的（這個檔案的檔頭就在解釋為什麼不查），
      // 所以比對的是「當成識別字用」的樣子：`prisma.x` 或 `tx.x`。
      const used = new RegExp(`(prisma|tx)\\s*\\.\\s*${table}\\b`).test(src);
      assert.equal(used, false, `${file} 查了 ${table}——${why}`);
    }
  });
}

test('家長端沒有自己的讀取 API，只有給職員的管理 API', () => {
  // 多一支「家長讀自己孩子」的 API，就多一個要重新判斷
  // 「這個 studentId 是不是他的孩子」的地方，而那個判斷寫錯的
  // 方向是別人家的成績。所以 `app/api/guardians/**` 底下每一支的
  // 第一行都是同一件事：你是職員嗎。
  for (const file of GUARDIAN_SOURCES.filter((f) => f.startsWith('app/api/'))) {
    assert.ok(
      read(file).includes('isStaff('),
      `${file} 沒有職員檢查——家長打得到這一支`,
    );
  }
});

test('家長端每一支讀取都先過 requireChild', () => {
  const src = read('lib/guardian.ts');
  // `childView` 是家長端唯一的資料入口，而它的第一行必須是身分比對。
  // RLS 擋得住別家補習班，擋不住同一間補習班的另一個孩子。
  const body = src.slice(src.indexOf('export async function childView'));
  const firstLines = body.split('\n').slice(0, 4).join('\n');
  assert.ok(
    firstLines.includes('requireChild'),
    'childView 沒有先比對這是不是他的孩子',
  );
});

test('nav 上家長只有一項，而且進不了任何職員的區域', async () => {
  const { mayUse, navFor } = await import('../lib/nav.ts');
  const items = navFor('GUARDIAN');
  assert.equal(items.length, 1, '家長的導覽列不該有第二項');
  assert.equal(items[0].href, '/guardian');

  // 「看不到連結」與「進不去」必須是同一份規則。這幾條是家長最可能
  // 直接打網址試的：題庫是答案本，成績是全班的分數，匯入是原始題本。
  for (const href of ['/bank', '/grades', '/import', '/papers', '/assignments',
    '/classes', '/knowledge', '/settings/staff', '/settings/years', '/take']) {
    assert.equal(mayUse('GUARDIAN', href), false, `家長進得去 ${href}`);
  }
  // 學生那一項也不該被家長拿到——`/take` 是作答本身。
  assert.equal(mayUse('STUDENT', '/guardian'), false, '學生看得到家長端');
  assert.equal(mayUse('TEACHER', '/guardian'), false, '老師看得到家長端');
  assert.equal(mayUse('GUARDIAN', '/guardian'), true);
});
