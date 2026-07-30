/**
 * 級分預測與個申落點對真的 Postgres 的端到端驗證。
 *
 * 預測的方法、四個不確定性來源、校準曲線的計算、篩選邏輯、跨科相關性
 * 與三檔可靠度有 87 個單元測試（apps/web/tests/predict.test.mjs、
 * placement.test.mjs）。**這一支不重複測它們。** 它驗的是跨越資料庫與
 * HTTP 邊界之後還對不對：
 *
 *   · 級分的範圍在**真的 CHECK 約束**上真的擋得住，而路由層先給一句人話
 *   · **信心水準不可以是 1** 這條 CHECK 真的在（1 代表保證）
 *   · 樣本不足的科目**寫不進 `GradePrediction`**，而回應說得出跳過幾科
 *     ——編一個區間補進去會讓校準曲線看起來很健康，卻剛好毀掉唯一能
 *     檢查樣本門檻訂得對不對的機制
 *   · 學生看得到的 payload 裡**沒有任何單一級分的點估計**（`basis.center`
 *     被投影濾掉）。這一條在單元測試裡看不到，因為那一層本來就回得出它
 *   · 同一個預測**不重複落地**，否則校準曲線的每一筆權重會變成
 *     「這位學生重整了幾次頁面」
 *   · 輸入真正的學測級分 → 歷次預測**自動回填** → 校準曲線算得出來。
 *     回填掛在成績輸入上而不是一顆獨立的按鈕，因為獨立的按鈕永遠不會
 *     被按，而校準曲線會永遠是空的
 *   · 落點：**同樣的輸入給同樣的結果**（學生會重整頁面）
 *   · 落點：可靠度低於 0.4 的志願顯示「無法估計」而不是一個數字
 *   · `SimulationRun` 存得下輸入快照，含種子——「上週看到的是 60%，
 *     現在怎麼變 45%」要答得出來
 *   · RLS：隔壁補習班的級分、預測與模擬不會出現在這一家
 *
 * # 為什麼要在這裡再測一次「thin 不落地」
 *
 * 因為那是一個**寫入路徑**的決定，而純函式那一層測不到：`predictGrade()`
 * 回 `interval: null` 之後，是這一層決定「不寫」還是「編一個」。
 * 編一個的後果不是當機，是校準曲線多了幾百筆永遠命中的假資料。
 *
 * # 為什麼用 pg-shim 而不是 PrismaClient
 *
 * 理由見 tools/pg-shim.mjs 的檔頭：Prisma 的查詢引擎要從外部網域下載，
 * 而這套系統要部署的補習班機房是封閉網段。shim 從同一份 schema 取得
 * 欄位對應，所以欄位名寫錯一樣會被抓到。
 *
 * 用法（只需要 Postgres，不需要 Redis、S3、AI 服務，也不需要網路）：
 *
 *   su postgres -c "psql -c \"CREATE ROLE yunzhi_pred LOGIN PASSWORD 'predpw' CREATEDB\""
 *   su postgres -c "psql -c 'CREATE DATABASE yunzhi_pred OWNER yunzhi_pred'"
 *   su postgres -c "psql -d yunzhi_pred -c 'CREATE EXTENSION vector'"
 *   su postgres -c "psql -d yunzhi_pred -c 'CREATE EXTENSION pg_trgm'"
 *   DATABASE_URL=postgresql://yunzhi_pred:predpw@127.0.0.1:5432/yunzhi_pred \
 *     npx prisma migrate deploy --schema packages/db/schema.prisma
 *   DATABASE_URL=postgresql://yunzhi_pred:predpw@127.0.0.1:5432/yunzhi_pred \
 *     node tools/e2e-predict.mjs
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

/** bcrypt 格式的假雜湊。長度合法但對不上任何密碼。 */
const HASH = '$2a$12$notarealhashnotarealhashnotarealhashnotarealhashnotar';

// ─────────────────────────────────────────────────────────────
// Prisma 替身的補丁。與 tools/e2e-admission-ref.mjs 同一份。
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
          if (op === 'upsert') {
            return async ({ where, create, update }) => {
              const flat = Object.values(where)[0];
              const k = flat && typeof flat === 'object' ? flat : where;
              const found = await m.findFirst({ where: k });
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

// ─────────────────────────────────────────────────────────────
// 把真的程式碼打包起來
// ─────────────────────────────────────────────────────────────

const outDir = mkdtempSync(path.join(ROOT, 'node_modules', '.yz-e2e-predict-'));

const shimPath = path.join(outDir, 'prisma-shim.mjs');
writeFileSync(shimPath, 'export const prisma = globalThis.__YZ_PRED_PRISMA__;\n');

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
globalThis.__YZ_PRED_PRISMA__ = prisma;

const { NextRequest } = await import('next/dist/server/web/spec-extension/request.js');

const routes = {
  grades: await bundle('app/api/admission/grades/route.ts'),
  grade: await bundle('app/api/admission/grades/[recordId]/route.ts'),
  predict: await bundle('app/api/admission/predict/route.ts'),
  placement: await bundle('app/api/admission/placement/route.ts'),
  calibration: await bundle('app/api/admission/calibration/route.ts'),
  wishes: await bundle('app/api/admission/wishes/route.ts'),
  refs: await bundle('app/api/admission/refs/route.ts'),
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

/**
 * 學年度。**這個數字決定學測日期**（民國 Y 學年度的學測在西元
 * 1911+Y+1 年的 1 月），而學測日期決定剩餘時間那一項不確定性。
 */
const YEAR = admissionYearOf();
/** 這個學年度的學測。回填實際成績時的考試日期要落在這一天附近。 */
const GSAT_DAY = `${1911 + YEAR + 1}-01-20`;
const stamp = Date.now();

// ── 種子 ─────────────────────────────────────────────────────

/**
 * 一家補習班：一位老師、一位管理員、三位學生。
 *
 * 兩家用同一個函式建，理由與 tools/e2e-admission-ref.mjs 相同：兩邊的
 * 資料形狀一模一樣、只有 tenantId 不同，所以任何一列跨界出現在對方的
 * 結果裡都只可能是隔離漏了。
 */
async function seedTenant(spec) {
  const tenant = await withoutTenantScope('建立測試用的補習班', () =>
    raw.tenant.create({ data: { name: `${spec.tag} 級分預測 e2e ${stamp}` } }),
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
    const students = [];
    for (const [i, n] of ['甲一', '乙二', '丙三'].entries()) {
      students.push(await mk(`S${String(i + 1).padStart(2, '0')}`, `${spec.tag}的${n}`, 'STUDENT'));
    }
    return { tenant, admin, teacher, students };
  });
}

// ── 常用的請求 ───────────────────────────────────────────────

const addGrade = (actor, body) =>
  callAs(asUser(actor), routes.grades.POST, '/api/admission/grades', { method: 'POST', json: body });

const getGrades = (actor, qs = '') =>
  callAs(asUser(actor), routes.grades.GET, `/api/admission/grades?year=${YEAR}${qs}`);

const savePredictions = (actor, body = {}) =>
  callAs(asUser(actor), routes.predict.POST, '/api/admission/predict', {
    method: 'POST',
    json: { year: YEAR, ...body },
  });

const getCalibration = (actor) =>
  callAs(asUser(actor), routes.calibration.GET, '/api/admission/calibration');

const runPlacement = (actor) =>
  callAs(asUser(actor), routes.placement.POST, '/api/admission/placement', {
    method: 'POST',
    json: { year: YEAR, draws: 4000 },
  });

const addApplyWish = (actor, institutionName, programName, rank) =>
  callAs(asUser(actor), routes.wishes.POST, '/api/admission/wishes', {
    method: 'POST',
    json: { year: YEAR, channel: 'APPLY', rank, institutionName, programName },
  });

const addRef = (actor, body) =>
  callAs(asUser(actor), routes.refs.POST, '/api/admission/refs', { method: 'POST', json: body });

/** 四次模考，日期落在學測前的那個秋冬。 */
const MOCKS = [
  { examName: '模考一', examDate: `${1911 + YEAR}-09-15`, grade: 10 },
  { examName: '模考二', examDate: `${1911 + YEAR}-10-15`, grade: 11 },
  { examName: '模考三', examDate: `${1911 + YEAR}-11-15`, grade: 11 },
  { examName: '模考四', examDate: `${1911 + YEAR}-12-15`, grade: 12 },
];

const mockFor = (subjectCode, i, over = {}) => ({
  subjectCode,
  ...MOCKS[i],
  source: 'EXTERNAL_MOCK',
  ...over,
});

async function main() {
  const home = await seedTenant({ tag: '本家', prefix: `H${stamp}` });
  const other = await seedTenant({ tag: '隔壁', prefix: `O${stamp}` });
  const [jiayi, yier] = home.students;

  // ═══════════════════════════════════════════════════════════
  section('一、級分記錄：資料庫的 CHECK 與路由層的人話');
  // ═══════════════════════════════════════════════════════════

  await withTenant(home.tenant.id, async () => {
    await test('級分填成百分制（78）被擋，而且訊息說得出這一欄是級分', async () => {
      const r = await addGrade(jiayi, mockFor('MATH_A', 0, { grade: 78 }));
      assert.equal(r.status, 400, r.text);
      assert.match(r.body.error, /級分/);
      assert.match(r.body.error, /0 到 15/);
    });

    await test('★ 真的 CHECK 約束也擋得住（不是只有路由層在擋）', async () => {
      await assert.rejects(
        () =>
          prisma.subjectGradeRecord.create({
            data: {
              tenantId: home.tenant.id,
              userId: jiayi.id,
              subjectCode: 'MATH_A',
              examName: '繞過路由的那一次',
              examDate: new Date(`${1911 + YEAR}-09-15`),
              grade: 78,
              source: 'EXTERNAL_MOCK',
              enteredBy: jiayi.id,
            },
          }),
        /grade_range|violates check constraint/i,
      );
    });

    await test('來源不在三種之內時擋得住（CHECK 有一條在管這件事）', async () => {
      const r = await addGrade(jiayi, mockFor('MATH_A', 0, { source: 'SOMEWHERE' }));
      assert.equal(r.status, 400, r.text);
    });

    await test('考試日期在未來被擋（年份打錯的那一次）', async () => {
      const r = await addGrade(jiayi, mockFor('MATH_A', 0, { examDate: '2099-01-01' }));
      assert.equal(r.status, 400, r.text);
      assert.match(r.body.error, /年份打錯/);
    });

    await test('四次數學A的級分存進去了', async () => {
      for (let i = 0; i < 4; i += 1) {
        const r = await addGrade(jiayi, mockFor('MATH_A', i));
        assert.equal(r.status, 200, r.text);
      }
      const rows = await prisma.subjectGradeRecord.findMany({
        where: { userId: jiayi.id, subjectCode: 'MATH_A' },
      });
      assert.equal(rows.length, 4);
      assert.equal(rows[0].enteredBy, jiayi.id);
    });

    await test('★ 同一場考試同一科不能有兩個級分（趨勢與波動會算錯）', async () => {
      const r = await addGrade(jiayi, mockFor('MATH_A', 0, { grade: 15 }));
      assert.equal(r.status, 400, r.text);
      assert.match(r.body.error, /已經輸入過/);
    });

    await test('國文與英文各四次，自然刻意只有兩次（留在樣本門檻之下）', async () => {
      for (let i = 0; i < 4; i += 1) {
        assert.equal((await addGrade(jiayi, mockFor('CHINESE', i, { grade: 11 }))).status, 200);
        assert.equal(
          (await addGrade(jiayi, mockFor('ENGLISH', i, { grade: 12 + (i % 2) }))).status,
          200,
        );
      }
      // 自然只有兩次：兩次算不出成績波動（兩次剛好同分的話會算出 0），
      // 所以它會被標成 thin 而且不給區間。這一科的存在是為了驗那條路。
      for (let i = 0; i < 2; i += 1) {
        assert.equal((await addGrade(jiayi, mockFor('SCIENCE', i, { grade: 9 }))).status, 200);
      }
    });

    await test('老師不能替學生輸入（這一階段沒有代輸入的路徑）', async () => {
      const r = await addGrade(home.teacher, mockFor('SOCIAL', 0));
      assert.equal(r.status, 403);
    });
  });

  // ═══════════════════════════════════════════════════════════
  section('二、預測：區間、樣本門檻、以及不外洩點估計');
  // ═══════════════════════════════════════════════════════════

  await withTenant(home.tenant.id, async () => {
    await test('GET 回四科的預測，而且沒有記錄的科目列在 withoutRecords', async () => {
      const r = await getGrades(jiayi);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.predictions.length, 4);
      assert.ok(r.body.withoutRecords.includes('SOCIAL'));
      assert.ok(r.body.withoutRecords.includes('MATH_B'));
      assert.ok(r.body.examDate.startsWith(String(1911 + YEAR + 1)));
    });

    await test('★ 只有兩次記錄的科目標成 thin，而且**沒有區間**', async () => {
      const r = await getGrades(jiayi);
      const ch = r.body.predictions.find((p) => p.subjectCode === 'SCIENCE');
      assert.equal(ch.thin, true);
      assert.equal(ch.interval, null, '硬給一個區間的話，那個寬度來自預設值而不是他的成績');
      assert.equal(ch.distribution, null);
      assert.match(ch.reason, /資料不足/);
    });

    await test('四次記錄的科目有區間，而且區間不是單一級分', async () => {
      const r = await getGrades(jiayi);
      for (const code of ['MATH_A', 'ENGLISH']) {
        const p = r.body.predictions.find((x) => x.subjectCode === code);
        assert.equal(p.thin, false, code);
        assert.ok(p.interval, `${code} 沒有區間`);
        assert.ok(p.interval.high > p.interval.low, `${code} 的區間是單一級分`);
        assert.ok(p.interval.confidence > 0 && p.interval.confidence < 1, `${code} 的信心是 1`);
        assert.equal(p.distribution.length, 16);
        const sum = p.distribution.reduce((a, d) => a + d.p, 0);
        assert.ok(Math.abs(sum - 1) < 1e-3, `${code} 的分布總和是 ${sum}`);
      }
    });

    await test('★ 學生看得到的 payload 裡沒有任何單一級分的點估計', async () => {
      // 規格書 §6.3：介面上不存在呈現單一級分數字的路徑。`basis.center`
      // 留在純函式裡是為了校準與稽核，但它**不能傳到前端**——傳過去的話，
      // 遲早有人為了畫面方便把它印出來，而那時整條原則就沒了。
      const r = await getGrades(jiayi);
      const json = JSON.stringify(r.body.predictions);
      for (const banned of ['center', 'weightedMean', 'improvement', 'slopePerMonth']) {
        assert.ok(!json.includes(banned), `payload 裡出現了 ${banned}`);
      }
      // 但四個不確定性來源要在——它們對應到學生做得到的事。
      const p = r.body.predictions.find((x) => x.subjectCode === 'MATH_A');
      assert.deepEqual(Object.keys(p.basis.variance).sort(), ['diff', 'disp', 'drift', 'scale']);
    });

    await test('信心水準切到 0.9 時區間變寬', async () => {
      const a = await getGrades(jiayi, '&confidence=0.6');
      const b = await getGrades(jiayi, '&confidence=0.9');
      const w = (r) => {
        const p = r.body.predictions.find((x) => x.subjectCode === 'MATH_A');
        return p.interval.high - p.interval.low;
      };
      assert.ok(w(b) >= w(a), `0.9 的區間 ${w(b)} 應該不窄於 0.6 的 ${w(a)}`);
    });

    await test('學生看不到別人的級分記錄', async () => {
      const r = await getGrades(yier);
      assert.equal(r.body.records.length, 0);
      assert.equal(r.body.predictions.length, 0);
    });
  });

  // ═══════════════════════════════════════════════════════════
  section('三、落地與校準');
  // ═══════════════════════════════════════════════════════════

  await withTenant(home.tenant.id, async () => {
    await test('★ 落地時 thin 的科目被跳過，而且回應說得出跳過幾科', async () => {
      const r = await savePredictions(jiayi);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.saved.saved, 3, '數學A、國文、英文');
      assert.equal(r.body.saved.skipped.length, 1, '自然只有兩次記錄');
      assert.equal(r.body.saved.skipped[0].subjectCode, 'SCIENCE');

      const rows = await prisma.gradePrediction.findMany({ where: { userId: jiayi.id } });
      assert.equal(rows.length, 3);
      for (const row of rows) {
        assert.equal(row.targetYear, YEAR);
        assert.ok(row.intervalHigh > row.intervalLow);
        assert.ok(row.confidence > 0 && row.confidence < 1);
        assert.equal(row.thin, false);
        assert.equal(row.actualGrade, null);
      }
      // **自然沒有被編一個區間存進去。** 那樣做會讓校準曲線多幾百筆
      // 假資料，而它剛好毀掉唯一能檢查樣本門檻訂得對不對的機制。
      assert.ok(!rows.some((x) => x.subjectCode === 'SCIENCE'));
    });

    await test('★ 信心水準是 1 的預測存不進去（1 代表保證）', async () => {
      await assert.rejects(
        () =>
          prisma.gradePrediction.create({
            data: {
              tenantId: home.tenant.id,
              userId: jiayi.id,
              subjectCode: 'SOCIAL',
              targetYear: YEAR,
              intervalLow: 0,
              intervalHigh: 15,
              confidence: 1,
              distribution: [],
              basis: {},
            },
          }),
        /confidence_range|violates check constraint/i,
      );
    });

    await test('區間上下界反了也存不進去', async () => {
      await assert.rejects(
        () =>
          prisma.gradePrediction.create({
            data: {
              tenantId: home.tenant.id,
              userId: jiayi.id,
              subjectCode: 'SOCIAL',
              targetYear: YEAR,
              intervalLow: 13,
              intervalHigh: 11,
              confidence: 0.7,
              distribution: [],
              basis: {},
            },
          }),
        /interval_ordered|violates check constraint/i,
      );
    });

    await test('★ 同一個預測不會重複落地（否則校準曲線量的是重整次數）', async () => {
      const r = await savePredictions(jiayi);
      assert.equal(r.body.saved.saved, 0);
      assert.equal(r.body.saved.unchanged, 3);
      const rows = await prisma.gradePrediction.findMany({ where: { userId: jiayi.id } });
      assert.equal(rows.length, 3, '又多存了一份');
    });

    await test('多考一次之後才算一次新的預測', async () => {
      const add = await addGrade(jiayi, {
        subjectCode: 'MATH_A',
        examName: '模考五',
        examDate: `${1911 + YEAR + 1}-01-05`,
        grade: 13,
        source: 'EXTERNAL_MOCK',
      });
      assert.equal(add.status, 200, add.text);
      const r = await savePredictions(jiayi);
      assert.ok(r.body.saved.saved >= 1, '數學A的樣本數變了，要多存一份');
      const rows = await prisma.gradePrediction.findMany({
        where: { userId: jiayi.id, subjectCode: 'MATH_A' },
      });
      assert.ok(rows.length >= 2);
    });

    await test('校準曲線在還沒有實際成績時說得出「要等學測成績公布」', async () => {
      const r = await getCalibration(home.teacher);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.overall.scored, 0);
      assert.ok(r.body.overall.pending >= 3);
      assert.match(r.body.overall.verdict, /等學測成績公布/);
    });

    await test('★ 輸入真正的學測級分 → 歷次預測自動回填實際成績', async () => {
      // 回填掛在成績輸入上而不是一顆獨立的按鈕：獨立的按鈕永遠不會被按，
      // 而校準曲線會永遠是空的，然後沒有人知道這套預測準不準。
      const r = await addGrade(jiayi, {
        subjectCode: 'MATH_A',
        examName: `${YEAR} 學測`,
        examDate: GSAT_DAY,
        grade: 12,
        source: 'OFFICIAL_GSAT',
      });
      assert.equal(r.status, 200, r.text);
      assert.ok(r.body.backfilled >= 2, `只回填了 ${r.body.backfilled} 份`);

      const rows = await prisma.gradePrediction.findMany({
        where: { userId: jiayi.id, subjectCode: 'MATH_A' },
      });
      assert.ok(rows.length >= 2);
      for (const row of rows) assert.equal(row.actualGrade, 12);
      // 英文那幾份沒有被動到——回填只碰同一科。
      const en = await prisma.gradePrediction.findMany({
        where: { userId: jiayi.id, subjectCode: 'ENGLISH' },
      });
      assert.ok(en.every((x) => x.actualGrade === null));
    });

    await test('★ 校準曲線算得出來，而且小樣本標成「還下不了結論」', async () => {
      const r = await getCalibration(home.teacher);
      assert.equal(r.status, 200, r.text);
      assert.ok(r.body.overall.scored >= 2);
      assert.ok(r.body.overall.totals.hitRate !== null);
      assert.ok(r.body.overall.totals.expected !== null);
      // 兩三筆資料不可以產生告警——第一屆天天紅字的話，這個告警會被關掉。
      assert.equal(r.body.overall.alerts.length, 0);
      assert.match(r.body.overall.verdict, /還下不了結論/);
      // 逐科也要有一份：偏離往往集中在某一科，而整體曲線會把它平掉。
      const math = r.body.bySubject.find((s) => s.subjectCode === 'MATH_A');
      assert.ok(math, '逐科的報告裡沒有數學A');
      assert.ok(math.curve.scored >= 2);
      const sci = r.body.bySubject.find((s) => s.subjectCode === 'SCIENCE');
      assert.equal(sci, undefined, '自然沒有落地過預測，不該出現在校準裡');
    });

    await test('★ 校準偏離時真的會告警（餵 40 筆全部落在區間外）', async () => {
      // 直接寫進資料庫而不是繞一圈：這一條驗的是**曲線的判斷**在真的
      // 資料上會亮，而不是預測本身準不準。
      for (let i = 0; i < 40; i += 1) {
        await prisma.gradePrediction.create({
          data: {
            tenantId: home.tenant.id,
            userId: yier.id,
            subjectCode: 'SOCIAL',
            targetYear: YEAR,
            intervalLow: 10,
            intervalHigh: 12,
            confidence: 0.7,
            distribution: [],
            basis: { records: 4 },
            // 全部落在區間外 → 命中率 0%，遠低於宣稱的 70%。
            actualGrade: 5,
          },
        });
      }
      const r = await getCalibration(home.teacher);
      assert.ok(r.body.overall.alerts.length >= 1, '應該有告警');
      const alert = r.body.overall.alerts.find((a) => a.severity === 'OVERCONFIDENT');
      assert.ok(alert, `告警是 ${JSON.stringify(r.body.overall.alerts)}`);
      assert.match(alert.text, /區間開得太窄/);
      assert.match(r.body.overall.verdict, /過度自信/);
    });

    await test('學生看不到校準報告，而 403 的訊息說得出為什麼', async () => {
      const r = await getCalibration(jiayi);
      assert.equal(r.status, 403);
      assert.match(r.body.error, /機構自己的品質報告/);
    });

    await test('管理員與學科召集人看得到', async () => {
      assert.equal((await getCalibration(home.admin)).status, 200);
    });
  });

  // ═══════════════════════════════════════════════════════════
  section('四、落點：門檻、可重現、三檔可靠度');
  // ═══════════════════════════════════════════════════════════

  const sieveRef = (over = {}) => ({
    year: YEAR - 1,
    channel: 'APPLY',
    kind: 'SIEVE_THRESHOLD',
    institutionName: '臺灣大學',
    programName: '資訊工程學系',
    raw: { subjects: '國文、數學A', grades: '10、10' },
    sourceKind: 'OFFICIAL_DOC',
    sourceRef: '委員會歷年篩選標準查詢',
    lookedUpAt: `${1911 + YEAR + 1}-01-25`,
    ...over,
  });

  await withTenant(home.tenant.id, async () => {
    await test('沒有志願時跑模擬不會炸，但也沒有東西可以算', async () => {
      const r = await runPlacement(jiayi);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.result.wishes.length, 0);
      assert.equal(r.body.result.combo.estimated, 0);
    });

    await test('建兩個個申志願，並輸入三年的篩選門檻（其中一個只有聽說的）', async () => {
      assert.equal((await addApplyWish(jiayi, '臺灣大學', '資訊工程學系', 1)).status, 200);
      assert.equal((await addApplyWish(jiayi, '清華大學', '電機工程學系', 2)).status, 200);

      for (const y of [YEAR - 1, YEAR - 2, YEAR - 3]) {
        const r = await addRef(jiayi, sieveRef({ year: y }));
        assert.equal(r.status, 200, r.text);
      }
      // 清華只有一筆，而且是聽同學說的 → 可靠度會低於 0.4。
      const r = await addRef(
        jiayi,
        sieveRef({
          year: YEAR - 2,
          institutionName: '清華大學',
          programName: '電機工程學系',
          raw: { subjects: '國文、數學A', grades: '11、11' },
          sourceKind: 'HEARSAY',
          sourceRef: '同班的小明說的',
        }),
      );
      assert.equal(r.status, 200, r.text);
    });

    let first = null;

    await test('★ 跑模擬：機率算得出來，而且每一個都帶著資料基礎', async () => {
      const r = await runPlacement(jiayi);
      assert.equal(r.status, 200, r.text);
      first = r.body;

      const ntu = r.body.result.wishes.find((w) => w.institutionName === '臺灣大學');
      assert.ok(ntu, '臺大那個志願不見了');
      assert.equal(typeof ntu.passRate, 'number');
      assert.ok(ntu.passRate > 0 && ntu.passRate < 1);
      // §8.4：用了哪幾年、可靠度分數、最後更新日期。
      assert.deepEqual(ntu.thresholdYears, [YEAR - 1, YEAR - 2, YEAR - 3]);
      assert.equal(typeof ntu.reliability.score, 'number');
      assert.ok(ntu.reliability.lookedUpAt, '沒有查詢日期');
      assert.equal(ntu.thresholdRefs.length, 3);
      assert.ok(ntu.thresholdRefs[0].sourceLabel);
      // 三年官方門檻且穩定 → 高於 0.7，正常呈現（三檔的最上面那一檔）。
      assert.ok(ntu.reliability.score > 0.7, `可靠度是 ${ntu.reliability.score}`);
      assert.equal(ntu.tier, 'NORMAL');
      // 篩選是依序的兩關，順序照他抄進來的順序。
      assert.deepEqual(
        ntu.stages.map((s) => s.subjects[0]),
        ['CHINESE', 'MATH_A'],
      );
      // 第二階段的界線要跟著每一次模擬走。
      assert.match(r.body.result.stageTwoNote, /不是錄取機率/);
    });

    await test('★ 可靠度低於 0.4 的志願顯示「無法估計」而不是一個數字', async () => {
      const nthu = first.result.wishes.find((w) => w.institutionName === '清華大學');
      assert.ok(nthu);
      assert.equal(nthu.passRate, null, '無法估計時不可以有數字');
      assert.equal(nthu.tier, 'NO_ESTIMATE');
      assert.ok(nthu.reliability.score < 0.4, `可靠度是 ${nthu.reliability.score}`);
      // 已知的門檻仍然要列出來供學生自行判斷（§8.4）。
      assert.equal(nthu.thresholdRefs.length, 1);
      assert.ok(nthu.notes.some((n) => /不會拿相近校系的數字推估/.test(n)));
      // 而且它不會被算成 0——組合統計裡它是「排除」而不是「零」。
      assert.equal(first.result.combo.excluded, 1);
      assert.ok(first.result.combo.warnings.some((w) => w.code === 'EXCLUDED'));
    });

    await test('★ SimulationRun 存下輸入快照，含種子與每一筆門檻的來源', async () => {
      const rows = await prisma.simulationRun.findMany({ where: { userId: jiayi.id } });
      assert.ok(rows.length >= 2);
      const latest = rows.sort((a, b) => new Date(b.runAt) - new Date(a.runAt))[0];
      assert.equal(latest.channel, 'APPLY');
      assert.equal(latest.year, YEAR);
      assert.equal(latest.draws, 4000);
      assert.ok(Number.isInteger(latest.input.seed));
      assert.ok(latest.input.marginals.MATH_A, '快照裡要有當時的級分分布');
      assert.equal(latest.input.thresholds.length, 4);
      assert.ok(latest.input.thresholds.every((t) => t.sourceKind && t.lookedUpAt));
      assert.ok(latest.dataAsOf, '沒有 dataAsOf');
    });

    await test('★ 同樣的輸入給同樣的結果（學生會重整頁面）', async () => {
      const again = await runPlacement(jiayi);
      assert.equal(again.status, 200, again.text);
      assert.equal(again.body.result.seed, first.result.seed, '種子應該一樣');
      assert.deepEqual(
        again.body.result.wishes.map((w) => [w.institutionName, w.passRate]),
        first.result.wishes.map((w) => [w.institutionName, w.passRate]),
      );
      assert.equal(again.body.result.combo.atLeastOne, first.result.combo.atLeastOne);
      assert.equal(again.body.result.combo.expectedPasses, first.result.combo.expectedPasses);
    });

    await test('★ 門檻改了之後結果才變，而且舊的那一次仍然查得回來', async () => {
      // 「上週看到的是 60%，現在怎麼變 45%」——答案是輸入變了，
      // 而每一次的快照都留著，所以說得出是哪一項變了。
      const r = await addRef(
        jiayi,
        sieveRef({ year: YEAR, raw: { subjects: '國文、數學A', grades: '12、12' } }),
      );
      assert.equal(r.status, 200, r.text);

      const after = await runPlacement(jiayi);
      const before = first.result.wishes.find((w) => w.institutionName === '臺灣大學');
      const now = after.body.result.wishes.find((w) => w.institutionName === '臺灣大學');
      assert.notEqual(after.body.result.seed, first.result.seed, '輸入變了種子就該變');
      assert.ok(now.passRate < before.passRate, `門檻變嚴了，通過率應該降：${before.passRate} → ${now.passRate}`);
      // 而且門檻跳動之後**可靠度跟著掉**：個申的門檻由當年報名者決定，
      // 跳動大代表歷年資料的參考價值低。這一檔照樣給機率，但強制標
      // 「不確定性較高」（規格書 §8.4 的中間那一檔）。
      assert.ok(now.reliability.score < before.reliability.score);
      assert.equal(now.tier, 'HIGH_UNCERTAINTY');
      // 歷史查得回來，而且每一次都帶著它當時用的資料日期。
      assert.ok(after.body.runs.length >= 3);
      assert.ok(after.body.runs.every((x) => x.dataAsOf && Number.isInteger(x.seed)));
    });

    await test('★ 用到的科目級分不足時也是「無法估計」，不是給一個假分布', async () => {
      // 社會科一筆記錄都沒有，所以用到它的志願算不出來。
      assert.equal((await addApplyWish(jiayi, '政治大學', '外交學系', 3)).status, 200);
      const r = await addRef(
        jiayi,
        sieveRef({
          year: YEAR - 1,
          institutionName: '政治大學',
          programName: '外交學系',
          raw: { subjects: '社會', grades: '11' },
        }),
      );
      assert.equal(r.status, 200, r.text);

      const out = await runPlacement(jiayi);
      const nccu = out.body.result.wishes.find((w) => w.institutionName === '政治大學');
      assert.equal(nccu.passRate, null);
      assert.equal(nccu.tier, 'NO_ESTIMATE');
      assert.ok(nccu.notes.some((n) => /資料不足/.test(n) && /社會/.test(n)));
      assert.ok(out.body.result.missingSubjects.includes('SOCIAL'));
    });

    await test('檢定標準抄進來之後會被逐次抽樣檢查', async () => {
      const r = await addRef(jiayi, {
        year: YEAR,
        channel: 'APPLY',
        kind: 'QUALIFY',
        institutionName: '臺灣大學',
        programName: '資訊工程學系',
        raw: { rules: '數學A 前標(14)、英文 均標(10)' },
        sourceKind: 'OFFICIAL_DOC',
        sourceRef: `${YEAR} 學年度個人申請招生簡章`,
        lookedUpAt: `${1911 + YEAR + 1}-01-25`,
      });
      assert.equal(r.status, 200, r.text);

      const out = await runPlacement(jiayi);
      const ntu = out.body.result.wishes.find((w) => w.institutionName === '臺灣大學');
      assert.equal(ntu.qualify.length, 2);
      assert.ok(ntu.qualify.some((q) => q.describe.includes('數學A 前標')));
      assert.equal(ntu.tier, 'HIGH_UNCERTAINTY');
      // 數學A 要 14 級分而他的分布中心在 12 附近 → 檢定就過不了的機率不低。
      assert.ok(ntu.qualifyFailRate > 0.3, `檢定不通過率只有 ${ntu.qualifyFailRate}`);
      assert.equal(ntu.undecidableQualify, 0, '兩條都有級分，不該有無法判定的');
    });

    await test('老師請不動落點模擬', async () => {
      const r = await runPlacement(home.teacher);
      assert.equal(r.status, 403);
    });
  });

  // ═══════════════════════════════════════════════════════════
  section('五、租戶隔離');
  // ═══════════════════════════════════════════════════════════

  await withTenant(other.tenant.id, async () => {
    await test('隔壁的學生也輸入級分（數字刻意不同）', async () => {
      for (let i = 0; i < 4; i += 1) {
        const r = await addGrade(other.students[0], mockFor('MATH_A', i, { grade: 3 }));
        assert.equal(r.status, 200, r.text);
      }
      const r = await savePredictions(other.students[0]);
      assert.ok(r.body.saved.saved >= 1);
    });

    await test('隔壁的學生也跑一次落點（三張表都要有兩家的資料，RLS 才驗得出來）', async () => {
      assert.equal((await addApplyWish(other.students[0], '臺灣大學', '資訊工程學系', 1)).status, 200);
      const ref = await addRef(other.students[0], {
        year: YEAR - 1,
        channel: 'APPLY',
        kind: 'SIEVE_THRESHOLD',
        institutionName: '臺灣大學',
        programName: '資訊工程學系',
        raw: { subjects: '數學A', grades: '2' },
        sourceKind: 'OFFICIAL_DOC',
        sourceRef: '隔壁查的',
        lookedUpAt: `${1911 + YEAR + 1}-01-25`,
      });
      assert.equal(ref.status, 200, ref.text);
      const run = await runPlacement(other.students[0]);
      assert.equal(run.status, 200, run.text);
      const rows = await prisma.simulationRun.findMany({ where: { userId: other.students[0].id } });
      assert.ok(rows.length >= 1);
    });
  });

  await withTenant(home.tenant.id, async () => {
    await test('★ 隔壁的級分不會出現在本家的預測裡', async () => {
      const r = await getGrades(jiayi);
      const json = JSON.stringify(r.body);
      assert.ok(!json.includes(other.students[0].id));
      assert.ok(!json.includes(other.students[0].username));
      const math = r.body.predictions.find((p) => p.subjectCode === 'MATH_A');
      // 隔壁那四筆都是 3 級分。混進來的話區間會被拉到很低。
      assert.ok(math.interval.low >= 8, `區間下界是 ${math.interval.low}，隔壁的資料混進來了？`);
    });

    await test('★ 隔壁的預測不會出現在本家的校準報告裡', async () => {
      const r = await getCalibration(home.teacher);
      const scoped = await prisma.gradePrediction.findMany({});
      assert.ok(scoped.every((x) => x.tenantId === home.tenant.id));
      assert.equal(r.body.total, scoped.length);
    });

    await test('學生刪不掉同學的級分記錄（404，與「不存在」同一個回應）', async () => {
      const mine = await prisma.subjectGradeRecord.findMany({ where: { userId: jiayi.id } });
      assert.ok(mine.length > 0);
      const r = await callAs(
        asUser(yier),
        routes.grade.DELETE,
        `/api/admission/grades/${mine[0].id}`,
        { method: 'DELETE', params: { recordId: mine[0].id } },
      );
      assert.equal(r.status, 404);
      const still = await prisma.subjectGradeRecord.findFirst({ where: { id: mine[0].id } });
      assert.ok(still, '資料被別人刪掉了');
    });

    await test('學生刪不掉隔壁補習班的級分記錄', async () => {
      const theirs = await withTenant(other.tenant.id, () =>
        prisma.subjectGradeRecord.findMany({ where: { userId: other.students[0].id } }),
      );
      assert.ok(theirs.length > 0);
      const r = await callAs(
        asUser(jiayi),
        routes.grade.DELETE,
        `/api/admission/grades/${theirs[0].id}`,
        { method: 'DELETE', params: { recordId: theirs[0].id } },
      );
      assert.equal(r.status, 404);
    });
  });

  await test('★ 三張表的每一家都只看得到自己的（RLS 濾掉的，不是表裡只有那幾列）', async () => {
    for (const table of ['subjectGradeRecord', 'gradePrediction', 'simulationRun']) {
      for (const [t, tag] of [
        [home.tenant.id, '本家'],
        [other.tenant.id, '隔壁'],
      ]) {
        const scoped = await withTenant(t, () => prisma[table].findMany({}));
        const direct = await withoutTenantScope('驗證兩家的資料都在同一張表裡', () =>
          raw[table].findMany({ where: { tenantId: t } }),
        );
        assert.equal(scoped.length, direct.length, `${tag} 的 ${table} 筆數對不上`);
        assert.ok(scoped.every((r) => r.tenantId === t), `${tag} 在 ${table} 看到了別家的列`);
      }
      const both = await withoutTenantScope('驗證兩家合計都在同一張表裡', () =>
        raw[table].findMany({
          where: { tenantId: { in: [home.tenant.id, other.tenant.id] } },
        }),
      );
      const homeOnly = await withTenant(home.tenant.id, () => prisma[table].findMany({}));
      assert.ok(both.length > homeOnly.length, `${table}：RLS 沒有濾掉任何東西？`);
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
