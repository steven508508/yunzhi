#!/usr/bin/env node
/**
 * 遷移 SQL 與 Prisma schema 的偏移檢查。
 *
 * 為什麼需要這支：遷移是手寫 SQL（為了能審閱索引與約束），
 * schema.prisma 是另外維護的。兩邊一旦不同步，錯誤不會在啟動時
 * 出現，而是在某位老師按下「匯入」的那一刻，以
 * 「column ... does not exist」的形式炸在使用者臉上。
 *
 * 這支腳本把兩邊的表名與欄位名對起來，讓偏移在 CI 就被擋下。
 *
 * 檢查的是「Prisma 認為存在、但 SQL 沒有」這個方向 —— 這個方向
 * 才會造成執行期錯誤。反方向（SQL 有、Prisma 沒有）只是尚未
 * 對應到的欄位，會另外列為提示而不算失敗。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const wasm = require('@prisma/prisma-schema-wasm');
globalThis.PRISMA_WASM_PANIC_REGISTRY ??= { set_message() {} };

const SCHEMA = 'packages/db/schema.prisma';
const MIGRATIONS = 'packages/db/migrations';

// ── 1. 從遷移 SQL 重建「資料庫實際長怎樣」 ────────────────────

/** table -> Set(column) */
const sqlTables = new Map();

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, '');
}

/** 依括號深度切出 CREATE TABLE 的主體，避免被欄位裡的括號騙到。 */
function bodyAfter(sql, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') {
      depth--;
      if (depth === 0) return sql.slice(openIdx + 1, i);
    }
  }
  return '';
}

/** 只取每行第一個帶引號的識別字，且排除表級約束。 */
const CONSTRAINT_KEYWORDS = /^\s*(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE)\b/i;

function parseCreateTable(sql, at) {
  const m = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+"([^"]+)"\s*\(/i.exec(sql.slice(at));
  if (!m) return null;
  const start = at + m.index;
  const open = sql.indexOf('(', start);
  const body = bodyAfter(sql, open);

  const cols = new Set();
  let depth = 0;
  let line = '';
  const flush = () => {
    const t = line.trim();
    line = '';
    if (!t || CONSTRAINT_KEYWORDS.test(t)) return;
    const c = /^"([^"]+)"/.exec(t);
    if (c) cols.add(c[1]);
  };
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) flush();
    else line += ch;
  }
  flush();

  return { name: m[1], cols, end: open + body.length + 2 };
}

const files = readdirSync(MIGRATIONS)
  .filter((d) => !d.startsWith('.'))
  .sort()
  .map((d) => path.join(MIGRATIONS, d, 'migration.sql'));

for (const f of files) {
  const sql = stripComments(readFileSync(f, 'utf8'));

  let cursor = 0;
  while (true) {
    const t = parseCreateTable(sql, cursor);
    if (!t) break;
    sqlTables.set(t.name, t.cols);
    cursor = t.end;
  }

  // 後續遷移的 ADD COLUMN / DROP COLUMN / RENAME 也要跟上，
  // 否則「第二份遷移加的欄位」會被誤判為偏移。
  //
  // 一句 ALTER TABLE 可以逗號分隔加好幾欄，而 Postgres 完全接受。
  // 只認第一欄的話，其餘幾欄會被報成「遷移沒建」——那是**假警報**，
  // 而假警報比沒有檢查更糟：它會讓人養成忽略這支工具的習慣。
  for (const m of sql.matchAll(/ALTER TABLE\s+"([^"]+)"\s+([\s\S]*?);/gi)) {
    const cols = sqlTables.get(m[1]);
    if (!cols) continue;
    for (const c of m[2].matchAll(
      /ADD COLUMN(?:\s+IF NOT EXISTS)?\s+"([^"]+)"/gi,
    )) {
      cols.add(c[1]);
    }
  }
  for (const m of sql.matchAll(/ALTER TABLE\s+"([^"]+)"\s+DROP COLUMN(?:\s+IF EXISTS)?\s+"([^"]+)"/gi)) {
    sqlTables.get(m[1])?.delete(m[2]);
  }
  for (const m of sql.matchAll(
    /ALTER TABLE\s+"([^"]+)"\s+RENAME COLUMN\s+"([^"]+)"\s+TO\s+"([^"]+)"/gi,
  )) {
    const cols = sqlTables.get(m[1]);
    if (cols?.delete(m[2])) cols.add(m[3]);
  }
  for (const m of sql.matchAll(/ALTER TABLE\s+"([^"]+)"\s+RENAME TO\s+"([^"]+)"/gi)) {
    const cols = sqlTables.get(m[1]);
    if (cols) {
      sqlTables.delete(m[1]);
      sqlTables.set(m[2], cols);
    }
  }
  for (const m of sql.matchAll(/DROP TABLE(?:\s+IF EXISTS)?\s+"([^"]+)"/gi)) {
    sqlTables.delete(m[1]);
  }
}

// ── 2. 從 Prisma schema 取出「應用層以為長怎樣」 ────────────────

const content = readFileSync(SCHEMA, 'utf8');
const dmmf = JSON.parse(wasm.get_dmmf(JSON.stringify({ prismaSchema: content })));
const models = dmmf.datamodel.models;

// ── 3. 對照 ────────────────────────────────────────────────────

const problems = [];
const hints = [];

for (const model of models) {
  const table = model.dbName ?? model.name;
  const cols = sqlTables.get(table);
  if (!cols) {
    problems.push(`模型 ${model.name} 對應的資料表 "${table}" 在遷移裡找不到`);
    continue;
  }

  const mapped = new Set();
  for (const f of model.fields) {
    // 關聯欄位不是實體欄位（外鍵欄位另外以純量欄位存在）
    if (f.kind === 'object') continue;
    const col = f.dbName ?? f.name;
    mapped.add(col);
    if (!cols.has(col)) {
      problems.push(`${model.name}.${f.name} → 資料表 "${table}" 沒有欄位 "${col}"`);
    }
  }

  for (const c of cols) {
    if (!mapped.has(c)) hints.push(`"${table}"."${c}" 尚未對應到 Prisma 欄位`);
  }
}

const modelled = new Set(models.map((m) => m.dbName ?? m.name));
for (const t of sqlTables.keys()) {
  if (!modelled.has(t) && t !== '_prisma_migrations') {
    hints.push(`資料表 "${t}" 尚未對應到 Prisma 模型`);
  }
}

// ── 4. 報告 ────────────────────────────────────────────────────

const w = (s) => process.stdout.write(s + '\n');

w(`遷移共 ${sqlTables.size} 張表、schema 共 ${models.length} 個模型`);

if (hints.length) {
  w('');
  w(`提示（不算失敗，但值得看一眼）—— ${hints.length} 項：`);
  for (const h of hints) w(`  · ${h}`);
}

if (problems.length) {
  process.stderr.write(`\n偏移 ${problems.length} 項，這些會在執行期炸掉：\n`);
  for (const p of problems) process.stderr.write(`  ✗ ${p}\n`);
  process.stderr.write('\n');
  process.exit(1);
}

w('');
w('沒有偏移。');
