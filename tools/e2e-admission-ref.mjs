/**
 * 「學生自己查資料」那一段對真的 Postgres 的端到端驗證。
 *
 * 信任度、過期判定與假精確度的閘門有 94 個單元測試
 * （apps/web/tests/admissionRef.test.mjs、adviceGuard.test.mjs）。
 * **這一支不重複測它們。** 它驗的是跨越資料庫與 HTTP 邊界之後還對不對：
 *
 *   · 必填的來源與查詢日期在真的 schema 上真的擋得住（NOT NULL、
 *     CHECK 約束、以及路由層先擋一次給的人話訊息）
 *   · 學生輸入一筆 → 建議那一側吃得到（含來源標籤與查詢日期）
 *   · **過期的資料被標出來而不是被丟掉**——歷年趨勢是繁星唯一可用的
 *     東西，但它必須帶著「這是 114 學年度的，你現在看 115」
 *   · **學生自己輸入的在校百分比不影響其他學生看到的序位**
 *     ——這一項是本模組最惡劣的一種失效方式：受害者不是打錯字的那位
 *   · 閘門在真的請求路徑上會擋：AI 給機率 → 重生成 → 三次都不過 →
 *     退回只陳述事實的版本，而且回應裡說得出「這不是 AI 寫的」
 *   · 每一次建議都寫一列 AiUsageLog（AI 使用揭露的證據）
 *   · RLS：隔壁補習班的參考資料不會出現在這一家的建議裡
 *
 * # 為什麼要在這裡再測一次閘門
 *
 * 因為單元測試餵的是字串，而正式路徑上那段字串來自 HTTP、事實來自
 * Postgres。中間任何一段接錯（`adviceFacts()` 拿到空的 numbers、
 * `basis.references` 少了一欄）的症狀都是**閘門變成永遠不擋或永遠擋**，
 * 而兩種在單元測試裡都看不到。
 *
 * # 為什麼要 stub AI 服務而不是真的叫它
 *
 * 因為要控制它回什麼。這一支要驗的是「模型給了一個機率的時候會怎樣」，
 * 而真的模型不見得會給。stub 換掉的只有 `globalThis.fetch`——
 * 路由、閘門、重試迴圈、用量記錄全部是正式那一份。
 *
 * # 為什麼用 pg-shim 而不是 PrismaClient
 *
 * 理由見 tools/pg-shim.mjs 的檔頭：Prisma 的查詢引擎要從外部網域下載，
 * 而這套系統要部署的補習班機房是封閉網段。shim 從同一份 schema 取得
 * 欄位對應，所以欄位名寫錯一樣會被抓到。
 *
 * 用法（只需要 Postgres，不需要 Redis、S3、AI 服務，也不需要網路）：
 *
 *   su postgres -c "psql -c \"CREATE ROLE yunzhi_ref LOGIN PASSWORD 'refpw' CREATEDB\""
 *   su postgres -c "psql -c 'CREATE DATABASE yunzhi_ref OWNER yunzhi_ref'"
 *   su postgres -c "psql -d yunzhi_ref -c 'CREATE EXTENSION vector'"
 *   su postgres -c "psql -d yunzhi_ref -c 'CREATE EXTENSION pg_trgm'"
 *   DATABASE_URL=postgresql://yunzhi_ref:refpw@127.0.0.1:5432/yunzhi_ref \
 *     npx prisma migrate deploy --schema packages/db/schema.prisma
 *   DATABASE_URL=postgresql://yunzhi_ref:refpw@127.0.0.1:5432/yunzhi_ref \
 *     node tools/e2e-admission-ref.mjs
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
    console.error(`     ${String(e.message).split('\n').slice(0, 10).join('\n     ')}`);
    failed += 1;
  }
}

function section(name) {
  console.log(`\n\x1b[1m── ${name}\x1b[0m`);
}

/** bcrypt 格式的假雜湊。長度合法但對不上任何密碼。 */
const HASH = '$2a$12$notarealhashnotarealhashnotarealhashnotarealhashnotar';

// ─────────────────────────────────────────────────────────────
// Prisma 替身的補丁。與 tools/e2e-admission.mjs 同一份，
// 理由也相同：**每一個都刻意做得很笨。**
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
            // shim 沒有 upsert。用複合唯一鍵自己查一次再決定——
            // `AiBudgetCounter` 的 `[tenantId, yearMonth]` 走的就是這一段。
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

// ─────────────────────────────────────────────────────────────
// 把真的程式碼打包起來
// ─────────────────────────────────────────────────────────────

const outDir = mkdtempSync(path.join(ROOT, 'node_modules', '.yz-e2e-admref-'));

const shimPath = path.join(outDir, 'prisma-shim.mjs');
writeFileSync(shimPath, 'export const prisma = globalThis.__YZ_REF_PRISMA__;\n');

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
// AI 服務的替身
//
// **只換掉 `globalThis.fetch`。** 路由、閘門、重試迴圈、用量記錄全部
// 是正式那一份——換掉閘門就等於什麼都沒測到。
// ─────────────────────────────────────────────────────────────

/** 下一次（幾次）呼叫要回什麼。用完就重複最後一段。 */
let aiReplies = [];
let aiCalls = [];
/** 設成 true 時 fetch 直接失敗，用來驗「AI 服務沒起來」那條路。 */
let aiDown = false;

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  aiCalls.push({ url: String(url), body });
  if (aiDown) throw new Error('connect ECONNREFUSED（測試刻意讓 AI 服務掛掉）');
  const text = aiReplies.length > 1 ? aiReplies.shift() : (aiReplies[0] ?? '（沒有設定回應）');
  return new Response(
    JSON.stringify({
      text,
      model: 'stub/advice-1',
      provider: 'stub',
      input_tokens: 1200,
      output_tokens: 210,
      tokens_estimated: true,
      latency_ms: 42,
      prompt_version: 'e2e-stub',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};

function setAi(...replies) {
  aiReplies = replies;
  aiCalls = [];
  aiDown = false;
}

// ─────────────────────────────────────────────────────────────

const raw = createPgShim({
  connectionString: process.env.DATABASE_URL,
  schemaPath: 'packages/db/schema.prisma',
});
const prisma = adapt(raw);
globalThis.__YZ_REF_PRISMA__ = prisma;

const { NextRequest } = await import('next/dist/server/web/spec-extension/request.js');

const routes = {
  refs: await bundle('app/api/admission/refs/route.ts'),
  ref: await bundle('app/api/admission/refs/[refId]/route.ts'),
  advice: await bundle('app/api/admission/advice/route.ts'),
  wishes: await bundle('app/api/admission/wishes/route.ts'),
  ranks: await bundle('app/api/admission/ranks/route.ts'),
  star: await bundle('app/api/admission/star/route.ts'),
};

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

const YEAR = admissionYearOf();
const stamp = Date.now();

// ── 種子 ─────────────────────────────────────────────────────

/**
 * 一家補習班：一位管理員（＝繁星承辦）、一位老師、四位學生。
 *
 * 兩家用同一個函式建，理由與 tools/e2e-admission.mjs 相同：兩邊的資料
 * 形狀一模一樣、只有 tenantId 不同，所以任何一列跨界出現在對方的結果裡
 * 都只可能是隔離漏了。
 */
async function seedTenant(spec) {
  const tenant = await withoutTenantScope('建立測試用的補習班', () =>
    raw.tenant.create({ data: { name: `${spec.tag} 參考資料 e2e ${stamp}` } }),
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

    const names = ['甲一', '乙二', '丙三', '丁四'];
    const students = [];
    for (const [i, n] of names.entries()) {
      students.push(await mk(`S${String(i + 1).padStart(2, '0')}`, `${spec.tag}的${n}`, 'STUDENT'));
    }
    return { tenant, admin, teacher, students };
  });
}

// ── 常用的請求 ───────────────────────────────────────────────

const addRef = (actor, body) =>
  callAs(asUser(actor), routes.refs.POST, '/api/admission/refs', { method: 'POST', json: body });

const getRefs = (actor) =>
  callAs(asUser(actor), routes.refs.GET, `/api/admission/refs?year=${YEAR}`);

const askAdvice = (actor, question) =>
  callAs(asUser(actor), routes.advice.POST, '/api/admission/advice', {
    method: 'POST',
    json: { year: YEAR, question },
  });

const addStarWish = (actor, institutionName, starGroup, rank = 1) =>
  callAs(asUser(actor), routes.wishes.POST, '/api/admission/wishes', {
    method: 'POST',
    json: { year: YEAR, channel: 'STAR', rank, institutionName, starGroup },
  });

/** 一筆「繁星第一輪錄取標準」。 */
const round1 = (over = {}) => ({
  year: YEAR - 1,
  channel: 'STAR',
  kind: 'STAR_ROUND1',
  institutionName: '臺灣大學',
  starGroup: 2,
  raw: { percentile: 18 },
  sourceKind: 'OFFICIAL_DOC',
  sourceRef: 'https://www.cac.edu.tw/cacportal/index.php 的簡章 p.42',
  lookedUpAt: '2026-03-05',
  ...over,
});

/**
 * 一段通得過閘門的建議：有數字、有來源、有資料基礎。
 *
 * **刻意不提他自己的百分比。** 教務處那一份到第四節才匯入，而在那之前
 * 提一個「你的 12%」就是模型自己編的——閘門會擋，而那正是它該做的事。
 */
const GOOD_ADVICE = (nums) =>
  `你查到臺灣大學第 2 類學群第一輪最後一名錄取者的在校百分比是 ` +
  `${nums.join('%、')}%，來源是官方文件。` +
  '但這個判斷的資料基礎很薄：官方公布的只有最後一名錄取者的百分比，' +
  '而繁星校系第一輪名額常常只有 1 至 3 名，也就是每年只有一個極值資料點，' +
  '年際波動可能很大。教務處還沒有你的在校百分比，去問導師怎麼拿。';

/** 一段一定會被擋的建議：明說機率。 */
const ODDS_ADVICE =
  '依你查到的門檻，你的通過機率大約 68%，可以說相當有把握，' +
  '近三年平均錄取百分比是 16.5%。';

async function main() {
  const home = await seedTenant({ tag: '本家', prefix: `H${stamp}` });
  const other = await seedTenant({ tag: '隔壁', prefix: `O${stamp}` });
  const [jiayi, yier, bingsan, dingsi] = home.students;

  // ═══════════════════════════════════════════════════════════
  section('一、來源與查詢日期是必填的');
  // ═══════════════════════════════════════════════════════════

  await withTenant(home.tenant.id, async () => {
    await test('沒有來源類型存不進去', async () => {
      const { sourceKind, ...rest } = round1();
      void sourceKind;
      const r = await addRef(jiayi, rest);
      assert.equal(r.status, 400, r.text);
      assert.match(r.body.error, /來源類型/);
    });

    await test('來源填空白字串存不進去（NOT NULL 擋不掉 ""）', async () => {
      const r = await addRef(jiayi, round1({ sourceRef: '   ' }));
      assert.equal(r.status, 400, r.text);
      assert.match(r.body.error, /從哪裡查到的/);
    });

    await test('沒有查詢日期存不進去', async () => {
      const { lookedUpAt, ...rest } = round1();
      void lookedUpAt;
      const r = await addRef(jiayi, rest);
      assert.equal(r.status, 400, r.text);
      assert.match(r.body.error, /查到的日期/);
    });

    await test('查詢日期在未來會被擋（年份打錯的那一次）', async () => {
      const r = await addRef(jiayi, round1({ lookedUpAt: '2099-01-01' }));
      assert.equal(r.status, 400, r.text);
      assert.match(r.body.error, /年份打錯/);
    });

    await test('百分比填 PR 值會被擋，而且訊息說得出來', async () => {
      const r = await addRef(jiayi, round1({ raw: { percentile: 120 } }));
      assert.equal(r.status, 400, r.text);
      assert.match(r.body.error, /PR 值/);
    });

    await test('民國學年度以外的數字擋在路由層（不是等 CHECK 約束）', async () => {
      const r = await addRef(jiayi, round1({ year: 2025 }));
      assert.equal(r.status, 400, r.text);
      assert.match(r.body.error, /學年度/);
    });

    await test('「聽同學說的」存得進去（它是一個可以誠實選的選項）', async () => {
      const r = await addRef(
        jiayi,
        round1({
          year: YEAR - 3,
          raw: { percentile: 25 },
          sourceKind: 'HEARSAY',
          sourceRef: '同班的小明說的',
        }),
      );
      assert.equal(r.status, 200, r.text);
      const row = await prisma.admissionReference.findFirst({
        where: { userId: jiayi.id, year: YEAR - 3 },
      });
      assert.equal(row.sourceKind, 'HEARSAY');
      assert.equal(row.forSelfOnly, true, '學生自己輸入的一律 forSelfOnly');
      assert.equal(row.enteredBy, jiayi.id);
      assert.equal(row.staleAfterYear, YEAR - 3, '預設等於 year');
    });

    await test('三筆歷年門檻都存進去了', async () => {
      for (const [y, p] of [
        [YEAR - 1, 18],
        [YEAR - 2, 15],
      ]) {
        const r = await addRef(jiayi, round1({ year: y, raw: { percentile: p } }));
        assert.equal(r.status, 200, r.text);
      }
      const rows = await prisma.admissionReference.findMany({ where: { userId: jiayi.id } });
      assert.equal(rows.length, 3, '含前面那筆聽說的');
    });

    await test('當年度的簡章門檻存得進去（這一筆才會是最高一級）', async () => {
      const r = await addRef(jiayi, {
        year: YEAR,
        channel: 'STAR',
        kind: 'QUALIFY',
        institutionName: '臺灣大學',
        starGroup: 2,
        // 刻意不放阿拉伯數字：這一筆的內容會進入閘門的數字白名單，
        // 而後面有一項測試要驗「編出來的數字擋得住」。
        raw: { rules: '在校成績達全校前四分之一、數A均標、英文前標' },
        sourceKind: 'OFFICIAL_DOC',
        sourceRef: `${YEAR} 學年度繁星推薦招生簡章 p.42`,
        lookedUpAt: '2026-03-05',
      });
      assert.equal(r.status, 200, r.text);
    });

    await test('老師不能替學生輸入', async () => {
      const r = await addRef(home.teacher, round1({ year: YEAR - 1 }));
      assert.equal(r.status, 403);
    });
  });

  // ═══════════════════════════════════════════════════════════
  section('二、讀回來：信任度與過期');
  // ═══════════════════════════════════════════════════════════

  await withTenant(home.tenant.id, async () => {
    await test('每一筆都帶著來源標籤、查詢日期與信任度', async () => {
      const r = await getRefs(jiayi);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.references.length, 4);
      for (const x of r.body.references) {
        assert.ok(x.trust.sourceLabel, '沒有來源標籤');
        assert.ok(x.lookedUpAt, '沒有查詢日期');
        assert.ok(['SOLID', 'WORKABLE', 'WEAK'].includes(x.trust.level));
        // **不給分數。** 一個 0.72 的可信度本身就是一種假精確度。
        assert.ok(!('score' in x.trust));
      }
    });

    await test('★ 過期的資料被標出來，而不是被丟掉', async () => {
      const r = await getRefs(jiayi);
      const old = r.body.references.find((x) => x.year === YEAR - 3);
      assert.equal(old.trust.stale, true);
      assert.equal(old.trust.staleBy, 3);
      assert.equal(old.trust.level, 'WEAK', '聽說的 + 過期');
      assert.ok(
        old.trust.notes.some((n) => n.includes(`${YEAR - 3} 學年度的資料`) && n.includes(`${YEAR}`)),
        '過期的說明要把兩個學年度都講出來',
      );
      // 但它還在清單裡——歷年趨勢是繁星唯一可用的東西。
      assert.ok(r.body.references.some((x) => x.year === YEAR - 3));
    });

    await test('★ 當年度的官方文件才是最高一級；去年的官方文件只是「可以參考」', async () => {
      const r = await getRefs(jiayi);

      // 當年度的簡章：可以照著做決定。
      const thisYear = r.body.references.find((x) => x.year === YEAR);
      assert.equal(thisYear.trust.sourceLabel, '官方文件');
      assert.equal(thisYear.trust.stale, false);
      assert.equal(thisYear.trust.level, 'SOLID');

      // 去年的官方門檻：**降一級，但不是丟掉。** 歷年趨勢是繁星唯一
      // 可用的東西，而它不是今年的門檻——兩件事都要說得出來。
      const lastYear = r.body.references.find((x) => x.year === YEAR - 1);
      assert.equal(lastYear.trust.sourceLabel, '官方文件');
      assert.equal(lastYear.trust.stale, true);
      assert.equal(lastYear.trust.level, 'WORKABLE');
      assert.ok(lastYear.trust.notes.some((n) => n.includes('歷年趨勢仍然有參考價值')));
    });

    await test('資料缺口算得出來，而且每一條都帶著去哪裡查', async () => {
      const r = await getRefs(jiayi);
      // 兩年的門檻（YEAR-1、YEAR-2）加一筆過期的（YEAR-3）＝三個年份，
      // 所以不是「只有一年」。缺的是他自己的在校百分比。
      const codes = r.body.gaps.map((g) => g.code);
      assert.ok(codes.includes('NO_OWN_PERCENTILE'), `缺口是 ${codes.join('、')}`);
      for (const g of r.body.gaps) {
        assert.ok('url' in g, '缺口沒有帶網址欄位');
      }
    });

    await test('學生看不到別人輸入的資料', async () => {
      const r = await getRefs(yier);
      assert.equal(r.body.references.length, 0, '乙二應該什麼都沒有');
    });

    await test('老師打這一支會被擋', async () => {
      const r = await callAs(asUser(home.teacher), routes.refs.GET, '/api/admission/refs');
      assert.equal(r.status, 403);
    });
  });

  // ═══════════════════════════════════════════════════════════
  section('三、AI 老師：建議吃得到，閘門擋得住');
  // ═══════════════════════════════════════════════════════════

  await withTenant(home.tenant.id, async () => {
    await test('建議吃得到他查來的資料（來源與日期都進了提示詞）', async () => {
      setAi(GOOD_ADVICE([18, 15]));
      const r = await askAdvice(jiayi, '我這樣算是有機會嗎');
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.fellBack, false);
      assert.equal(r.body.blockedDrafts, 0);
      assert.equal(aiCalls.length, 1);

      const sent = aiCalls[0].body;
      assert.equal(sent.references.length, 4);
      const one = sent.references.find((x) => x.year === YEAR - 1);
      assert.equal(one.value_text, '18%');
      assert.equal(one.source_label, '官方文件');
      assert.equal(one.looked_up_at, '2026-03-05');
      // 去年的門檻是「可以參考」而不是「可以照著做決定」——它不是今年的
      // 門檻。當年度的簡章那一筆才是最高一級。
      assert.equal(one.trust_label, '可以參考');
      assert.equal(one.stale, true);
      assert.equal(sent.references.find((x) => x.year === YEAR).trust_label, '可以照著做決定');
      // 過期那一筆要帶著旗標進去，否則模型會把它當成今年的門檻。
      assert.equal(sent.references.find((x) => x.year === YEAR - 3).stale, true);
      // 缺口是系統算的，不是讓模型自己判斷。
      assert.ok(sent.gaps.length >= 1);
      assert.equal(sent.question, '我這樣算是有機會嗎');
    });

    await test('★ 閘門擋得住機率：三次都給機率就退回只陳述事實的版本', async () => {
      setAi(ODDS_ADVICE, ODDS_ADVICE, ODDS_ADVICE, ODDS_ADVICE);
      const r = await askAdvice(jiayi);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.fellBack, true, '應該退回罐頭');
      assert.equal(r.body.blockedDrafts, 4, '生成四次全部被擋');
      assert.equal(aiCalls.length, 4);
      // 重試要帶 retry，否則四次會拿到四段一模一樣的違規輸出。
      assert.deepEqual(
        aiCalls.map((c) => c.body.retry),
        [0, 1, 2, 3],
      );

      // 擋掉的理由要說得出來（老師會問「這個 AI 到底有沒有亂講」）。
      assert.equal(r.body.blockedReasons.length, 4, '四次生成 → 四條理由');
      const why = r.body.blockedReasons.join(' ');
      assert.match(why, /ODDS_PREDICTION|CERTAINTY|EXTREME_AS_AVERAGE|UNSOURCED_NUMBER/);
      // **理由裡不可以有那個被擋掉的數字。** 用一句「68% 被擋掉了」把
      // 那個數字說給學生聽，他會記住 68%，而 68% 從來就不存在。
      for (const n of ['68', '16.5']) {
        assert.ok(!why.includes(n), `擋下來的理由把「${n}」講出來了`);
      }

      // 退回的那一段是事實，不是「稍後再試」。
      assert.match(r.body.text, /18%/);
      assert.match(r.body.text, /官方文件/);
      assert.match(r.body.text, /極值/);
      for (const banned of ['稍後再試', '暫時無法', '系統忙碌']) {
        assert.ok(!r.body.text.includes(banned), `退路出現了「${banned}」`);
      }
      // **而且那個 68% 一個字都不能出現在回應裡。**
      assert.ok(!r.text.includes('68'), '被擋掉的草稿洩漏到回應裡了');
      assert.ok(!r.text.includes('相當有把握'));
    });

    await test('★ 第一次被擋、第二次通過時，回應要說得出擋過幾次', async () => {
      setAi(ODDS_ADVICE, GOOD_ADVICE([18, 15]));
      const r = await askAdvice(jiayi);
      assert.equal(r.body.fellBack, false);
      assert.equal(r.body.blockedDrafts, 1);
      // 一次生成折成一個字串，即使那一段同時犯了五條規則。
      assert.equal(r.body.blockedReasons.length, 1);
      assert.match(r.body.blockedReasons[0], /ODDS_PREDICTION/);
      assert.equal(aiCalls.length, 2);
    });

    await test('模型引用一個對不回資料的數字也會被擋', async () => {
      // 他查到的是 18、15、25。21% 是編的。
      setAi(
        `近三年的門檻是 18%、15%、21%。這是根據每年僅一個極值資料點的估計。`,
        GOOD_ADVICE([18, 15]),
      );
      const r = await askAdvice(jiayi);
      assert.equal(r.body.blockedDrafts, 1);
      assert.ok(
        r.body.blockedReasons.some((x) => x.includes('UNSOURCED_NUMBER')),
        r.body.blockedReasons.join('；'),
      );
      // 那個編出來的 21% 一個字都不能出現在回應裡。
      assert.ok(!r.text.includes('21'), '編出來的數字洩漏到回應裡了');
    });

    await test('AI 服務第一次就掛掉時往上拋，不假裝有建議', async () => {
      setAi(GOOD_ADVICE([18]));
      aiDown = true;
      const r = await askAdvice(jiayi);
      assert.equal(r.status, 503, r.text);
      assert.match(r.body.error, /連不上|想太久/);
      aiDown = false;
    });

    await test('★ 每一次建議都寫一列 AiUsageLog（AI 使用揭露的證據）', async () => {
      const logs = await prisma.aiUsageLog.findMany({
        where: { refType: 'AdmissionAdvice', refId: jiayi.id },
      });
      // 前面成功三次（含退回罐頭那一次）。AI 掛掉那一次沒有 token，
      // 也就沒有記錄。
      assert.ok(logs.length >= 3, `只有 ${logs.length} 列`);
      for (const l of logs) {
        assert.equal(l.purpose, 'OTHER', 'schema 沒有 ADMISSION_ADVICE，用 OTHER + refType');
        assert.equal(l.tier, 'MID');
        assert.ok(l.inputTokens > 0);
      }
      // 退回罐頭那一次也要記，而且標得出來——不記的話，一位三次都被擋的
      // 學生會在揭露聲明裡看到「未使用 AI」，那是不實陳述。
      assert.ok(logs.some((l) => l.succeeded === false && l.errorCode === 'ADVICE_GUARD_FALLBACK'));
      assert.ok(logs.some((l) => l.succeeded === true));
    });

    await test('老師請不動 AI 老師', async () => {
      setAi(GOOD_ADVICE([18]));
      const r = await askAdvice(home.teacher);
      assert.equal(r.status, 403);
      assert.equal(aiCalls.length, 0, '被擋下來就不該花錢');
    });
  });

  // ═══════════════════════════════════════════════════════════
  section('四、學生自己輸入的百分比不影響別人');
  // ═══════════════════════════════════════════════════════════

  await withTenant(home.tenant.id, async () => {
    await test('四位學生都推臺大第 2 類，教務處匯入三位的百分比', async () => {
      for (const u of home.students) {
        assert.equal((await addStarWish(u, '臺灣大學', 2)).status, 200);
      }
      const csv = [
        '學號,百分比',
        `${jiayi.username},10`,
        `${yier.username},20`,
        `${bingsan.username},30`,
        // 丁四刻意不匯。
      ].join('\n');
      const form = new FormData();
      form.set('file', new File([csv], 'ranks.csv', { type: 'text/csv' }));
      form.set('year', String(YEAR));
      const r = await callAs(asUser(home.admin), routes.ranks.POST, '/api/admission/ranks', {
        method: 'POST',
        form,
      });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.imported, 3);
    });

    /** 序位的快照：每位學生從自己那一支拿到的名次。 */
    const orders = async () => {
      const out = {};
      for (const u of home.students) {
        const r = await callAs(asUser(u), routes.star.GET, '/api/admission/star');
        out[u.username] = r.body.position.positions[0]?.order ?? null;
      }
      return out;
    };

    const before = await orders();

    await test('模擬前的序位：依教務處的百分比', async () => {
      assert.equal(before[jiayi.username], 1);
      assert.equal(before[yier.username], 2);
      assert.equal(before[bingsan.username], 3);
      assert.equal(before[dingsi.username], null, '丁四沒有百分比，排不進去');
    });

    await test('★ 丁四自己輸入 1%（比誰都好）之後，其他人的序位一個字都沒變', async () => {
      const r = await addRef(dingsi, {
        year: YEAR,
        channel: 'STAR',
        kind: 'MY_PERCENTILE',
        institutionName: '本校',
        raw: { percentile: 1 },
        sourceKind: 'SCHOOL_OFFICE',
        sourceRef: '教務處 陳老師',
        lookedUpAt: '2026-03-06',
      });
      assert.equal(r.status, 200, r.text);

      const after = await orders();
      // 這是本模組最惡劣的一種失效方式：受害者不是打錯字的那一位。
      // 若那個 1% 進得了模擬，甲一會從第 1 掉到第 2——而他只會看到
      // 一個完全正常的「第 2 位」。
      assert.deepEqual(after, before);
    });

    await test('★ 丁四自己還是排不進去（自填的不會補上教務處那一格）', async () => {
      const r = await callAs(asUser(dingsi), routes.star.GET, '/api/admission/star');
      assert.equal(r.body.position.unranked, true, '應該仍然是 unranked');
      assert.equal(r.body.position.positions.length, 0);
    });

    await test('承辦人的全校檢視裡也沒有那個 1%', async () => {
      const r = await callAs(
        asUser(home.admin),
        routes.star.GET,
        '/api/admission/star?scope=school',
      );
      assert.equal(r.status, 200, r.text);
      const pos = r.body.report.positions.find((p) => p.institutionName === '臺灣大學');
      assert.equal(pos.cohort, 3, '只有三位有百分比的人進得了排序');
      assert.deepEqual(
        pos.entries.map((e) => e.percentile),
        [10, 20, 30],
      );
      assert.ok(
        r.body.report.unranked.some((u) => u.userId === dingsi.id),
        '丁四要出現在「要先處理的幾件事」裡',
      );
    });

    await test('但丁四自己的建議看得到他填的 1%', async () => {
      // 隔離不是把功能關掉——那個數字對他自己是有用的。
      setAi('你自己輸入的在校百分比是 1%，來源是教務處。這一份只用於你自己的建議。');
      const r = await askAdvice(dingsi);
      assert.equal(r.status, 200, r.text);
      assert.equal(aiCalls[0].body.self_percentile, 1);
      assert.equal(aiCalls[0].body.official_percentile, null, '教務處那一格是空的');
    });

    await test('甲一的建議裡兩個百分比分得開', async () => {
      setAi(GOOD_ADVICE([18, 15]));
      await askAdvice(jiayi);
      assert.equal(aiCalls[0].body.official_percentile, 10, '教務處匯入的');
      assert.equal(aiCalls[0].body.self_percentile, null, '他自己沒填');
    });

    await test('建議裡的校內序位不含任何其他學生的資訊', async () => {
      setAi(GOOD_ADVICE([18, 15]));
      await askAdvice(jiayi);
      const sent = JSON.stringify(aiCalls[0].body);
      for (const u of home.students) {
        if (u.id === jiayi.id) continue;
        assert.ok(!sent.includes(u.id), `送給模型的脈絡裡有 ${u.displayName} 的 id`);
        assert.ok(!sent.includes(u.username));
        assert.ok(!sent.includes(u.displayName));
      }
      assert.ok(!sent.includes('cohort'), '參與人數不該送出去');
      assert.ok(!sent.includes('"percentile"'), '別人的百分比不該送出去');
      assert.equal(aiCalls[0].body.star_positions[0].order, 1);
    });
  });

  // ═══════════════════════════════════════════════════════════
  section('五、刪除與租戶隔離');
  // ═══════════════════════════════════════════════════════════

  await withTenant(other.tenant.id, async () => {
    await test('隔壁的學生也輸入一筆（同一個校系，數字刻意不同）', async () => {
      const r = await addRef(
        other.students[0],
        round1({ year: YEAR - 1, raw: { percentile: 77 }, sourceRef: '隔壁查的' }),
      );
      assert.equal(r.status, 200, r.text);
    });
  });

  await withTenant(home.tenant.id, async () => {
    await test('★ 隔壁的資料不會出現在本家的建議裡', async () => {
      setAi(GOOD_ADVICE([18, 15]));
      const r = await askAdvice(jiayi);
      assert.equal(r.status, 200, r.text);
      const sent = JSON.stringify(aiCalls[0].body);
      assert.ok(!sent.includes('77'), '隔壁的 77% 跑進本家的脈絡裡了');
      assert.ok(!sent.includes('隔壁查的'));
      assert.equal(aiCalls[0].body.references.length, 4, '只有他自己那四筆');
    });

    await test('★ 打錯的數字改得動，不必刪掉重打（1.8% 打成 18%）', async () => {
      // 這是這張表最常見的打錯法，而它會被 AI 老師拿去跟學生自己的
      // 百分比比較——18% 與 1.8% 是一位前 20% 學生與一位頂標學生的差別。
      // 只有「刪掉」的話，修一個小數點要重打校名、學年度、來源與日期
      // 五個欄位，而其中四個原本就是對的。
      const row = (
        await prisma.admissionReference.findMany({
          where: { userId: jiayi.id, kind: 'STAR_ROUND1' },
        })
      )[0];
      const r = await callAs(
        asUser(jiayi),
        routes.ref.PATCH,
        `/api/admission/refs/${row.id}?year=${YEAR}`,
        {
          method: 'PATCH',
          params: { refId: row.id },
          json: { raw: { percentile: '1.8' }, note: '小數點打錯了，回官方 PDF 對過' },
        },
      );
      assert.equal(r.status, 200, r.text);
      const after = await prisma.admissionReference.findFirst({ where: { id: row.id } });
      assert.equal(after.value.percentile, 1.8);
      // **其他欄位一個字都沒變**——那正是「改」與「刪掉重加」的差別。
      assert.equal(after.year, row.year);
      assert.equal(after.institutionName, row.institutionName);
      assert.equal(after.kind, row.kind);
      assert.equal(after.sourceKind, row.sourceKind);
      // 回應是重算後的完整基礎，改完立刻看得到新的判斷。
      assert.ok(Array.isArray(r.body.references));
      const changed = r.body.references.find((x) => x.id === row.id);
      assert.equal(changed.describe, '1.8%');

      // 改回去，後面幾條測試吃的是原本那組數字。
      await callAs(asUser(jiayi), routes.ref.PATCH, `/api/admission/refs/${row.id}?year=${YEAR}`, {
        method: 'PATCH',
        params: { refId: row.id },
        json: { raw: { percentile: String(row.value.percentile) } },
      });
    });

    await test('改的時候一樣擋得住 PR 值與未來的日期', async () => {
      const row = (
        await prisma.admissionReference.findMany({
          where: { userId: jiayi.id, kind: 'STAR_ROUND1' },
        })
      )[0];
      const bad = await callAs(
        asUser(jiayi),
        routes.ref.PATCH,
        `/api/admission/refs/${row.id}?year=${YEAR}`,
        { method: 'PATCH', params: { refId: row.id }, json: { raw: { percentile: '120' } } },
      );
      assert.equal(bad.status, 400);
      assert.match(bad.body.error, /PR 值/);

      const future = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
      const later = await callAs(
        asUser(jiayi),
        routes.ref.PATCH,
        `/api/admission/refs/${row.id}?year=${YEAR}`,
        { method: 'PATCH', params: { refId: row.id }, json: { lookedUpAt: future } },
      );
      assert.equal(later.status, 400);
      assert.match(later.body.error, /未來/);
    });

    await test('學生改不動別人的資料（404，與「不存在」同一個回應）', async () => {
      const mine = await prisma.admissionReference.findMany({ where: { userId: jiayi.id } });
      const r = await callAs(
        asUser(yier),
        routes.ref.PATCH,
        `/api/admission/refs/${mine[0].id}?year=${YEAR}`,
        { method: 'PATCH', params: { refId: mine[0].id }, json: { raw: { percentile: '99' } } },
      );
      assert.equal(r.status, 404);
      const still = await prisma.admissionReference.findFirst({ where: { id: mine[0].id } });
      assert.notEqual(still.value.percentile, 99);
    });

    await test('學生刪不掉別人的資料（404，與「不存在」同一個回應）', async () => {
      const mine = await prisma.admissionReference.findMany({ where: { userId: jiayi.id } });
      assert.ok(mine.length > 0);
      const r = await callAs(
        asUser(yier),
        routes.ref.DELETE,
        `/api/admission/refs/${mine[0].id}?year=${YEAR}`,
        { method: 'DELETE', params: { refId: mine[0].id } },
      );
      assert.equal(r.status, 404);
      const still = await prisma.admissionReference.findFirst({ where: { id: mine[0].id } });
      assert.ok(still, '資料被別人刪掉了');
    });

    await test('學生刪不掉隔壁補習班的資料', async () => {
      const theirs = await withTenant(other.tenant.id, () =>
        prisma.admissionReference.findMany({ where: { userId: other.students[0].id } }),
      );
      assert.ok(theirs.length > 0);
      const r = await callAs(
        asUser(jiayi),
        routes.ref.DELETE,
        `/api/admission/refs/${theirs[0].id}?year=${YEAR}`,
        { method: 'DELETE', params: { refId: theirs[0].id } },
      );
      assert.equal(r.status, 404);
    });

    await test('刪掉自己那一筆之後，缺口跟著重算', async () => {
      const mine = await prisma.admissionReference.findMany({
        where: { userId: jiayi.id, kind: 'STAR_ROUND1' },
      });
      // 留一筆就好——剩一年之後「只有一年」的缺口要出現。
      for (const row of mine.slice(1)) {
        const r = await callAs(
          asUser(jiayi),
          routes.ref.DELETE,
          `/api/admission/refs/${row.id}?year=${YEAR}`,
          { method: 'DELETE', params: { refId: row.id } },
        );
        assert.equal(r.status, 200, r.text);
      }
      const r = await getRefs(jiayi);
      const codes = r.body.gaps.map((g) => g.code);
      assert.ok(codes.includes('ONE_YEAR_ONLY'), `缺口是 ${codes.join('、')}`);
      const gap = r.body.gaps.find((g) => g.code === 'ONE_YEAR_ONLY');
      assert.ok(gap.url, '「只有一年」這一條一定要帶著去哪裡查');
      assert.match(gap.url, /^https:\/\/www\.cac\.edu\.tw\//);
    });
  });

  // ═══════════════════════════════════════════════════════════
  section('六、RLS 的總結');
  // ═══════════════════════════════════════════════════════════

  await test('兩家的資料在同一張表裡，各自只看得到自己的', async () => {
    for (const [t, tag] of [
      [home.tenant.id, '本家'],
      [other.tenant.id, '隔壁'],
    ]) {
      const scoped = await withTenant(t, () => prisma.admissionReference.findMany({}));
      const direct = await withoutTenantScope('驗證兩家的資料都在同一張表裡', () =>
        raw.admissionReference.findMany({ where: { tenantId: t } }),
      );
      assert.equal(scoped.length, direct.length, `${tag} 的筆數對不上`);
      assert.ok(scoped.every((r) => r.tenantId === t), `${tag} 看到了別家的列`);
    }
    // 上面那些數字是 RLS 濾出來的，不是因為表裡只有那幾列。
    const both = await withoutTenantScope('驗證兩家合計都在同一張表裡', () =>
      raw.admissionReference.findMany({
        where: { tenantId: { in: [home.tenant.id, other.tenant.id] } },
      }),
    );
    const homeOnly = await withTenant(home.tenant.id, () =>
      prisma.admissionReference.findMany({}),
    );
    assert.ok(both.length > homeOnly.length, 'RLS 沒有濾掉任何東西？');
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
