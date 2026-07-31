/**
 * 學習歷程的隱私：四條線，每一條都要在程式裡真的擋住。
 *
 * # 為什麼這一支讀原始碼，而不只是呼叫函式
 *
 * 因為要證明的命題是「**沒有**任何一條路徑」，而那是一個全稱句。
 * 呼叫幾支函式證明不了它——證明得了的只有「這幾支我測過的沒漏」，
 * 而漏的那一支正是沒有人想到要測的那一支。
 *
 * 這與 `tests/guardian.test.mjs` 的作法相同：它讀 `lib/guardian.ts` 的
 * 原始碼，確認全檔沒有 `tutorSession`、`attemptAnswer`、`proctorEvent`
 * 任何一個字。畫面層漏一個 `if` 是很平常的事，漏查一個查詢不是。
 *
 * # 四條線（規格書 §9.5）
 *
 * 一、內容預設**只有學生本人**看得到
 * 二、可選擇性分享給特定老師，**且可隨時撤回**
 * 三、**家長在任何路徑下都讀不到**——學生可能寫下不希望家長看到的事
 * 四、**AI 對話紀錄僅學生本人可見，老師連摘要都看不到**
 *
 * 第四條與智慧老師模組**相反**（那裡老師看得到班上的對話），所以它是
 * 最容易在日後被「統一一下」而破掉的一條。這裡用兩種方式釘住它：
 * 型別上沒有欄位裝得下，以及原始碼裡沒有第二支查那張表的函式。
 *
 * # 真正打 API 的驗證在 e2e
 *
 * `tools/e2e-portfolio.mjs` 對真的 Postgres 用真的路由驗「家長打 API
 * 拿不到」「老師沒被分享時拿不到」「AI 對話老師拿不到」。這一支是
 * 它的靜態對照：e2e 證明現在擋得住，這一支證明將來不會被順手改掉。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');
const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');

const read = (p) => readFileSync(p, 'utf8');

/** 註解不算數：一句「老師看不到 tutorSession」不該讓檢查失敗。 */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
}

const portfolioDb = code(read(path.join(LIB, 'portfolioDb.ts')));
const guardian = code(read(path.join(LIB, 'guardian.ts')));
const guardianView = code(read(path.join(LIB, 'guardianView.mjs')));

// ═════════════════════════════════════════════════════════════════
// 一、家長那一側從來沒有長出對這幾張表的查詢
// ═════════════════════════════════════════════════════════════════

/**
 * 家長不可以碰的表（Prisma client 上的名字）。
 *
 * `interviewPractice` 也在裡面：練習的回答裡有他還沒想清楚的話、
 * 講砸的版本、以及對自己志向的猶豫，與學習歷程的內容是同一類的東西。
 */
const FORBIDDEN_FOR_GUARDIAN = [
  'portfolioItem',
  'portfolioEssay',
  'aiDisclosureLog',
  'aiDisclosureStatement',
  'interviewPractice',
];

test('lib/guardian.ts 全檔沒有查任何一張學習歷程的表', () => {
  for (const model of FORBIDDEN_FOR_GUARDIAN) {
    assert.ok(
      !guardian.includes(model),
      `lib/guardian.ts 出現了 ${model}。家長端多一個查詢，就是規格書 §9.5 那條線破了一個洞，` +
        '而症狀是沒有症狀——只有被看的那個孩子受影響，而他不會知道。',
    );
  }
});

test('家長看得到的投影裡沒有任何一個學習歷程的欄位', () => {
  for (const field of ['essay', 'portfolio', 'disclosure', 'statement', 'interview']) {
    assert.ok(
      !new RegExp(`\\b${field}`, 'i').test(guardianView),
      `guardianView.mjs 出現了 ${field}——那是家長那一份資料的形狀`,
    );
  }
});

test('學習歷程的每一支進入點都擋家長，而且說得出為什麼', () => {
  // 不是靠畫面上沒有連結。家長直接打 API 拿到的必須是 403。
  assert.ok(portfolioDb.includes("user.systemRole === 'GUARDIAN'"));
  const src = read(path.join(LIB, 'portfolioDb.ts'));
  assert.ok(
    src.includes('不希望家長看到'),
    '擋住了但沒有說出理由。下一個人會以為那是可以放寬的設定。',
  );
});

// ═════════════════════════════════════════════════════════════════
// 二、AI 對話紀錄：老師連摘要都看不到
// ═════════════════════════════════════════════════════════════════

test('只有一支函式查 AiDisclosureLog 的清單，而它收的是 SessionUser', () => {
  // 收 `SessionUser` 而不是 userId，所以呼叫端**沒有辦法**傳一個
  // 「別人的 id」進來——那個參數在型別上不存在。
  const hits = [...portfolioDb.matchAll(/prisma\.aiDisclosureLog\.\w+/g)].map((m) => m[0]);
  assert.deepEqual(
    [...new Set(hits)].sort(),
    ['prisma.aiDisclosureLog.create', 'prisma.aiDisclosureLog.findMany'],
    '多了一種對 AiDisclosureLog 的操作。這張表只該被寫入與被本人讀取。',
  );

  // `myDisclosure` 與 `makeStatement` 是唯二會 findMany 的地方，兩支都
  // 走 `assertStudent(user)`。
  const src = read(path.join(LIB, 'portfolioDb.ts'));
  for (const fn of ['myDisclosure', 'makeStatement']) {
    const body = src.slice(src.indexOf(`export async function ${fn}(`));
    assert.ok(
      body.slice(0, 700).includes('assertStudent(user)'),
      `${fn} 沒有在一開始就擋住非學生`,
    );
  }
});

test('沒有任何一支函式讓老師讀別人的 AI 記錄或練習', () => {
  // 「查某一位學生的」這種形狀的函式名，在這一區一律不該存在。
  const suspicious = [
    /disclosureFor(?:Class|Student|Teacher)/,
    /logsFor(?:Class|Student)/,
    /practicesFor(?:Class|Student)/,
    /essaysFor(?:Class|Student)/,
    /portfolioFor(?:Class|Student)/,
  ];
  for (const re of suspicious) {
    assert.ok(!re.test(portfolioDb), `出現了一支可以看別人的函式：${re}`);
  }
});

test('老師看得到的型別裡沒有欄位裝得下 AI 對話或分享名單', () => {
  // **這是這一條規則的實作方式。** 「記得不要 select」在改版時撐不住
  // ——下一個人加一個欄位是為了讓畫面好看，而他不會想到那一欄違反了
  // 一條寫在規格書裡的線。沒有地方放的話，加欄位是編譯錯誤。
  const src = read(path.join(LIB, 'portfolioDb.ts'));
  const start = src.indexOf('export type SharedEssayView');
  assert.ok(start > 0, '找不到 SharedEssayView');
  const decl = src.slice(start, src.indexOf('};', start));
  for (const forbidden of ['sharedWith', 'disclosure', 'statement', 'aiLevel', 'logs', 'natureNote']) {
    assert.ok(!decl.includes(forbidden), `SharedEssayView 多了 ${forbidden} 這個欄位`);
  }
  // 而且它的欄位是白名單式的：列得出來的只有這幾個。
  assert.deepEqual(
    [...decl.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]),
    ['id', 'kind', 'authorName', 'body', 'charCount', 'updatedAt'],
  );
});

test('老師端的入口只查「分享給我的」，不查「我帶的班」', () => {
  // 帶班不等於被授權。規格書 §3 的權限表在這一列寫的是「R（學生授權後）」。
  const src = read(path.join(LIB, 'portfolioDb.ts'));
  const start = src.indexOf('export async function essaysSharedWithMe');
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.ok(body.includes('sharedWith: { has: user.id }'));
  assert.ok(!body.includes('classMembership'), '老師端的查詢混進了班級條件');
  assert.ok(!body.includes('isHomeroom'));
});

// ═════════════════════════════════════════════════════════════════
// 三、分享與撤回
// ═════════════════════════════════════════════════════════════════

test('撤回是把 id 從陣列裡拿掉，不是另一張「已撤回」的表', () => {
  // 做成只增不減的授權表加一個 revokedAt 的話，會有一個「查詢忘記
  // 過濾已撤回」的破口，而那個破口的症狀是沒有症狀。
  const src = read(path.join(LIB, 'portfolioDb.ts'));
  const start = src.indexOf('export async function shareEssay');
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.ok(body.includes('row.sharedWith.filter'));
  // 比對的是**去掉註解之後**的原始碼：檔頭那一段正在解釋為什麼不用
  // `revokedAt`，而拿註解去比對的話，寫得越清楚的檔案越容易被判失敗。
  assert.ok(!/revoked/i.test(portfolioDb), '出現了 revokedAt，那是另一種設計而且它有破口');
});

test('存新版本時分享名單要繼承，否則每存一次就等於撤回', () => {
  // 不繼承的話，學生每存一次就等於撤回了分享，而他不會知道——老師
  // 那邊只是安靜地看不到最新的一版。
  const src = read(path.join(LIB, 'portfolioDb.ts'));
  const start = src.indexOf('export async function saveEssay');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.ok(body.includes('sharedWith: prev?.sharedWith ?? []'));
});

// ═════════════════════════════════════════════════════════════════
// 四、不用於任何形式的統計分析
// ═════════════════════════════════════════════════════════════════

/**
 * 可以被聚合的兩張表，以及為什麼它們不算「這一區的資料」。
 *
 * 規格書 §9.5 的「不用於任何形式的統計分析」講的是**學生的個人陳述
 * 與生涯敘事**：`PortfolioEssay`、`PortfolioItem`、`AiDisclosureLog`、
 * `AiDisclosureStatement`、`InterviewPractice`。對那五張表做 groupBy
 * 或 count，就是在拿他寫的東西算平均——而那正是這條規定要禁的事。
 *
 * · `interviewQuestion` 數的是**題庫有幾題**（租戶層級的設定，
 *   用來判斷要不要匯入內建範本），與任何一位學生無關。
 * · `aiUsageLog` 是**token 與成本**，裡面沒有一個字是學生寫的
 *   （欄位是 provider／model／tokens／refType）。這個模組原本一列都
 *   沒有寫，於是它的花費完全不在 `doctor.sh` 與 `OPERATIONS.md` 的
 *   帳上；補上之後，月度預算判定必須 sum 那張表——tutor、
 *   admissionRef、gradingProposal、import-pipeline 四處都是這樣做的，
 *   而它們的檔頭寫明了為什麼真相是這張表而不是 `AiBudgetCounter`。
 *
 * 這份白名單是逐張表列的，不是「跳過所有聚合」：多一張表要有人動手，
 * 動手的時候會看到這段說明。
 */
const AGGREGATABLE = ['interviewQuestion', 'aiUsageLog'];

test('沒有對這幾張表做過任何聚合', () => {
  const aggregates = [...portfolioDb.matchAll(/prisma\.(\w+)\.(groupBy|aggregate|count)\(/g)];
  for (const [, model, op] of aggregates) {
    assert.ok(
      AGGREGATABLE.includes(model),
      `對 ${model} 做了 ${op}，而這一區的資料不做統計分析`,
    );
  }
});

// ═════════════════════════════════════════════════════════════════
// 五、導覽列與頁面：連結藏起來與真的擋住，兩件事都要在
// ═════════════════════════════════════════════════════════════════

test('導覽列不畫給家長，但那只是第二道', () => {
  const nav = code(read(path.join(LIB, 'nav.ts')));
  const line = nav.split('\n').find((l) => l.includes("href: '/portfolio'"));
  assert.ok(line, '導覽列裡沒有學習歷程');
  assert.ok(!line.includes('GUARDIAN'));
  // `/interview` 連職員都不畫——老師沒有任何一條路徑看別人的練習。
  const iv = nav.split('\n').find((l) => l.includes("href: '/interview'"));
  assert.ok(iv.includes('LEARNER') && !iv.includes('STAFF'));
});

test('每一支 API 路由都經過 portfolioDb 的角色判定，沒有人直接打 prisma', () => {
  // 直接在路由裡打 prisma 的話，那一支就繞過了 `assertStudent()`，
  // 而它看起來與別支一模一樣。
  const files = [
    'api/portfolio/items/route.ts',
    'api/portfolio/items/[itemId]/route.ts',
    'api/portfolio/essays/route.ts',
    'api/portfolio/essays/[essayId]/route.ts',
    'api/portfolio/coach/route.ts',
    'api/portfolio/disclosure/route.ts',
    'api/portfolio/checklist/route.ts',
    'api/portfolio/policy/route.ts',
    'api/portfolio/limits/route.ts',
    'api/interview/questions/route.ts',
    'api/interview/practice/route.ts',
  ];
  for (const f of files) {
    const src = code(read(path.join(APP, f)));
    assert.ok(
      !/from '@\/lib\/prisma'/.test(src),
      `${f} 直接 import 了 prisma，那一支就繞過了角色判定`,
    );
    assert.ok(/scopedRoute/.test(src), `${f} 沒有用 scopedRoute`);
  }
});
