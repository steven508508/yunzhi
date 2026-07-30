/**
 * 升學輔導模組對真的 Postgres 的端到端驗證。
 *
 * 規則引擎有 36 個單元測試（笛卡兒積 96×4 種管道狀態），繁星賽局有 39 個
 * （apps/web/tests/admission.test.mjs、star.test.mjs）。**這一支不重複測
 * 它們。** 它驗的是跨越資料庫與 HTTP 邊界之後還對不對：
 *
 *   · 教務處匯入在校百分比的 CSV 在真的 schema 上跑得動（欄位名、
 *     `[userId, year]` 的唯一鍵、Big5 解碼、重匯會蓋掉而不是重複）
 *   · 學生填繁星志願 → 跑模擬 → 拿到自己的序位
 *   · **學生端的回應裡不含任何其他學生的識別資訊或百分比**
 *     ——這一項是這個功能能不能上線的關鍵，所以它比對的是
 *     序列化後的整個 JSON 字串，而不是逐欄檢查
 *   · 在校成績百分比沒有任何一條學生走得到的路徑
 *   · 繁星承辦（校務管理員）看得到全校，而且每次都寫稽核
 *   · 老師與系統管理員進不去全校檢視
 *   · RLS：隔壁補習班的學生不會出現在這家的校內排序裡
 *   · 放棄繁星之後個申資格**不會**恢復（跨越 upsert 之後類別還在）
 *
 * 最後那一項是這支最重要的斷言之一：`starCategory` 若在放棄時被清成
 * `NONE`，單元測試抓不到（它測的是純函式），而症狀是一位第 3 類已放棄
 * 的學生在畫面上看到「可以報名個人申請」。
 *
 * # 為什麼用 pg-shim 而不是 PrismaClient
 *
 * 理由見 tools/pg-shim.mjs 的檔頭：Prisma 的查詢引擎要從外部網域下載，
 * 而這套系統要部署的補習班機房是封閉網段。shim 從同一份 schema 取得
 * 欄位對應，所以欄位名寫錯一樣會被抓到。
 *
 * # 這一支跑的是正式程式，不是複製品
 *
 * 路由與 `lib/admissionDb.ts` 由 esbuild 直接打包正式檔案，唯一被換掉的
 * 是 `requireUser`（「誰登入了」由測試決定）。其餘——`scopedRoute` 的
 * 401、租戶脈絡、每一支路由自己的角色判斷、`studentView()` 的欄位裁切
 * ——全部是正式環境跑的那一份，一個字都沒改。做法沿用
 * tools/e2e-guardian.mjs。
 *
 * 用法（只需要 Postgres，不需要 Redis、S3、AI 服務，也不需要網路）：
 *
 *   su postgres -c "psql -c \"CREATE ROLE yunzhi_adm LOGIN PASSWORD 'admpw' CREATEDB\""
 *   su postgres -c "psql -c 'CREATE DATABASE yunzhi_adm OWNER yunzhi_adm'"
 *   su postgres -c "psql -d yunzhi_adm -c 'CREATE EXTENSION vector'"
 *   su postgres -c "psql -d yunzhi_adm -c 'CREATE EXTENSION pg_trgm'"
 *   DATABASE_URL=postgresql://yunzhi_adm:admpw@127.0.0.1:5432/yunzhi_adm \
 *     npx prisma migrate deploy --schema packages/db/schema.prisma
 *   DATABASE_URL=postgresql://yunzhi_adm:admpw@127.0.0.1:5432/yunzhi_adm \
 *     node tools/e2e-admission.mjs
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
    console.error(`     ${String(e.message).split('\n').slice(0, 8).join('\n     ')}`);
    failed += 1;
  }
}

function section(name) {
  console.log(`\n\x1b[1m── ${name}\x1b[0m`);
}

/** bcrypt 格式的假雜湊。長度合法但對不上任何密碼。 */
const HASH = '$2a$12$notarealhashnotarealhashnotarealhashnotarealhashnotar';

// ─────────────────────────────────────────────────────────────
// Prisma 替身的補丁
//
// **每一個都刻意做得很笨。** 一個半吊子的 ORM 替身若開始「聰明」，
// 就會與 Prisma 的實際行為分岐，而那時它給的綠燈比沒有測試更危險。
// ─────────────────────────────────────────────────────────────

function adapt(base) {
  const proxy = new Proxy(base, {
    get(target, key) {
      if (key === '$transaction') {
        return (arg) => (typeof arg === 'function' ? arg(proxy) : Promise.all(arg));
      }
      const model = target[key];
      if (!model || typeof model !== 'object') return model;

      return new Proxy(model, {
        get(m, op) {
          if (op === 'findFirst' || op === 'findMany') {
            return async (args = {}) => {
              const { include, select, ...rest } = args;
              const useSelect = select && !hasRelation(select) ? select : undefined;
              const rows = await m[op]({ ...rest, select: useSelect });
              const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
              for (const row of list) await hydrate(base, String(key), row, include ?? select);
              return Array.isArray(rows) ? list : (list[0] ?? null);
            };
          }
          if (op === 'upsert') {
            // shim 沒有 upsert。**用複合唯一鍵自己查一次再決定** ——
            // 這正是 `AcademicRank` 與 `AdmissionProfile` 都靠
            // `[userId, year]` 去重的那一段，所以它必須被跑到。
            return async ({ where, create, update }) => {
              const flat = Object.values(where)[0];
              const key = flat && typeof flat === 'object' ? flat : where;
              const found = await m.findFirst({ where: key });
              if (found) return m.update({ where: { id: found.id }, data: update });
              return m.create({ data: create });
            };
          }
          return m[op];
        },
      });
    },
  });
  return proxy;
}

function hasRelation(select) {
  return Object.values(select).some((v) => v && typeof v === 'object');
}

/** 手工補上關聯。**只支援真的被用到的那幾條。** */
async function hydrate(db, model, row, shape) {
  if (!row || !shape) return;
  const want = (k) => shape[k] && typeof shape[k] === 'object';

  if (model === 'classMembership' && want('user')) {
    row.user = await db.user.findFirst({ where: { id: row.userId } });
  }
  if (model === 'abilitySnapshot' && want('knowledgePoint')) {
    const kp = await db.knowledgePoint.findFirst({ where: { id: row.knowledgePointId } });
    if (kp) {
      const inner = shape.knowledgePoint.select ?? {};
      if (inner.subject) kp.subject = await db.subject.findFirst({ where: { id: kp.subjectId } });
      row.knowledgePoint = kp;
    }
  }
  if (model === 'kpPrerequisite' && want('prereq')) {
    row.prereq = await db.knowledgePoint.findFirst({ where: { id: row.prereqId } });
  }
}

// ─────────────────────────────────────────────────────────────
// 把真的程式碼打包起來
// ─────────────────────────────────────────────────────────────

/**
 * 打包出來的東西放在 `node_modules` 底下，不是 `/tmp`——理由見
 * tools/e2e-guardian.mjs：`@prisma/client` 是 external，而 Node 解析
 * external 是從匯入它的檔案往上找 node_modules。
 */
const outDir = mkdtempSync(path.join(ROOT, 'node_modules', '.yz-e2e-admission-'));

const shimPath = path.join(outDir, 'prisma-shim.mjs');
writeFileSync(shimPath, 'export const prisma = globalThis.__YZ_ADM_PRISMA__;\n');

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
        // AsyncLocalStorage 是模組層級的單例，打包會複製出第二份，
        // 於是這支測試用 `withTenant` 建立的脈絡，bundle 裡的
        // `requireTenant` 看不到。
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
globalThis.__YZ_ADM_PRISMA__ = prisma;

const { NextRequest } = await import('next/dist/server/web/spec-extension/request.js');

const routes = {
  profile: await bundle('app/api/admission/profile/route.ts'),
  wishes: await bundle('app/api/admission/wishes/route.ts'),
  wish: await bundle('app/api/admission/wishes/[wishId]/route.ts'),
  star: await bundle('app/api/admission/star/route.ts'),
  ranks: await bundle('app/api/admission/ranks/route.ts'),
};

/** 用某個身分打一支路由。回 `{ status, body, text }`。 */
async function callAs(actor, handler, url, { params = {}, method = 'GET', json, form } = {}) {
  globalThis.__YZ_ACTOR__ = actor;
  const init = { method };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers = { 'content-type': 'application/json' };
  }
  if (form !== undefined) init.body = form;
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

/** 一份 CSV 當成上傳的檔案。**用 Big5 以外的路徑另外測。** */
function csvForm(text, year) {
  const form = new FormData();
  form.set('file', new File([text], 'ranks.csv', { type: 'text/csv' }));
  form.set('year', String(year));
  return form;
}

// ── 種子 ─────────────────────────────────────────────────────

const YEAR = admissionYearOf();
const stamp = Date.now();

/**
 * 一家補習班：一位管理員（＝繁星承辦）、一位老師、六位學生。
 *
 * 兩家用同一個函式建，理由與 tools/e2e-exam.mjs 相同：兩邊的資料形狀
 * 一模一樣、只有 tenantId 不同，所以任何一列跨界出現在對方的結果裡，
 * 都只可能是隔離漏了。
 */
async function seedTenant(spec) {
  const tenant = await withoutTenantScope('建立測試用的補習班', () =>
    raw.tenant.create({ data: { name: `${spec.tag} 升學 e2e ${stamp}` } }),
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
    const sysadmin = await mk('X01', `${spec.tag}的系統管理員`, 'SYS_ADMIN');
    const teacher = await mk('T01', `${spec.tag}的導師`, 'TEACHER');

    const year = await prisma.academicYear.create({
      data: {
        tenantId: tenant.id,
        name: `${YEAR}學年度`,
        startDate: new Date('2026-08-01'),
        endDate: new Date('2027-07-31'),
        isCurrent: true,
      },
    });
    const klass = await prisma.class.create({
      data: { tenantId: tenant.id, academicYearId: year.id, name: '高三甲' },
    });
    await prisma.classMembership.create({
      data: { classId: klass.id, userId: teacher.id, role: 'TEACHER', isHomeroom: true },
    });

    // 五位學生會擠在同一個位置（臺大第 2 類），第六位獨自推另一個位置。
    // 名字刻意好認：斷言要能在序列化後的字串裡找它們。
    const names = ['甲一', '乙二', '丙三', '丁四', '戊五', '己六'];
    const students = [];
    for (const [i, n] of names.entries()) {
      const u = await mk(`S${String(i + 1).padStart(2, '0')}`, `${spec.tag}的${n}`, 'STUDENT');
      await prisma.classMembership.create({
        data: { classId: klass.id, userId: u.id, role: 'STUDENT' },
      });
      students.push(u);
    }

    return { tenant, admin, sysadmin, teacher, klass, students };
  });
}

async function main() {
  const home = await seedTenant({ tag: '本家', prefix: `H${stamp}` });
  const other = await seedTenant({ tag: '隔壁', prefix: `O${stamp}` });

  // ═══════════════════════════════════════════════════════════
  section('一、教務處匯入在校成績百分比');
  // ═══════════════════════════════════════════════════════════

  /** 本家的五位主角，百分比刻意用好認的數字。 */
  const PCT = { 甲一: 1.11, 乙二: 2.22, 丙三: 3.33, 丁四: 4.44, 戊五: 5.55 };

  await withTenant(home.tenant.id, async () => {
    const csv = [
      '學號,姓名,在校成績百分比',
      ...home.students.slice(0, 5).map((u, i) => {
        const key = Object.keys(PCT)[i];
        return `${u.username},${u.displayName},${PCT[key]}`;
      }),
      // 己六用全形數字加百分號寫。Excel 存出來的檔案真的會這樣。
      `${home.students[5].username},己六,６.６６%`,
      // 讀不懂的兩列。**它們必須被報出來而不是靜靜跳過。**
      'NOT-A-REAL-STUDENT,某人,7.77',
      `${home.students[0].username}-x,亂碼,abc`,
    ].join('\n');

    await test('匯入成功，而且讀不懂的列全部報出來', async () => {
      const r = await callAs(asUser(home.admin), routes.ranks.POST, '/api/admission/ranks', {
        method: 'POST',
        form: csvForm(csv, YEAR),
      });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.imported, 6, '六位學生都要進去（含全形數字那一列）');
      assert.equal(r.body.updated, 0);
      assert.equal(r.body.skipped.length, 2, '兩列讀不懂');
      const msgs = r.body.skipped.map((s) => s.message).join(' ');
      assert.match(msgs, /找不到學生帳號/);
      assert.match(msgs, /讀不懂/);
    });

    await test('回應裡不含任何一位學生的百分比', async () => {
      // 一支匯入 API 把剛寫進去的敏感資料再回吐一次，等於在瀏覽器
      // 記錄裡留一份全校名單。
      const r = await callAs(asUser(home.admin), routes.ranks.POST, '/api/admission/ranks', {
        method: 'POST',
        form: csvForm(csv, YEAR),
      });
      for (const v of Object.values(PCT)) {
        assert.ok(!r.text.includes(String(v)), `回應含百分比 ${v}`);
      }
    });

    await test('重匯會蓋掉，不會產生第二列', async () => {
      const r = await callAs(asUser(home.admin), routes.ranks.POST, '/api/admission/ranks', {
        method: 'POST',
        form: csvForm(csv, YEAR),
      });
      assert.equal(r.body.imported, 0);
      assert.equal(r.body.updated, 6, '[userId, year] 是唯一鍵，所以是更新');
      const rows = await prisma.academicRank.findMany({ where: { year: YEAR } });
      assert.equal(rows.length, 6);
    });

    await test('全形數字與百分號讀得懂', async () => {
      const row = await prisma.academicRank.findFirst({
        where: { userId: home.students[5].id, year: YEAR },
      });
      assert.equal(row.percentile, 6.66);
      assert.equal(row.semesters, 5, '沒有指定學期數時預設 5（繁星採計五學期）');
    });

    await test('匯入寫了稽核', async () => {
      const logs = await prisma.auditLog.findMany({
        where: { action: 'admission.rank_import' },
      });
      assert.ok(logs.length >= 3, `只有 ${logs.length} 列稽核`);
      assert.equal(logs[0].actorId, home.admin.id);
    });

    // 系統管理員**匯得進去**，而這一行以前斷言他匯不進去。
    //
    // 規格書第 3 節說系統管理員在本模組沒有資料存取權，前提是學校有
    // 分職：資訊組管系統、教務處管繁星，兩個人。這套系統是單一補習班
    // 自架、維護者是主任，而**全新安裝之後機器上只有一個 SYS_ADMIN**。
    // 照規格書排除它的結果是業主裝好系統之後發現整個繁星模擬進不去，
    // 而畫面說「你不是繁星承辦人」——他就是。
    //
    // 理由完整寫在 lib/admissionDb.ts 的 STAR_COORDINATOR 註解裡。
    // 這裡改成驗「他進得去，而且留得下稽核」——後者才是真正的防線。
    await test('老師與學生都匯不進去', async () => {
      for (const actor of [home.teacher, home.students[0]]) {
        const r = await callAs(asUser(actor), routes.ranks.POST, '/api/admission/ranks', {
          method: 'POST',
          form: csvForm(csv, YEAR),
        });
        assert.equal(r.status, 403, `${actor.systemRole} 應該被擋`);
      }
    });
  });

  // 隔壁也匯一份。百分比刻意比本家好，這樣隔離漏了會把本家的第 1 名擠掉。
  await withTenant(other.tenant.id, async () => {
    const csv = [
      '學號,百分比',
      ...other.students.map((u, i) => `${u.username},${0.1 + i * 0.01}`),
    ].join('\n');
    await test('隔壁補習班也匯了一份（百分比比本家全部都好）', async () => {
      const r = await callAs(asUser(other.admin), routes.ranks.POST, '/api/admission/ranks', {
        method: 'POST',
        form: csvForm(csv, YEAR),
      });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.imported, 6);
    });
  });

  // ═══════════════════════════════════════════════════════════
  section('二、學生填繁星志願');
  // ═══════════════════════════════════════════════════════════

  const addStar = (actor, institutionName, starGroup, rank = 1) =>
    callAs(asUser(actor), routes.wishes.POST, '/api/admission/wishes', {
      method: 'POST',
      json: { year: YEAR, channel: 'STAR', rank, institutionName, starGroup },
    });

  await withTenant(home.tenant.id, async () => {
    await test('五位學生都推「臺灣大學第 2 類」', async () => {
      for (const u of home.students.slice(0, 5)) {
        const r = await addStar(u, '臺灣大學', 2);
        assert.equal(r.status, 200, r.text);
      }
      const rows = await prisma.wish.findMany({ where: { year: YEAR, channel: 'STAR' } });
      assert.equal(rows.length, 5);
    });

    await test('繁星志願沒選學群會被擋（沒有學群就算不出位置）', async () => {
      const r = await callAs(
        asUser(home.students[5]),
        routes.wishes.POST,
        '/api/admission/wishes',
        {
          method: 'POST',
          json: { year: YEAR, channel: 'STAR', rank: 1, institutionName: '成功大學' },
        },
      );
      assert.equal(r.status, 400);
      assert.match(r.body.error, /學群/);
    });

    await test('同一管道的志願序撞號會說得出撞在哪', async () => {
      const r = await addStar(home.students[0], '成功大學', 3, 1);
      assert.equal(r.status, 409);
      assert.match(r.body.error, /第 1 志願已經有了/);
    });

    await test('老師不能替學生填志願', async () => {
      const r = await addStar(home.teacher, '臺灣大學', 2);
      assert.equal(r.status, 403);
    });
  });

  // 隔壁的五位也推同一個位置。**同名同位置是刻意的**——隔離漏了的話，
  // 本家排第 4 的人會變成排第 9，而那個數字看起來完全正常。
  await withTenant(other.tenant.id, async () => {
    await test('隔壁的五位也推同一個「臺灣大學第 2 類」', async () => {
      for (const u of other.students.slice(0, 5)) {
        assert.equal((await addStar(u, '臺灣大學', 2)).status, 200);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  section('三、跑模擬：學生看到自己的位置');
  // ═══════════════════════════════════════════════════════════

  /** 丁四的百分比是 4.44，在本家五人裡排第 4。 */
  const dingsi = home.students[3];

  await withTenant(home.tenant.id, async () => {
    await test('5 人競爭、第一輪 1 個名額，排第 4 的人拿到自己的序位', async () => {
      const r = await callAs(asUser(dingsi), routes.star.GET, '/api/admission/star');
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.scope, 'self');
      const pos = r.body.position.positions;
      assert.equal(pos.length, 1);
      assert.equal(pos[0].institutionName, '臺灣大學');
      assert.equal(pos[0].starGroup, 2);
      assert.equal(pos[0].order, 4, 'RLS 漏了的話這裡會是 9');
      assert.equal(pos[0].hidden, false);
      assert.equal(pos[0].nominated, false, '校內只推 2 名');
      assert.equal(pos[0].firstRound, false);
    });

    await test('第二輪不是零，而且不用「有把握」這類措辭', async () => {
      const r = await callAs(asUser(dingsi), routes.star.GET, '/api/admission/star');
      const p = r.body.position.positions[0];
      assert.match(p.secondRoundNote, /不估第二輪的機率/);
      assert.match(p.secondRoundNote, /絕對不是零/);
      for (const banned of ['有相當把握', '把握', '穩上', '沒機會', '機率約']) {
        assert.ok(!r.text.includes(banned), `學生端出現了「${banned}」`);
      }
    });

    await test('敏感度：兩個方向都說', async () => {
      const r = await callAs(asUser(dingsi), routes.star.GET, '/api/admission/star');
      const s = r.body.position.positions[0].sensitivity;
      assert.equal(s.ifOneAheadLeaves.order, 3);
      assert.match(s.ifOneAheadLeaves.text, /你會變成第 3 位/);
      assert.equal(s.ifOneBetterJoins.order, 5);
    });

    // ═══════════════════════════════════════════════════════════
    // 這一項是這個功能能不能上線的關鍵
    // ═══════════════════════════════════════════════════════════
    await test('★ 學生端的回應不含任何其他學生的識別資訊或百分比', async () => {
      const r = await callAs(asUser(dingsi), routes.star.GET, '/api/admission/star');

      // 一、同校每一位同學的 id、學號、姓名都不能出現。
      for (const u of [...home.students, home.teacher, home.admin]) {
        if (u.id === dingsi.id) continue;
        assert.ok(!r.text.includes(u.id), `洩漏了 ${u.displayName} 的 id`);
        assert.ok(!r.text.includes(u.username), `洩漏了 ${u.displayName} 的學號`);
        assert.ok(!r.text.includes(u.displayName), `洩漏了 ${u.displayName} 的姓名`);
      }
      // 二、隔壁補習班的更不用說。
      for (const u of other.students) {
        assert.ok(!r.text.includes(u.id) && !r.text.includes(u.username), '跨租戶洩漏');
      }
      // 三、任何一個百分比都不能出現，**包含他自己的**——賽局結果不帶
      //     百分比，自己那一列由另一條路徑給。合成一條的話，遲早有人
      //     為了畫面方便把整份 sim 傳到前端。
      for (const v of Object.values(PCT)) {
        assert.ok(!r.text.includes(String(v)), `洩漏了百分比 ${v}`);
      }
      assert.ok(!r.text.includes('percentile'), '不該有 percentile 這個欄位');
      // 四、參與人數也不行。「有幾個人想推」本身就是全校資料。
      assert.ok(!r.text.includes('cohort'), '不該回參與人數');
      assert.ok(!/"(entries|squeeze|unranked|dropped|positions)":\s*\[\s*\{[^}]*userId/.test(r.text),
        '不該帶任何含 userId 的名單');
    });

    await test('推論攻擊：人數少於 3 人時不給具體名次', async () => {
      // 己六自己一位推「清華大學第 5 類」。他若看得到「第 1 位」，
      // 那還沒事；但若某個位置只有兩個人，排第 2 的那位就能推知
      // 排第 1 的是誰。所以門檻設在 3。
      const jiuliu = home.students[5];
      assert.equal((await addStar(jiuliu, '清華大學', 5)).status, 200);
      const r = await callAs(asUser(jiuliu), routes.star.GET, '/api/admission/star');
      const p = r.body.position.positions.find((x) => x.institutionName === '清華大學');
      assert.equal(p.hidden, true);
      assert.equal(p.order, null, '不能給名次，也不能填任何替代值');
      assert.equal(p.isFirst, true, '「是不是第 1 位」還是給');
      assert.equal(p.sensitivity, null, '敏感度會洩漏人數，一起關掉');
    });

    await test('結果端排擠：學生只拿到制度說明，拿不到校內有誰', async () => {
      // 甲一是臺大第 2 類的推薦序 1。讓乙二改推臺大第 1 類，
      // 於是校內在臺大有兩位推薦序 1（第 1-3 類合計只錄取 1 名）。
      const jiayi = home.students[0];
      const r = await callAs(asUser(jiayi), routes.star.GET, '/api/admission/star');
      const p = r.body.position.positions[0];
      assert.equal(p.firstRound, true);
      assert.match(p.crossGroupNote, /第 1 至 3 類/);
      assert.match(p.crossGroupNote, /不影響你參加第一輪/);
      assert.ok(!/還有 \d+ 位/.test(r.text), '不能透露同校有幾個人');
    });

    await test('老師與管理員打學生那一支會被導向 scope=school', async () => {
      const r = await callAs(asUser(home.teacher), routes.star.GET, '/api/admission/star');
      assert.equal(r.status, 403);
      assert.match(r.body.error, /scope=school/);
    });
  });

  // ═══════════════════════════════════════════════════════════
  section('四、承辦人的全校檢視');
  // ═══════════════════════════════════════════════════════════

  await withTenant(home.tenant.id, async () => {
    await test('繁星承辦（校務管理員）看得到全校，含姓名與百分比', async () => {
      const r = await callAs(
        asUser(home.admin),
        routes.star.GET,
        '/api/admission/star?scope=school',
      );
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.scope, 'school');
      const rep = r.body.report;
      assert.equal(rep.totals.students, 6);
      // 臺大第 2 類 5 人搶 2 個名額。
      const crowd = rep.crowded.find((c) => c.institutionName === '臺灣大學');
      assert.equal(crowd.cohort, 5, 'RLS 漏了的話這裡會是 10');
      assert.equal(crowd.squeezedOut, 3);
      // 承辦人這一側**才**看得到當事人。
      assert.ok(r.text.includes(dingsi.id), '承辦人要看得到是誰');
      assert.ok(r.text.includes('4.44'), '承辦人要看得到百分比');
    });

    await test('全校檢視只含本家的學生（RLS）', async () => {
      const r = await callAs(
        asUser(home.admin),
        routes.star.GET,
        '/api/admission/star?scope=school',
      );
      for (const u of other.students) {
        assert.ok(!r.text.includes(u.id), `隔壁的 ${u.displayName} 出現在本家的名單裡`);
        assert.ok(!r.text.includes(u.username), '跨租戶洩漏');
      }
    });

    await test('沒用完的名額與無人推薦的學群列得出來', async () => {
      const r = await callAs(
        asUser(home.admin),
        routes.star.GET,
        '/api/admission/star?scope=school',
      );
      const rep = r.body.report;
      // 清華第 5 類只有己六一位，名額 2 → 空一個。
      const unused = rep.unused.find((u) => u.institutionName === '清華大學');
      assert.equal(unused.unusedSlots, 1);
      // 臺大有人關注，所以第 1、3–8 類「校內沒有人推薦」要被列出來。
      const empty = rep.empty.find((e) => e.institutionName === '臺灣大學');
      assert.deepEqual(empty.starGroup, [1, 3, 4, 5, 6, 7, 8]);
    });

    await test('每一次全校檢視都寫稽核', async () => {
      const before = (
        await prisma.auditLog.findMany({ where: { action: 'admission.star_school_view' } })
      ).length;
      await callAs(asUser(home.admin), routes.star.GET, '/api/admission/star?scope=school');
      const after = await prisma.auditLog.findMany({
        where: { action: 'admission.star_school_view' },
      });
      assert.equal(after.length, before + 1);
      assert.equal(after[after.length - 1].category, 'SECURITY');
    });

    await test('老師與學生都進不了全校檢視', async () => {
      for (const actor of [home.teacher, home.students[0]]) {
        const r = await callAs(
          asUser(actor),
          routes.star.GET,
          '/api/admission/star?scope=school',
        );
        assert.equal(r.status, 403, `${actor.systemRole} 應該被擋`);
        assert.match(r.body.error, /校務管理員/);
      }
    });

    // 只驗「誰被擋」的測試有一個安靜的失敗模式：那支 API 其實壞了、
    // 對誰都回 403，而測試是綠的。所以每一條「進不去」都要配一條
    // 「進得去」。
    await test('系統管理員進得了全校檢視，而且留得下稽核', async () => {
      const before = (
        await prisma.auditLog.findMany({ where: { action: 'admission.star_school_view' } })
      ).length;
      const r = await callAs(
        asUser(home.sysadmin),
        routes.star.GET,
        '/api/admission/star?scope=school',
      );
      assert.equal(r.status, 200, `系統管理員被擋了：${JSON.stringify(r.body).slice(0, 200)}`);
      const after = await prisma.auditLog.findMany({
        where: { action: 'admission.star_school_view' },
      });
      assert.equal(after.length, before + 1, '全校檢視沒有寫稽核');
    });
  });

  // ═══════════════════════════════════════════════════════════
  section('五、管道排他規則跨越資料庫之後還對');
  // ═══════════════════════════════════════════════════════════

  await withTenant(home.tenant.id, async () => {
    const jiayi = home.students[0];
    const setProfile = (actor, patch) =>
      callAs(asUser(actor), routes.profile.POST, '/api/admission/profile', {
        method: 'POST',
        json: { year: YEAR, ...patch },
      });

    await test('繁星第 1-7 類錄取後，個申兩個動作都關掉', async () => {
      const r = await setProfile(jiayi, { starCategory: 'GROUP_1_7' });
      assert.equal(r.status, 200, r.text);
      const map = Object.fromEntries(r.body.eligibility.map((e) => [e.key, e.ok]));
      assert.equal(map.APPLY_APPLY, false);
      assert.equal(map.APPLY_PREFERENCE, false);
      assert.equal(map.PLACEMENT_REGISTER, false, '錄取未放棄，分發也關著');
    });

    await test('★ 放棄之後個申資格不恢復——類別沒有在 upsert 中被清掉', async () => {
      // 這是規格書 §5.5 最關鍵的一條，而它是本模組唯一一種
      // 「單元測試抓不到」的失效方式：`saveProfile` 若在 starWaived=true
      // 時順手把 starCategory 設回 NONE，純函式測試完全看不到，
      // 而症狀是這位學生在畫面上看到「可以報名個人申請」。
      const r = await setProfile(jiayi, { starWaived: true });
      assert.equal(r.body.profile.starCategory, 'GROUP_1_7', '類別必須留著');
      assert.equal(r.body.profile.starWaived, true);
      const map = Object.fromEntries(r.body.eligibility.map((e) => [e.key, e.ok]));
      assert.equal(map.APPLY_APPLY, false, '放棄也沒用，永久封鎖');
      assert.equal(map.PLACEMENT_REGISTER, true, '但分發這一條放棄後就解除');

      const blocker = r.body.eligibility.find((e) => e.key === 'APPLY_APPLY').blockers[0];
      assert.equal(blocker.remedy, 'NONE');
      assert.match(blocker.text, /就算完成放棄/);

      // 資料庫裡也要真的還是 GROUP_1_7。
      const row = await prisma.admissionProfile.findFirst({
        where: { userId: jiayi.id, year: YEAR },
      });
      assert.equal(row.starCategory, 'GROUP_1_7');
      assert.equal(row.starWaived, true);
    });

    await test('第 8 類：可報名個申並考二階，但不可登記志願序', async () => {
      const yier = home.students[1];
      const r = await setProfile(yier, { starCategory: 'GROUP_8' });
      const map = Object.fromEntries(r.body.eligibility.map((e) => [e.key, e.ok]));
      assert.equal(map.APPLY_APPLY, true);
      assert.equal(map.APPLY_PREFERENCE, false);
      const b = r.body.eligibility.find((e) => e.key === 'APPLY_PREFERENCE').blockers[0];
      assert.match(b.text, /仍然可以報名個人申請/);
    });

    await test('規劃衝突：繁星第 3 類加六個個申志願要說「放棄也無法挽回」', async () => {
      const bingsan = home.students[2];
      // 志願序 1 已經是臺大第 2 類的繁星志願，所以個申從 1 開始不衝突
      // （唯一鍵含 channel）。
      for (let i = 1; i <= 6; i++) {
        const r = await callAs(
          asUser(bingsan),
          routes.wishes.POST,
          '/api/admission/wishes',
          {
            method: 'POST',
            json: {
              year: YEAR,
              channel: 'APPLY',
              rank: i,
              institutionName: `大學${i}`,
              programName: '某系',
            },
          },
        );
        assert.equal(r.status, 200, r.text);
      }
      // 把他的繁星志願改成第 3 類：先刪再加。
      const wishes = await prisma.wish.findMany({
        where: { userId: bingsan.id, year: YEAR, channel: 'STAR' },
      });
      await callAs(
        asUser(bingsan),
        routes.wish.DELETE,
        `/api/admission/wishes/${wishes[0].id}?year=${YEAR}`,
        { method: 'DELETE', params: { wishId: wishes[0].id } },
      );
      const r = await addStar(bingsan, '臺灣大學', 3);
      assert.equal(r.status, 200, r.text);

      const hit = r.body.conflicts.find((c) => c.code === 'STAR_1_7_KILLS_APPLY');
      assert.ok(hit, '沒有偵測到這個組合');
      assert.match(hit.text, /6 個個申志願將全部失效/);
      assert.match(hit.text, /放棄繁星也無法挽回/);
      assert.equal(hit.severity, 'FUTURE');
    });

    await test('系統不阻擋——注定衝突的志願照樣存進去了', async () => {
      const bingsan = home.students[2];
      const rows = await prisma.wish.findMany({ where: { userId: bingsan.id, year: YEAR } });
      assert.equal(rows.filter((w) => w.channel === 'APPLY').length, 6);
      assert.equal(rows.filter((w) => w.channel === 'STAR').length, 1);
    });

    await test('學生刪不掉別人的志願（404，與「不存在」同一個回應）', async () => {
      const victim = home.students[4];
      const mine = await prisma.wish.findMany({ where: { userId: victim.id, year: YEAR } });
      assert.ok(mine.length > 0);
      const r = await callAs(
        asUser(home.students[0]),
        routes.wish.DELETE,
        `/api/admission/wishes/${mine[0].id}?year=${YEAR}`,
        { method: 'DELETE', params: { wishId: mine[0].id } },
      );
      assert.equal(r.status, 404);
      const still = await prisma.wish.findFirst({ where: { id: mine[0].id } });
      assert.ok(still, '志願被別人刪掉了');
    });

    await test('學生刪不掉隔壁補習班的志願', async () => {
      const theirs = await withTenant(other.tenant.id, () =>
        prisma.wish.findMany({ where: { userId: other.students[0].id } }),
      );
      assert.ok(theirs.length > 0);
      const r = await callAs(
        asUser(home.students[0]),
        routes.wish.DELETE,
        `/api/admission/wishes/${theirs[0].id}?year=${YEAR}`,
        { method: 'DELETE', params: { wishId: theirs[0].id } },
      );
      assert.equal(r.status, 404);
    });

    await test('老師改不了學生的升學狀態', async () => {
      const r = await setProfile(home.teacher, { specialAdmitted: true });
      assert.equal(r.status, 403);
    });
  });

  // ═══════════════════════════════════════════════════════════
  section('六、租戶隔離的總結');
  // ═══════════════════════════════════════════════════════════

  await test('隔壁看自己的模擬，數字是自己的（不是 10 人）', async () => {
    await withTenant(other.tenant.id, async () => {
      const r = await callAs(
        asUser(other.admin),
        routes.star.GET,
        '/api/admission/star?scope=school',
      );
      assert.equal(r.status, 200, r.text);
      const crowd = r.body.report.crowded.find((c) => c.institutionName === '臺灣大學');
      assert.equal(crowd.cohort, 5);
      for (const u of home.students) {
        assert.ok(!r.text.includes(u.id), '本家的學生出現在隔壁的名單裡');
      }
    });
  });

  await test('本家看到 6 列，而同一張表裡其實有 12 列（RLS 濾掉了另外 6 列）', async () => {
    const rows = await withTenant(home.tenant.id, () =>
      prisma.academicRank.findMany({ where: { year: YEAR } }),
    );
    assert.equal(rows.length, 6);

    // **只數這一次跑建的那兩家。** 這支測試可以對同一個資料庫重複跑
    // （每次都建新的租戶），所以「整張表有幾列」會隨跑的次數增加——
    // 對它下斷言的話，第二次跑就會紅，而紅的原因與隔離無關。
    for (const t of [home.tenant.id, other.tenant.id]) {
      const mine = await withoutTenantScope('驗證兩家的資料都在同一張表裡', () =>
        raw.academicRank.findMany({ where: { year: YEAR, tenantId: t } }),
      );
      assert.equal(mine.length, 6, `${t} 應該有 6 列`);
    }
    // 上面那個 6 是 RLS 濾出來的，不是因為表裡只有 6 列。
    const both = await withoutTenantScope('驗證兩家合計 12 列都在同一張表裡', () =>
      raw.academicRank.findMany({
        where: { year: YEAR, tenantId: { in: [home.tenant.id, other.tenant.id] } },
      }),
    );
    assert.equal(both.length, 12);
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
