/**
 * 非選題 AI 閱卷對真的 Postgres 的端到端驗證。
 *
 * # 為什麼要有這一支，而不是只靠閘門的單元測試
 *
 * 閘門的 88 個單元測試驗的是「這一份評分該不該擋」。它們驗不到的是跨越
 * 資料庫與行程邊界之後還對不對，而這個功能的核心承諾**只在那一側才
 * 成立**：
 *
 *   · **AI 的建議永遠不會自己變成分數。** 產生建議之後
 *     `AttemptAnswer.earnedScore` 一定還是 null——這一條寫錯就是
 *     「AI 決定」而不是「AI 提出」，而畫面上完全看不出差別。
 *   · 老師採用之後分數**真的寫進去了**，而且帶著人工給分的記號，
 *     所以**下一次「全班重新計分」不會把它蓋掉**。既有機制早就寫好了
 *     （`lib/scoring.ts` 的 `isManualScore` 那一段），這裡確認 AI 這條路
 *     真的走了同一支。
 *   · `answer_grade_proposals` 上那三條 CHECK 真的擋得住（已決定的一定
 *     要有人與時間、改分或不採用一定要填理由、被擋下的一定要有理由）。
 *   · **被擋下的建議真的存進去了**——那是唯一看得出「AI 的閱卷準不準」
 *     的資料，漏存的症狀是採用率永遠算不出來。
 *   · 規準的描述文字**學生身分拿不到**（`internalOnly`，授權範圍是
 *     機構內部閱卷）。
 *   · RLS：隔壁補習班的規準與建議不會混進這家。
 *
 * # 兩個替身，各自的理由
 *
 * **Prisma 用 pg-shim 的加強版。** 理由見 tools/pg-shim.mjs 的檔頭：
 * Prisma 的查詢引擎要從外部網域下載，而這套系統要部署的機房是封閉
 * 網段。shim 沒有實作 `include`／`aggregate`／`upsert`／`$transaction`／
 * 關聯過濾，這裡在**測試這一側**補上（`adapt()`），不去動共用的 shim
 * ——那是好幾支 e2e 共用的東西，為了一支測試改它不划算。
 *
 * **AI 服務用本機的假伺服器。** 真的模型每跑一次要錢、而且回應不是
 * 確定性的，那會讓「閘門有沒有擋住」變成擲骰子。這裡的假伺服器照腳本
 * 回應，包含**一段通篇套語的評分**（驗證它被擋下、被存起來、而且沒有
 * 變成分數）與**一組三次差很多的評分**（驗證離散度真的被算出來並標成
 * 「判斷不穩」）。
 *
 * 用法（沿用 tools/e2e-tutor.mjs 的建庫方式，只需要 Postgres）：
 *
 *   su postgres -c "psql -c \"CREATE ROLE yunzhi_grading LOGIN PASSWORD 'pw' CREATEDB\""
 *   su postgres -c "psql -c 'CREATE DATABASE yunzhi_grading OWNER yunzhi_grading'"
 *   su postgres -c "psql -d yunzhi_grading -c 'CREATE EXTENSION vector'"
 *   su postgres -c "psql -d yunzhi_grading -c 'CREATE EXTENSION pg_trgm'"
 *   DATABASE_URL=postgresql://yunzhi_grading:pw@127.0.0.1:5432/yunzhi_grading \
 *     npx prisma migrate deploy --schema packages/db/schema.prisma
 *   DATABASE_URL=postgresql://yunzhi_grading:pw@127.0.0.1:5432/yunzhi_grading \
 *     node tools/e2e-grading-ai.mjs
 *
 * **不需要 Redis、S3、也不需要 AI 服務**——AI 那一側是本檔自己起的
 * 假伺服器，所以這一支在沒有網路、沒有金鑰的機器上也跑得完。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import { createPgShim } from './pg-shim.mjs';
import { withTenant, withoutTenantScope } from '../apps/web/lib/tenantContext.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`   ✓ ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`   ✗ ${name}`);
    console.error(`     ${String(e.message).split('\n').slice(0, 6).join('\n     ')}`);
    failed += 1;
  }
}

function section(name) {
  console.log(`\n\x1b[1m── ${name}\x1b[0m`);
}

const HASH = '$2a$12$notarealhashnotarealhashnotarealhashnotarealhashnotar';

/** 學生寫的那一段。**閘門要靠它判斷「理由有沒有引用具體內容」。** */
const ANSWER =
  '我認為最能說明這件事的是魚市場的清晨。' +
  '凌晨三點，攤販把冰塊鋪在木箱上，燈泡一盞一盞亮起來，那時候還沒有任何客人。' +
  '他們做的每一件事都不是為了自己，而是為了幾個小時之後才會出現的人。';

/** 一段真的引用了答案的理由。假伺服器的「正常」腳本用它。 */
const GOOD_REASON =
  '你寫「攤販把冰塊鋪在木箱上，燈泡一盞一盞亮起來」，這個細節把時間點交代得很清楚，' +
  '而且把準備寫成「為了幾個小時之後才會出現的人」，是從經驗長出來的判斷。' +
  '扣分在最後一段只用一句話帶過感受，沒有回到那個場景。';

/** 一段可以貼到任何一份答案上的評語。**這一段一定要被擋下來。** */
const GENERIC_REASON =
  '這一篇回應了題目的要求，內容有具體的例子，敘述完整，值得肯定的地方不少，' +
  '不過在感受的部分還可以再深入一些，整體來說是一篇中上程度的作品。';

// ─────────────────────────────────────────────────────────────
// Prisma 替身：把正式程式用到、而 pg-shim 沒有實作的操作補起來。
//
// **每一個都刻意做得很笨。** 一個半吊子的 ORM 替身若開始「聰明」，
// 就會與 Prisma 的實際行為分岐，而那時它給的綠燈比沒有測試更危險。
// ─────────────────────────────────────────────────────────────

function adapt(base) {
  return new Proxy(base, {
    get(target, key) {
      if (key === '$transaction') {
        // 呼叫端寫的是 `$transaction([a, b, c])`，而 shim 的每一個操作在
        // 放進陣列的當下就已經開始跑了。所以這裡只能等它們全部結束
        // ——**不是真的交易**。這支測試驗的是「有沒有寫進去」，
        // 原子性由 tools/e2e-exam.mjs 那一側負責。
        return (ops) => Promise.all(ops);
      }
      if (typeof key === 'string' && key.startsWith('$')) return target[key];

      const model = target[key];
      if (!model || typeof model !== 'object') return model;

      return new Proxy(model, {
        get(m, op) {
          if (op === 'aggregate') return aggregate(m);
          if (op === 'upsert') return upsert(m);
          if (op === 'findFirst' || op === 'findMany') return finder(base, String(key), m, op);
          if (op === 'count') {
            return async (args = {}) => (await finder(base, String(key), m, 'findMany')(args)).length;
          }
          return m[op];
        },
      });
    },
  });
}

/** `_sum` 加上 `gte` / `lt` 的範圍。正式環境走索引範圍掃描，這裡在記憶體裡篩。 */
function aggregate(m) {
  return async (args) => {
    const { eq, ops } = splitWhere(args.where ?? {});
    let rows = await m.findMany({ where: eq });
    for (const [k, cond] of ops) {
      if ('gte' in cond) rows = rows.filter((r) => new Date(r[k]) >= new Date(cond.gte));
      if ('lt' in cond) rows = rows.filter((r) => new Date(r[k]) < new Date(cond.lt));
    }
    const sum = {};
    for (const f of Object.keys(args._sum ?? {})) {
      sum[f] = rows.reduce((n, r) => n + Number(r[f] ?? 0), 0);
    }
    return { _sum: sum };
  };
}

function upsert(m) {
  return async (args) => {
    // 複合唯一鍵在 Prisma 裡寫成 `{ a_b: { a, b } }`，攤平之後才餵得進 shim。
    const flat = {};
    for (const v of Object.values(args.where)) Object.assign(flat, v);
    const found = await m.findFirst({ where: flat });
    if (!found) return m.create({ data: args.create, select: args.select });
    const data = {};
    for (const [k, v] of Object.entries(args.update)) {
      data[k] =
        v && typeof v === 'object' && 'increment' in v
          ? BigInt(found[k] ?? 0n) + BigInt(v.increment)
          : v;
    }
    return m.update({ where: { id: found.id }, data, select: args.select });
  };
}

/** shim 只認得純量條件，運算子與關聯條件要抽出來自己處理。 */
function splitWhere(where) {
  const eq = {};
  const ops = [];
  const relations = [];
  for (const [k, v] of Object.entries(where ?? {})) {
    if (v === null || v instanceof Date || typeof v !== 'object') {
      eq[k] = v;
    } else if ('in' in v || 'notIn' in v || 'equals' in v || 'not' in v || 'lt' in v || 'gt' in v) {
      eq[k] = v;
    } else if ('gte' in v || 'lte' in v) {
      ops.push([k, v]);
    } else {
      relations.push([k, v]);
    }
  }
  return { eq, ops, relations };
}

/** 關聯過濾：`{ attempt: { assignmentId } }` → 先查出 attemptId 清單。 */
const RELATION_FK = {
  attempt: ['attempt', 'attemptId'],
  question: ['question', 'questionId'],
  user: ['user', 'userId'],
};

function finder(db, key, m, op) {
  return async (args = {}) => {
    const { include, select, orderBy, take, skip, distinct, where, ...rest } = args;
    const { eq, ops, relations } = splitWhere(where ?? {});

    for (const [name, cond] of relations) {
      const [model, fk] = RELATION_FK[name] ?? [];
      if (!model) throw new Error(`e2e adapt：不認得的關聯過濾 ${key}.${name}`);
      const parents = await db[model].findMany({ where: cond, select: { id: true } });
      eq[fk] = { in: parents.map((p) => p.id) };
    }

    // 含關聯的 select 一律整列撈：挑欄位再補外鍵需要知道每個模型有哪些
    // 欄位，而那是 shim 的工作，不是這個測試替身的。
    const plain = select && !hasRelation(select) ? { ...rest, select } : rest;
    // 關聯排序（`{ user: { username: 'asc' } }`）shim 不認得，在記憶體裡排。
    const scalarOrder = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).filter(
      (o) => Object.values(o).every((v) => typeof v === 'string'),
    );
    let rows = await m[op]({
      ...plain,
      where: eq,
      ...(scalarOrder.length ? { orderBy: scalarOrder } : {}),
    });

    const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
    for (const [k, cond] of ops) {
      if ('gte' in cond) {
        for (let i = list.length - 1; i >= 0; i -= 1) {
          if (!(new Date(list[i][k]) >= new Date(cond.gte))) list.splice(i, 1);
        }
      }
    }
    for (const row of list) await hydrate(db, key, row, include ?? select);
    if (distinct) {
      const seen = new Set();
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const sig = distinct.map((f) => list[i][f]).join(' ');
        if (seen.has(sig)) list.splice(i, 1);
        else seen.add(sig);
      }
    }
    return Array.isArray(rows) ? (take ? list.slice(skip ?? 0, (skip ?? 0) + take) : list) : (list[0] ?? null);
  };
}

function hasRelation(select) {
  return Object.values(select).some((v) => v && typeof v === 'object');
}

/**
 * 手工補上關聯。**只支援正式程式真的用到的那幾條**，
 * 用不到的一律拋錯而不是靜靜回 undefined。
 */
async function hydrate(db, model, row, shape) {
  if (!row || !shape) return;
  const want = (k) => shape[k] && typeof shape[k] === 'object';

  if (model === 'attempt') {
    if (want('answers')) {
      row.answers = await db.attemptAnswer.findMany({ where: { attemptId: row.id } });
    }
    if (shape.answers === true) {
      row.answers = await db.attemptAnswer.findMany({ where: { attemptId: row.id } });
    }
    if (want('assignment')) {
      row.assignment = await db.assignment.findFirst({ where: { id: row.assignmentId } });
      await hydrate(db, 'assignment', row.assignment, shape.assignment.select ?? {});
    }
    if (want('user')) row.user = await db.user.findFirst({ where: { id: row.userId } });
  }
  if (model === 'assignment') {
    if (want('paper')) {
      row.paper = await db.examPaper.findFirst({ where: { id: row.paperId } });
      await hydrate(db, 'examPaper', row.paper, shape.paper.select ?? {});
    }
  }
  if (model === 'examPaper') {
    if (want('items')) {
      row.items = (await db.examPaperItem.findMany({ where: { paperId: row.id } })).sort(
        (a, b) => a.order - b.order,
      );
      for (const it of row.items) await hydrate(db, 'examPaperItem', it, shape.items.select ?? {});
    }
    if (want('subject')) row.subject = await db.subject.findFirst({ where: { id: row.subjectId } });
  }
  if (model === 'examPaperItem' && want('question')) {
    row.question = await db.question.findFirst({ where: { id: row.questionId } });
    await hydrate(db, 'question', row.question, shape.question.select ?? {});
  }
  if (model === 'question') {
    if (want('group')) {
      row.group = row.groupId
        ? await db.questionGroup.findFirst({ where: { id: row.groupId } })
        : null;
    }
    if (shape._count) {
      const options = await db.questionOption.findMany({ where: { questionId: row.id } });
      row._count = { options: options.length };
    }
  }
  if (model === 'rubric') {
    if (want('dimensions')) {
      row.dimensions = (await db.rubricDimension.findMany({ where: { rubricId: row.id } })).sort(
        (a, b) => a.order - b.order,
      );
    }
    if (want('bands')) {
      row.bands = (await db.rubricBand.findMany({ where: { rubricId: row.id } })).sort(
        (a, b) => a.order - b.order,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 假的 AI 服務
// ─────────────────────────────────────────────────────────────

/** 下一次呼叫要回哪一組樣本。用完之後重複最後一組。 */
let script = [];
let calls = [];

function samplesOf(spec) {
  return spec.map((s) => ({
    score: s.score,
    dimensions: s.dimensions ?? [],
    rationale: s.rationale,
    confidence: s.confidence ?? 0.6,
  }));
}

function startFakeAi() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const payload = JSON.parse(body || '{}');
        calls.push(payload);
        const spec = script[Math.min(calls.length - 1, script.length - 1)] ?? [
          { score: 0, rationale: '（沒有腳本）' },
        ];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            samples: samplesOf(spec),
            parse_failures: 0,
            model: 'fake/grading',
            provider: 'fake',
            input_tokens: 900,
            output_tokens: 240,
            tokens_estimated: false,
            latency_ms: 7,
            prompt_version: '2026-07-30.1',
          }),
        );
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ─────────────────────────────────────────────────────────────
// 主程式
// ─────────────────────────────────────────────────────────────

const raw = createPgShim({
  connectionString: process.env.DATABASE_URL,
  schemaPath: 'packages/db/schema.prisma',
});
const prisma = adapt(raw);

const server = await startFakeAi();
process.env.AI_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;

// lib/rubric.ts、lib/gradingProposalDb.ts、lib/scoring.ts 是 TypeScript 而且
// 用 `@/` 別名。用 esbuild 打包成一份 ESM，把 `@/lib/prisma` 換成上面那個
// 替身——**其餘的程式碼一個字都不改**，所以這裡跑的判斷與正式環境跑的
// 是同一份。
// 打包的產物要放在 `node_modules` 底下，**不是** `/tmp`。
//
// `external: ['@prisma/client']` 的意思是「不要打包進來，執行時再解析」，
// 而 Node 解析 bare specifier 是從**匯入者所在的目錄**往上找 node_modules。
// bundle 放 `/tmp` 的話那條路上一個 node_modules 都沒有，於是整支測試
// 在 `await import()` 那一行以 `ERR_MODULE_NOT_FOUND` 炸掉。
//
// 這件事會被拖到今天才發現，是因為在 `lib/scoring.ts` 開始 import
// `lib/notifyDb.ts`（成績重算要通知學生）之前，這個 bundle 恰好沒有
// 任何一條路徑真的用到 `@prisma/client` 的**值**（其餘都是 `import type`，
// esbuild 會整句抹掉）。也就是說它一直是對的地雷、只是沒人踩到——
// 而它沒被踩到的三個月裡，這支測試也沒有被任何 runner 跑過。
//
// 其餘六支 e2e 早就寫成 `ROOT/node_modules/...`（見 e2e-admission-ref、
// e2e-tutor、e2e-portfolio…），這裡跟它們一致。`.` 開頭的目錄名是為了
// 不被 npm 當成套件掃到。
const outDir = mkdtempSync(path.join(ROOT, 'node_modules', '.yz-e2e-grading-'));
const shimPath = path.join(outDir, 'prisma-shim.mjs');
writeFileSync(shimPath, 'export const prisma = globalThis.__YZ_GRADING_PRISMA__;\n');
const entry = path.join(outDir, 'entry.ts');
writeFileSync(
  entry,
  [
    // 一個 barrel：三個模組要在同一個 bundle 裡，否則它們各自帶一份
    // prisma 替身與一份租戶脈絡。
    "export { saveRubric, deleteRubric, loadRubricForGrading, loadRubricForAi, rubricNoticeForStudent, assertRubricExportable } from '@/lib/rubric';",
    "export { proposeGrade, proposeGradesForQuestion, decideProposal, loadQuestionBatch, loadProposalsForAttempt, nonObjectiveItems, gradingAccuracy } from '@/lib/gradingProposalDb';",
    "export { gradeAttemptById, setManualScore } from '@/lib/scoring';",
  ].join('\n'),
);

await build({
  entryPoints: [entry],
  outfile: path.join(outDir, 'bundle.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['@prisma/client'],
  alias: { '@/lib/prisma': shimPath, '@': path.join(ROOT, 'apps/web') },
  plugins: [
    {
      // 租戶脈絡**不可以被打包進去**。`tenantContext.mjs` 裡的
      // AsyncLocalStorage 是一個模組層級的單例，打包會複製出第二份——
      // 於是這支測試用 `withTenant` 建立的脈絡，bundle 裡的
      // `requireTenant` 看不到，每一個查詢都失敗在「忘記包 withTenant？」。
      name: 'share-tenant-context',
      setup(b) {
        b.onResolve({ filter: /(^|\/)tenantContext\.mjs$/ }, () => ({
          path: pathToFileURL(path.join(ROOT, 'apps/web/lib/tenantContext.mjs')).href,
          external: true,
        }));
      },
    },
  ],
});

globalThis.__YZ_GRADING_PRISMA__ = prisma;
const lib = await import(pathToFileURL(path.join(outDir, 'bundle.mjs')).href);

// ── 種子 ─────────────────────────────────────────────────────

/**
 * 一家補習班：一位老師（校務管理員，所以不受科目限制）、一位學生、
 * 一題 25 分的作文、一份卷、一個任務、一份已交卷的作答。
 *
 * 兩家用同一個函式建，理由與其他 e2e 相同：兩邊的資料形狀一模一樣、
 * 只有 tenantId 不同，所以任何一列跨界出現在對方的結果裡，
 * 都只可能是隔離漏了。
 */
async function seed(spec) {
  // 建租戶那一列本身跨租戶：`tenants` 的政策比對的是 `id`，而這一刻
  // 還沒有 id 可以比對（RLS 是 fail closed，所以 INSERT 會被擋）。
  const tenant = await withoutTenantScope('建立測試用的補習班', () =>
    raw.tenant.create({ data: { name: spec.name } }),
  );
  return withTenant(tenant.id, async () => {
    const year = await raw.academicYear.create({
      data: {
        tenantId: tenant.id,
        name: '115學年度',
        startDate: new Date('2026-08-01'),
        endDate: new Date('2027-07-31'),
        isCurrent: true,
      },
    });
    const subject = await raw.subject.create({
      data: { tenantId: tenant.id, code: 'CHINESE', name: '國文', order: 1 },
    });
    const teacher = await raw.user.create({
      data: {
        tenantId: tenant.id,
        username: `${spec.prefix}-T01`,
        displayName: `${spec.tag}的國文老師`,
        // 校務管理員不受科目限制（`subjectScope` 回 null），所以
        // `mayGrade` 不必查授課表——這一支測的是閱卷，不是權限矩陣。
        systemRole: 'SCHOOL_ADMIN',
        passwordHash: HASH,
      },
    });
    const student = await raw.user.create({
      data: {
        tenantId: tenant.id,
        username: `${spec.prefix}-S01`,
        displayName: `${spec.tag}的學生甲`,
        systemRole: 'STUDENT',
        passwordHash: HASH,
      },
    });
    const classmate = await raw.user.create({
      data: {
        tenantId: tenant.id,
        username: `${spec.prefix}-S02`,
        displayName: `${spec.tag}的學生乙`,
        systemRole: 'STUDENT',
        passwordHash: HASH,
      },
    });

    const essay = await raw.question.create({
      data: {
        tenantId: tenant.id,
        subjectId: subject.id,
        familyId: `${spec.prefix}-fam-essay`,
        type: 'ESSAY',
        status: 'PUBLISHED',
        content: '閱讀上文之後，請以自己的經驗說明你對「準備」這兩個字的理解，文長不限。',
        score: 25,
        sourceType: 'TEACHER_ORIGINAL',
        licenseScope: 'TENANT_EXPORTABLE',
      },
    });
    // 一題客觀題，用來確認重新計分真的跑得動（而且不碰人工分數）。
    const mc = await raw.question.create({
      data: {
        tenantId: tenant.id,
        subjectId: subject.id,
        familyId: `${spec.prefix}-fam-mc`,
        type: 'SINGLE_CHOICE',
        status: 'PUBLISHED',
        content: '下列哪一個是正確的？',
        score: 5,
        answerKeys: [2],
        sourceType: 'TEACHER_ORIGINAL',
        licenseScope: 'TENANT_EXPORTABLE',
      },
    });
    for (const [i, text] of ['甲', '乙', '丙', '丁'].entries()) {
      await raw.questionOption.create({
        data: { questionId: mc.id, order: i + 1, label: String(i + 1), content: text },
      });
    }

    const paper = await raw.examPaper.create({
      data: {
        tenantId: tenant.id,
        subjectId: subject.id,
        title: `${spec.tag}的國寫練習`,
        status: 'READY',
        totalScore: 30,
      },
    });
    await raw.examPaperItem.create({
      data: { paperId: paper.id, questionId: mc.id, order: 1, score: 5 },
    });
    await raw.examPaperItem.create({
      data: { paperId: paper.id, questionId: essay.id, order: 2, score: 25 },
    });

    const assignment = await raw.assignment.create({
      data: {
        tenantId: tenant.id,
        paperId: paper.id,
        title: `${spec.tag}的國寫作業`,
        mode: 'PRACTICE',
        createdBy: teacher.id,
        releasePolicy: 'IMMEDIATE',
      },
    });

    const layout = [
      { questionId: mc.id, order: 1, score: 5, optionOrder: [1, 2, 3, 4] },
      { questionId: essay.id, order: 2, score: 25, optionOrder: [] },
    ];

    const attempts = [];
    for (const [i, who] of [student, classmate].entries()) {
      const attempt = await raw.attempt.create({
        data: {
          assignmentId: assignment.id,
          userId: who.id,
          attemptNo: 1,
          status: 'SUBMITTED',
          startedAt: new Date(Date.now() - 3600_000),
          submittedAt: new Date(Date.now() - 60_000),
          layout,
        },
      });
      await raw.attemptAnswer.create({
        data: { attemptId: attempt.id, questionId: mc.id, answerKeys: [2] },
      });
      await raw.attemptAnswer.create({
        data: {
          attemptId: attempt.id,
          questionId: essay.id,
          answerKeys: [],
          answerText: i === 0 ? ANSWER : `${ANSWER}我也想過要早一點到。`,
        },
      });
      attempts.push(attempt);
    }

    return {
      tenantId: tenant.id,
      subjectId: subject.id,
      teacher,
      student,
      essayId: essay.id,
      mcId: mc.id,
      assignmentId: assignment.id,
      attemptId: attempts[0].id,
      otherAttemptId: attempts[1].id,
    };
  });
}

console.log('\n\x1b[1m雲端智學 — 非選題 AI 閱卷 端到端驗證\x1b[0m');
console.log(`   資料庫：${(process.env.DATABASE_URL ?? '（沒設）').replace(/:[^:@]*@/, ':***@')}`);

// 先清庫。**不清的話，`questions_familyId_version_key` 這種跨租戶的
// 唯一鍵會在第二次執行時撞上**，而錯誤訊息完全看不出是上一次的殘留。
// 與 tools/e2e-ability.mjs 同一個做法。
await withoutTenantScope('AI 閱卷端到端：清庫', async () => {
  await raw.$executeRawUnsafe(`
    TRUNCATE TABLE tenants, subjects, publishers, official_source_fetches
    RESTART IDENTITY CASCADE
  `);
});

const A = await seed({ name: '甲補習班（AI 閱卷）', prefix: 'GA', tag: '甲' });
const B = await seed({ name: '乙補習班（AI 閱卷）', prefix: 'GB', tag: '乙' });

const asA = (fn) => withTenant(A.tenantId, fn);
const asB = (fn) => withTenant(B.tenantId, fn);

/** 學測國寫的等第規準（描述文字是這支測試自己寫的，不是抄來的）。 */
const BAND_DRAFT = {
  name: '國寫情意題評分原則',
  totalScore: 25,
  mode: 'BAND',
  sourceRef: '這一份是測試資料',
  dimensions: [],
  bands: [
    {
      grade: 'A+',
      scoreMin: 22,
      scoreMax: 25,
      descriptor: '經驗寫得具體而且看得出是自己的事，感受與經驗對得起來，敘述有層次而不只是把事情講完。',
      order: 0,
    },
    {
      grade: 'B',
      scoreMin: 10,
      scoreMax: 21,
      descriptor: '有經驗也有感受，但兩者之間的連結偏弱，或者經驗停在概括的層面而沒有落到細節。',
      order: 1,
    },
    { grade: '0', scoreMin: 0, scoreMax: 9, descriptor: '空白、文不對題、或完全與題目無關。', order: 2 },
  ],
};

// ── 一、規準 ────────────────────────────────────────────────

section('評分規準');

await test('老師建得起來一份等第制的規準', async () => {
  await asA(async () => {
    const r = await lib.saveRubric(A.teacher, A.essayId, BAND_DRAFT);
    assert.equal(r.totalScore, 25);
    assert.equal(r.bands.length, 3);
    assert.equal(r.dimensions.length, 0);
    // **預設是內部使用**，即使草稿沒有明說。
    assert.equal(r.internalOnly, true);
  });
});

await test('加總對不上的規準存不進去', async () => {
  await asA(async () => {
    await assert.rejects(
      () =>
        lib.saveRubric(A.teacher, A.essayId, {
          ...BAND_DRAFT,
          bands: [{ grade: 'A', scoreMin: 0, scoreMax: 20, descriptor: '只到 20 分', order: 0 }],
        }),
      (e) => /沒有人拿得到滿分/.test(e.message),
    );
  });
});

await test('改規準是原地換內容，rubricId 不變（建議才對得回去）', async () => {
  await asA(async () => {
    const before = await lib.loadRubricForAi(A.essayId);
    const after = await lib.saveRubric(A.teacher, A.essayId, {
      ...BAND_DRAFT,
      name: '國寫情意題評分原則（第二版）',
    });
    assert.equal(after.id, before.id);
    assert.equal(after.name, '國寫情意題評分原則（第二版）');
    assert.equal(after.bands.length, 3);
  });
});

await test('學生身分拿不到規準的描述文字', async () => {
  await asA(async () => {
    await assert.rejects(
      () => lib.loadRubricForGrading(A.student, A.essayId),
      (e) => e.status === 403 && /內部閱卷/.test(e.message),
    );
  });
});

await test('給學生看的投影裡一段描述文字都沒有', async () => {
  await asA(async () => {
    const full = await lib.loadRubricForAi(A.essayId);
    const notice = lib.rubricNoticeForStudent(full);
    const json = JSON.stringify(notice);
    for (const b of full.bands) {
      assert.ok(!json.includes(b.descriptor), `學生看得到等第 ${b.grade} 的描述`);
      assert.ok(!json.includes(b.descriptor.slice(0, 12)), '學生看得到描述的開頭');
    }
    assert.equal(notice.hasRubric, true);
    assert.equal(notice.totalScore, 25);
  });
});

await test('internalOnly 的規準匯不出去（丟例外，不是回空的）', async () => {
  await asA(async () => {
    const full = await lib.loadRubricForAi(A.essayId);
    assert.throws(
      () => lib.assertRubricExportable(full),
      (e) => e.status === 403 && /內部/.test(e.message),
    );
  });
});

await test('隔壁補習班的規準查不到（RLS）', async () => {
  await asB(async () => {
    assert.equal(await lib.loadRubricForAi(A.essayId), null);
  });
  // 反向也要驗：不然「兩邊都查不到」也會讓上面那一條通過。
  await asA(async () => {
    assert.ok(await lib.loadRubricForAi(A.essayId));
  });
});

// ── 二、AI 給建議 ────────────────────────────────────────────

section('AI 的建議');

await test('AI 給了建議，而分數還是 null', async () => {
  calls = [];
  script = [
    [
      { score: 18, rationale: GOOD_REASON, confidence: 0.7 },
      { score: 18, rationale: GOOD_REASON, confidence: 0.7 },
      { score: 19, rationale: GOOD_REASON, confidence: 0.7 },
    ],
  ];
  await asA(async () => {
    const out = await lib.proposeGrade(A.teacher, A.attemptId, A.essayId);
    assert.equal(out.state, 'PENDING');
    assert.equal(out.proposal.suggestedScore, 18);
    assert.equal(out.proposal.unstable, false);
    assert.ok(out.proposal.confidence > 0.5, `信心 ${out.proposal.confidence}`);
    assert.equal(out.proposal.rubricId, (await lib.loadRubricForAi(A.essayId)).id);
    assert.equal(out.proposal.promptVersion, '2026-07-30.1');

    // **這一條是整個功能的核心承諾。**
    const row = await raw.attemptAnswer.findFirst({
      where: { attemptId: A.attemptId, questionId: A.essayId },
    });
    assert.equal(row.earnedScore, null, 'AI 的建議變成了分數');
    assert.equal(row.scoreNote, null);
  });
  // 送出去的請求裡要有規準（沒有的話模型評的是另一件事）。
  assert.equal(calls.length, 1);
  assert.equal(calls[0].samples, 3);
  assert.ok(calls[0].rubric, '請求裡沒有規準');
  assert.equal(calls[0].rubric.bands.length, 3);
  assert.ok(calls[0].answer.includes('魚市場'));
});

await test('用量記到 AiUsageLog 與 AiBudgetCounter', async () => {
  await asA(async () => {
    const logs = await raw.aiUsageLog.findMany({ where: { tenantId: A.tenantId } });
    const mine = logs.filter((l) => l.purpose === 'GRADING');
    assert.ok(mine.length >= 1, '沒有記到用量');
    assert.equal(mine[0].refType, 'Attempt');
    assert.equal(mine[0].promptVersion, '2026-07-30.1');
    const counter = await raw.aiBudgetCounter.findMany({ where: { tenantId: A.tenantId } });
    assert.ok(counter.length === 1 && Number(counter[0].inputTokens) > 0);
  });
});

await test('通篇套語的評分被擋下來，而且被存起來', async () => {
  // 三次都是套語 → 重試用完 → BLOCKED。
  script = [[{ score: 18, rationale: GENERIC_REASON, confidence: 0.9 }]];
  await asA(async () => {
    const out = await lib.proposeGrade(A.teacher, A.otherAttemptId, A.essayId);
    assert.equal(out.state, 'BLOCKED');
    assert.match(out.blockedReason, /GENERIC_RATIONALE/);
    // **被擋下的建議留著**：那是唯一看得出 AI 準不準的資料。
    const row = await raw.answerGradeProposal.findFirst({
      where: { attemptId: A.otherAttemptId, questionId: A.essayId },
    });
    assert.ok(row, '被擋下的建議沒有存進去');
    assert.equal(row.state, 'BLOCKED');
    assert.ok(row.blockedReason && row.blockedReason.length > 10);
    // 分數當然還是 null。
    const ans = await raw.attemptAnswer.findFirst({
      where: { attemptId: A.otherAttemptId, questionId: A.essayId },
    });
    assert.equal(ans.earnedScore, null);
  });
});

await test('重試真的把上一次的違規講給模型聽', async () => {
  assert.ok(calls.length >= 4, `只呼叫了 ${calls.length} 次`);
  const retries = calls.filter((c) => c.retry > 0);
  assert.ok(retries.length >= 1, '沒有重試');
  assert.match(retries[0].violations, /GENERIC_RATIONALE/);
});

await test('三次評分差很多時標成「判斷不穩」並壓低信心', async () => {
  script = [
    [
      { score: 9, rationale: GOOD_REASON, confidence: 0.8 },
      { score: 14, rationale: GOOD_REASON, confidence: 0.8 },
      { score: 20, rationale: GOOD_REASON, confidence: 0.8 },
    ],
  ];
  await asA(async () => {
    const out = await lib.proposeGrade(A.teacher, A.attemptId, A.essayId);
    assert.equal(out.state, 'PENDING');
    assert.equal(out.proposal.suggestedScore, 14, '取的不是中位數那一份');
    assert.equal(out.proposal.unstable, true);
    assert.ok(out.proposal.confidence <= 0.4, `信心沒有被壓低：${out.proposal.confidence}`);
    assert.match(out.proposal.stabilityNote, /不穩|差/);
    // 存進資料庫的理由裡也帶得出那個記號（畫面少畫一次也看得到）。
    const row = await raw.answerGradeProposal.findFirst({
      where: { attemptId: A.attemptId, questionId: A.essayId },
    });
    assert.match(row.rationale, /^【AI 判斷不穩】/);
  });
});

await test('沒有規準也評得出來，但沒有逐面向的分數', async () => {
  script = [[{ score: 16, rationale: GOOD_REASON, confidence: 0.5 }]];
  await asA(async () => {
    await lib.deleteRubric(A.teacher, A.essayId);
    assert.equal(await lib.loadRubricForAi(A.essayId), null);
    const out = await lib.proposeGrade(A.teacher, A.attemptId, A.essayId);
    assert.equal(out.state, 'PENDING');
    assert.deepEqual(out.proposal.dimensions, []);
    assert.equal(out.proposal.rubricId, null);
    // 規準刪掉了，但已經產生的建議還在（採用率才算得出來）。
    const all = await raw.answerGradeProposal.findMany({ where: { tenantId: A.tenantId } });
    assert.ok(all.length >= 2);
    // 建回去，後面的測試要用。
    await lib.saveRubric(A.teacher, A.essayId, BAND_DRAFT);
  });
});

await test('自己發明面向的評分被擋下來（老師會以為那是他訂的標準）', async () => {
  script = [
    [
      {
        score: 18,
        rationale: GOOD_REASON,
        dimensions: [{ dimension_id: 'made-up', name: '創意', score: 18, max_score: 25, reason: '很有創意' }],
        confidence: 0.7,
      },
    ],
  ];
  await asA(async () => {
    const out = await lib.proposeGrade(A.teacher, A.attemptId, A.essayId);
    assert.equal(out.state, 'BLOCKED');
    assert.match(out.blockedReason, /UNKNOWN_DIMENSION|MISSING_DIMENSION/);
  });
});

await test('隔壁補習班的作答評不到（RLS）', async () => {
  script = [[{ score: 18, rationale: GOOD_REASON, confidence: 0.7 }]];
  await asB(async () => {
    await assert.rejects(
      () => lib.proposeGrade(B.teacher, A.attemptId, A.essayId),
      (e) => e.code === 'NOT_FOUND',
    );
  });
});

// ── 三、老師的決定 ──────────────────────────────────────────

section('老師的決定');

await test('先把這一份的建議恢復成可用的', async () => {
  script = [
    [
      { score: 18, rationale: GOOD_REASON, confidence: 0.7 },
      { score: 18, rationale: GOOD_REASON, confidence: 0.7 },
      { score: 18, rationale: GOOD_REASON, confidence: 0.7 },
    ],
  ];
  await asA(async () => {
    const out = await lib.proposeGrade(A.teacher, A.attemptId, A.essayId);
    assert.equal(out.state, 'PENDING');
    assert.equal(out.proposal.suggestedScore, 18);
  });
});

await test('改分沒有填理由會被擋（程式先擋，訊息看得懂）', async () => {
  await asA(async () => {
    await assert.rejects(
      () =>
        lib.decideProposal(A.teacher, {
          attemptId: A.attemptId,
          questionId: A.essayId,
          finalScore: 21,
        }),
      (e) => e.code === 'BAD_DECISION' && /為什麼/.test(e.message),
    );
    // 被擋下時**分數不可以被寫進去**。
    const row = await raw.attemptAnswer.findFirst({
      where: { attemptId: A.attemptId, questionId: A.essayId },
    });
    assert.equal(row.earnedScore, null);
  });
});

await test('老師改分：分數真的寫進去，帶著人工給分的記號', async () => {
  await asA(async () => {
    const out = await lib.decideProposal(A.teacher, {
      attemptId: A.attemptId,
      questionId: A.essayId,
      finalScore: 21,
      note: '第三段其實有回到那個場景，不該扣這麼多',
      weakDimensions: [],
    });
    assert.equal(out.proposal.state, 'ADJUSTED');
    assert.equal(out.proposal.finalScore, 21);
    assert.equal(out.proposal.decidedBy, A.teacher.id);
    assert.ok(out.proposal.decidedAt);

    const row = await raw.attemptAnswer.findFirst({
      where: { attemptId: A.attemptId, questionId: A.essayId },
    });
    assert.equal(row.earnedScore, 21);
    assert.match(row.scoreNote, /人工/, `scoreNote 少了人工給分的記號：${row.scoreNote}`);
    // 評語裡**不可以**有 AI 的理由原文（它可能引用規準的描述）。
    assert.ok(!row.scoreNote.includes(GOOD_REASON.slice(0, 20)));
    assert.match(row.scoreNote, /老師調整後給分/);

    // 總分跟著重算：客觀題 5 分 ＋ 作文 21 分。
    const attempt = await raw.attempt.findFirst({ where: { id: A.attemptId } });
    assert.equal(attempt.totalScore, 26);
    assert.equal(attempt.status, 'GRADED');
  });
});

await test('**重新計分不會蓋掉那個分數**', async () => {
  await asA(async () => {
    const re = await lib.gradeAttemptById(A.attemptId, {
      actorId: A.teacher.id,
      reason: 'e2e：確認人工分數不被覆蓋',
    });
    const row = await raw.attemptAnswer.findFirst({
      where: { attemptId: A.attemptId, questionId: A.essayId },
    });
    assert.equal(row.earnedScore, 21, '重新計分把老師給的分數蓋掉了');
    assert.equal(re.totalScore, 26);
    // 重算完之後那一題不算「還沒評」。
    assert.equal(re.pendingManual, 0);
  });
});

await test('採用建議不必填理由，而且記成 ACCEPTED', async () => {
  script = [
    [
      { score: 12, rationale: GOOD_REASON, confidence: 0.75 },
      { score: 12, rationale: GOOD_REASON, confidence: 0.75 },
      { score: 12, rationale: GOOD_REASON, confidence: 0.75 },
    ],
  ];
  await asA(async () => {
    // 上一次這一份是 BLOCKED，重評一次拿到可用的建議。
    const out = await lib.proposeGrade(A.teacher, A.otherAttemptId, A.essayId);
    assert.equal(out.state, 'PENDING');
    const d = await lib.decideProposal(A.teacher, {
      attemptId: A.otherAttemptId,
      questionId: A.essayId,
      finalScore: 12,
    });
    assert.equal(d.proposal.state, 'ACCEPTED');
    const row = await raw.attemptAnswer.findFirst({
      where: { attemptId: A.otherAttemptId, questionId: A.essayId },
    });
    assert.equal(row.earnedScore, 12);
    assert.match(row.scoreNote, /AI 提出建議、老師確認後給分/);
  });
});

await test('不採用要填理由，而且記得下「哪個面向評不準」', async () => {
  script = [
    [
      { score: 24, rationale: GOOD_REASON, confidence: 0.6 },
      { score: 24, rationale: GOOD_REASON, confidence: 0.6 },
      { score: 24, rationale: GOOD_REASON, confidence: 0.6 },
    ],
  ];
  await asA(async () => {
    await lib.proposeGrade(A.teacher, A.attemptId, A.essayId);
    const d = await lib.decideProposal(A.teacher, {
      attemptId: A.attemptId,
      questionId: A.essayId,
      finalScore: 15,
      dismissed: true,
      note: '它完全沒有看出第二段是抄的',
      weakDimensions: ['內容'],
    });
    assert.equal(d.proposal.state, 'REJECTED');
    assert.deepEqual(d.proposal.weakDimensions, ['內容']);
    assert.equal(d.proposal.decisionNote, '它完全沒有看出第二段是抄的');
    const row = await raw.attemptAnswer.findFirst({
      where: { attemptId: A.attemptId, questionId: A.essayId },
    });
    assert.equal(row.earnedScore, 15);
    assert.match(row.scoreNote, /未採用 AI 建議/);
  });
});

await test('超過配分的分數採用不了（走的是同一支 setManualScore）', async () => {
  await asA(async () => {
    await assert.rejects(
      () =>
        lib.decideProposal(A.teacher, {
          attemptId: A.attemptId,
          questionId: A.essayId,
          finalScore: 99,
          note: '亂給',
        }),
      (e) => /配分/.test(e.message),
    );
  });
});

await test('隔壁補習班的老師決定不了這一筆（RLS）', async () => {
  await asB(async () => {
    await assert.rejects(
      () =>
        lib.decideProposal(B.teacher, {
          attemptId: A.attemptId,
          questionId: A.essayId,
          finalScore: 10,
          note: '越權',
        }),
      (e) => e.code === 'NOT_FOUND',
    );
  });
});

// ── 四、資料庫那一層的擋阻 ──────────────────────────────────

section('資料庫的 CHECK');

await test('已決定的建議一定要有人與時間', async () => {
  await asA(async () => {
    const row = await raw.answerGradeProposal.findFirst({
      where: { attemptId: A.otherAttemptId, questionId: A.essayId },
    });
    await assert.rejects(
      () =>
        raw.answerGradeProposal.update({
          where: { id: row.id },
          data: { decidedBy: null, decidedAt: null },
        }),
      (e) => /decided_has_actor/.test(e.message),
    );
  });
});

await test('改分或不採用一定要填理由', async () => {
  await asA(async () => {
    const row = await raw.answerGradeProposal.findFirst({
      where: { attemptId: A.attemptId, questionId: A.essayId },
    });
    await assert.rejects(
      () =>
        raw.answerGradeProposal.update({ where: { id: row.id }, data: { decisionNote: '   ' } }),
      (e) => /change_has_note/.test(e.message),
    );
  });
});

await test('被擋下的建議一定要有理由', async () => {
  await asA(async () => {
    const row = await raw.answerGradeProposal.findFirst({
      where: { attemptId: A.attemptId, questionId: A.essayId },
    });
    await assert.rejects(
      () =>
        raw.answerGradeProposal.update({
          where: { id: row.id },
          data: {
            state: 'BLOCKED',
            blockedReason: null,
            decidedBy: null,
            decidedAt: null,
            finalScore: null,
            decisionNote: null,
          },
        }),
      (e) => /blocked_has_reason/.test(e.message),
    );
  });
});

await test('一份作答的一題只有一筆建議（重評是覆蓋，不是堆疊）', async () => {
  await asA(async () => {
    const rows = await raw.answerGradeProposal.findMany({
      where: { attemptId: A.attemptId, questionId: A.essayId },
    });
    assert.equal(rows.length, 1, `同一題堆了 ${rows.length} 筆建議`);
  });
});

// ── 五、老師的閱卷介面與準確度 ──────────────────────────────

section('批次閱卷與準確度');

await test('批次閱卷讀得出全班，而且最需要人看的排前面', async () => {
  await asA(async () => {
    const view = await lib.loadQuestionBatch(A.teacher, A.assignmentId, A.essayId);
    assert.equal(view.rows.length, 2);
    assert.equal(view.maxScore, 25);
    assert.ok(view.rubric, '老師這一側看得到規準');
    assert.ok(view.rows[0].answerText.includes('魚市場'));
    // 已決定的沉到最後：兩份都決定過了，所以只驗它們都在。
    assert.deepEqual(
      view.rows.map((r) => r.earnedScore).sort((a, b) => a - b),
      [12, 15],
    );
    for (const r of view.rows) assert.equal(r.manual, true);
  });
});

await test('非選題清單只列非選題，而且算得出進度', async () => {
  await asA(async () => {
    const items = await lib.nonObjectiveItems(A.assignmentId);
    assert.equal(items.length, 1, '客觀題混進了閱卷清單');
    assert.equal(items[0].questionId, A.essayId);
    assert.equal(items[0].hasRubric, true);
    assert.equal(items[0].total, 2);
    assert.equal(items[0].scored, 2);
    assert.equal(items[0].undecided, 0);
  });
});

await test('採用率、平均誤差、被改最多的面向都算得出來', async () => {
  await asA(async () => {
    const a = await lib.gradingAccuracy({ assignmentId: A.assignmentId });
    assert.equal(a.decided, 2);
    assert.equal(a.ACCEPTED, 1);
    assert.equal(a.REJECTED, 1);
    assert.equal(a.adoptionRate, 0.5);
    // 一筆誤差 0（採用），一筆 |15 − 24| = 9 → 平均 4.5
    assert.equal(a.mae, 4.5);
    assert.equal(a.worstDimensions[0].name, '內容');
    // 樣本太少時不下判斷。
    assert.equal(a.enough, false);
    assert.match(a.verdict, /還看不出/);
  });
});

await test('隔壁補習班的建議不會混進這家的採用率（RLS）', async () => {
  script = [
    [
      { score: 20, rationale: GOOD_REASON, confidence: 0.7 },
      { score: 20, rationale: GOOD_REASON, confidence: 0.7 },
      { score: 20, rationale: GOOD_REASON, confidence: 0.7 },
    ],
  ];
  await asB(async () => {
    await lib.saveRubric(B.teacher, B.essayId, BAND_DRAFT);
    await lib.proposeGrade(B.teacher, B.attemptId, B.essayId);
    await lib.decideProposal(B.teacher, {
      attemptId: B.attemptId,
      questionId: B.essayId,
      finalScore: 20,
    });
    const b = await lib.gradingAccuracy({});
    assert.equal(b.decided, 1, '乙補習班看到了甲補習班的決定');
    assert.equal(b.ACCEPTED, 1);
  });
  await asA(async () => {
    const a = await lib.gradingAccuracy({});
    assert.equal(a.decided, 2, '甲補習班看到了乙補習班的決定');
  });
  // 跨租戶看得到全部——這一條反過來確認上面兩條不是「兩邊都查不到」。
  await withoutTenantScope('AI 閱卷端到端：確認隔離不是「兩邊都查不到」', async () => {
    const all = await raw.answerGradeProposal.findMany({});
    assert.ok(all.length >= 3, `跨租戶只看到 ${all.length} 筆`);
  });
});

await test('全班一起評：已經決定過的不重評（重評會清掉老師的決定）', async () => {
  script = [
    [
      { score: 17, rationale: GOOD_REASON, confidence: 0.7 },
      { score: 17, rationale: GOOD_REASON, confidence: 0.7 },
      { score: 17, rationale: GOOD_REASON, confidence: 0.7 },
    ],
  ];
  await asA(async () => {
    const out = await lib.proposeGradesForQuestion(A.teacher, A.assignmentId, A.essayId);
    assert.equal(out.done, 0);
    assert.equal(out.skipped, 2, `跳過的份數不對：${JSON.stringify(out)}`);
    // 老師的決定還在。
    const rows = await raw.answerGradeProposal.findMany({ where: { questionId: A.essayId } });
    assert.ok(rows.every((r) => r.state === 'ACCEPTED' || r.state === 'REJECTED'));
  });
});

// ── 收尾 ────────────────────────────────────────────────────

server.close();
await raw.$disconnect?.();

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} 通過，${failed} 失敗\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
