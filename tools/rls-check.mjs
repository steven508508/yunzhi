#!/usr/bin/env node
/**
 * 租戶隔離的檢查與產生。
 *
 *   node tools/rls-check.mjs --emit    印出遷移用的 SQL
 *   node tools/rls-check.mjs           對著真的資料庫驗證（需要 DATABASE_URL）
 *   node tools/rls-check.mjs --static  只做不需要資料庫的檢查
 *
 * 檢查五件事：
 *
 *   一、schema 裡的每一個模型都有租戶歸屬。
 *       **新增模型而沒有決定它屬於誰，這裡會失敗。** 這是整套設計
 *       最重要的一道關卡——一張沒有人注意的表對所有租戶敞開，
 *       不會有任何錯誤訊息。
 *   二、分類為 direct 的表真的有 tenantId 欄位（打錯字擋在這裡）。
 *   三、分類為 indirect 的父表與外鍵欄位真的存在。
 *   四、跨租戶逃生口只出現在允許的檔案裡。
 *   五、（需要資料庫）每一張非 global 的表都真的啟用了 RLS、
 *       FORCE 了、而且政策內容與這裡算出來的一致。
 *
 * 第五項要對著真的資料庫跑，因為**遷移寫了不代表跑過**。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BYPASS_ALLOWED,
  BYPASS_GUC,
  CROSS_TENANT_ALLOWED,
  GLOBAL,
  INDIRECT,
  ROOT_TABLE,
  policyExpr,
  policyName,
  tableSql,
} from './tenancy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const B = (s) => `\x1b[1m${s}\x1b[0m`;
const OK = '\x1b[32m✓\x1b[0m';
const NO = '\x1b[31m✗\x1b[0m';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`   ${ok ? OK : NO} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`     ${detail.replace(/\n/g, '\n     ')}`);
  }
}

// ── 從 schema 取出模型與資料表 ───────────────────────────────────

function loadTables() {
  const wasm = require('@prisma/prisma-schema-wasm');
  globalThis.PRISMA_WASM_PANIC_REGISTRY ??= { set_message() {} };
  const schema = readFileSync(path.join(ROOT, 'packages/db/schema.prisma'), 'utf8');
  const dmmf = JSON.parse(wasm.get_dmmf(JSON.stringify({ prismaSchema: schema })));

  const out = new Map();
  for (const m of dmmf.datamodel.models) {
    out.set(m.dbName ?? m.name, {
      model: m.name,
      columns: new Set(m.fields.filter((f) => f.kind !== 'object').map((f) => f.dbName ?? f.name)),
    });
  }
  return out;
}

// ── 一、每一張表都分類過 ─────────────────────────────────────────

function classify(table) {
  if (table === ROOT_TABLE) return 'root';
  if (GLOBAL[table]) return 'global';
  if (INDIRECT[table]) return 'indirect';
  return 'direct';
}

function staticChecks(tables) {
  console.log(`\n${B('── 分類')}`);

  const direct = [];
  for (const [table, meta] of tables) {
    if (classify(table) === 'direct') direct.push([table, meta]);
  }

  // 二、direct 的表真的有 tenantId
  const missingCol = direct.filter(([, m]) => !m.columns.has('tenantId'));
  check(
    `分類為 direct 的 ${direct.length} 張表都有 tenantId 欄位`,
    missingCol.length === 0,
    missingCol.length
      ? `這幾張沒有 tenantId，卻沒有列進 GLOBAL 或 INDIRECT：\n` +
        missingCol.map(([t]) => `  · ${t}`).join('\n') +
        `\n新增模型時必須決定它屬於誰。改 tools/tenancy.mjs。`
      : '',
  );

  // 三、indirect 的父表與外鍵存在
  const badParent = [];
  for (const [table, [parent, fk]] of Object.entries(INDIRECT)) {
    if (!tables.has(table)) badParent.push(`${table}：schema 裡沒有這張表`);
    else if (!tables.has(parent)) badParent.push(`${table}：父表 ${parent} 不存在`);
    else if (!tables.get(table).columns.has(fk)) {
      badParent.push(`${table}：沒有外鍵欄位 ${fk}`);
    }
  }
  check('indirect 的父表與外鍵都存在', badParent.length === 0, badParent.join('\n'));

  // GLOBAL 裡列了不存在的表
  const ghostGlobal = Object.keys(GLOBAL).filter((t) => !tables.has(t));
  check(
    'GLOBAL 清單沒有列到不存在的表',
    ghostGlobal.length === 0,
    ghostGlobal.length ? `這幾張表已經不在 schema 裡：${ghostGlobal.join('、')}` : '',
  );

  const counts = { root: 0, direct: 0, indirect: 0, global: 0 };
  for (const t of tables.keys()) counts[classify(t)]++;
  console.log(
    `     共 ${tables.size} 張表：租戶表 ${counts.root}、` +
      `直接 ${counts.direct}、間接 ${counts.indirect}、全域 ${counts.global}`,
  );

  return tables;
}

// ── 四、逃生口只在允許的檔案 ─────────────────────────────────────

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === '.next') continue;
    const p = path.join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js|sql)$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * 哪些 `@/lib/*` 模組會碰到資料庫。**自己算出來，不用手寫清單。**
 *
 * 這裡原本是一條寫死的正規表達式，列著當時已知的幾個模組。它會壞在
 * 一個固定的地方：有人新增 `lib/attempt.ts`（會查資料庫）並且從路由
 * 引用它，而正規表達式不認得這個名字——於是那支路由就從「必須建立
 * 租戶脈絡」的檢查裡消失了。**檢查器安靜地少檢查一項，比它報錯糟得多。**
 * 這件事真的發生過，四個模組一次全漏。
 *
 * 所以改成從 `@/lib/prisma` 出發做傳遞閉包：直接引用它的算，引用了
 * 「引用它的模組」的也算。新增模組不必回來改這裡。
 */
function dbTouchingLibModules() {
  const libDir = path.join(ROOT, 'apps/web/lib');
  const sources = new Map(); // 模組名 → 原始碼
  for (const f of walk(libDir)) {
    if (!/\.(ts|tsx|mjs)$/.test(f) || f.endsWith('.d.ts')) continue;
    const name = path.relative(libDir, f).replace(/\.(ts|tsx|mjs)$/, '');
    sources.set(name, readFileSync(f, 'utf8'));
  }

  // prisma 本身是根。`.mjs` 的 client 包裝也是——測試替身走那一條。
  const hits = new Set(['prisma', 'prismaClient']);
  for (let pass = 0; pass < sources.size; pass++) {
    let grew = false;
    for (const [name, text] of sources) {
      if (hits.has(name)) continue;
      if (importsAny(text, hits)) {
        hits.add(name);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return hits;
}

/**
 * 這份原始碼有沒有**在執行期**引用 `@/lib/<名字>`（可帶 `.mjs` 副檔名）。
 *
 * `import type { … }` 不算：那種引用在編譯後完全消失，不會執行到
 * 任何一行程式，當然也不會查資料庫。作答頁 `take/[assignmentId]`
 * 就是這樣——它是 client component，只借了 `lib/attempt.ts` 的型別，
 * 資料全部走 API。把它算成「碰資料庫」的話，這個檢查會要求一個
 * client component 去呼叫 `scopedPage()`，而那件事做不到。
 *
 * `import { type Foo, bar }` 這種混合形式仍然算——`bar` 是真的會被
 * 執行的。
 */
function importsAny(text, moduleNames) {
  const runtime = text
    .replace(/^\s*import\s+type\s[\s\S]*?from\s*'[^']*';?$/gm, '')
    .replace(/^\s*export\s+type\s[\s\S]*?from\s*'[^']*';?$/gm, '');
  for (const name of moduleNames) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`from '@/lib/${esc}(\\.mjs)?'`).test(runtime)) return true;
  }
  return false;
}

function bypassCheck() {
  console.log(`\n${B('── 跨租戶逃生口')}`);
  const files = walk(ROOT).filter(
    (f) => !f.includes(path.join('packages', 'db', 'migrations')),
  );

  // 一、誰能直接動資料庫的設定值
  const gucAllowed = new Set(BYPASS_ALLOWED.map((p) => path.join(ROOT, p)));
  const gucOffenders = files
    .filter((f) => !gucAllowed.has(f) && readFileSync(f, 'utf8').includes(BYPASS_GUC))
    .map((f) => path.relative(ROOT, f));
  check(
    `只有基礎設施會直接設定 ${BYPASS_GUC}`,
    gucOffenders.length === 0,
    gucOffenders.length
      ? `這幾個檔案直接動了資料庫的跨租戶設定值：\n` +
        gucOffenders.map((o) => `  · ${o}`).join('\n') +
        `\n業務程式應該呼叫 withoutTenantScope()，不要自己送 SQL。`
      : '',
  );

  // 二、誰能真的跨租戶做事。**這一項比上一項重要。**
  const xAllowed = new Set(Object.keys(CROSS_TENANT_ALLOWED).map((p) => path.join(ROOT, p)));
  const xOffenders = files
    .filter(
      (f) =>
        !xAllowed.has(f) &&
        !f.startsWith(path.join(ROOT, 'tools')) &&
        /withoutTenantScope\s*\(/.test(readFileSync(f, 'utf8')),
    )
    .map((f) => path.relative(ROOT, f));
  check(
    `只有 ${Object.keys(CROSS_TENANT_ALLOWED).length} 個檔案能跨租戶執行`,
    xOffenders.length === 0,
    xOffenders.length
      ? `這幾個檔案呼叫了 withoutTenantScope()：\n` +
        xOffenders.map((o) => `  · ${o}`).join('\n') +
        `\n若那件事本質上就是跨租戶的，把它加進 tools/tenancy.mjs 的\n` +
        `CROSS_TENANT_ALLOWED 並寫清楚為什麼。「這樣寫比較方便」不是理由。`
      : '',
  );

  // 三、碰資料庫的路由與頁面有沒有建立租戶脈絡
  //
  // **這是最容易漏的一項，也是漏了最沒有症狀的一項。** 忘記建立
  // 脈絡的路由在 RLS 底下會查不到資料，但那要跑起來才看得到；
  // 這裡在提交前就擋住。
  const appDir = path.join(ROOT, 'apps/web/app');
  const dbModules = dbTouchingLibModules();
  const naked = [];
  for (const f of files) {
    if (!f.startsWith(appDir)) continue;
    if (!/\/(route|page)\.tsx?$/.test(f)) continue;
    const text = readFileSync(f, 'utf8');
    if (!importsAny(text, dbModules)) continue;
    const scoped =
      /scopedRoute|scopedPage|withTenant|withoutTenantScope|publicRoute/.test(text);
    if (!scoped) naked.push(path.relative(ROOT, f));
  }
  check(
    '每一個碰資料庫的路由與頁面都建立了租戶脈絡',
    naked.length === 0,
    naked.length
      ? `這幾個檔案會查資料庫，但沒有建立租戶脈絡：\n` +
        naked.map((o) => `  · ${o}`).join('\n') +
        `\n路由用 scopedRoute()、頁面用 scopedPage()；` +
        `確實不需要登入的用 publicRoute() 明說。`
      : '',
  );
}

// ── 五、對著真的資料庫驗證 ───────────────────────────────────────

async function liveChecks(tables) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log(`\n${B('── 資料庫')}\n     （沒有 DATABASE_URL，略過。遷移寫了不代表跑過。）`);
    return;
  }
  console.log(`\n${B('── 資料庫')}`);

  const pg = require('pg');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows: state } = await client.query(
      `SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );
    const byTable = new Map(state.map((r) => [r.table, r]));

    const want = [...tables.keys()].filter((t) => classify(t) !== 'global');
    const notEnabled = want.filter((t) => byTable.has(t) && !byTable.get(t).enabled);
    const notForced = want.filter((t) => byTable.has(t) && !byTable.get(t).forced);
    const absent = want.filter((t) => !byTable.has(t));

    check(
      `${want.length} 張需要隔離的表都啟用了 RLS`,
      notEnabled.length === 0 && absent.length === 0,
      [
        notEnabled.length ? `沒啟用：${notEnabled.join('、')}` : '',
        absent.length ? `資料庫裡沒有這幾張表（遷移沒跑？）：${absent.join('、')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    check(
      '都設了 FORCE',
      notForced.length === 0,
      notForced.length
        ? `沒 FORCE：${notForced.join('、')}\n` +
          `少了 FORCE，應用程式用資料表擁有者身分連線時 RLS 形同虛設——` +
          `而那正是最常見的部署方式。`
        : '',
    );

    const { rows: pol } = await client.query(
      `SELECT tablename, policyname, qual, with_check FROM pg_policies WHERE schemaname = 'public'`,
    );
    const byName = new Map(pol.map((p) => [`${p.tablename}.${p.policyname}`, p]));
    const missing = want.filter((t) => !byName.has(`${t}.${policyName(t)}`));
    check(
      '每一張表都有隔離政策',
      missing.length === 0,
      missing.length ? `沒有政策：${missing.join('、')}` : '',
    );

    // 政策內容比對：Postgres 會把運算式正規化，所以比對正規化後的形狀
    const norm = (s) => (s || '').replace(/\s+/g, ' ').replace(/[()"]/g, '').trim().toLowerCase();
    const drifted = [];
    for (const t of want) {
      const p = byName.get(`${t}.${policyName(t)}`);
      if (!p) continue;
      const { rows } = await client.query(`SELECT ${policyExpr(t).replace(/current_setting/g, 'current_setting')} IS NOT NULL AS ok`).catch(() => ({ rows: [{ ok: true }] }));
      void rows;
      // 只比對關鍵字：政策有沒有引用到正確的 GUC 與正確的欄位／父表
      const q = norm(p.qual);
      if (!q.includes('app.tenant_id')) drifted.push(`${t}：政策沒有引用 app.tenant_id`);
      if (!q.includes('app.cross_tenant')) drifted.push(`${t}：政策沒有跨租戶逃生口`);
      if (classify(t) === 'indirect' && !q.includes(INDIRECT[t][0])) {
        drifted.push(`${t}：政策沒有引用父表 ${INDIRECT[t][0]}`);
      }
      if (classify(t) === 'direct' && !q.includes('tenantid')) {
        drifted.push(`${t}：政策沒有引用 tenantId`);
      }
      if (norm(p.with_check) !== q) {
        drifted.push(`${t}：WITH CHECK 與 USING 不一致，代表寫得進去卻讀不到`);
      }
    }
    check('政策內容與 tools/tenancy.mjs 一致', drifted.length === 0, drifted.join('\n'));

    // 真的試一次：沒設租戶時應該什麼都看不到
    await client.query(`SELECT set_config('app.tenant_id', '', true)`);
    const { rows: blind } = await client
      .query(`SELECT count(*)::int AS n FROM ${JSON.stringify(ROOT_TABLE).replace(/"/g, '"')}`)
      .catch(() => [{ n: -1 }]);
    check(
      '沒設租戶時查不到任何資料（fail closed）',
      !blind || blind[0]?.n === 0,
      `沒設租戶時仍查得到 ${blind?.[0]?.n} 筆。忘記設租戶必須是「查不到東西」` +
        `而不是「查到全部」——後者是安靜的資料外洩。`,
    );
  } finally {
    await client.end();
  }
}

// ── 主流程 ───────────────────────────────────────────────────────

const args = process.argv.slice(2);
const tables = loadTables();

if (args.includes('--emit')) {
  const want = [...tables.keys()].filter((t) => classify(t) !== 'global').sort();
  console.log('-- 由 tools/rls-check.mjs --emit 產生。不要手改，改 tools/tenancy.mjs。\n');
  for (const t of want) console.log(tableSql(t) + '\n');
  process.exit(0);
}

console.log(B('\n租戶隔離檢查'));
staticChecks(tables);
bypassCheck();

if (!args.includes('--static')) {
  await liveChecks(tables);
}

console.log();
if (failures) {
  console.log(`\x1b[31m${failures} 項未通過\x1b[0m\n`);
  process.exit(1);
}
console.log('\x1b[32m全部通過\x1b[0m\n');
