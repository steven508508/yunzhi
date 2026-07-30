/**
 * 學習歷程輔助與面試準備對真的 Postgres 的端到端驗證。
 *
 * 件數與制度規則、防代寫閘門、結構回饋有 83 個單元測試
 * （apps/web/tests/portfolio.test.mjs、portfolioGuard.test.mjs、
 * interview.test.mjs、portfolioPrivacy.test.mjs）。**這一支不重複測
 * 它們。** 它驗的是跨越資料庫與 HTTP 邊界之後還對不對：
 *
 *   · **家長直接打 API 拿到的是 403**，不是「畫面上沒有連結」。
 *     這是規格書 §9.5 那條線唯一能被證明的方式
 *   · **老師沒有被分享時查不到任何內容**；學生分享之後查得到；
 *     **撤回之後又查不到**——撤回是把 id 從陣列裡拿掉，而那個陣列
 *     就是老師端的查詢條件
 *   · **老師在任何一支 API 上都拿不到 AI 對話紀錄與揭露聲明**。
 *     這一條與智慧老師相反，所以它最容易在日後被「統一一下」而破掉
 *   · **綜整心得不計入 10 件額度**在真的寫入路徑上也成立——十件多元
 *     表現加一份綜整心得，第十一件真的多元表現才被擋
 *   · **AI 層級超出時功能停用**（403），而不是「可以用但要標註」；
 *     沒有設定的班級一律停用；多班取最嚴的一級
 *   · **揭露聲明走的是閘門的另一條路**：它產得出來（不會無限重試），
 *     而且產出的內容對得回 `AiDisclosureLog` 的實際記錄
 *   · 自述的版本：存新版之後舊版留著、分享名單跟著新版走
 *   · 面試練習與一致性檢查落地，而且只有本人查得到
 *   · RLS：隔壁補習班的素材、自述、記錄與練習不會出現在這一家
 *
 * # 為什麼要在這裡再測一次「綜整心得不計入額度」
 *
 * 因為那是一個**寫入路徑**的決定。純函式那一層證明了 `countCentralUpload`
 * 算得對，但真正擋住學生的是 `addItem()` 裡的 `mayAddItem()`——中間隔著
 * 一次資料庫查詢（把既有的素材撈出來），而那次查詢漏掉一列或多撈一列
 * 的症狀，剛好就是件數算錯。
 *
 * # 為什麼用 pg-shim 而不是 PrismaClient
 *
 * 理由見 tools/pg-shim.mjs 的檔頭：Prisma 的查詢引擎要從外部網域下載，
 * 而這套系統要部署的補習班機房是封閉網段。shim 從同一份 schema 取得
 * 欄位對應，所以欄位名寫錯一樣會被抓到。
 *
 * 用法（只需要 Postgres，不需要 Redis、S3、AI 服務，也不需要網路）：
 *
 *   su postgres -c "psql -c \"CREATE ROLE yunzhi_pf LOGIN PASSWORD 'pfpw' CREATEDB\""
 *   su postgres -c "psql -c 'CREATE DATABASE yunzhi_pf OWNER yunzhi_pf'"
 *   su postgres -c "psql -d yunzhi_pf -c 'CREATE EXTENSION vector'"
 *   su postgres -c "psql -d yunzhi_pf -c 'CREATE EXTENSION pg_trgm'"
 *   DATABASE_URL=postgresql://yunzhi_pf:pfpw@127.0.0.1:5432/yunzhi_pf \
 *     npx prisma migrate deploy --schema packages/db/schema.prisma
 *   DATABASE_URL=postgresql://yunzhi_pf:pfpw@127.0.0.1:5432/yunzhi_pf \
 *     node tools/e2e-portfolio.mjs
 *
 * AI 服務不必起來：`generateWithGate()` 第一次就連不上時會往上拋，
 * 而這一支只在**揭露聲明**那一段需要它——那一段用的是退路版本
 * （`safeStatement()`，由程式組出來），所以連不上反而是要測的路徑之一。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import { createPgShim } from './pg-shim.mjs';
import { withTenant, withoutTenantScope } from '../apps/web/lib/tenantContext.mjs';
import { admissionYearOf } from '../apps/web/lib/admission.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'apps/web');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`   \x1b[32m✓\x1b[0m ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`   \x1b[31m✗\x1b[0m ${name}`);
    console.error(`     ${String(e.message).split('\n').slice(0, 12).join('\n     ')}`);
    failed += 1;
  }
}

function section(name) {
  console.log(`\n\x1b[1m── ${name}\x1b[0m`);
}

const HASH = '$2a$12$notarealhashnotarealhashnotarealhashnotarealhashnotar';

// ─────────────────────────────────────────────────────────────
// Prisma 替身的補丁
//
// `tools/pg-shim.mjs` 刻意只實作管線用到的語法，而且用到沒實作的東西時
// **直接拋錯而不是默默給錯的結果**（見它的檔頭：一個支援太多語法的
// ORM 替身，它給的綠燈比沒有測試更危險）。
//
// 這一支用到三種它沒有的：`upsert`、純量陣列的 `has`、以及 `select`
// 裡帶關聯。補在這裡而不是補進 pg-shim，理由與 e2e-predict 把 `upsert`
// 補在自己的 adapt() 裡相同：**那個檔案是所有 e2e 共用的替身，
// 它越通用，它與 Prisma 的實際行為分岐的機會就越大**——而分岐的那一天，
// 綠燈的是測試，壞掉的是產線。
// ─────────────────────────────────────────────────────────────

/**
 * 這一支用到的關聯，逐項列出來。
 *
 * 刻意寫死而不是從 DMMF 推導：推導出來的版本會支援每一種關聯，於是
 * 下一個人可以在正式程式碼裡寫任意深度的 `include`，而**只有這個替身
 * 撐得住，Prisma 的行為（N+1、排序、null 語意）不見得一樣**。
 * 列出來的好處是加一個關聯要有人動手，動手的時候會看到這段註解。
 */
const RELATIONS = {
  portfolioEssay: { user: { model: 'user', localKey: 'userId', foreignKey: 'id' } },
  interviewPractice: {
    question: { model: 'interviewQuestion', localKey: 'questionId', foreignKey: 'id' },
  },
  classMembership: { class: { model: 'class', localKey: 'classId', foreignKey: 'id' } },
  // 反向的一對一：政策掛在班級上，外鍵在政策那一側。
  class: { aiUsagePolicy: { model: 'aiUsagePolicy', localKey: 'id', foreignKey: 'classId' } },
  // 素材提示要接核心系統的能力分析。
  abilitySnapshot: {
    knowledgePoint: { model: 'knowledgePoint', localKey: 'knowledgePointId', foreignKey: 'id' },
  },
};

function adapt(base) {
  /** 帶關聯的查詢。遞迴，因為班級 → AI 層級是兩層。 */
  async function queryWithRelations(modelKey, args) {
    const relDefs = RELATIONS[modelKey] ?? {};
    const select = args.select ?? null;
    const relKeys = select ? Object.keys(select).filter((k) => relDefs[k] && select[k]) : [];

    // 純量陣列的 `has`：pg-shim 沒有這個運算子。把它從 where 拿掉，
    // 查完之後在 JS 這一側過濾——RLS 仍然在資料庫那一側生效，
    // 所以過濾的對象已經是這一家的資料。
    const where = { ...(args.where ?? {}) };
    const hasFilters = [];
    for (const [k, v] of Object.entries(where)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && 'has' in v) {
        hasFilters.push([k, v.has]);
        delete where[k];
      }
    }

    if (relKeys.length === 0 && hasFilters.length === 0) {
      return base[modelKey].findMany(args);
    }

    // 關聯的欄位不能進 select，但外鍵要進去（回填時要對得回來）。
    const scalarSelect = select ? {} : null;
    const added = [];
    if (select) {
      for (const [k, v] of Object.entries(select)) if (!relDefs[k]) scalarSelect[k] = v;
      for (const k of relKeys) {
        const lk = relDefs[k].localKey;
        if (!scalarSelect[lk]) {
          scalarSelect[lk] = true;
          added.push(lk);
        }
      }
      // `has` 過濾要用到的欄位同樣得取回來。
      for (const [k] of hasFilters) {
        if (!scalarSelect[k]) {
          scalarSelect[k] = true;
          added.push(k);
        }
      }
    }

    let rows = await base[modelKey].findMany({
      ...args,
      where,
      ...(scalarSelect ? { select: scalarSelect } : {}),
    });

    for (const [k, needle] of hasFilters) {
      rows = rows.filter((r) => Array.isArray(r[k]) && r[k].includes(needle));
    }

    for (const k of relKeys) {
      const def = relDefs[k];
      const sub = select[k] === true ? {} : select[k];
      const ids = [...new Set(rows.map((r) => r[def.localKey]).filter((v) => v != null))];
      let targets = [];
      if (ids.length > 0) {
        const subArgs = { where: { [def.foreignKey]: { in: ids } } };
        if (sub.select) {
          subArgs.select = { ...sub.select };
          if (!subArgs.select[def.foreignKey]) subArgs.select[def.foreignKey] = true;
        }
        targets = await queryWithRelations(def.model, subArgs);
      }
      const byKey = new Map(targets.map((t) => [t[def.foreignKey], t]));
      for (const r of rows) {
        const hit = byKey.get(r[def.localKey]) ?? null;
        if (hit && sub.select && !sub.select[def.foreignKey]) {
          const { [def.foreignKey]: _drop, ...rest } = hit;
          r[k] = rest;
        } else {
          r[k] = hit;
        }
      }
    }

    for (const r of rows) for (const a of added) delete r[a];
    return rows;
  }

  const proxy = new Proxy(base, {
    get(target, key) {
      if (key === '$transaction') {
        return (arg) => (typeof arg === 'function' ? arg(proxy) : Promise.all(arg));
      }
      const model = target[key];
      if (!model || typeof model !== 'object') return model;
      return new Proxy(model, {
        get(m, op) {
          if (op === 'upsert') {
            return async ({ where, create, update }) => {
              const flat = Object.values(where)[0];
              const k = flat && typeof flat === 'object' ? flat : where;
              const found = await m.findFirst({ where: k });
              if (found) return m.update({ where: { id: found.id }, data: update });
              return m.create({ data: create });
            };
          }
          if (op === 'findMany') {
            return (args = {}) => queryWithRelations(key, args);
          }
          return m[op];
        },
      });
    },
  });
  return proxy;
}

// ─────────────────────────────────────────────────────────────
// 把真的程式碼打包起來
// ─────────────────────────────────────────────────────────────

const outDir = mkdtempSync(path.join(ROOT, 'node_modules', '.yz-e2e-pf-'));

const shimPath = path.join(outDir, 'prisma-shim.mjs');
writeFileSync(shimPath, 'export const prisma = globalThis.__YZ_PF_PRISMA__;\n');

const authPath = path.join(outDir, 'auth-stub.mjs');
writeFileSync(
  authPath,
  [
    `import * as real from ${JSON.stringify(path.join(WEB, 'lib/auth.ts'))};`,
    'export const SESSION_COOKIE = real.SESSION_COOKIE;',
    'export const resolveRequestTenant = real.resolveRequestTenant;',
    'export const canEditSubject = real.canEditSubject;',
    'export const isHomeroomOf = real.isHomeroomOf;',
    'export async function requireUser() { return globalThis.__YZ_ACTOR__ ?? null; }',
    '',
  ].join('\n'),
);

const BANNER = [
  "import { createRequire as __cr } from 'node:module';",
  "import { fileURLToPath as __f } from 'node:url';",
  "import __p from 'node:path';",
  'const require = __cr(import.meta.url);',
  'const __filename = __f(import.meta.url);',
  'const __dirname = __p.dirname(__filename);',
].join('');

let bundleNo = 0;
async function bundle(entry) {
  const outfile = path.join(outDir, `b${bundleNo++}.mjs`);
  await build({
    entryPoints: [path.join(WEB, entry)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external: ['@prisma/client'],
    banner: { js: BANNER },
    alias: { '@/lib/prisma': shimPath, '@/lib/auth': authPath, '@': WEB },
    plugins: [
      {
        // 租戶脈絡不可以被打包進去：`tenantContext.mjs` 的
        // AsyncLocalStorage 是模組層級的單例，打包會複製出第二份。
        name: 'share-tenant-context',
        setup(b) {
          b.onResolve({ filter: /(^|\/)tenantContext\.mjs$/ }, () => ({
            path: pathToFileURL(path.join(WEB, 'lib/tenantContext.mjs')).href,
            external: true,
          }));
        },
      },
    ],
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
}

// ─────────────────────────────────────────────────────────────

const raw = createPgShim({
  connectionString: process.env.DATABASE_URL,
  schemaPath: 'packages/db/schema.prisma',
});
const prisma = adapt(raw);
globalThis.__YZ_PF_PRISMA__ = prisma;

const { NextRequest } = await import('next/dist/server/web/spec-extension/request.js');

const routes = {
  items: await bundle('app/api/portfolio/items/route.ts'),
  item: await bundle('app/api/portfolio/items/[itemId]/route.ts'),
  essays: await bundle('app/api/portfolio/essays/route.ts'),
  essay: await bundle('app/api/portfolio/essays/[essayId]/route.ts'),
  coach: await bundle('app/api/portfolio/coach/route.ts'),
  disclosure: await bundle('app/api/portfolio/disclosure/route.ts'),
  checklist: await bundle('app/api/portfolio/checklist/route.ts'),
  policy: await bundle('app/api/portfolio/policy/route.ts'),
  limits: await bundle('app/api/portfolio/limits/route.ts'),
  ivQuestions: await bundle('app/api/interview/questions/route.ts'),
  ivPractice: await bundle('app/api/interview/practice/route.ts'),
};

async function callAs(actor, handler, url, { params = {}, method = 'GET', json } = {}) {
  globalThis.__YZ_ACTOR__ = actor;
  const init = { method };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers = { 'content-type': 'application/json' };
  }
  const req = new NextRequest(`http://localhost${url}`, init);
  const res = await handler(req, { params: Promise.resolve(params) });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, text };
}

const asUser = (u) => ({
  id: u.id,
  tenantId: u.tenantId,
  username: u.username,
  displayName: u.displayName,
  systemRole: u.systemRole,
  mustChangePassword: false,
});

const YEAR = admissionYearOf();
const stamp = Date.now();

/**
 * AI 服務起來了沒有。
 *
 * **兩種情形都要能跑，而且兩種都在驗真的東西。**
 *
 *   · 沒起來：驗的是**退路**——揭露聲明仍然產得出來（它是及格線，
 *     AI 掛掉的那一天不可以變成他交不出揭露的那一天），而回饋這一支
 *     回 503 並說出「制度檢查不受影響」。
 *   · 起來了（`AI_PROVIDER=mock`）：驗的是**主線**——生成 → 閘門 →
 *     收下這一整圈走得完，而且模型產出的揭露聲明對得回實際記錄。
 *
 * 判定放在這裡而不是要求呼叫者傳旗標，是因為忘記傳的那一次會讓一整段
 * 斷言靜默地變成「另一種情形也成立」，而那正是這一支要防的事。
 */
const AI_URL = (process.env.AI_SERVICE_URL ?? 'http://ai:8000').replace(/\/+$/, '');
const AI_UP = await (async () => {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 2000);
    const r = await fetch(`${AI_URL}/healthz`, { signal: c.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
})();

// ── 種子 ─────────────────────────────────────────────────────

/**
 * 一家補習班：一位管理員、一位老師、一位「另一個老師」、兩位學生、
 * 一位家長，以及一個班。
 *
 * 兩家用同一個函式建，理由與 tools/e2e-predict.mjs 相同：兩邊的資料
 * 形狀一模一樣、只有 tenantId 不同，所以任何一列跨界出現在對方的
 * 結果裡都只可能是隔離漏了。
 */
async function seedTenant(spec) {
  const tenant = await withoutTenantScope('建立測試用的補習班', () =>
    raw.tenant.create({ data: { name: `${spec.tag} 學習歷程 e2e ${stamp}` } }),
  );

  return withTenant(tenant.id, async () => {
    const mk = (username, displayName, systemRole) =>
      prisma.user.create({
        data: {
          tenantId: tenant.id,
          username: `${spec.prefix}-${username}`,
          displayName,
          systemRole,
          passwordHash: HASH,
          status: 'ACTIVE',
        },
      });

    const admin = await mk('A01', `${spec.tag}的教務主任`, 'SCHOOL_ADMIN');
    const teacher = await mk('T01', `${spec.tag}的導師`, 'TEACHER');
    const other = await mk('T02', `${spec.tag}的另一位老師`, 'TEACHER');
    const guardian = await mk('G01', `${spec.tag}的家長`, 'GUARDIAN');
    const student = await mk('S01', `${spec.tag}的甲一`, 'STUDENT');
    const student2 = await mk('S02', `${spec.tag}的乙二`, 'STUDENT');

    const ay = await prisma.academicYear.create({
      data: { tenantId: tenant.id, name: `${spec.tag} ${YEAR}`, startDate: new Date(`${1911 + YEAR}-08-01`), endDate: new Date(`${1911 + YEAR + 1}-07-31`), isCurrent: false },
    });
    const klass = await prisma.class.create({
      data: { tenantId: tenant.id, academicYearId: ay.id, name: `${spec.tag} 三年甲班`, type: 'HOMEROOM' },
    });
    const klass2 = await prisma.class.create({
      data: { tenantId: tenant.id, academicYearId: ay.id, name: `${spec.tag} 數A加強班`, type: 'GROUP' },
    });
    for (const s of [student, student2]) {
      await prisma.classMembership.create({
        data: { classId: klass.id, userId: s.id, role: 'STUDENT', isHomeroom: false },
      });
    }
    await prisma.classMembership.create({
      data: { classId: klass2.id, userId: student.id, role: 'STUDENT', isHomeroom: false },
    });

    return { tenant, admin, teacher, other, guardian, student, student2, klass, klass2 };
  });
}

// ── 常用的請求 ───────────────────────────────────────────────

const getItems = (a) => callAs(asUser(a), routes.items.GET, `/api/portfolio/items?year=${YEAR}`);
const addItem = (a, json) =>
  callAs(asUser(a), routes.items.POST, '/api/portfolio/items', { method: 'POST', json });
const patchItem = (a, id, json) =>
  callAs(asUser(a), routes.item.PATCH, `/api/portfolio/items/${id}`, {
    method: 'PATCH',
    params: { itemId: id },
    json,
  });
const getEssays = (a) => callAs(asUser(a), routes.essays.GET, '/api/portfolio/essays');
const saveEssay = (a, json) =>
  callAs(asUser(a), routes.essays.POST, '/api/portfolio/essays', { method: 'POST', json });
const shareEssay = (a, id, teacherId, share) =>
  callAs(asUser(a), routes.essay.PATCH, `/api/portfolio/essays/${id}`, {
    method: 'PATCH',
    params: { essayId: id },
    json: { teacherId, share },
  });
const coach = (a, json) =>
  callAs(asUser(a), routes.coach.POST, '/api/portfolio/coach', { method: 'POST', json });
const getDisclosure = (a) => callAs(asUser(a), routes.disclosure.GET, '/api/portfolio/disclosure');
const makeStatement = (a, json = {}) =>
  callAs(asUser(a), routes.disclosure.POST, '/api/portfolio/disclosure', { method: 'POST', json });
const setPolicy = (a, json) =>
  callAs(asUser(a), routes.policy.POST, '/api/portfolio/policy', { method: 'POST', json });
const setLimits = (a, json) =>
  callAs(asUser(a), routes.limits.POST, '/api/portfolio/limits', { method: 'POST', json });
const runChecklist = (a, json) =>
  callAs(asUser(a), routes.checklist.POST, '/api/portfolio/checklist', { method: 'POST', json });
const ivQuestions = (a) =>
  callAs(asUser(a), routes.ivQuestions.GET, '/api/interview/questions?fieldTag=EECS');
const ivPractice = (a, json) =>
  callAs(asUser(a), routes.ivPractice.POST, '/api/interview/practice', { method: 'POST', json });
const ivHistory = (a) => callAs(asUser(a), routes.ivPractice.GET, '/api/interview/practice');

const diverse = (i, semester = '高二上') => ({
  category: 'DIVERSE_PERFORMANCE',
  itemCode: 'G',
  title: `社團活動 ${i}`,
  semester,
});

async function main() {
  const home = await seedTenant({ tag: '本家', prefix: `H${stamp}` });
  const nb = await seedTenant({ tag: '隔壁', prefix: `O${stamp}` });
  const { student, student2, teacher, other, guardian, admin, klass, klass2 } = home;

  // ═══════════════════════════════════════════════════════════
  section('一、隱私：家長在任何路徑下都讀不到');
  // ═══════════════════════════════════════════════════════════

  await withTenant(home.tenant.id, async () => {
    await test('★ 家長直接打素材 API 拿到 403，不是空清單', async () => {
      // 空清單會讓人以為「他看得到但目前沒有資料」，而那是錯的訊息。
      const r = await getItems(guardian);
      assert.equal(r.status, 403, r.text);
      assert.match(r.body.error, /家長/);
    });

    await test('★ 家長打自述 API 拿到 403', async () => {
      assert.equal((await getEssays(guardian)).status, 403);
      assert.equal((await saveEssay(guardian, { kind: 'MOTIVATION', body: 'x' })).status, 403);
    });

    await test('★ 家長打 AI 使用記錄 API 拿到 403', async () => {
      assert.equal((await getDisclosure(guardian)).status, 403);
      assert.equal((await makeStatement(guardian)).status, 403);
    });

    await test('★ 家長打面試練習 API 拿到 403', async () => {
      assert.equal((await ivHistory(guardian)).status, 403);
      assert.equal((await ivPractice(guardian, { questionId: 'x', answerText: 'y' })).status, 403);
    });

    await test('★ 家長打確認清單與回饋 API 拿到 403', async () => {
      assert.equal((await runChecklist(guardian, { programs: [] })).status, 403);
      assert.equal((await coach(guardian, { feature: 'WRITING_FEEDBACK' })).status, 403);
    });

    await test('403 的訊息說得出理由，而且指向他該去的那一頁', async () => {
      const r = await getItems(guardian);
      assert.match(r.body.error, /不希望家長看到/);
      assert.match(r.body.error, /孩子的狀況/);
    });
  });

  // ═══════════════════════════════════════════════════════════
  section('二、件數：綜整心得不計入 10 件額度');
  // ═══════════════════════════════════════════════════════════

  await withTenant(home.tenant.id, async () => {
    await test('十件多元表現存得進去', async () => {
      for (let i = 0; i < 10; i += 1) {
        const r = await addItem(student, diverse(i));
        assert.equal(r.status, 200, r.text);
      }
      const r = await getItems(student);
      const y = r.body.central.byYear.find((x) => x.year === 'G2');
      assert.equal(y.diverse.used, 10);
    });

    await test('★ 第十一件真的多元表現被擋，訊息說得出上限', async () => {
      const r = await addItem(student, diverse(99));
      assert.equal(r.status, 400, r.text);
      assert.match(r.body.error, /10/);
      assert.equal(r.body.code, 'OVER_LIMIT');
    });

    await test('★ 但綜整心得（N）加得進去——它不計入那 10 件', async () => {
      // **這一條是這個模組最多人搞錯的規則，而且它的失敗方向很惡劣：**
      // 擋掉的話，學生會刪掉一件真的多元表現去換綜整心得的位置。
      const r = await addItem(student, {
        category: 'DIVERSE_PERFORMANCE',
        itemCode: 'N',
        title: '多元表現綜整心得',
        semester: '高二上',
      });
      assert.equal(r.status, 200, r.text);
      const y = r.body.central.byYear.find((x) => x.year === 'G2');
      assert.equal(y.diverse.used, 10, '綜整心得被算進額度了');
      assert.equal(y.diverse.over, false);
      assert.equal(y.diverse.summaryExcluded, 1, '不印出來的話，學生數的檔案數會與系統對不起來');
    });

    await test('加了綜整心得之後，第十一件真的多元表現還是被擋', async () => {
      const r = await addItem(student, diverse(98));
      assert.equal(r.status, 400, r.text);
    });

    await test('換一個學年就重新算（件數是逐學年的）', async () => {
      const r = await addItem(student, diverse(0, '高三上'));
      assert.equal(r.status, 200, r.text);
      const y = r.body.central.byYear.find((x) => x.year === 'G3');
      assert.equal(y.diverse.used, 1);
    });

    await test('單件超過中央資料庫的容量上限，在上傳當下就被擋', async () => {
      const r = await addItem(student, {
        category: 'COURSE_OUTCOME',
        itemCode: 'B',
        title: '太大的報告',
        semester: '高三上',
        fileName: 'big.pdf',
        fileBytes: 5 * 1024 * 1024,
        fileKind: 'DOC',
      });
      assert.equal(r.status, 400, r.text);
      assert.match(r.body.error, /4MB/);
    });

    await test('個申勾選的上限是逐校系算的', async () => {
      const items = (await getItems(student)).body.items.filter(
        (i) => i.category === 'DIVERSE_PERFORMANCE' && i.itemCode === 'G',
      );
      for (const it of items.slice(0, 3)) {
        assert.equal((await patchItem(student, it.id, { selectedFor: ['001'] })).status, 200);
      }
      const r = await getItems(student);
      const p = r.body.selected.byProgram.find((x) => x.programRef === '001');
      assert.equal(p.diverse.used, 3);
      assert.equal(p.diverse.over, false);
    });

    await test('學生改不到別人的素材（RLS 擋得住別家，擋不住隔壁同學）', async () => {
      const mine = (await getItems(student)).body.items[0];
      const r = await patchItem(student2, mine.id, { title: '我改的' });
      assert.equal(r.status, 404, r.text);
    });
  });

  // ═══════════════════════════════════════════════════════════
  section('三、上限是資料：沒有建檔時要標出來');
  // ═══════════════════════════════════════════════════════════

  await withTenant(home.tenant.id, async () => {
    await test('沒有建檔時 isDefault 是 true，而且沒有來源', async () => {
      const r = await getItems(student);
      assert.equal(r.body.limits.isDefault, true);
      assert.equal(r.body.limits.sourceRef, null);
    });

    await test('★ 建檔時沒填來源會被擋——這幾個數字錯了會擋住學生', async () => {
      const r = await setLimits(admin, { year: YEAR, sourceRef: '', diversePerYear: 8 });
      assert.equal(r.status, 400, r.text);
    });

    await test('老師改不了上限（影響全校，只有校務管理員能改）', async () => {
      const r = await setLimits(teacher, {
        year: YEAR,
        sourceRef: `${YEAR} 簡章第 42 頁`,
        diversePerYear: 8,
      });
      assert.equal(r.status, 403, r.text);
    });

    await test('管理員建檔之後，件數改用新的上限算', async () => {
      const r = await setLimits(admin, {
        year: YEAR,
        sourceRef: `${YEAR} 學年度簡章總則第 42 頁`,
        diversePerYear: 8,
      });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.isDefault, false);
      assert.equal(r.body.diversePerYear, 8);

      const now = await getItems(student);
      const y = now.body.central.byYear.find((x) => x.year === 'G2');
      assert.equal(y.diverse.max, 8);
      assert.equal(y.diverse.over, true, '上限調小之後，本來合格的變成超過');
    });

    await test('本來就超過時，學生不會被鎖死在動不了的狀態', async () => {
      // 他要做的第一件事可能正是把一件換成另一件。
      const r = await addItem(student, diverse(0, '高一上'));
      assert.equal(r.status, 200, r.text);
    });

    await test('把上限改回去', async () => {
      const r = await setLimits(admin, {
        year: YEAR,
        sourceRef: `${YEAR} 學年度簡章總則第 42 頁`,
        diversePerYear: 10,
      });
      assert.equal(r.status, 200, r.text);
    });
  });

  // ═══════════════════════════════════════════════════════════
  section('四、自述：版本、分享、撤回');
  // ═══════════════════════════════════════════════════════════

  let essayId = null;

  await withTenant(home.tenant.id, async () => {
    await test('存三份自述，版本從 1 開始', async () => {
      for (const [kind, body] of [
        ['REFLECTION', '我在高一的時候還不知道自己要做什麼。'],
        ['MOTIVATION', '我想讀這個系是因為高二的一次專題。'],
        ['PLAN', '我打算在大一先把基礎的程式課修完。'],
      ]) {
        const r = await saveEssay(student, { kind, body });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.body.essay.version, 1);
      }
      const r = await getEssays(student);
      assert.equal(r.body.essays.length, 3);
      essayId = r.body.essays.find((e) => e.kind === 'MOTIVATION').id;
    });

    await test('★ 存新版本時舊版留著（回頭看三個月前怎麼想的）', async () => {
      const r = await saveEssay(student, {
        kind: 'MOTIVATION',
        body: '我想讀這個系是因為高二下那次專題，那時候我第一次自己把一個東西做出來。',
      });
      assert.equal(r.body.essay.version, 2);
      const all = await prisma.portfolioEssay.findMany({
        where: { userId: student.id, kind: 'MOTIVATION' },
      });
      assert.equal(all.length, 2);
      assert.equal(all.filter((e) => e.isCurrent).length, 1, '同時有兩份 current');
      essayId = all.find((e) => e.isCurrent).id;
    });

    await test('制度檢查跟著自述走：三個子項齊了就過', async () => {
      const r = await getEssays(student);
      const selfChecks = r.body.ruleChecks.filter((c) => c.code.startsWith('SELF_'));
      assert.equal(selfChecks.length, 3);
      assert.ok(selfChecks.every((c) => c.ok));
    });

    await test('★ 老師沒有被分享時，查不到任何內容', async () => {
      const r = await getEssays(teacher);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.role, 'STAFF');
      assert.deepEqual(r.body.shared, []);
    });

    await test('學生分享之後，那位老師查得到', async () => {
      const r = await shareEssay(student, essayId, teacher.id, true);
      assert.equal(r.status, 200, r.text);
      const t = await getEssays(teacher);
      assert.equal(t.body.shared.length, 1);
      assert.equal(t.body.shared[0].authorName, student.displayName);
      assert.match(t.body.shared[0].body, /高二下那次專題/);
    });

    await test('★ 沒有被分享的那位老師還是查不到', async () => {
      const r = await getEssays(other);
      assert.deepEqual(r.body.shared, []);
    });

    await test('★ 老師拿到的形狀裡沒有 AI 對話、揭露聲明、或分享名單', async () => {
      // 規格書 §9.5：「AI 對話紀錄僅學生本人可見，老師連摘要都看不到」。
      // 這一條與智慧老師相反，所以它最容易被「統一一下」而破掉。
      const t = await getEssays(teacher);
      assert.deepEqual(Object.keys(t.body.shared[0]).sort(), [
        'authorName',
        'body',
        'charCount',
        'id',
        'kind',
        'updatedAt',
      ]);
      const json = JSON.stringify(t.body);
      for (const banned of ['sharedWith', 'disclosure', 'statement', 'natureNote', 'aiLevel']) {
        assert.ok(!json.includes(banned), `老師的 payload 裡出現了 ${banned}`);
      }
    });

    await test('★ 撤回之後，那位老師立刻查不到', async () => {
      assert.equal((await shareEssay(student, essayId, teacher.id, false)).status, 200);
      const t = await getEssays(teacher);
      assert.deepEqual(t.body.shared, []);
    });

    await test('★ 存新版本時分享名單要繼承，否則每存一次就等於撤回', async () => {
      await shareEssay(student, essayId, teacher.id, true);
      const r = await saveEssay(student, {
        kind: 'MOTIVATION',
        body: '我想讀這個系是因為高二下那次專題，那時候我第一次自己把一個東西從無到有做出來。',
      });
      assert.equal(r.body.essay.version, 3);
      const t = await getEssays(teacher);
      assert.equal(t.body.shared.length, 1, '存了新版之後老師看不到了——他不會知道被撤回了');
      assert.match(t.body.shared[0].body, /從無到有/);
      essayId = (await getEssays(student)).body.essays.find((e) => e.kind === 'MOTIVATION').id;
    });

    await test('學生分享不了別人的自述', async () => {
      const r = await shareEssay(student2, essayId, teacher.id, true);
      assert.equal(r.status, 404, r.text);
    });

    await test('分享給一個不是老師的人會被擋', async () => {
      const r = await shareEssay(student, essayId, student2.id, true);
      assert.equal(r.status, 404, r.text);
    });
  });

  // ═══════════════════════════════════════════════════════════
  section('五、AI 使用層級：超出的功能停用');
  // ═══════════════════════════════════════════════════════════

  await withTenant(home.tenant.id, async () => {
    await test('★ 沒有設定層級時，撰寫回饋是停用的（不是「可以用但要標註」）', async () => {
      const r = await coach(student, { feature: 'WRITING_FEEDBACK' });
      assert.equal(r.status, 403, r.text);
      assert.equal(r.body.code, 'AI_DISABLED');
      assert.match(r.body.error, /還沒有設定/);
      assert.match(r.body.error, /老師/);
    });

    await test('老師設定第 1 級之後，撰寫回饋仍然停用而且訊息換一句', async () => {
      assert.equal((await setPolicy(teacher, { classId: klass.id, level: 1 })).status, 200);
      assert.equal((await setPolicy(teacher, { classId: klass2.id, level: 4 })).status, 200);
      const r = await coach(student, { feature: 'WRITING_FEEDBACK' });
      assert.equal(r.status, 403, r.text);
      assert.match(r.body.error, /第 1 級/);
      assert.match(r.body.error, /事前明定/);
    });

    await test('★ 多個班級取最嚴的一級（第 1 級與第 4 級 → 第 1 級）', async () => {
      // 取最寬的話，學生只要另外加入一個第 4 級的班，那位設第 1 級的
      // 老師的決定就整組失效——而他不會知道。
      const d = await getDisclosure(student);
      assert.equal(d.body.level, 1);
      assert.equal(d.body.classes.length, 2);
    });

    await test('★ 第 2 級開素材提示，但撰寫回饋仍然停用', async () => {
      await setPolicy(teacher, { classId: klass.id, level: 2 });
      await setPolicy(teacher, { classId: klass2.id, level: 2 });
      const w = await coach(student, { feature: 'WRITING_FEEDBACK' });
      assert.equal(w.status, 403, w.text);
      assert.equal(w.body.code, 'AI_DISABLED');

      // 素材提示這一支會走到 AI 服務。**403 與 503 的差別就是這一條
      // 在驗的**：403 是老師的決定（AI_DISABLED），503 是機器的問題
      // （AI_DOWN），兩句話對學生完全不同——前者要他去問老師，
      // 後者要他等一下再試。折成同一個狀態碼的話，他會去問老師一件
      // 老師處理不了的事。
      const m = await coach(student, { feature: 'MATERIAL_HINT' });
      if (AI_UP) {
        assert.equal(m.status, 200, m.text);
        assert.equal(m.body.feature, 'MATERIAL_HINT');
      } else {
        assert.equal(m.status, 503, m.text);
        assert.equal(m.body.code, 'AI_DOWN');
        assert.match(m.body.error, /制度檢查/);
      }
    });

    await test('第 3 級開撰寫回饋，選件討論仍然要第 4 級', async () => {
      await setPolicy(teacher, { classId: klass.id, level: 3 });
      await setPolicy(teacher, { classId: klass2.id, level: 3 });
      const r = await coach(student, { feature: 'WRITING_FEEDBACK' });
      assert.equal(r.status, AI_UP ? 200 : 503, r.text);
      const s = await coach(student, { feature: 'SELECTION_DISCUSS' });
      assert.equal(s.status, 403, s.text);
      assert.equal(s.body.code, 'AI_DISABLED');
    });

    await test('層級只有老師改得動，學生改不了', async () => {
      const r = await setPolicy(student, { classId: klass.id, level: 4 });
      assert.equal(r.status, 403, r.text);
    });

    await test('層級 1 到 4 之外的值被擋', async () => {
      assert.equal((await setPolicy(teacher, { classId: klass.id, level: 5 })).status, 400);
      assert.equal((await setPolicy(teacher, { classId: klass.id, level: 0 })).status, 400);
    });
  });

  // ═══════════════════════════════════════════════════════════
  section('六、揭露聲明：走的是閘門的另一條路');
  // ═══════════════════════════════════════════════════════════

  await withTenant(home.tenant.id, async () => {
    // 前面那幾段跑過的功能會不會留下記錄，取決於 AI 服務起來了沒有。
    // 所以這一段一律用**差值**斷言，不用絕對值——寫死絕對值的話，
    // 這一支在兩種環境下只有一種會綠，而那時候沒有人分得出是哪一種
    // 情形壞了。
    let before = { total: 0, feedback: 0 };

    await test('先造幾筆真的 AI 使用記錄', async () => {
      const b = await getDisclosure(student);
      before = { total: b.body.total, feedback: b.body.counts.WRITING_FEEDBACK ?? 0 };
      for (let i = 0; i < 3; i += 1) {
        await prisma.aiDisclosureLog.create({
          data: {
            tenantId: home.tenant.id,
            userId: student.id,
            feature: 'WRITING_FEEDBACK',
            essayId,
            natureNote: '請 AI 看過自述草稿，指出哪裡不夠具體',
            aiLevel: 3,
          },
        });
      }
      const d = await getDisclosure(student);
      assert.equal(d.body.total, before.total + 3);
      assert.equal(d.body.counts.WRITING_FEEDBACK, before.feedback + 3);
    });

    await test('★ 揭露聲明產得出來——它不會被自己的閘門無限重試', async () => {
      // **這是規格書 §13 點名的陷阱。** 聲明本身就是一段五十幾字的
      // 連續第一人稱敘述，走防代寫閘門的話這一支會永遠轉圈。
      //
      // 兩種情形都要成立而且都在驗真的東西：AI 起來的時候驗的是
      // 「生成 → 走另一組規則 → 收下」這一整圈；AI 沒起來的時候驗的是
      // 退路——**揭露是及格線，AI 掛掉的那一天不可以變成他交不出
      // 揭露的那一天**（見 portfolioDb 的 fallbackOnUpstreamFailure）。
      const r = await makeStatement(student);
      assert.equal(r.status, 200, r.text);
      assert.ok(r.body.made.generated.length > 10);
      assert.equal(r.body.made.blockedDrafts, 0, `聲明被自己那一組規則擋了 ${r.body.made.blockedDrafts} 次`);
      if (!AI_UP) assert.equal(r.body.made.fellBack, true, 'AI 沒起來，應該用退路版本');
    });

    await test('★ 產出的聲明對得回記錄：有撰寫回饋就要講出來', async () => {
      const r = await getDisclosure(student);
      const s = r.body.statements[0].generated;
      assert.match(s, /本人/);
      assert.match(s, /回饋/, '記錄裡有三次撰寫回饋，而聲明沒有提到');
      assert.match(s, /未使用\s*AI\s*生成內容/);
      // 而且它不可以宣稱完全沒用過。
      assert.ok(!/未使用\s*AI\s*輔助工具/.test(s), '記錄裡有互動，聲明卻說沒用過');
    });

    await test('產生聲明這件事本身也被記了一筆（稽核要完整）', async () => {
      // 記錄要完整，聲明才可以只講該講的——`MUST_DISCLOSE` 刻意不含
      // 這一項（理由在 portfolioGuard.mjs），但那是「不寫進聲明」，
      // 不是「不記錄」。
      const r = await getDisclosure(student);
      assert.equal(r.body.counts.DISCLOSURE_STATEMENT, 1);
      assert.equal(r.body.total, before.total + 3 + 1);
    });

    await test('學生可以編輯聲明，而原始的版本留著', async () => {
      const before = (await getDisclosure(student)).body.statements[0];
      const r = await makeStatement(student, {
        statementId: before.id,
        edited: `${before.generated}（本人已逐項確認）`,
      });
      assert.equal(r.status, 200, r.text);
      const after = r.body.statements.find((s) => s.id === before.id);
      assert.equal(after.generated, before.generated, '原始版本被蓋掉了');
      assert.match(after.edited, /逐項確認/);
    });

    await test('★ 記錄改不動：沒有任何一支 API 可以刪或改 AiDisclosureLog', async () => {
      // 它是揭露聲明的事實基礎。可以改的話，聲明就不是揭露而是宣稱。
      assert.equal(routes.disclosure.DELETE, undefined);
      assert.equal(routes.disclosure.PATCH, undefined);
      assert.equal(routes.disclosure.PUT, undefined);
    });

    await test('★ 老師打不到 AI 使用記錄那一支（連摘要都看不到）', async () => {
      const r = await getDisclosure(teacher);
      assert.equal(r.status, 403, r.text);
      assert.match(r.body.error, /學生自己的/);
    });

    await test('★ 學生看不到別人的 AI 記錄', async () => {
      const r = await getDisclosure(student2);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.total, 0);
    });

    await test('★ 第 1 級的學生產生聲明時完全不呼叫模型', async () => {
      // 這一級的學生依定義不可能有任何一次模型互動，而他的聲明內容就是
      // 「未使用」——一句由程式組得出來的話。為了產生它去呼叫模型，
      // 等於讓一位被明定不得使用 AI 的學生產生一次 AI 互動，
      // 而那次互動還會被記進他自己的揭露記錄裡。
      await setPolicy(teacher, { classId: klass.id, level: 1 });
      const r = await makeStatement(student2);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.made.fellBack, true, `AI ${AI_UP ? '起來了' : '沒起來'}，但第 1 級不該呼叫它`);
      assert.match(r.body.made.generated, /未使用\s*AI\s*輔助工具/);
      await setPolicy(teacher, { classId: klass.id, level: 3 });
    });
  });

  // ═══════════════════════════════════════════════════════════
  section('七、送出前的確認清單');
  // ═══════════════════════════════════════════════════════════

  await withTenant(home.tenant.id, async () => {
    await test('混搭與沒選上傳方式都是阻斷項', async () => {
      const r = await runChecklist(student, {
        programs: [
          { programRef: '001', name: '甲系', mode: 'MIXED', deadline: '2026-05-10' },
          { programRef: '002', name: '乙系', mode: null, deadline: null },
        ],
      });
      assert.equal(r.status, 200, r.text);
      const by = Object.fromEntries(r.body.items.map((c) => [c.code, c]));
      assert.equal(by.MODE_NOT_MIXED.ok, false);
      assert.equal(by.MODE_NOT_MIXED.severity, 'BLOCK');
      assert.equal(by.MODE_CHOSEN.ok, false);
      assert.equal(by.DEADLINE_KNOWN.ok, false);
      assert.equal(by.DEADLINE_KNOWN.severity, 'WARN');
      assert.ok(r.body.blocking >= 2);
    });

    await test('「送出確認後不得修改」一定在清單上', async () => {
      const r = await runChecklist(student, { programs: [] });
      const irr = r.body.items.find((c) => c.code === 'IRREVERSIBLE');
      assert.ok(irr);
      assert.equal(irr.severity, 'INFO');
    });

    await test('清單用的是真的素材與自述（不是前端傳來的數字）', async () => {
      const r = await runChecklist(student, {
        programs: [{ programRef: '001', mode: 'CENTRAL', deadline: '2026-05-10' }],
      });
      const central = r.body.items.find((c) => c.code === 'COUNT_CENTRAL');
      assert.match(central.detail, /高二/);
      assert.match(central.detail, /綜整心得/);
      const selfO = r.body.items.find((c) => c.code === 'SELF_O');
      assert.equal(selfO.ok, true);
    });
  });

  // ═══════════════════════════════════════════════════════════
  section('八、面試：題庫、結構回饋、一致性檢查');
  // ═══════════════════════════════════════════════════════════

  let questionId = null;

  await withTenant(home.tenant.id, async () => {
    await test('第一次進來會把內建題庫匯入，而且只匯入一次', async () => {
      const a = await ivQuestions(student);
      assert.equal(a.status, 200, a.text);
      assert.ok(a.body.questions.length > 0);
      const n1 = await prisma.interviewQuestion.count({ where: { tenantId: home.tenant.id } });
      await ivQuestions(student2);
      const n2 = await prisma.interviewQuestion.count({ where: { tenantId: home.tenant.id } });
      assert.equal(n1, n2, '第二次進來又匯入了一份，題庫會變兩倍');
      questionId = a.body.questions[0].id;
    });

    await test('依校系類型過濾時，通用題也會出現', async () => {
      const a = await ivQuestions(student);
      assert.ok(a.body.questions.some((q) => q.fieldTag === 'GENERAL'));
      assert.ok(a.body.questions.every((q) => ['EECS', 'GENERAL'].includes(q.fieldTag)));
    });

    await test('練習一題，拿到結構回饋而且回饋裡沒有任何評價', async () => {
      const r = await ivPractice(student, {
        questionId,
        answerText:
          '是高二上那個自走車。卡最久的是感測器的雜訊，讀值一直跳。' +
          '後來我把取樣改成平均十次，花了兩個禮拜才穩定下來，最後在成果展上拿到第三名。',
      });
      assert.equal(r.status, 200, r.text);
      const fb = r.body.feedback;
      assert.deepEqual(Object.keys(fb).sort(), [
        'addressed',
        'contradictions',
        'examples',
        'length',
        'questions',
      ]);
      assert.equal('score' in fb, false);
      const all = JSON.stringify(fb);
      assert.ok(!/很好|不錯|優秀|展現了/.test(all), `回饋裡出現了內容評價：${all.slice(0, 200)}`);
      assert.ok(fb.questions.every((q) => /[？?]/.test(q)));
    });

    await test('★ 一致性檢查：講了檔案裡沒有的東西要被指出來', async () => {
      const r = await ivPractice(student, {
        questionId,
        answerText: '我在天文社辦過三次觀星活動，那次的全國物理競賽也讓我學到很多。',
      });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.consistency.ok, false);
      assert.ok(r.body.consistency.unmatched.length > 0);
      assert.match(r.body.consistency.note, /不一定有問題/);
    });

    await test('練習有落地，而且 feedback 與 consistency 都存下來了', async () => {
      const rows = await prisma.interviewPractice.findMany({ where: { userId: student.id } });
      assert.ok(rows.length >= 2);
      assert.ok(rows[0].feedback);
      assert.ok(rows[0].consistency);
    });

    await test('★ 練習紀錄只有本人查得到', async () => {
      const mine = await ivHistory(student);
      assert.ok(mine.body.practices.length >= 2);
      const theirs = await ivHistory(student2);
      assert.equal(theirs.body.practices.length, 0);
      // 老師連這一支都打不到。
      assert.equal((await ivHistory(teacher)).status, 403);
    });

    await test('空的回答被擋', async () => {
      assert.equal((await ivPractice(student, { questionId, answerText: '   ' })).status, 400);
    });
  });

  // ═══════════════════════════════════════════════════════════
  section('九、租戶隔離');
  // ═══════════════════════════════════════════════════════════

  await withTenant(nb.tenant.id, async () => {
    await test('隔壁的學生也放幾件素材與一份自述', async () => {
      assert.equal((await addItem(nb.student, diverse(0))).status, 200);
      assert.equal(
        (await saveEssay(nb.student, { kind: 'MOTIVATION', body: '隔壁的動機。' })).status,
        200,
      );
      await prisma.aiDisclosureLog.create({
        data: {
          tenantId: nb.tenant.id,
          userId: nb.student.id,
          feature: 'WRITING_FEEDBACK',
          natureNote: '隔壁的互動',
          aiLevel: 3,
        },
      });
    });
  });

  await withTenant(home.tenant.id, async () => {
    await test('本家的學生看不到隔壁的素材', async () => {
      const r = await getItems(student);
      assert.ok(r.body.items.every((i) => !i.title.includes('隔壁')));
    });

    await test('本家的老師看不到隔壁分享的自述', async () => {
      await withTenant(nb.tenant.id, async () => {
        const e = (await getEssays(nb.student)).body.essays[0];
        await shareEssay(nb.student, e.id, nb.teacher.id, true);
      });
      const t = await getEssays(teacher);
      assert.ok(t.body.shared.every((s) => !s.body.includes('隔壁')));
    });

    await test('本家的學生改不到隔壁的素材', async () => {
      const theirs = await withTenant(nb.tenant.id, () =>
        prisma.portfolioItem.findMany({ where: { userId: nb.student.id } }),
      );
      assert.ok(theirs.length > 0);
      const r = await patchItem(student, theirs[0].id, { title: '我改的' });
      assert.equal(r.status, 404, r.text);
    });
  });

  await test('★ 六張表的每一家都只看得到自己的（RLS 濾掉的，不是表裡只有那幾列）', async () => {
    for (const table of [
      'portfolioItem',
      'portfolioEssay',
      'aiDisclosureLog',
      'aiDisclosureStatement',
      'interviewQuestion',
      'interviewPractice',
    ]) {
      for (const [t, tag] of [
        [home.tenant.id, '本家'],
        [nb.tenant.id, '隔壁'],
      ]) {
        const scoped = await withTenant(t, () => prisma[table].findMany({}));
        const direct = await withoutTenantScope('驗證兩家的資料都在同一張表裡', () =>
          raw[table].findMany({ where: { tenantId: t } }),
        );
        assert.equal(scoped.length, direct.length, `${tag} 的 ${table} 筆數對不上`);
        assert.ok(scoped.every((r) => r.tenantId === t), `${tag} 在 ${table} 看到了別家的列`);
      }
    }
  });

  await test('★ AiUsagePolicy 與 PortfolioLimitSet 也受 RLS 保護', async () => {
    for (const table of ['aiUsagePolicy', 'portfolioLimitSet']) {
      const home_ = await withTenant(home.tenant.id, () => prisma[table].findMany({}));
      assert.ok(home_.every((r) => r.tenantId === home.tenant.id), `${table} 洩漏了`);
    }
  });
}

main()
  .catch((e) => {
    console.error('\n端到端測試本身出錯：', e);
    failed += 1;
  })
  .finally(async () => {
    await raw.$disconnect().catch(() => {});
    rmSync(outDir, { recursive: true, force: true });
    console.log(`\n${passed} 通過，${failed} 失敗`);
    process.exit(failed > 0 ? 1 : 0);
  });
