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
  classMeansFromAttempts,
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

// ── 班級平均數的是人，不是作答次數 ───────────────────────────

/** `n` 次作答，同一位學生。 */
const tries = (assignmentId, userId, scores) =>
  scores.map((totalScore, i) => ({ assignmentId, userId, totalScore, attemptNo: i + 1 }));

test('一份可作答三次的練習卷上，兩個學生不會變成六位同學', () => {
  // 這是整個反推防線失效的那一種：`maxAttempts = 3`，班上只有兩位
  // 學生寫、各交三次 → 六列 GRADED → `peers = 6 ≥ PEER_FLOOR` →
  // 媽媽的手機上出現「班級平均 74.3」。而扣掉自己只剩**一個人**，
  // 她知道自己孩子的分數，`2×平均 − 自己` 就是另一個孩子的分數。
  const rows = [...tries('a1', 'kid', [60, 70, 68]), ...tries('a1', 'other', [80, 82, 84])];
  const stat = classMeansFromAttempts(rows).get('a1');
  assert.equal(stat.peers, 2, '數成作答次數了');
  const c = compareToClass({ score: 68, maxScore: 100, mean: stat.mean, peers: stat.peers });
  assert.equal(c.show, false, '兩個人的平均被交出去了');
  assert.equal(c.mean, null);
});

test('平均不是按作答次數加權的——重考三次的那一位只算一票', () => {
  // 加權的後果不只是數字偏掉：孩子那一欄用的是**最後一次交卷**，
  // 而平均用的是全部作答，於是「68 分／班級平均 74.3／−6.3」
  // 三個數字對不起來。那正是 compareToClass 特地「先四捨五入再算
  // 差距」要避免的事。
  const rows = [
    ...tries('a1', 'busy', [0, 0, 90]), // 只有最後一次算數
    { assignmentId: 'a1', userId: 'b', totalScore: 70, attemptNo: 1 },
    { assignmentId: 'a1', userId: 'c', totalScore: 80, attemptNo: 1 },
  ];
  const stat = classMeansFromAttempts(rows).get('a1');
  assert.equal(stat.peers, 3);
  assert.equal(stat.mean, 80, '(90 + 70 + 80) / 3');
});

test('算數的是最近一次交出去的，與孩子自己看到的那一份同一個口徑', () => {
  // 挑最高分的話，班級平均會系統性地高於每個人自己看到的分數，
  // 而家長讀到的是「我孩子低於平均」——一個由統計口徑製造出來的結論。
  const stat = classMeansFromAttempts(tries('a1', 'u', [95, 40])).get('a1');
  assert.equal(stat.mean, 40, '取的不是最後一次');
  assert.equal(stat.peers, 1);
});

test('沒有分數的作答不算人頭', () => {
  // 交了但還沒計分的那一列如果算進來，`peers` 會在平均還沒成形時
  // 就跨過門檻。
  const rows = [
    { assignmentId: 'a1', userId: 'u1', totalScore: 70, attemptNo: 1 },
    { assignmentId: 'a1', userId: 'u2', totalScore: null, attemptNo: 1 },
    { assignmentId: 'a1', userId: 'u3', totalScore: undefined, attemptNo: 1 },
  ];
  const stat = classMeansFromAttempts(rows).get('a1');
  assert.equal(stat.peers, 1);
  assert.equal(stat.mean, 70);
});

test('五個不同的人才給得出平均', () => {
  // 門檻本身沒有放寬——修的方向是「人數不夠就不給數字」，
  // 不是「把門檻調低」。
  const five = ['a', 'b', 'c', 'd', 'e'].map((u, i) => ({
    assignmentId: 'a1',
    userId: u,
    totalScore: 70 + i,
    attemptNo: 1,
  }));
  const stat = classMeansFromAttempts(five).get('a1');
  assert.equal(stat.peers, PEER_FLOOR);
  assert.equal(compareToClass({ score: 68, maxScore: 100, ...stat }).show, true);

  const four = classMeansFromAttempts(five.slice(0, 4)).get('a1');
  assert.equal(compareToClass({ score: 68, maxScore: 100, ...four }).show, false);
});

// ── 空狀態：「已經離開」與「還沒編班」不是同一件事 ───────────

test('學年度結算之後，不會叫全補習班的家長打電話給櫃檯', () => {
  // `closeAcademicYear` 一句 updateMany 把全部班籍寫上 leftAt，
  // 於是每一個孩子的 className 都變成 null。舊的判斷只看「有沒有
  // 班」，所以那個晚上兩百位家長會同時讀到「還沒有編進任何班級，
  // 請告訴櫃檯」——而那句話明確叫她們打電話問一件系統自己做的事。
  const closed = { inClass: false, taskCount: 0, submittedCount: 0, scoredCount: 0 };
  assert.equal(noDataReason({ ...closed, everInClass: true }), 'BETWEEN_CLASSES');
  // 從來沒進過任何班的那一種才是要找櫃檯的。
  assert.equal(noDataReason({ ...closed, everInClass: false }), 'NO_CLASS');
});

test('轉學走了不會永遠停在「還沒有編進任何班級」', () => {
  // `archiveStudent` 不動 GuardianLink，而舊的判斷也不看 status，
  // 所以媽媽的帳號會**永遠**顯示那一句，唯一的出口是櫃檯手動逐條
  // 移除連結。而「已經離開」在資料上與「還沒編班」長得一模一樣。
  assert.equal(
    noDataReason({
      inClass: false,
      taskCount: 0,
      submittedCount: 0,
      scoredCount: 0,
      hasLeft: true,
      everInClass: true,
    }),
    'LEFT',
  );
  // 已經離開排在最前面：它是其他每一種狀況的原因。
  assert.equal(
    noDataReason({ inClass: true, taskCount: 3, submittedCount: 2, scoredCount: 1, hasLeft: true }),
    'LEFT',
  );
});

test('剛換班的孩子不會被說成「老師還沒有派任何作業」', () => {
  // 轉班之後舊班的作業與成績從家長端消失（任務清單只看還在的班籍），
  // 而空狀態會說「老師還沒有派任何作業或考試」——對一個上了兩年的
  // 孩子，那是假話，家長讀到的是「兩年的紀錄不見了」。
  const empty = { inClass: true, taskCount: 0, submittedCount: 0, scoredCount: 0 };
  assert.equal(noDataReason({ ...empty, changedClass: true }), 'NEW_CLASS');
  assert.equal(noDataReason(empty), 'NO_TASK', '沒換過班的還是原來那一句');
});

test('新加的原因不影響原本那四種', () => {
  // 舊的呼叫端（與這一支測試上面那幾格）不帶新參數，行為必須完全不變。
  const base = { inClass: true, taskCount: 3, submittedCount: 2, scoredCount: 1 };
  assert.equal(noDataReason({ ...base, inClass: false }), 'NO_CLASS');
  assert.equal(noDataReason({ ...base, taskCount: 0 }), 'NO_TASK');
  assert.equal(noDataReason({ ...base, submittedCount: 0 }), 'NOT_SUBMITTED');
  assert.equal(noDataReason({ ...base, scoredCount: 0 }), 'NOT_RELEASED');
  assert.equal(noDataReason(base), null);
});

// ── 「看不到連結」與「進不去」：這一次真的驗頁面 ─────────────

/**
 * 導覽項 → 那一區的入口頁面。
 *
 * # 為什麼要有這張表
 *
 * 因為上面那一格（`mayUse('GUARDIAN', href)` 全部是 false）驗的是
 * `lib/nav.ts` 那張表，**一個字都沒有碰到頁面**。而 `/take` 曾經
 * 就是那樣：清單裡列著它、斷言是綠的，而頁面上全頁沒有任何存取
 * 判定——家長直接打網址進得去，看到「我的任務／王小美家長」與
 * 一句「如果你知道有一份但這裡沒有，請告訴班級老師」，然後照著
 * 打電話。沒有資料外洩，但那是導覽列與頁面兩件事只做了一件。
 *
 * # 這裡沒有列 /admission、/interview、/portfolio
 *
 * 那三頁的判定現在寫成 `systemRole !== 'STUDENT'` 的二分法（家長被
 * 當成老師），而它們不屬於這一批改動。**列進來會讓這一格對別人的
 * 檔案紅**，而一條指著別人的紅燈不會被修，只會被關掉。修好之後
 * 把它們加進來。
 */
const AREA_PAGE = {
  '/take': 'app/(app)/take/page.tsx',
  '/ability': 'app/(app)/ability/page.tsx',
  '/bank': 'app/(app)/bank/page.tsx',
  '/import': 'app/(app)/import/page.tsx',
  '/papers': 'app/(app)/papers/page.tsx',
  '/assignments': 'app/(app)/assignments/page.tsx',
  '/grades': 'app/(app)/grades/page.tsx',
  '/classes': 'app/(app)/classes/page.tsx',
  '/knowledge': 'app/(app)/knowledge/page.tsx',
  '/settings/years': 'app/(app)/settings/years/page.tsx',
  '/settings/subjects': 'app/(app)/settings/subjects/page.tsx',
  '/settings/staff': 'app/(app)/settings/staff/page.tsx',
};

test('家長進不去的每一區，頁面自己也擋——不是只有導覽列不畫', async () => {
  const { mayUse } = await import('../lib/nav.ts');
  for (const [href, file] of Object.entries(AREA_PAGE)) {
    assert.equal(mayUse('GUARDIAN', href), false, `nav.ts 讓家長進得去 ${href}`);
    const src = read(file);

    // 判定要走 `lib/nav.ts` 那張表：直接 `mayUse`，或包一層
    // （`mayComposeArea`）但參數仍然是那條路徑。頁面自己手寫一份
    // 角色清單的話，改角色的時候沒有人會記得跟著改。
    const guard = new RegExp(`!\\s*may\\w*\\(\\s*user\\.systemRole,\\s*(?:AREA|'${href}')`);
    assert.match(src, guard, `${file} 沒有頁面層的存取判定（家長直接打網址就進得去）`);
    if (/!\s*may\w*\(\s*user\.systemRole,\s*AREA/.test(src)) {
      assert.match(
        src,
        new RegExp(`const AREA = '${href}'`),
        `${file} 用了 AREA 但它不是 ${href}`,
      );
    }
    // 擋下來要說得出為什麼。一個空白的畫面會變成一通電話。
    assert.match(src, /<Denied/, `${file} 擋了但沒有說明`);
  }
});

test('/take 擋家長但不擋老師——「不擋老師」不等於「誰都不擋」', () => {
  // nav.ts 寫得很清楚：老師偶爾會被指定為作答對象（自己先試考一份
  // 再派出去），所以導覽列不畫但網址進得去。那句話原本被實作成
  // 「全頁沒有判定」。
  const src = read('app/(app)/take/page.tsx');
  assert.match(src, /!mayUse\(user\.systemRole, '\/take'\) && !staff/, '例外沒有寫成例外');
  assert.match(src, /mayUse\(user\.systemRole, '\/bank'\)/, '職員那一條例外不見了');
});

test('/ability 不把「不是學生」全部當成老師', async () => {
  // 系統有六種角色。二分法之下，家長看到的是「老師要看的是某一位
  // 學生或某一個班的弱點，那在班級頁裡」與一顆「去班級」——
  // 而 /classes 對她是拒絕。一句對她說的話，加上一顆按不動的按鈕。
  const src = read('app/(app)/ability/page.tsx');
  const code = src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  assert.ok(
    !/systemRole !== 'STUDENT'/.test(code),
    '/ability 還在用「不是學生就是老師」的二分法',
  );
  // 兩種人要看到不同的話，而且家長那一句要指向她按得動的地方。
  assert.match(code, /mayUse\(user\.systemRole, '\/classes'\)/, '老師與家長被寫成同一句');
  assert.match(code, /href="\/guardian"/, '家長那一句沒有指向她進得去的地方');
});

// ── 家長端的每一句「去找人」都要指得出一個人 ─────────────────

test('家長端不再叫她去找一位沒有名字的「班級老師」', () => {
  // 這一頁上有孩子的名字、班名、任務名稱、分數——在導師的姓名出現
  // 之前，沒有任何一位老師的名字、沒有電話、沒有補習班的聯絡方式，
  // 而收件匣是唯讀的。「請告訴班級老師」在那個情況下就是一句
  // 指向系統外面而且沒有指路的話，而她讀完會打電話。
  const src = read('app/(app)/guardian/page.tsx');
  const code = src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l))
    .join('\n');
  assert.ok(
    !/告訴櫃檯或班級老師|跟班級老師說|問老師/.test(code),
    '還有一句沒有名字的「去找老師」',
  );
  assert.match(code, /contact\(picked\)/, '沒有用上導師的姓名');
  // 姓名要真的查得出來，否則 `contact()` 永遠走 fallback。
  const lib = read('lib/guardian.ts');
  assert.match(lib, /isHomeroom: true/, 'childrenOf 沒有查導師');
  assert.match(lib, /homeroomTeacher/, 'Child 沒有帶出導師姓名');
});

test('成績還沒開放時，不會要家長自己每天回來按一次', () => {
  // 那一段原本寫「開放之後這裡就看得到」，而**開放的那一刻沒有任何
  // 跡象**——她一個月只看兩次。現在家長也收得到放行通知，
  // 所以這一句要說出來。
  const src = read('app/(app)/guardian/page.tsx');
  assert.match(src, /開放的時候系統會發一則通知給你/, '沒有告訴她會收到通知');
});

// ── 移除連結：對話框說的話要與程式做的事一樣 ─────────────────

test('「正在看的畫面也會被登出」只出現在真的會被登出的那一邊', () => {
  // `unlinkGuardian` 只在他一個孩子都不剩時才清 session（還有孩子
  // 就不動帳號）。所以兩個孩子的家長不會被登出，而那句話原本對
  // 所有人都說——同一個對話框裡兩句話對不起來，而按下去的人
  // 以為自己知道會發生什麼。
  const lib = read('lib/guardian.ts');
  const body = lib.slice(lib.indexOf('export async function unlinkGuardian'));
  const upTo = body.slice(0, body.indexOf('await audit('));
  assert.match(upTo, /left === 0/, 'unlinkGuardian 的前提變了，這一格要重寫');
  assert.match(upTo, /session\.deleteMany/);

  // 註解拿掉再驗：這一格檢查的是**畫出來的字**，而說明為什麼要
  // 這樣寫的註解裡本來就會出現「會被登出」這幾個字。
  const dialog = read('app/(app)/classes/[classId]/Guardians.tsx')
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const at = dialog.indexOf('removing.children > 1');
  assert.ok(at > 0, '找不到那個分支');
  const [manyKids, onlyKid] = dialog.slice(at).split(') : (');
  // 兩個孩子的那一邊要**明講不會被登出**（沉默不夠：上一句話剛說完
  // 「立刻看不到任何資料」，讀的人會自己補上「所以被踢出去了」）。
  assert.match(manyKids, /不會被登出/, '沒有說清楚他不會被登出');
  assert.match(onlyKid.slice(0, 400), /也會立刻被登出/, '唯一的孩子那一邊沒有說會被登出');
  // 而那句話也不可以留在分支外面（原本就在那裡，所以對所有人都說）。
  assert.ok(!/登出/.test(dialog.slice(0, at)), '分支外面還有一句「會被登出」');
});

// ── 收件匣：第二頁也要標成已讀 ───────────────────────────────

test('翻到第二頁時，標記已讀不會被上一頁的旗標擋掉', () => {
  // `/inbox?before=…` 是同一個元件在 React 樹上的同一個位置，
  // state 與 ref 都保留下來。記「送過了沒」的布林值在第一頁是對的，
  // 第二頁起就永遠 return——導覽列上的數字停在 60 不動，
  // 而收件匣那三道歸零機制裡的第一道從第二頁起就不作用了。
  const src = read('app/(app)/inbox/MarkRead.tsx');
  assert.match(src, /sentKey\.current === key/, '守衛沒有跟著這一頁的 id 走');
  assert.match(src, /sentKey\.current = key/);
  assert.ok(!/sent\.current = true/.test(src), '還是那個一次性的布林旗標');
});
