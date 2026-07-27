#!/usr/bin/env node
/**
 * 離線的 Prisma schema 檢查。
 *
 * `prisma validate` 會去 binaries.prisma.sh 抓引擎，沙箱與封閉網段裡
 * 都拿不到；但驗證本身是純 wasm，不需要引擎。這支腳本直接呼叫 wasm，
 * 讓 schema 的錯誤在沒有對外網路的環境下也能當場看到。
 *
 * 用法：node tools/prisma-check.mjs [--format]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wasm = require('@prisma/prisma-schema-wasm');

const PATH = 'packages/db/schema.prisma';
const content = readFileSync(PATH, 'utf8');

function unwrap(e) {
  const msg = typeof e === 'string' ? e : (e?.message ?? String(e));
  try {
    const j = JSON.parse(msg);
    return j.message ?? msg;
  } catch {
    return msg;
  }
}

try {
  wasm.validate(JSON.stringify({ prismaSchema: content, noColor: true }));
} catch (e) {
  process.stderr.write(`\nschema 驗證失敗：\n${unwrap(e)}\n`);
  process.exit(1);
}

// wasm 的 panic hook 會寫進這個全域物件；沒先建好，任何 panic
// 都會變成看不出原因的 TypeError。
globalThis.PRISMA_WASM_PANIC_REGISTRY ??= { set_message() {} };

// lint 的參數形狀在 5.x 各版之間換過（純字串 → 帶 prismaSchema 的物件）。
// 這裡兩種都試，避免升版時整個檢查掛掉 —— lint 只是加分項，
// 真正把關的是上面的 validate。
function lintWarnings() {
  for (const arg of [content, JSON.stringify({ prismaSchema: content })]) {
    try {
      return JSON.parse(wasm.lint(arg)).filter((l) => l.is_warning);
    } catch {}
  }
  return null;
}

const warnings = lintWarnings();
for (const w of warnings ?? []) process.stdout.write(`  ⚠ ${w.text}\n`);

if (process.argv.includes('--format')) {
  writeFileSync(PATH, wasm.format(content, JSON.stringify({ tabSize: 2 })));
  process.stdout.write('已格式化\n');
}

const models = (content.match(/^model /gm) ?? []).length;
const enums = (content.match(/^enum /gm) ?? []).length;
process.stdout.write(`schema 有效：${models} 個模型、${enums} 個列舉、${warnings === null ? "lint 未執行" : warnings.length + " 則警告"}\n`);
