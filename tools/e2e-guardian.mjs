/**
 * 家長端的端到端驗證：連結真的建得起來，而**界線真的擋得住**。
 *
 * # 為什麼一定要有這一支
 *
 * 家長端的規格裡有一半是「看不到什麼」，而「看不到」是最難用單元
 * 測試證明的東西：一個回傳空陣列的函式與一個根本不會被呼叫的函式，
 * 在斷言上長得一樣。`apps/web/tests/guardian.test.mjs` 驗的是投影
 * 規則與原始碼裡沒有那幾張表；那些都在同一個行程裡、同一份記憶體
 * 裡，證明不了跨越 HTTP 與資料庫邊界之後還成立。
 *
 * 所以這一支做兩件那邊做不到的事：
 *
 *   **一、真的打那幾支 API。** 不是呼叫 lib 的函式——是把
 *   `app/api` 底下的 route.ts 用 esbuild 打包起來，餵一個真的
 *   `NextRequest`，然後看回應的狀態碼與內容。走的是真的
 *   `scopedRoute`、真的 `withTenant`、真的權限判斷。
 *
 *   **二、每一條「拿不到」都配一條「拿得到」。** 只驗 403 的測試
 *   有一個很安靜的失敗模式：那支 API 其實壞了，對誰都回 403，
 *   而測試是綠的。所以每一項都用學生自己的身分再打一次同一支——
 *   拿得到，才證明剛才那個 403 是「因為他是家長」。
 *
 * # 兩個替身，以及唯一被動過手腳的東西
 *
 * **Prisma 用 pg-shim。** 理由見 `tools/pg-shim.mjs` 的檔頭：Prisma
 * 的查詢引擎要從外部網域下載，而這套系統要部署的機房是封閉網段。
 * shim 沒有實作 `include`、關聯條件與 `$transaction`，這裡在
 * 測試這一側補上（`adapt()`），不去動共用的 shim。
 *
 * **`requireUser` 被換掉了，而那是刻意的**——它是這支測試唯一的
 * 自變數。「誰登入了」由測試決定，其餘（`scopedRoute` 的 401、
 * 租戶脈絡、每一支路由自己的角色判斷、每一個 lib 的 userId 比對）
 * 全部是正式環境跑的那一份程式碼，一個字都沒改。
 *
 * 用法（沿用 tools/e2e-import.sh 的建庫方式，但只需要 Postgres）：
 *
 *   su postgres -c "psql -c \"CREATE ROLE yunzhi_guardian LOGIN PASSWORD 'pw' CREATEDB\""
 *   su postgres -c "psql -c 'CREATE DATABASE yunzhi_guardian OWNER yunzhi_guardian'"
 *   su postgres -c "psql -d yunzhi_guardian -c 'CREATE EXTENSION vector'"
 *   su postgres -c "psql -d yunzhi_guardian -c 'CREATE EXTENSION pg_trgm'"
 *   DATABASE_URL=postgresql://yunzhi_guardian:pw@127.0.0.1:5432/yunzhi_guardian \
 *     npx prisma migrate deploy --schema packages/db/schema.prisma
 *   DATABASE_URL=postgresql://yunzhi_guardian:pw@127.0.0.1:5432/yunzhi_guardian \
 *     node tools/e2e-guardian.mjs
 *
 * **不需要 Redis、S3、AI 服務，也不需要網路。**
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import { createPgShim } from './pg-shim.mjs';
import { withTenant, withoutTenantScope } from '../apps/web/lib/tenantContext.mjs';

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
    console.error(`     ${String(e.message).split('\n').slice(0, 6).join('\n     ')}`);
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
        // 兩種呼叫形式都要支援：陣列（`resetGuardianPassword`）與
        // 回呼（`provisionGuardiansForClass`）。
        //
        // **這不是真的交易。** 這一支驗的是「有沒有寫進去」與
        // 「誰看得到」，不是原子性；原子性由 Postgres 那一側的
        // e2e（tools/e2e-exam.mjs）負責。
        return (arg) => (typeof arg === 'function' ? arg(proxy) : Promise.all(arg));
      }
      const model = target[key];
      if (!model || typeof model !== 'object') return model;

      return new Proxy(model, {
        get(m, op) {
          if (op === 'findFirstOrThrow') {
            return async (args) => {
              const r = await m.findFirst(args);
              if (!r) throw new Error('findFirstOrThrow：找不到');
              return r;
            };
          }
          if (op === 'findFirst' || op === 'findMany') {
            return async (args = {}) => {
              const { include, select, where, ...rest } = args;
              // 關聯條件（`targets: { some: … }`）shim 解不開。只有
              // `listStudentTasks` 用得到，所以只翻譯那一種——多實作
              // 一種沒被用到的，就是多一個寫錯了也不會被發現的地方。
              const plain = await resolveRelationWhere(base, String(key), where);
              const useSelect = select && !hasRelation(select) ? select : undefined;
              const rows = await m[op]({ ...rest, where: plain, select: useSelect });
              const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
              for (const row of list) await hydrate(base, String(key), row, include ?? select);
              return Array.isArray(rows) ? list : (list[0] ?? null);
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

/** `assignment.findMany({ where: { targets: { some: … } } })` → 一組 id。 */
async function resolveRelationWhere(db, model, where) {
  if (!where || !where.targets) return where;
  const { targets, ...rest } = where;
  const cond = targets.some ?? {};
  const or = cond.OR ?? [cond];
  const ids = new Set();
  for (const c of or) {
    const rows = await db.assignmentTarget.findMany({ where: c });
    for (const r of rows) ids.add(r.assignmentId);
  }
  void model;
  return { ...rest, id: { in: [...ids] } };
}

/**
 * 手工補上關聯。**只支援真的被用到的那幾條**，
 * 用不到的一律靜靜跳過而不是假裝支援。
 */
async function hydrate(db, model, row, shape) {
  if (!row || !shape) return;
  const want = (k) => shape[k] && typeof shape[k] === 'object';

  if (model === 'assignment') {
    if (want('paper')) {
      const p = await db.examPaper.findFirst({ where: { id: row.paperId } });
      if (p) {
        const inner = shape.paper.select ?? {};
        if (inner.subject) {
          p.subject = await db.subject.findFirst({ where: { id: p.subjectId } });
        }
        if (inner._count) {
          const items = await db.examPaperItem.findMany({ where: { paperId: p.id } });
          p._count = { items: items.length };
        }
        row.paper = p;
      }
    }
    if (want('attempts')) {
      const inner = shape.attempts;
      row.attempts = await db.attempt.findMany({
        where: { assignmentId: row.id, ...(inner.where ?? {}) },
        orderBy: inner.orderBy,
      });
    }
    if (shape._count) {
      const attempts = await db.attempt.findMany({ where: { assignmentId: row.id } });
      row._count = { attempts: attempts.length };
    }
  }

  if (model === 'attempt' && want('assignment')) {
    const a = await db.assignment.findFirst({ where: { id: row.assignmentId } });
    const inner = shape.assignment.select ?? {};
    if (a && inner.paper && typeof inner.paper === 'object') {
      const p = await db.examPaper.findFirst({ where: { id: a.paperId } });
      if (p) {
        const pin = inner.paper.select ?? {};
        if (pin.subject) p.subject = await db.subject.findFirst({ where: { id: p.subjectId } });
        a.paper = p;
      }
    }
    row.assignment = a;
  }
}

// ─────────────────────────────────────────────────────────────
// 把真的程式碼打包起來
// ─────────────────────────────────────────────────────────────

/**
 * 打包出來的東西放在 `node_modules` 底下，不是 `/tmp`。
 *
 * 因為 `@prisma/client` 是 external（它只提供 `Prisma.DbNull` 這類
 * 常數，打包進去沒有意義），而 Node 解析 external 是**從匯入它的
 * 檔案往上找 node_modules**——放在 /tmp 的 bundle 一路找到根目錄
 * 都找不到，錯誤訊息是 `Cannot find package '@prisma/client'`，
 * 完全看不出與輸出位置有關。
 */
const outDir = mkdtempSync(path.join(ROOT, 'node_modules', '.yz-e2e-guardian-'));

const shimPath = path.join(outDir, 'prisma-shim.mjs');
writeFileSync(shimPath, 'export const prisma = globalThis.__YZ_GUARDIAN_PRISMA__;\n');

/**
 * `requireUser` 的替身，其餘全部是真的。
 *
 * 這是整支測試唯一被換掉的東西：正式環境的它從 cookie 查一列
 * session，而那需要 Next 的請求脈絡。換掉的是「誰登入了」，
 * 不是「登入之後能做什麼」——後者才是這一支要驗的。
 */
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
    alias: {
      '@/lib/prisma': shimPath,
      '@/lib/auth': authPath,
      '@': WEB,
    },
    plugins: [
      {
        // 租戶脈絡**不可以被打包進去**。`tenantContext.mjs` 裡的
        // AsyncLocalStorage 是模組層級的單例，打包會複製出第二份——
        // 於是這支測試用 `withTenant` 建立的脈絡，bundle 裡的
        // `requireTenant` 看不到，每一個查詢都失敗在「忘記包
        // withTenant？」。留成 external，Node 讓兩邊共用同一個實例。
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
globalThis.__YZ_GUARDIAN_PRISMA__ = prisma;

const { NextRequest } = await import('next/dist/server/web/spec-extension/request.js');

const guardianLib = await bundle('lib/guardian.ts');
const routes = {
  tutorSession: await bundle('app/api/tutor/[sessionId]/route.ts'),
  attempt: await bundle('app/api/attempts/[attemptId]/route.ts'),
  proctor: await bundle('app/api/attempts/[attemptId]/proctor/route.ts'),
  guardians: await bundle('app/api/guardians/route.ts'),
  guardianLink: await bundle('app/api/guardians/[linkId]/route.ts'),
  classGuardians: await bundle('app/api/classes/[classId]/guardians/route.ts'),
};

/** 用某個身分打一支路由。回 `{ status, body }`。 */
async function callAs(actor, handler, url, { params = {}, method = 'GET', json } = {}) {
  globalThis.__YZ_ACTOR__ = actor;
  const req = new NextRequest(`http://localhost${url}`, {
    method,
    ...(json !== undefined
      ? { body: JSON.stringify(json), headers: { 'content-type': 'application/json' } }
      : {}),
  });
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

/** 一個登入中的使用者。`requireUser` 的替身就回這個形狀。 */
const asUser = (u) => ({
  id: u.id,
  tenantId: u.tenantId,
  username: u.username,
  displayName: u.displayName,
  systemRole: u.systemRole,
  mustChangePassword: false,
});

// ── 種子 ─────────────────────────────────────────────────────

const stamp = Date.now();
const tenant = await withoutTenantScope('建立測試用的補習班', () =>
  raw.tenant.create({ data: { name: `家長端 e2e ${stamp}` } }),
);

const ctx = await withTenant(tenant.id, async () => {
  const admin = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      username: `admin-${stamp}`,
      displayName: '主任',
      systemRole: 'SYS_ADMIN',
      passwordHash: HASH,
      status: 'ACTIVE',
    },
  });
  // 一位用信箱當登入代號的老師。名冊上的家長信箱打成他的信箱時，
  // **絕對不可以靜靜接上去**——那個人立刻看得到那位學生的成績。
  const teacher = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      username: `teacher-${stamp}@example.com`,
      email: `teacher-${stamp}@example.com`,
      displayName: '數學老師',
      systemRole: 'TEACHER',
      passwordHash: HASH,
      status: 'ACTIVE',
    },
  });
  const year = await prisma.academicYear.create({
    data: {
      tenantId: tenant.id,
      name: '115學年度',
      startDate: new Date('2026-08-01'),
      endDate: new Date('2027-07-31'),
      isCurrent: true,
    },
  });
  const classA = await prisma.class.create({
    data: { tenantId: tenant.id, academicYearId: year.id, name: '高三甲' },
  });
  const classB = await prisma.class.create({
    data: { tenantId: tenant.id, academicYearId: year.id, name: '高三乙' },
  });

  const makeStudent = async (n, name, classId, guardianEmail) => {
    const u = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        username: `S${stamp}${n}`,
        displayName: name,
        systemRole: 'STUDENT',
        passwordHash: HASH,
        status: 'ACTIVE',
        consentAt: new Date('2026-08-20'),
        guardianEmail: guardianEmail ?? null,
      },
    });
    await prisma.classMembership.create({
      data: { classId, userId: u.id, role: 'STUDENT' },
    });
    return u;
  };

  // 王大明與王小美是兄妹：**同一個家長信箱**，所以應該變成
  // 一個帳號兩條連結，不是兩個帳號。
  const daming = await makeStudent(1, '王大明', classA.id, `mom-${stamp}@example.com`);
  const xiaomei = await makeStudent(2, '王小美', classA.id, `MOM-${stamp}@Example.com`);
  const xiaohua = await makeStudent(3, '陳小華', classA.id, `dad-${stamp}@example.com`);
  // 班級平均要五位以上才給得出來（見 `PEER_FLOOR`），所以湊滿。
  const others = [];
  for (let i = 0; i < 4; i++) {
    others.push(await makeStudent(10 + i, `同學${i + 1}`, classA.id, null));
  }
  // 另一個班的孩子。家長不可以看到他。
  const outsider = await makeStudent(20, '別班的孩子', classB.id, `mom-${stamp}@example.com`);

  const subject = await prisma.subject.create({
    data: { tenantId: tenant.id, code: 'MATH_A', name: '數學A', gsatFullScore: 15 },
  });
  const paper = await prisma.examPaper.create({
    data: {
      tenantId: tenant.id,
      subjectId: subject.id,
      title: '第三次模擬考卷',
      totalScore: 100,
      createdBy: admin.id,
    },
  });
  const paper2 = await prisma.examPaper.create({
    data: {
      tenantId: tenant.id,
      subjectId: subject.id,
      title: '隨堂測驗卷',
      totalScore: 20,
      createdBy: admin.id,
    },
  });

  const mkAssignment = async (paperId, title, policy) => {
    const a = await prisma.assignment.create({
      data: {
        tenantId: tenant.id,
        paperId,
        title,
        mode: 'EXAM',
        releasePolicy: policy,
        maxAttempts: 1,
        createdBy: admin.id,
      },
    });
    await prisma.assignmentTarget.create({ data: { assignmentId: a.id, classId: classA.id } });
    return a;
  };
  const exam = await mkAssignment(paper.id, '第三次模擬考', 'ON_SUBMIT');
  // 老師還沒放行的那一份。家長不可以比學生早看到分數。
  const held = await mkAssignment(paper.id, '期中考（尚未放行）', 'MANUAL');
  const quiz = await mkAssignment(paper2.id, '隨堂測驗', 'ON_SUBMIT');

  const submit = async (assignmentId, user, score) =>
    prisma.attempt.create({
      data: {
        assignmentId,
        userId: user.id,
        attemptNo: 1,
        status: 'GRADED',
        startedAt: new Date('2026-09-05T01:00:00Z'),
        submittedAt: new Date('2026-09-05T02:00:00Z'),
        totalScore: score,
        autoScore: score,
        gradedAt: new Date('2026-09-05T02:01:00Z'),
      },
    });

  // 模擬考：七個人交卷，王大明 68 分。班級平均給得出來。
  const damingAttempt = await submit(exam.id, daming, 68);
  await submit(exam.id, xiaomei, 91);
  await submit(exam.id, xiaohua, 77);
  for (const [i, o] of others.entries()) await submit(exam.id, o, 60 + i * 5);
  // 期中考：只有王大明交了，而且老師沒放行。
  await submit(held.id, daming, 88);

  // 王大明的逐題作答。家長不可以看到它。
  const question = await prisma.question.create({
    data: {
      tenantId: tenant.id,
      subjectId: subject.id,
      familyId: `fam-${stamp}`,
      version: 1,
      type: 'SINGLE_CHOICE',
      content: '下列何者為質數？',
      score: 4,
      answerKeys: [2],
      sourceType: 'TEACHER_ORIGINAL',
      licenseScope: 'TENANT_EXPORTABLE',
      status: 'PUBLISHED',
    },
  });
  await prisma.attemptAnswer.create({
    data: {
      attemptId: damingAttempt.id,
      questionId: question.id,
      answerKeys: [3],
      isCorrect: false,
      earnedScore: 0,
    },
  });

  // 王大明求助過智慧老師。家長不可以看到這一段。
  const tutorSession = await prisma.tutorSession.create({
    data: {
      tenantId: tenant.id,
      userId: daming.id,
      attemptId: damingAttempt.id,
      questionId: question.id,
      status: 'OPEN',
      messageCount: 2,
    },
  });
  await prisma.tutorMessage.create({
    data: {
      sessionId: tutorSession.id,
      role: 'STUDENT',
      content: '我完全看不懂質數是什麼，我是不是很笨',
    },
  });

  // 隨堂測驗：王大明正在寫。考試行為事件掛在這一份上。
  const liveAttempt = await prisma.attempt.create({
    data: {
      assignmentId: quiz.id,
      userId: daming.id,
      attemptNo: 1,
      status: 'IN_PROGRESS',
      startedAt: new Date(Date.now() - 10 * 60 * 1000),
    },
  });
  await prisma.proctorEvent.create({
    data: { attemptId: liveAttempt.id, type: 'TAB_HIDDEN', at: new Date(), durationMs: 42_000 },
  });

  return {
    admin,
    teacher,
    classA,
    classB,
    daming,
    xiaomei,
    xiaohua,
    outsider,
    exam,
    held,
    damingAttempt,
    liveAttempt,
    tutorSession,
    momEmail: `mom-${stamp}@example.com`,
    dadEmail: `dad-${stamp}@example.com`,
  };
});

// ── 跑 ───────────────────────────────────────────────────────

console.log('\n\x1b[1m家長端的端到端驗證\x1b[0m');

let mom = null;
let momLink = null;

await withTenant(tenant.id, async () => {
  section('從名冊建立連結');

  await test('名冊帶了家長信箱：家長帳號與連結一起建起來', async () => {
    const r = await guardianLib.provisionGuardiansForClass(ctx.classA.id, ctx.admin.id);
    assert.equal(r.created, 2, '兩個不同的信箱應該開兩個帳號');
    assert.equal(r.linked, 3, '三位學生各一條連結');
    assert.equal(r.withoutEmail, 4, '沒填信箱的那四位要數得出來');
    assert.equal(r.credentials.length, 2, '新帳號的初始密碼要回來，而且只有這一次');
    assert.ok(
      r.credentials.every((c) => c.password && c.password.length >= 8),
      '初始密碼太短或是空的',
    );
  });

  await test('兄妹共用一個信箱 → 一個帳號兩條連結', async () => {
    mom = await prisma.user.findFirst({ where: { username: ctx.momEmail } });
    assert.ok(mom, '家長帳號沒有用信箱當登入代號');
    assert.equal(mom.systemRole, 'GUARDIAN');
    assert.equal(mom.status, 'ACTIVE', '家長是成年人，不該卡在等待同意');
    assert.equal(mom.mustChangePassword, true, '初始密碼應該要求第一次登入時更換');

    const links = await prisma.guardianLink.findMany({ where: { guardianId: mom.id } });
    assert.equal(links.length, 2, '兄妹應該接到同一個家長帳號底下');
  });

  await test('信箱大小寫不同不會變成第二個帳號', async () => {
    // 櫃檯打 `MOM@Example.com`、家長登入打 `mom@example.com`，
    // 那是同一個人，而唯一鍵認為不是。
    const all = await prisma.user.findMany({ where: { systemRole: 'GUARDIAN' } });
    assert.equal(all.length, 2, `建出了 ${all.length} 個家長帳號，應該只有 2 個`);
  });

  await test('按第二次一條都不會重建——冪等是這一支的前提', async () => {
    const r = await guardianLib.provisionGuardiansForClass(ctx.classA.id, ctx.admin.id);
    assert.equal(r.created, 0, '第二次不該再開帳號');
    assert.equal(r.linked, 0, '第二次不該再建連結');
    assert.equal(r.alreadyLinked, 3, '本來就接好的要數得出來');
    assert.equal(r.credentials.length, 0, '既有帳號不可以被重設密碼——他可能正在用');
  });

  await test('家長信箱撞到別人的登入代號：跳過並說原因，不接上去', async () => {
    // 這是最危險的一種錯：靜靜接上去的話，那個帳號的主人立刻
    // 看得到這位學生的成績。
    const clash = await prisma.user.findFirst({ where: { id: ctx.xiaohua.id } });
    await prisma.user.update({
      where: { id: clash.id },
      data: { guardianEmail: ctx.teacher.username },
    });
    const r = await guardianLib.provisionGuardiansForClass(ctx.classA.id, ctx.admin.id);
    assert.equal(r.skipped.length, 1, '撞號的那一位要被列出來');
    assert.ok(r.skipped[0].why.includes('登入代號'), '沒有說出為什麼接不上');
    const bad = await prisma.guardianLink.findMany({ where: { guardianId: ctx.teacher.id } });
    assert.equal(bad.length, 0, '把老師的帳號接成一位學生的家長了');
    await prisma.user.update({ where: { id: clash.id }, data: { guardianEmail: ctx.dadEmail } });
  });

  await test('學生的帳號綁不成別人的家長', async () => {
    await assert.rejects(
      () => guardianLib.linkGuardian(ctx.xiaohua.id, ctx.daming.id, ctx.admin.id),
      /不是家長帳號/,
      '一位學生被綁成另一位學生的家長——他立刻看得到別人的成績',
    );
  });

  section('verifiedAt：交付確認');

  await test('剛建好的連結是「還沒交付」', async () => {
    const links = await prisma.guardianLink.findMany({ where: { guardianId: mom.id } });
    assert.ok(
      links.every((l) => l.verifiedAt === null),
      '建立連結不等於憑證交到人手上',
    );
    momLink = links.find((l) => l.studentId === ctx.daming.id);
    assert.ok(momLink, '王大明的連結不見了');
  });

  await test('沒確認交付的連結收不到任何通知', async () => {
    const list = await guardianLib.notifiableGuardians(ctx.daming.id);
    assert.equal(list.length, 0, '把成績寄給一個沒有人確認過的信箱');
  });

  await test('確認交付之後才進得了通知名單', async () => {
    await guardianLib.setGuardianDelivered(momLink.id, true, ctx.admin.id);
    const list = await guardianLib.notifiableGuardians(ctx.daming.id);
    assert.equal(list.length, 1);
    assert.equal(list[0].username, ctx.momEmail);
  });

  await test('撤回交付標記之後又收不到了', async () => {
    await guardianLib.setGuardianDelivered(momLink.id, false, ctx.admin.id);
    assert.equal((await guardianLib.notifiableGuardians(ctx.daming.id)).length, 0);
    await guardianLib.setGuardianDelivered(momLink.id, true, ctx.admin.id);
  });

  await test('交付與撤回都留下稽核，行為人記得住', async () => {
    const logs = await prisma.auditLog.findMany({ where: { targetId: momLink.id } });
    const actions = logs.map((l) => l.action);
    assert.ok(actions.includes('guardian.verify'), '確認交付沒有留稽核');
    assert.ok(actions.includes('guardian.unverify'), '撤回沒有留稽核');
    assert.ok(logs.every((l) => l.actorId === ctx.admin.id));
  });

  section('家長看得到自己的孩子');

  await test('看得到自己的兩個孩子，班級對得上', async () => {
    const kids = await guardianLib.childrenOf(mom.id);
    assert.deepEqual(
      kids.map((k) => k.displayName).sort(),
      ['王大明', '王小美'],
      '孩子的清單不對',
    );
    assert.equal(kids[0].className, '高三甲');
  });

  await test('看得到任務清單與交了沒', async () => {
    const view = await guardianLib.childView(mom.id, ctx.daming.id);
    assert.ok(view.tasks.length >= 3, '任務清單是空的');
    const exam = view.tasks.find((t) => t.title === '第三次模擬考');
    assert.ok(exam, '找不到模擬考那一份');
    assert.equal(exam.state, 'DONE');
    assert.ok(exam.lastSubmittedAt, '交卷時間沒有帶出來');
    assert.equal(view.summary.running, 1, '正在寫的那一份要數得出來');
  });

  await test('看得到已放行的成績與班級平均', async () => {
    const view = await guardianLib.childView(mom.id, ctx.daming.id);
    const exam = view.tasks.find((t) => t.title === '第三次模擬考');
    assert.equal(exam.score, 68);
    assert.equal(exam.maxScore, 100);
    assert.equal(exam.compare.show, true, '七個人交卷了，平均應該給得出來');
    assert.ok(exam.compare.mean > 0);
    assert.ok(
      ['高於班級平均', '低於班級平均', '與班級平均差不多'].includes(exam.compare.label),
      `相對位置的說法不對：${exam.compare.label}`,
    );
  });

  await test('老師沒放行的那一份，家長也看不到分數', async () => {
    // 家長比孩子早看到分數是不行的：那等於提前告訴他考完了、考得如何，
    // 而學生自己的畫面上還寫著「老師還沒有開放」。
    const view = await guardianLib.childView(mom.id, ctx.daming.id);
    const held = view.tasks.find((t) => t.title === '期中考（尚未放行）');
    assert.ok(held, '找不到那一份未放行的考試');
    assert.equal(held.score, null, '未放行的分數被送到家長那裡了');
    assert.equal(held.resultVisible, false);
    assert.equal(held.compare.show, false, '連平均都不該算——那也是一種提前告知');
  });

  await test('家長那一份沒有作答與檢討的把手', async () => {
    const view = await guardianLib.childView(mom.id, ctx.daming.id);
    for (const t of view.tasks) {
      for (const leak of ['assignmentId', 'openAttemptId', 'attemptsUsed', 'resultLevel']) {
        assert.equal(t[leak], undefined, `${leak} 被帶到家長那一份上了`);
      }
    }
  });

  section('看不到別人的孩子');

  await test('換一個 studentId 進來：擋下來', async () => {
    await assert.rejects(
      () => guardianLib.childView(mom.id, ctx.outsider.id),
      /不是你的孩子/,
      'RLS 擋得住別家補習班，擋不住同一間補習班的另一個孩子',
    );
  });

  await test('連同班同學也看不到', async () => {
    await assert.rejects(
      () => guardianLib.childView(mom.id, ctx.xiaohua.id),
      /不是你的孩子/,
    );
    const kids = await guardianLib.childrenOf(mom.id);
    assert.ok(!kids.some((k) => k.displayName === '陳小華'));
  });

  await test('班級平均是聚合的數字，不帶任何一位同學的姓名或分數', async () => {
    const view = await guardianLib.childView(mom.id, ctx.daming.id);
    const json = JSON.stringify(view);
    for (const name of ['陳小華', '同學1', '同學2', '別班的孩子']) {
      assert.ok(!json.includes(name), `${name} 的名字出現在家長的資料裡`);
    }
    assert.ok(!json.includes('"91"') && !json.includes(':91'), '同學的分數漏出去了');
  });

  section('直接打 API 也拿不到（每一項都配一條「學生自己拿得到」）');

  const momSession = asUser({ ...mom, tenantId: tenant.id });
  const studentSession = asUser({ ...ctx.daming, tenantId: tenant.id });

  await test('智慧老師的對話：家長 404、學生拿得到', async () => {
    const asGuardian = await callAs(
      momSession,
      routes.tutorSession.GET,
      `/api/tutor/${ctx.tutorSession.id}`,
      { params: { sessionId: ctx.tutorSession.id } },
    );
    assert.equal(asGuardian.status, 404, `家長拿到了 ${asGuardian.status}`);
    assert.ok(
      !asGuardian.text.includes('我是不是很笨'),
      '孩子求助的內容出現在家長的回應裡',
    );

    // 這一條證明上面那個 404 是「因為他是家長」，不是這支 API 壞了。
    const asStudent = await callAs(
      studentSession,
      routes.tutorSession.GET,
      `/api/tutor/${ctx.tutorSession.id}`,
      { params: { sessionId: ctx.tutorSession.id } },
    );
    assert.equal(asStudent.status, 200, '學生自己也打不開——那這支測試什麼都沒證明');
    assert.ok(asStudent.text.includes('我是不是很笨'), '學生應該看得到自己的對話');
  });

  await test('逐題作答：家長 403、學生拿得到', async () => {
    const asGuardian = await callAs(
      momSession,
      routes.attempt.GET,
      `/api/attempts/${ctx.damingAttempt.id}?full=1`,
      { params: { attemptId: ctx.damingAttempt.id } },
    );
    assert.equal(asGuardian.status, 403, `家長拿到了 ${asGuardian.status}`);
    assert.ok(!asGuardian.text.includes('質數'), '題目與作答內容漏出去了');

    const asStudent = await callAs(
      studentSession,
      routes.attempt.GET,
      `/api/attempts/${ctx.damingAttempt.id}`,
      { params: { attemptId: ctx.damingAttempt.id } },
    );
    assert.equal(asStudent.status, 200, '學生自己也拿不到——那這支測試什麼都沒證明');
  });

  await test('考試行為事件：家長寫不進去，也讀不到', async () => {
    const before = await prisma.proctorEvent.findMany({
      where: { attemptId: ctx.liveAttempt.id },
    });

    const asGuardian = await callAs(
      momSession,
      routes.proctor.POST,
      `/api/attempts/${ctx.liveAttempt.id}/proctor`,
      {
        params: { attemptId: ctx.liveAttempt.id },
        method: 'POST',
        json: { events: [{ type: 'TAB_HIDDEN', atOffsetMs: 1000 }] },
      },
    );
    assert.equal(asGuardian.body?.accepted, 0, '家長送的事件被收下了');
    const after = await prisma.proctorEvent.findMany({
      where: { attemptId: ctx.liveAttempt.id },
    });
    assert.equal(after.length, before.length, '家長在別人的作答上寫了一列行為事件');

    // 讀的那一側：家長端的資料裡一個字都沒有。行為事件沒有讀取 API
    // （老師是從頁面看的，而那一頁在 `/assignments` 底下，家長進不去），
    // 所以這裡驗的是家長真正拿得到的那一份。
    const view = await guardianLib.childView(mom.id, ctx.daming.id);
    const json = JSON.stringify(view);
    for (const trace of ['TAB_HIDDEN', 'proctor', '42000']) {
      assert.ok(!json.includes(trace), `考試行為的痕跡（${trace}）出現在家長的資料裡`);
    }

    // 學生自己送得進去——證明這支 API 是活的。
    const asStudent = await callAs(
      studentSession,
      routes.proctor.POST,
      `/api/attempts/${ctx.liveAttempt.id}/proctor`,
      {
        params: { attemptId: ctx.liveAttempt.id },
        method: 'POST',
        json: { events: [{ type: 'TAB_HIDDEN', atOffsetMs: 1000 }] },
      },
    );
    assert.equal(asStudent.body?.accepted, 1, '學生自己也送不進去——那這支測試什麼都沒證明');
  });

  await test('家長打不了家長管理 API（那是給職員的）', async () => {
    const list = await callAs(
      momSession,
      routes.guardians.GET,
      `/api/guardians?studentId=${ctx.daming.id}`,
    );
    assert.equal(list.status, 403, '家長讀得到自己孩子還有哪些家長');

    const add = await callAs(momSession, routes.guardians.POST, '/api/guardians', {
      method: 'POST',
      json: { studentId: ctx.outsider.id, email: ctx.momEmail },
    });
    assert.equal(add.status, 403, '家長把自己接到別人的孩子身上了');

    const del = await callAs(
      momSession,
      routes.guardianLink.DELETE,
      `/api/guardians/${momLink.id}`,
      { params: { linkId: momLink.id }, method: 'DELETE' },
    );
    assert.equal(del.status, 403);

    const batch = await callAs(
      momSession,
      routes.classGuardians.POST,
      `/api/classes/${ctx.classA.id}/guardians`,
      { params: { classId: ctx.classA.id }, method: 'POST' },
    );
    assert.equal(batch.status, 403, '家長跑得動整班的家長帳號建立');

    // 職員打同一支拿得到——證明上面四個 403 不是因為 API 壞了。
    const asAdmin = await callAs(
      asUser({ ...ctx.admin, tenantId: tenant.id }),
      routes.guardians.GET,
      `/api/guardians?studentId=${ctx.daming.id}`,
    );
    assert.equal(asAdmin.status, 200, '職員也拿不到——那這支測試什麼都沒證明');
    assert.equal(asAdmin.body.guardians.length, 1);
    assert.equal(asAdmin.body.guardians[0].children, 2, '這位家長接著兩個孩子');
  });

  await test('學生打不了家長管理 API', async () => {
    const r = await callAs(
      studentSession,
      routes.guardians.GET,
      `/api/guardians?studentId=${ctx.xiaohua.id}`,
    );
    assert.equal(r.status, 403, '學生查得到同學的家長聯絡資料');
  });

  section('移除連結');

  await test('職員移除之後，家長立刻看不到那個孩子', async () => {
    const r = await callAs(
      asUser({ ...ctx.admin, tenantId: tenant.id }),
      routes.guardianLink.DELETE,
      `/api/guardians/${momLink.id}`,
      { params: { linkId: momLink.id }, method: 'DELETE' },
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.archived, false, '她還有一個孩子，帳號不該被停用');

    const kids = await guardianLib.childrenOf(mom.id);
    assert.deepEqual(kids.map((k) => k.displayName), ['王小美']);
    await assert.rejects(
      () => guardianLib.childView(mom.id, ctx.daming.id),
      /不是你的孩子/,
      '連結移除了還看得到',
    );
  });

  await test('最後一個孩子也移除時，帳號一併停用而且被登出', async () => {
    await prisma.session.create({
      data: {
        sessionToken: `tok-${stamp}`,
        userId: mom.id,
        expires: new Date(Date.now() + 3600_000),
      },
    });
    const last = await prisma.guardianLink.findFirst({ where: { guardianId: mom.id } });
    await guardianLib.unlinkGuardian(last.id, ctx.admin.id);

    const after = await prisma.user.findFirst({ where: { id: mom.id } });
    assert.equal(after.status, 'ARCHIVED', '一個沒有孩子的家長帳號還登得進來');
    const sessions = await prisma.session.findMany({ where: { userId: mom.id } });
    assert.equal(sessions.length, 0, '正在看的那個分頁還活著');
    assert.equal((await guardianLib.childrenOf(mom.id)).length, 0);
  });

  await test('重新接上時帳號自動恢復', async () => {
    await guardianLib.linkGuardian(mom.id, ctx.daming.id, ctx.admin.id);
    const after = await prisma.user.findFirst({ where: { id: mom.id } });
    assert.equal(after.status, 'ACTIVE', '重新接上之後家長還是登不進去');
    assert.equal((await guardianLib.childrenOf(mom.id)).length, 1);
  });

  await test('移除都留下稽核（誰、什麼時候、哪一位學生）', async () => {
    const logs = await prisma.auditLog.findMany({ where: { action: 'guardian.unlink' } });
    assert.equal(logs.length, 2, '兩次移除應該留兩列');
    assert.ok(logs.every((l) => l.actorId === ctx.admin.id));
    assert.ok(logs.some((l) => l.after.guardianArchived === true), '停用那一次要記得出來');
  });

  section('租戶隔離');

  await test('別家補習班看不到這些連結', async () => {
    const other = await withoutTenantScope('建立第二個租戶', () =>
      raw.tenant.create({ data: { name: `隔壁補習班 ${stamp}` } }),
    );
    const seen = await withTenant(other.id, () => prisma.guardianLink.findMany({}));
    assert.equal(seen.length, 0, 'RLS 沒有隔開——隔壁看得到你的家長連結');
  });
});

console.log(
  `\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} 通過，${failed} 失敗\x1b[0m\n`,
);
await raw.$disconnect();
// 打包出來的東西住在 node_modules 底下，跑完就收掉——不收的話
// 每跑一次就多一個目錄，而它們看起來像是某個套件。
rmSync(outDir, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
