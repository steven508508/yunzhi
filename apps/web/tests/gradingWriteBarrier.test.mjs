/**
 * 「AI 不會自己變成分數」這件事的測試。
 *
 * # 為什麼這一支是靜態檢查而不是行為測試
 *
 * 因為要證明的是一個**否定命題**：「沒有任何路徑讓 AI 的評分寫進
 * `AttemptAnswer.earnedScore`」。行為測試證明不了否定命題——它只能證明
 * 「我試過的那幾條路沒有寫進去」，而下一個人加的那條路不在我試過的
 * 清單裡。
 *
 * 所以這裡讀原始碼，用規則判斷。`tools/rls-check.mjs --static` 用同一種
 * 手法守同一種東西（「每一個碰 prisma 的路由都有租戶脈絡」），理由也
 * 一樣：那一類缺口不會有症狀。
 *
 * # 這一支守的三條線
 *
 * **一、`AttemptAnswer` 只有兩個寫入者。** 作答時建立那一列
 * （`lib/attempt.ts`）與計分／人工給分（`lib/scoring.ts`）。AI 閱卷那
 * 一整批檔案裡不可以有第三個——採用建議走 `setManualScore`，也就是
 * 老師手動打一個數字時走的同一支。
 *
 * 少了這一條，下一個為了「批次採用比較快」而直接 update 的人不會有
 * 任何症狀——直到某次「全班重新計分」把三十份作文的分數清成 null
 * （因為那條路沒有寫 `scoreNote` 的人工給分記號）。
 *
 * **二、規準的描述文字不會流到學生那一側。** `Rubric.internalOnly`
 * 預設為真，授權範圍是機構內部閱卷。所以學生端的檔案不可以引用
 * `loadRubricForGrading` / `loadRubricForAi` / `RubricView`。
 *
 * **三、`isAiGradable` 與 `lib/grading.mjs` 沒有分岐。** 兩邊對「哪幾種
 * 題型要人評」的判斷不一致的症狀是：某一題永遠停在待評分而閱卷頁上
 * 找不到它，或者反過來——一題已經自動計分的簡答題被 AI 再評一次，
 * 而兩個分數不一樣。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { gradeAttempt } from '../lib/grading.mjs';
import { isAiGradable } from '../lib/gradingProposal.mjs';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 把註解拿掉。靜態檢查驗的是程式碼，而註解裡本來就會提到被禁的名字。 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'tests') continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const FILES = new Map(
  walk(WEB).map((f) => [path.relative(WEB, f).split(path.sep).join('/'), readFileSync(f, 'utf8')]),
);

/** AI 閱卷這一批新增的每一個檔案。清單是算出來的，不是手寫的。 */
const AI_GRADING_FILES = [...FILES.keys()].filter(
  (f) =>
    f === 'lib/gradingProposal.mjs' ||
    f === 'lib/gradingProposalDb.ts' ||
    f === 'lib/rubric.ts' ||
    f.startsWith('app/api/proposals/') ||
    f.startsWith('app/api/rubrics/') ||
    f.startsWith('app/(app)/grades/') ||
    f === 'app/(app)/bank/[questionId]/RubricEditor.tsx',
);

// ─────────────────────────────────────────────────────────────────
// 一、AttemptAnswer 的寫入者
// ─────────────────────────────────────────────────────────────────

/** 任何一種會改到那張表的呼叫。`findMany` / `select` 不算——讀是可以的。 */
const WRITE_CALL =
  /attemptAnswer\s*\.\s*(update|updateMany|create|createMany|upsert|delete|deleteMany)\b/;

test('AttemptAnswer 只有兩個寫入者：作答與計分', () => {
  const writers = [...FILES.entries()]
    .filter(([, text]) => WRITE_CALL.test(text))
    .map(([f]) => f)
    .sort();
  assert.deepEqual(
    writers,
    ['lib/attempt.ts', 'lib/scoring.ts'],
    '多了一個寫入者。AI 的評分建議必須走 setManualScore，' +
      '否則那個分數不帶人工給分的記號，下一次「全班重新計分」會把它清掉。',
  );
});

test('AI 閱卷的每一個檔案都寫不到 AttemptAnswer', () => {
  for (const f of AI_GRADING_FILES) {
    assert.ok(
      !WRITE_CALL.test(FILES.get(f)),
      `${f} 直接寫了 AttemptAnswer。這條路一定要走 lib/scoring.ts 的 setManualScore。`,
    );
  }
  // 清單不可以是空的——檔案改名之後這一整支測試會安靜地什麼都不驗。
  assert.ok(AI_GRADING_FILES.length >= 6, `只找到 ${AI_GRADING_FILES.length} 個檔案，清單壞了`);
});

test('AI 閱卷不用 raw SQL 繞過去', () => {
  for (const f of AI_GRADING_FILES) {
    const text = FILES.get(f);
    assert.ok(
      !/\$(executeRaw|queryRaw|executeRawUnsafe|queryRawUnsafe)/.test(text),
      `${f} 用了 raw SQL。那會同時繞過 setManualScore 與 RLS。`,
    );
  }
});

test('採用建議那一條路真的呼叫了 setManualScore', () => {
  const db = FILES.get('lib/gradingProposalDb.ts');
  assert.ok(db, '找不到 lib/gradingProposalDb.ts');
  assert.match(db, /import \{[^}]*setManualScore[^}]*\} from '@\/lib\/scoring'/s);
  assert.match(db, /await setManualScore\(/);
  // 順序：先寫分數，再記決定。反過來的話，一筆「已採用、18 分」會與
  // 一個還是待評分的作答並存，而老師的畫面上那一列已經處理完了。
  const scoreAt = db.indexOf('await setManualScore(');
  const updateAt = db.indexOf('answerGradeProposal.update(');
  assert.ok(scoreAt > 0 && updateAt > scoreAt, '要先寫分數再更新建議的狀態');
});

test('建議的狀態機沒有「自動採用」這條路', () => {
  for (const f of AI_GRADING_FILES) {
    const text = FILES.get(f);
    // ACCEPTED 只能由 `decideState()` 算出來（它需要老師給的分數），
    // 不可以有任何地方寫死。
    const code = stripComments(text);
    const hardcoded = /state:\s*'ACCEPTED'/.test(code);
    assert.ok(!hardcoded, `${f} 直接寫死了 state: 'ACCEPTED'。採用一定要經過老師的動作。`);
    assert.ok(
      !/autoAccept|auto_accept|autoApprove/i.test(code),
      `${f} 出現了自動採用的旗標。這個功能不做那件事。`,
    );
  }
});

test('產生建議的那一支只寫得出 PENDING 或 BLOCKED', () => {
  const db = FILES.get('lib/gradingProposalDb.ts');
  const propose = db.slice(db.indexOf('export async function proposeGrade'), db.indexOf('export async function proposeGradesForQuestion'));
  assert.ok(propose.length > 500, '找不到 proposeGrade 的內容');
  const states = [...stripComments(propose).matchAll(/'(PENDING|ACCEPTED|ADJUSTED|REJECTED|BLOCKED)'/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(
    [...new Set(states)].sort(),
    ['BLOCKED', 'PENDING'],
    `proposeGrade 裡出現了不該出現的狀態：${[...new Set(states)].join('、')}`,
  );
});

// ─────────────────────────────────────────────────────────────────
// 二、規準的描述文字不流到學生那一側
// ─────────────────────────────────────────────────────────────────

/** 學生會打開的頁面與它們用到的資料層。 */
const STUDENT_SIDE = [
  ...[...FILES.keys()].filter((f) => f.startsWith('app/(app)/take/')),
  ...[...FILES.keys()].filter((f) => f.startsWith('app/api/attempts/')),
  'lib/result.ts',
  'lib/attempt.ts',
  'lib/tutor.ts',
  'lib/guardianView.mjs',
].filter((f) => FILES.has(f));

test('學生端沒有任何檔案拿得到規準的描述文字', () => {
  assert.ok(STUDENT_SIDE.length >= 4, `學生端清單只有 ${STUDENT_SIDE.length} 個檔案，清單壞了`);
  for (const f of STUDENT_SIDE) {
    const text = FILES.get(f);
    for (const forbidden of ['loadRubricForGrading', 'loadRubricForAi', 'RubricView', 'rubricBand', 'rubricDimension']) {
      assert.ok(
        !text.includes(forbidden),
        `${f} 引用了 ${forbidden}。規準的描述文字受著作權保護，` +
          '授權範圍是機構內部閱卷——學生那一側只能拿 rubricNoticeForStudent（它的型別裡沒有 descriptor）。',
      );
    }
  }
});

test('給學生看的投影裡沒有任何欄位裝得下描述文字', () => {
  const src = FILES.get('lib/rubric.ts');
  const start = src.indexOf('export type RubricNotice');
  const end = src.indexOf('};', start);
  // 註解要先拿掉：型別上方的說明文字本來就會提到 descriptor
  // （它寫的正是「這裡沒有 descriptor」），而這一條驗的是欄位。
  const shape = stripComments(src.slice(start, end));
  assert.ok(shape.length > 40, '找不到 RubricNotice 的型別');
  assert.ok(
    !/descriptor/.test(shape),
    'RubricNotice 裡出現了 descriptor。這個型別的用途就是「填不進去」。',
  );
  // 它也不可以只是把整個 RubricView 傳出去。
  assert.ok(!/RubricView/.test(shape));
});

test('匯出的方向有一道明確的擋阻', () => {
  const src = FILES.get('lib/rubric.ts');
  assert.match(src, /export function assertRubricExportable/);
  // 回空的不算擋住：那樣匯出的檔案裡少一段而沒有人知道，
  // 下一次有人「修好」它就漏出去了。
  const fn = src.slice(src.indexOf('export function assertRubricExportable'));
  assert.match(fn.slice(0, 600), /throw new RubricError/);
});

// ─────────────────────────────────────────────────────────────────
// 三、與 lib/grading.mjs 不分岐
// ─────────────────────────────────────────────────────────────────

const TYPES = [
  'SINGLE_CHOICE',
  'MULTI_CHOICE',
  'TRUE_FALSE',
  'FILL_SLOT',
  'FILL_TEXT',
  'SHORT_ANSWER',
  'TRANSLATION',
  'ESSAY',
];

/** 一題的計分結果：`gradeAttempt` 有沒有把它留給人。 */
function leftToHuman(type, scoringRule) {
  const [result] = gradeAttempt(
    [
      {
        questionId: 'q1',
        type,
        score: 10,
        order: 1,
        correctKeys: [1],
        correctSlots: ['甲'],
        correctText: '甲',
        optionCount: 4,
        scoringRule,
      },
    ],
    [{ questionId: 'q1', answerKeys: [1], answerText: '甲', answerSlots: [{ slot: '甲', value: '甲' }] }],
  ).results;
  return result.earnedScore === null;
}

test('isAiGradable 與 lib/grading.mjs 對「留給人評」的判斷完全一致', () => {
  for (const type of TYPES) {
    assert.equal(
      isAiGradable(type, null),
      leftToHuman(type, null),
      `題型 ${type} 的判斷不一致：閱卷頁上會找不到它，或者它會被評兩次`,
    );
  }
});

test('設了自動比對規則的簡答題不進 AI 閱卷（那一題已經有分數了）', () => {
  for (const rule of [
    { mode: 'EXACT', answer: '甲' },
    { mode: 'CONTAINS', keywords: ['甲'] },
  ]) {
    assert.equal(isAiGradable('SHORT_ANSWER', rule), false, `${rule.mode} 應該由系統計分`);
    assert.equal(leftToHuman('SHORT_ANSWER', rule), false, `${rule.mode} 的行為對不上`);
  }
});

test('送分的題目不進 AI 閱卷', () => {
  const rule = { awardAll: { reason: '題目有爭議' } };
  assert.equal(isAiGradable('ESSAY', rule), false);
  assert.equal(leftToHuman('ESSAY', rule), false);
});

test('沒有規則的非選題三種都要進 AI 閱卷', () => {
  for (const type of ['ESSAY', 'TRANSLATION', 'SHORT_ANSWER']) {
    assert.equal(isAiGradable(type, null), true);
    assert.equal(isAiGradable(type, {}), true);
  }
});

// ─────────────────────────────────────────────────────────────────
// 四、老師端的介面不預填 AI 的分數
//
// 這一條也是靜態檢查，理由與第一條一樣：它要證明的是「沒有一條路」。
// 而它與第一條一樣重要——預填的話，老師會直接按確認，那就是
// 「AI 決定」而不是「AI 提出」，**而畫面上完全看不出差別**。
// ─────────────────────────────────────────────────────────────────

test('分數輸入框的初始值是空字串，不是建議的分數', () => {
  const card = FILES.get('app/(app)/grades/[assignmentId]/ProposalCard.tsx');
  assert.ok(card, '找不到 ProposalCard.tsx');
  const init = /useState\(([^)]*)\);\s*\n[^\n]*\/\/|const \[score, setScore\] = useState\(([^)]*)\)/.exec(
    card,
  );
  assert.ok(init, '找不到 score 的 useState');
  const arg = (init[1] ?? init[2] ?? '').trim();
  assert.equal(arg, "''", `分數輸入框的初始值是 ${arg}，它必須是空字串`);
  assert.ok(
    !/useState\(\s*(String\()?\s*(proposal|suggested)/.test(card),
    '輸入框被 AI 的建議預填了。要他自己打，或按一下「採用」。',
  );
});

test('採用是一個明確的動作，會把分數寫在請求裡', () => {
  const card = FILES.get('app/(app)/grades/[assignmentId]/ProposalCard.tsx');
  // 前端把它要送的那個數字寫出來，伺服器再判斷它與建議一不一樣。
  // 收 `{ accept: true }` 的協定等於「分數從 AI 的欄位直接流到分數欄」。
  assert.match(card, /decide\(suggested, false\)/);
  const api = FILES.get('app/api/proposals/decide/route.ts');
  assert.match(api, /finalScore: z\.number\(\)/);
  assert.ok(!/accept:\s*z\.boolean/.test(api), 'decide 不可以收「照它給」這種簡寫');
});
