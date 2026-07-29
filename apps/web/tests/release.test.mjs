/**
 * 放行時機與解析權利。
 *
 * # 這一支測的全部是「不會有錯誤訊息」的失敗
 *
 * 放行判斷寫錯不會當機，畫面也不會壞——它只是把答案提早給了學生。
 * 發現的方式只有一種：某一班的平均特別高，而那時候已經是三個月後、
 * 沒有人記得那一週改過什麼。解析權利判斷寫錯同理，只是收到的不是
 * 成績單而是律師函。
 *
 * 所以每一個測試的註解都寫**錯了會怎樣**，那是這些測試存在的理由。
 *
 * 第一段是一張 24 格的表：五種 releasePolicy（MANUAL 因為多一個
 * 「放行了沒」的狀態而拆成兩列）× 交了沒 × 過截止了沒。這張表要一次
 * 全列出來，因為漏掉的那一格永遠是沒有人想到的那一格。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkReleaseChange,
  cohortGate,
  fmtTaipei,
  maySeeResult,
  pickExplanation,
  readLayers,
  releaseControl,
} from '../lib/release.mjs';

// ── 共用的時間軸 ────────────────────────────────────────────────
const DUE = new Date('2026-08-03T09:00:00Z'); // 台灣時間 8/3 17:00
const BEFORE = new Date('2026-08-01T02:00:00Z');
const AFTER = new Date('2026-08-05T02:00:00Z');

const writing = { status: 'IN_PROGRESS', submittedAt: null };
const handedIn = { status: 'SUBMITTED', submittedAt: new Date('2026-08-01T01:00:00Z') };

/** 已放行的 MANUAL：老師在截止前就按了放行。 */
const RELEASED = new Date('2026-07-30T00:00:00Z');

// ─────────────────────────────────────────────────────────────────
// 一、五種政策 × 交了沒 × 過截止了沒
// ─────────────────────────────────────────────────────────────────

const MATRIX = [
  // policy,          releasedAt, 交了沒,     現在,     期望
  ['IMMEDIATE', null, writing, BEFORE, 'NONE'],
  ['IMMEDIATE', null, writing, AFTER, 'NONE'],
  ['IMMEDIATE', null, handedIn, BEFORE, 'FULL'],
  ['IMMEDIATE', null, handedIn, AFTER, 'FULL'],

  ['ON_SUBMIT', null, writing, BEFORE, 'NONE'],
  ['ON_SUBMIT', null, writing, AFTER, 'NONE'],
  ['ON_SUBMIT', null, handedIn, BEFORE, 'FULL'],
  ['ON_SUBMIT', null, handedIn, AFTER, 'FULL'],

  ['ON_DUE', null, writing, BEFORE, 'NONE'],
  ['ON_DUE', null, writing, AFTER, 'NONE'],
  // ↓ 整份規格裡最重要的一格。交了卷但還沒到截止時間：分數可以看，
  //   逐題與解析不行。
  ['ON_DUE', null, handedIn, BEFORE, 'SCORE_ONLY'],
  ['ON_DUE', null, handedIn, AFTER, 'FULL'],

  ['MANUAL', null, writing, BEFORE, 'NONE'],
  ['MANUAL', null, writing, AFTER, 'NONE'],
  ['MANUAL', null, handedIn, BEFORE, 'NONE'],
  ['MANUAL', null, handedIn, AFTER, 'NONE'],

  ['MANUAL', RELEASED, writing, BEFORE, 'NONE'],
  ['MANUAL', RELEASED, writing, AFTER, 'NONE'],
  ['MANUAL', RELEASED, handedIn, BEFORE, 'FULL'],
  ['MANUAL', RELEASED, handedIn, AFTER, 'FULL'],

  ['NEVER', null, writing, BEFORE, 'NONE'],
  ['NEVER', null, writing, AFTER, 'NONE'],
  ['NEVER', null, handedIn, BEFORE, 'NONE'],
  ['NEVER', null, handedIn, AFTER, 'NONE'],
];

test('五種放行政策 × 交了沒 × 過截止了沒，24 格全部符合預期', () => {
  assert.equal(MATRIX.length, 24, '表格被改小了，補回來——漏掉的那一格就是會出事的那一格');
  for (const [policy, releasedAt, attempt, now, want] of MATRIX) {
    const got = maySeeResult({ releasePolicy: policy, dueAt: DUE, releasedAt }, attempt, now);
    assert.equal(
      got.level,
      want,
      `${policy}${releasedAt ? '（已放行）' : ''} × ` +
        `${attempt === writing ? '作答中' : '已交卷'} × ` +
        `${now === BEFORE ? '截止前' : '截止後'}：期望 ${want}，實際 ${got.level}`,
    );
    assert.ok(got.reason.length > 0, '每一種結果都要說得出一句話，空字串會變成一塊空白畫面');
  }
});

test('ON_DUE 在截止前交卷的人，拿不到任何一題的答案', () => {
  // 這一條寫錯就是洩題：先寫完的人截一張圖傳給還在寫的同學，
  // 事後查不出來——成績單上只會看到那個班的平均特別高。
  const v = maySeeResult({ releasePolicy: 'ON_DUE', dueAt: DUE }, handedIn, BEFORE);
  assert.notEqual(v.level, 'FULL');
  assert.equal(v.level, 'SCORE_ONLY');
  assert.equal(v.availableAt?.getTime(), DUE.getTime(), '要說得出「什麼時候才看得到」');
  assert.ok(
    v.reason.includes(fmtTaipei(DUE)),
    `理由裡要有截止時間本身（現在是：${v.reason}）——「之後才開放」不算說明`,
  );
});

test('剛好在截止時刻那一秒，還是看不到答案', () => {
  // 邊界寫成 >= 的話，截止當下還能交卷（lib/attempt.ts 用的是 now > dueAt）
  // 的那批人會同時看得到答案。兩邊的邊界必須是同一邊。
  const v = maySeeResult({ releasePolicy: 'ON_DUE', dueAt: DUE }, handedIn, new Date(DUE));
  assert.equal(v.level, 'SCORE_ONLY');
});

test('ON_DUE 但老師沒設截止時間：分數給看，答案不給', () => {
  // 那個「截止之後」的時刻永遠不會到。判成 FULL 等於預設放行，
  // 判成 NONE 則是學生永遠看不到自己幾分而且不知道為什麼。
  const v = maySeeResult({ releasePolicy: 'ON_DUE', dueAt: null }, handedIn, AFTER);
  assert.equal(v.level, 'SCORE_ONLY');
  assert.equal(v.availableAt, null);
  assert.ok(v.reason.includes('老師'), '要告訴學生去找誰，這是設定漏了不是系統壞了');
});

test('MANUAL 的放行時間還沒到，不算放行', () => {
  // 用 `releasedAt != null` 當條件的話，老師預先排定一個未來的時間
  // 就等於立刻開放。
  const future = new Date('2026-08-10T00:00:00Z');
  const v = maySeeResult(
    { releasePolicy: 'MANUAL', dueAt: DUE, releasedAt: future },
    handedIn,
    AFTER,
  );
  assert.equal(v.level, 'NONE');
});

test('MANUAL 未放行時連分數都不給看', () => {
  // 老師選 MANUAL 通常正是因為還有東西沒處理完（非選題還在改、
  // 某一題要送分）。這時候給出自動計分的分數，學生會拿一個還會變的
  // 數字當結果——一份含作文的卷子在作文改完之前少了 25 分。
  const v = maySeeResult({ releasePolicy: 'MANUAL', dueAt: DUE }, handedIn, AFTER);
  assert.equal(v.level, 'NONE');
});

test('NEVER 不可以說「交卷之後就看得到」', () => {
  // 對一份永遠不開放的考試說「交卷後才看得到」，學生會交完卷再回來
  // 看一次，然後打電話問老師。訊息的正確性與擋不擋得住同樣重要。
  const v = maySeeResult({ releasePolicy: 'NEVER', dueAt: DUE }, writing, BEFORE);
  assert.equal(v.level, 'NONE');
  assert.ok(!v.reason.includes('交卷之後'), `NEVER 的理由不該提交卷（現在是：${v.reason}）`);
  assert.ok(v.reason.includes('不開放'));
});

test('作廢的作答一律看不到，就算政策是立刻開放而且已經交卷', () => {
  // VOIDED 是誠信事件或系統故障的結果，`gradeAttemptById` 直接拒絕
  // 計分。讓它進到檢討頁，學生看到的是一份 0 分的卷子而沒有任何說明。
  const v = maySeeResult(
    { releasePolicy: 'IMMEDIATE', dueAt: DUE },
    { status: 'VOIDED', submittedAt: new Date() },
    AFTER,
  );
  assert.equal(v.level, 'NONE');
  assert.ok(v.reason.includes('作廢'));
});

test('已評分（GRADED）與已交卷（SUBMITTED）一樣算交過了', () => {
  // 只認 SUBMITTED 的話，計分跑完之後狀態變 GRADED，整份檢討就消失了
  // ——而那正是它應該出現的時刻。
  const v = maySeeResult(
    { releasePolicy: 'ON_SUBMIT' },
    { status: 'GRADED', submittedAt: new Date() },
    AFTER,
  );
  assert.equal(v.level, 'FULL');
});

test('IMMEDIATE 在還沒交卷時看不到整份檢討', () => {
  // IMMEDIATE 是「每題作答後」，那是作答畫面裡逐題揭曉的機制。
  // 這一頁是整份卷子——寫到第 10 題就打開它的話，後面 30 題的答案
  // 會一起出現。那不是即時解析，那是一份答案卡。
  const v = maySeeResult({ releasePolicy: 'IMMEDIATE' }, writing, BEFORE);
  assert.equal(v.level, 'NONE');
});

test('認不得的放行政策一律當成不開放', () => {
  // schema 日後多一個 enum 值而這裡忘了跟上時，症狀是「學生看不到
  // 成績」——那會被回報。反過來預設開放的話症狀是洩題，不會被回報。
  const v = maySeeResult({ releasePolicy: 'AFTER_LUNCH' }, handedIn, AFTER);
  assert.equal(v.level, 'NONE');
});

test('時間一律換算成台灣時間', () => {
  // 伺服器跑在 UTC。直接印會告訴學生「9:00 開放」而其實是 17:00，
  // 而他會在早上九點打開頁面然後以為系統壞了。
  //
  // 不比對整串：Intl 在月日與時分之間放的是 U+2009（thin space），
  // 而那個字元會隨 ICU 版本變。這裡要驗的是時區換算，不是排版。
  const s = fmtTaipei(DUE);
  assert.ok(s.includes('8/3'), s);
  assert.ok(s.includes('17:00'), s);
  assert.ok(!s.includes('09:00'), `印出來的是 UTC 而不是台灣時間：${s}`);
});

// ─────────────────────────────────────────────────────────────────
// 二、哪一份解析可以給學生看
// ─────────────────────────────────────────────────────────────────

/** @param {object} over */
function explanation(over = {}) {
  return {
    id: 'e1',
    isPrimary: false,
    origin: 'AI_GENERATED',
    displayMode: 'FULL',
    licenseScope: 'TENANT_EXPORTABLE',
    takedownAt: null,
    layers: { conclusion: '答案是 (C)。' },
    sourceRef: null,
    modelUsed: null,
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    ...over,
  };
}

test('下架的解析一律不顯示', () => {
  // 下架的意思是權利人來信了。下架之後還看得到，等於沒有下架。
  const got = pickExplanation([explanation({ takedownAt: new Date('2026-07-20T00:00:00Z') })]);
  assert.equal(got, null);
});

test('下架的那一份不會擋住還能看的那一份', () => {
  // 只做「挑第一份再檢查有沒有下架」的話，一次下架會讓那些題目
  // 連原本就有的第二份解析都消失。
  const got = pickExplanation([
    explanation({ id: 'gone', isPrimary: true, takedownAt: new Date() }),
    explanation({ id: 'ok' }),
  ]);
  assert.equal(got?.id, 'ok');
});

test('displayMode = HIDDEN 的不顯示', () => {
  assert.equal(pickExplanation([explanation({ displayMode: 'HIDDEN' })]), null);
});

test('INTERNAL_USE_ONLY 的解析不給學生看', () => {
  // 「內部」指的是機構內部的老師。它與 TENANT_NO_EXPORT 差一個字，
  // 而放錯的那一次會把一份聲明為僅供內部參考的原文送到兩百個學生面前。
  assert.equal(pickExplanation([explanation({ licenseScope: 'INTERNAL_USE_ONLY' })]), null);
});

test('TENANT_NO_EXPORT 看得到，但標記為不可帶出去', () => {
  const got = pickExplanation([explanation({ licenseScope: 'TENANT_NO_EXPORT' })]);
  assert.equal(got?.noExport, true, '畫面要靠這個旗標決定不給複製／下載／列印');
});

test('可匯出的解析不會被誤標成不可帶出', () => {
  assert.equal(pickExplanation([explanation()])?.noExport, false);
});

test('isPrimary 的那一份優先，壓過來源優先序', () => {
  // isPrimary 是老師對這一題的明確決定，不能被系統的預設順序推翻。
  const got = pickExplanation([
    explanation({ id: 'teacher', origin: 'TEACHER_WRITTEN' }),
    explanation({ id: 'chosen', origin: 'VERBATIM_IMPORT', isPrimary: true }),
  ]);
  assert.equal(got?.id, 'chosen');
});

test('沒有 isPrimary 時依來源優先序：老師自編最前面', () => {
  // 學生上課學的是老師那一套解法。系統拿另一套教他，兩邊都不熟。
  const got = pickExplanation([
    explanation({ id: 'ai', origin: 'AI_GENERATED' }),
    explanation({ id: 'ceec', origin: 'OFFICIAL_CEEC' }),
    explanation({ id: 'teacher', origin: 'TEACHER_WRITTEN' }),
  ]);
  assert.equal(got?.id, 'teacher');
});

test('內容是空的那一份不算數，會退到下一份', () => {
  // layers 預設是 {}。挑中空的就回傳的話，學生看到一個標著「解析」
  // 卻什麼都沒有的區塊，他會以為是自己網路壞了。
  const got = pickExplanation([
    explanation({ id: 'empty', isPrimary: true, layers: {} }),
    explanation({ id: 'real' }),
  ]);
  assert.equal(got?.id, 'real');
});

test('全部都是空的就回 null，不回一個空殼', () => {
  assert.equal(pickExplanation([explanation({ layers: {} })]), null);
  assert.equal(pickExplanation([]), null);
});

test('輸出裡不會夾帶 rawBody', () => {
  // rawBody 是匯入的出版社原文，schema 註解寫明只作為 AI 改寫的依據。
  // 這一支是重建物件而不是刪欄位，所以就算呼叫端不小心查了它也不會外流。
  const got = pickExplanation([explanation({ rawBody: '出版社詳解的整段原文' })]);
  assert.ok(got);
  assert.ok(
    !JSON.stringify(got).includes('出版社詳解'),
    '原文跟著解析一起出去了——這是這整套權利模型要防的那件事',
  );
});

test('SUMMARY_ONLY 只留結論，推導與誘答項剖析都不給', () => {
  const got = pickExplanation([
    explanation({
      displayMode: 'SUMMARY_ONLY',
      layers: {
        conclusion: '答案是 (C)。',
        steps: ['第一步', '第二步'],
        distractors: [{ option: 'A', why: '忘記變號' }],
      },
    }),
  ]);
  assert.deepEqual(
    got?.layers.map((l) => l.key),
    ['conclusion'],
  );
});

// ── layers 的兩種形狀 ───────────────────────────────────────────

test('匯入寫進來的字串陣列 steps 讀得懂', () => {
  // lib/commit.ts 寫的是 { steps: ['整段原文'] }。只認物件陣列的話
  // 這一層會整個消失，而且沒有錯誤、沒有日誌，畫面上就是少一塊。
  const layers = readLayers({ steps: ['先求出 x 的範圍', '再代回原式'] });
  assert.equal(layers.length, 1);
  assert.deepEqual(
    layers[0].items.map((i) => i.body),
    ['先求出 x 的範圍', '再代回原式'],
  );
});

test('AI 產的物件陣列 steps 照 order 排，不照陣列順序', () => {
  // 步驟的順序就是解析的全部意義。照陣列順序畫出來會變成亂序的解法，
  // 而學生會照著那個順序算。
  const layers = readLayers({
    steps: [
      { order: 2, content: '再代回原式' },
      { order: 1, content: '先求出 x 的範圍' },
    ],
  });
  assert.deepEqual(
    layers[0].items.map((i) => i.body),
    ['先求出 x 的範圍', '再代回原式'],
  );
  assert.deepEqual(
    layers[0].items.map((i) => i.lead),
    ['1', '2'],
  );
});

test('誘答項剖析帶得出選項代號與迷思概念', () => {
  // 「你選 A，代表你可能對和差角公式的符號規則有誤解」比「你答錯了」
  // 有用得多，而那一句的價值全在這一層。
  const layers = readLayers({
    distractors: [{ option: 'A', why: '這是忘記變號的結果', misconception: '和差角的符號規則' }],
  });
  assert.equal(layers[0].key, 'distractors');
  assert.equal(layers[0].items[0].lead, '(A)');
  assert.ok(layers[0].items[0].body.includes('和差角的符號規則'));
});

test('讀不懂的東西一律跳過，不會印出 [object Object]', () => {
  // String(x) 的話畫面上會出現 [object Object]，學生回報的是
  // 「解析壞掉了」而不是「解析不見了」——要查的地方完全不同。
  const layers = readLayers({
    conclusion: { text: '這不是字串' },
    steps: [null, 42, { note: '沒有 content' }, '這一個是好的'],
  });
  assert.equal(layers.length, 1);
  assert.deepEqual(
    layers[0].items.map((i) => i.body),
    ['這一個是好的'],
  );
  assert.ok(!JSON.stringify(layers).includes('object Object'));
});

test('similarQuestionIds 不會變成畫面上的東西', () => {
  // 那是題庫裡其他題目的 id。把它們畫出來等於在檢討頁開一道
  // 通往整個題庫的門。
  const layers = readLayers({
    extensions: { similarQuestionIds: ['q_aaa', 'q_bbb'], commonTraps: ['注意定義域'] },
  });
  const flat = JSON.stringify(layers);
  assert.ok(!flat.includes('q_aaa'));
  assert.ok(flat.includes('注意定義域'));
});

test('layers 不是物件時回空陣列，不丟例外', () => {
  // 這一欄是 Json，資料庫裡什麼都可能有。一題壞掉不該讓整頁 500——
  // 那會讓全班的檢討頁一起打不開。
  assert.deepEqual(readLayers(null), []);
  assert.deepEqual(readLayers('一段字串'), []);
  assert.deepEqual(readLayers([1, 2, 3]), []);
  assert.deepEqual(readLayers(undefined), []);
});

// ─────────────────────────────────────────────────────────────────
// 五、手動放行：老師那一側
//
// 這一段測的是**放行按鈕本身**。它之所以要被測，是因為在它出現之前
// `releasedAt` 這一欄根本沒有任何介面寫得到——後端全部就緒、
// API 也接了，就是沒有人呼叫。症狀是老師選了「手動放行」的考試，
// 學生永遠看不到成績，而老師這一頁看起來完全正常。
//
// 所以這裡的每一條都對著同一個問題：**老師看到的狀態，與學生實際
// 看得到的東西，是不是同一個答案。**
// ─────────────────────────────────────────────────────────────────

test('非手動放行的任務不出現放行 UI，也不准寫 releasedAt', () => {
  // 對一份 ON_DUE 的任務寫進放行時刻，是一個「按了、畫面說成功、
  // 學生仍然要等截止」的動作。看起來完全正常的無效操作最難查。
  for (const policy of ['IMMEDIATE', 'ON_SUBMIT', 'ON_DUE', 'NEVER']) {
    const c = releaseControl({ releasePolicy: policy, dueAt: DUE });
    assert.equal(c.applicable, false, `${policy} 不該出現放行控制`);
    const chk = checkReleaseChange({ releasePolicy: policy, dueAt: DUE }, true);
    assert.equal(chk.ok, false, `${policy} 不該放行得動`);
  }
});

test('老師看到的「放行了沒」與學生看得到的東西完全一致', () => {
  // 這是這一段存在的主要理由。兩邊各寫一份判斷的話，最先分岔的
  // 就是「放行時刻在未來」那一格，而症狀是老師說已經放行、學生說
  // 看不到，兩邊都不覺得自己壞了。
  const future = new Date('2026-08-10T00:00:00Z');
  const CASES = [null, RELEASED, future];
  for (const releasedAt of CASES) {
    const assignment = { releasePolicy: 'MANUAL', dueAt: DUE, releasedAt };
    const teacherSees = releaseControl(assignment, AFTER).released;
    const studentSees = maySeeResult(assignment, handedIn, AFTER).level === 'FULL';
    assert.equal(
      teacherSees,
      studentSees,
      `releasedAt=${releasedAt}：老師端 ${teacherSees}、學生端 ${studentSees}`,
    );
  }
});

test('每一種放行狀態都要說得出一句話', () => {
  // 空字串會在畫面上變成一塊什麼都沒有的區塊，而老師需要知道的
  // 正是「現在學生看不看得到」——那是他按不按這顆鈕的唯一依據。
  for (const releasedAt of [null, RELEASED, new Date('2026-08-10T00:00:00Z')]) {
    const c = releaseControl({ releasePolicy: 'MANUAL', dueAt: DUE, releasedAt }, AFTER);
    assert.ok(c.applicable);
    assert.ok(c.note.length > 0);
  }
});

test('已放行的時間要出現在狀態文字裡', () => {
  // 「已放行」三個字答不出老師真正的問題：是我按的還是別人按的、
  // 是不是上禮拜就放了。時間本身才是那個答案。
  const c = releaseControl({ releasePolicy: 'MANUAL', dueAt: DUE, releasedAt: RELEASED }, AFTER);
  assert.equal(c.released, true);
  assert.ok(c.note.includes(fmtTaipei(RELEASED)), `狀態文字裡要有放行時間（現在是：${c.note}）`);
});

test('放行時刻在未來時，老師端也要說學生還看不到', () => {
  // 目前的 UI 產生不出這種值，但時鐘校正過的機器會。學生端一定會
  // 判成「還沒開放」（見上面 MANUAL 的那一條），老師端跟著說實話。
  const future = new Date('2026-08-10T00:00:00Z');
  const c = releaseControl({ releasePolicy: 'MANUAL', dueAt: DUE, releasedAt: future }, AFTER);
  assert.equal(c.released, false);
  assert.ok(c.note.includes('還沒到') || c.note.includes('仍看不到'));
});

test('重複放行與空收回都要擋下來，不能靜靜地成功', () => {
  // 兩個老師同時看著同一頁時，後按的那位會以為是自己放行的；
  // 而「收回一份根本沒放行過的任務」在畫面上與真的收回一模一樣。
  const released = { releasePolicy: 'MANUAL', dueAt: DUE, releasedAt: RELEASED };
  const pending = { releasePolicy: 'MANUAL', dueAt: DUE, releasedAt: null };

  assert.equal(checkReleaseChange(pending, true).ok, true, '沒放行過的要放行得動');
  assert.equal(checkReleaseChange(released, false).ok, true, '放行過的要收回得動');

  const twice = checkReleaseChange(released, true);
  assert.equal(twice.ok, false);
  assert.ok(twice.error.length > 0, '擋下來的時候要說得出為什麼');

  const empty = checkReleaseChange(pending, false);
  assert.equal(empty.ok, false);
  assert.ok(empty.error.length > 0);
});

test('放行時刻在未來時，再按一次放行仍然算重複', () => {
  // 這一格用 `releaseControl().released` 判斷的話會變成「還沒放行」，
  // 於是老師按下去、`updateAssignment` 保留原本的 releasedAt、
  // 什麼都沒發生而畫面顯示成功——又一個看起來正常的空操作。
  const future = new Date('2026-08-10T00:00:00Z');
  const r = checkReleaseChange({ releasePolicy: 'MANUAL', dueAt: DUE, releasedAt: future }, true);
  assert.equal(r.ok, false);
});

// ─────────────────────────────────────────────────────────────────
// 六、同一份卷子派給好幾個班
//
// 忠孝仁三個班考同一份卷子，忠班週五 15:00 截止、孝仁週六早上才考。
// 只看自己的 `dueAt` 的話，週五 15:00:01 起忠班 32 個人拿得到整份
// 題目、標準答案與詳解，而另外 58 個人隔天才要寫同一份。
//
// 這與 ON_DUE 本來要防的事是同一件事，只是時間軸從一節課拉長到一天。
// 而它與上面每一格一樣：**寫錯不會有任何錯誤訊息**，發現的方式是
// 那兩班的平均特別高，而那時候已經沒有人記得改過什麼。
// ─────────────────────────────────────────────────────────────────

/** 忠班：週五 15:00 截止。 */
const ZHONG_DUE = new Date('2026-07-31T07:00:00Z');
/** 孝班與仁班：週六 11:00 截止。 */
const XIAO_DUE = new Date('2026-08-01T03:00:00Z');
/** 忠班考完了，孝仁還沒考。 */
const SATURDAY_MORNING = new Date('2026-08-01T01:00:00Z');
/** 三個班都考完了。 */
const SATURDAY_NOON = new Date('2026-08-01T04:00:00Z');

const zhong = {
  releasePolicy: 'ON_DUE',
  dueAt: ZHONG_DUE,
  paperCohort: [
    { id: 'a_xiao', title: '第一次段考模擬（孝）', dueAt: XIAO_DUE },
    { id: 'a_ren', title: '第一次段考模擬（仁）', dueAt: XIAO_DUE },
  ],
};

test('沒帶同卷任務時，判定與只看自己的截止時間完全一樣', () => {
  // 呼叫端沒查這份資料時不可以推論出「沒有別的班」——一份空陣列
  // 與「還沒查」在程式裡長得一模一樣，而猜錯的方向是洩題。
  const g = cohortGate({ releasePolicy: 'ON_DUE', dueAt: ZHONG_DUE }, SATURDAY_MORNING);
  assert.equal(+g.dueAt, +ZHONG_DUE);
  assert.equal(g.blockedBy.length, 0);
  assert.equal(g.unbounded, false);
});

test('忠班考完的隔天早上，孝仁還沒考，忠班仍然看不到答案', () => {
  const v = maySeeResult(zhong, handedIn, SATURDAY_MORNING);
  assert.equal(v.level, 'SCORE_ONLY', '這一格通不過就是跨班洩題');
  assert.equal(+v.availableAt, +XIAO_DUE, '要說得出真正的開放時刻，不是自己的截止時間');
  assert.ok(v.reason.includes('別的班'), `理由要說得出為什麼還要等（現在是：${v.reason}）`);
});

test('最後一班也考完之後，三個班一起開放', () => {
  const v = maySeeResult(zhong, handedIn, SATURDAY_NOON);
  assert.equal(v.level, 'FULL');
});

test('已經考完的同卷任務擋不住任何東西', () => {
  // 上禮拜就截止的那一份算進來的話，這一份的檢討會永遠開不了。
  const g = cohortGate(
    {
      releasePolicy: 'ON_DUE',
      dueAt: XIAO_DUE,
      paperCohort: [{ id: 'a_zhong', title: '（忠）', dueAt: ZHONG_DUE }],
    },
    SATURDAY_NOON,
  );
  assert.equal(+g.dueAt, +XIAO_DUE);
  assert.equal(g.blockedBy.length, 0);
});

test('同卷任務沒設截止時間時，擋住而且說得出是設定問題', () => {
  // 一份沒有截止時間的任務隨時可能有人在寫。忽略它等於在那條路上
  // 放行洩題，而洩題不會被回報。
  const v = maySeeResult(
    {
      releasePolicy: 'ON_DUE',
      dueAt: ZHONG_DUE,
      paperCohort: [{ id: 'a_open', title: '自主練習（同一份卷子）', dueAt: null }],
    },
    handedIn,
    SATURDAY_NOON,
  );
  assert.equal(v.level, 'SCORE_ONLY');
  assert.equal(v.availableAt, null);
  assert.ok(v.reason.includes('老師'), '要告訴學生去找誰');
});

test('自己沒設截止但同卷任務有：仍然是設定問題，不放行', () => {
  const v = maySeeResult(
    {
      releasePolicy: 'ON_DUE',
      dueAt: null,
      paperCohort: [{ id: 'a_xiao', title: '（孝）', dueAt: XIAO_DUE }],
    },
    handedIn,
    SATURDAY_NOON,
  );
  // 自己沒有截止時間 → 這一份的「截止後」永遠不會到。同卷那一份
  // 已經考完了，所以擋住的理由回到原本那一個。
  assert.equal(v.level, 'SCORE_ONLY');
});

test('同卷任務不影響 ON_SUBMIT 與 MANUAL', () => {
  // 老師明確選了「交卷後開放」就是他要的設定，系統不該自作主張
  // 把它改成 ON_DUE。跨班洩題的警告在派卷那一頁上說，不在這裡擋。
  const cohort = [{ id: 'a_xiao', title: '（孝）', dueAt: XIAO_DUE }];
  assert.equal(
    maySeeResult({ releasePolicy: 'ON_SUBMIT', dueAt: ZHONG_DUE, paperCohort: cohort }, handedIn, SATURDAY_MORNING).level,
    'FULL',
  );
  assert.equal(
    maySeeResult(
      { releasePolicy: 'MANUAL', dueAt: ZHONG_DUE, releasedAt: RELEASED, paperCohort: cohort },
      handedIn,
      SATURDAY_MORNING,
    ).level,
    'FULL',
  );
});
