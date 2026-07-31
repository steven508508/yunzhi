/**
 * 靜默的資料遺失。
 *
 * **實地故障：** 一份 20 題的題本，校對編輯器只出現 4 題。
 * 沒有任何提示——老師看到的是 4 題「正常」的題目，會以為原稿就這些。
 *
 * 資料一直都在：`routes_import.py` 單頁判讀失敗時會塞一個空的
 * `PageReading()`（那一頁的題目因此全部消失），並且產生
 * `page_unreadable` 的 ERROR issue 與 `failed_pages` 清單。
 * import-pipeline.mjs 也收進了 `failedPages`。
 *
 * 但那份資料一路傳到 web 之後**只被拿去組進度頁的一行字**，
 * 校對介面從來沒有讀過它。routes_import.py 的註解寫著
 * 「校對介面會顯示『第 N 頁未能判讀』」——那是願望，不是事實。
 *
 * 這裡固定住三件事，任何一件被拆掉，靜默遺失就會回來。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const STATUS = read('lib/importStatus.ts');
const PAGE = read('app/(app)/import/[jobId]/page.tsx');
const REVIEW = read('app/(app)/import/[jobId]/Review.tsx');

test('loadProgress 把 failedPages 回傳出來，不是只用在進度文案', () => {
  assert.ok(
    /failedPages:\s*\(detail/.test(STATUS),
    'loadProgress 的回傳值要包含 failedPages',
  );
});

test('校對頁把 failedPages 傳給編輯器', () => {
  assert.ok(
    /failedPages=\{progress\.failedPages\}/.test(PAGE),
    '資料查到了卻沒往下傳，等於沒查',
  );
});

test('編輯器會顯示未能判讀的頁面', () => {
  assert.ok(REVIEW.includes('failedPages'), '編輯器要收這個 prop');
  assert.ok(
    /failedPages\.length > 0 && \(/.test(REVIEW),
    '要有實際的渲染分支，不能只是收下來不用',
  );
  assert.ok(
    REVIEW.includes('未能判讀'),
    '訊息要說得出「這些頁面的題目完全沒有進來」',
  );
});

test('警示用 role="alert" 且佔畫面，不是一小塊灰字', () => {
  const block = REVIEW.slice(REVIEW.indexOf('failedPages.length > 0'));
  assert.ok(
    block.slice(0, 400).includes('role="alert"'),
    '靜默遺失比抽錯更糟，這一塊必須讓輔助技術與眼睛都注意到',
  );
});
