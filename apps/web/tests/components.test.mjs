/**
 * 元件庫的無障礙不變量。
 *
 * # 為什麼測的是渲染出來的 HTML 而不是元件的參數
 *
 * 因為會壞掉的是輸出，不是介面。`<label htmlFor>` 有沒有接到對應的
 * `id`、錯誤訊息有沒有被 `aria-describedby` 指到、數字欄的表頭有沒有
 * 跟著靠右——這些都是「元件簽章完全正確、渲染結果卻是錯的」。
 *
 * 而且這一類錯誤**在畫面上看不出來**。標籤沒接上的表單長得跟接上的
 * 一模一樣；差別只有讀螢幕的人聽得到。規格書文件 01 §16 要求
 * WCAG 2.1 AA，那不是一份宣言，是這幾條。
 *
 * 校樣頁（components/Gallery.tsx）用到了每一個元件，所以拿它當
 * 樣本：只要有人改壞了任何一個，這裡就會紅。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import assert from 'node:assert/strict';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = path.join(ROOT, 'component-gallery.html');

/** 產一次，全部測試共用。 */
function gallery() {
  execFileSync('node', ['tools/build-gallery.mjs'], { cwd: ROOT, stdio: 'pipe' });
  return readFileSync(OUT, 'utf8');
}

const html = gallery();

test('每個 label 都接到真的存在的控制項', () => {
  const forIds = [...html.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(forIds.length >= 4, `label 太少（${forIds.length}），校樣是不是壞了`);
  for (const id of forIds) {
    assert.ok(
      new RegExp(`\\bid="${id}"`).test(html.replace(/<label[^>]*>/g, '')),
      `label for="${id}" 指向一個不存在的控制項——` +
        `讀螢幕的人聽不到這一格要填什麼，點標籤也不會 focus 過去`,
    );
  }
});

test('錯誤訊息被 aria-describedby 指到', () => {
  const invalid = [...html.matchAll(/<input[^>]*aria-invalid="true"[^>]*>/g)];
  assert.ok(invalid.length >= 1, '校樣裡應該有一個錯誤狀態的欄位');
  for (const [tag] of invalid) {
    const described = /aria-describedby="([^"]+)"/.exec(tag);
    assert.ok(
      described,
      'aria-invalid 的欄位沒有 aria-describedby——' +
        '輔助科技只知道「無效」，不知道為什麼',
    );
    for (const id of described[1].split(/\s+/)) {
      assert.ok(new RegExp(`\\bid="${id}"`).test(html), `describedby 指向不存在的 ${id}`);
    }
  }
});

test('錯誤不只用顏色傳達', () => {
  // WCAG 1.4.1。錯誤訊息前面有校對記號「×」，色盲的人也讀得到。
  const css = readFileSync(path.join(ROOT, 'apps/web/app/globals.css'), 'utf8');
  assert.match(
    css,
    /\.yz-field__err::before\s*\{\s*content:\s*"×/,
    '錯誤訊息只有顏色。色盲的使用者看不出那一行是錯誤',
  );
});

test('錯誤與警示會被讀出來', () => {
  assert.ok(
    (html.match(/role="alert"/g) ?? []).length >= 2,
    '錯誤區塊沒有 role="alert"——它出現時不會被讀出來，' +
      '使用者要自己 tab 回去才發現',
  );
});

test('資料表的表頭有 scope，數字欄表頭跟著靠右', () => {
  assert.ok(/<th [^>]*scope="col"/.test(html), '表頭沒有 scope="col"');
  assert.match(
    html,
    /<th[^>]*class="yz-table__num"[^>]*scope="col"|<th[^>]*scope="col"[^>]*class="yz-table__num"/,
    '數字欄的表頭沒有掛上 yz-table__num',
  );
  const css = readFileSync(path.join(ROOT, 'apps/web/app/globals.css'), 'utf8');
  assert.match(
    css,
    /\.yz-table thead th\.yz-table__num\s*\{[^}]*text-align:\s*right/,
    'thead th 的 text-align:left 特異度較高，數字欄表頭會靠左而值靠右——' +
      '而數字欄存在的理由就是為了對得齊',
  );
});

test('空表格不會只剩表頭', () => {
  // Table 元件在 rows 為空時回傳 empty，而不是渲染一個只有表頭的殼。
  // 只有表頭的表格看起來像壞掉，不像「沒有資料」。
  const src = readFileSync(path.join(ROOT, 'apps/web/components/Table.tsx'), 'utf8');
  assert.match(src, /rows\.length === 0/, 'Table 沒有處理空狀態');
  assert.match(src, /empty: ReactNode;/, 'empty 不是必填——那它就會被省略');
});

test('送出中的按鈕會被停用而且說得出來', () => {
  const src = readFileSync(path.join(ROOT, 'apps/web/components/Button.tsx'), 'utf8');
  assert.match(src, /disabled=\{disabled \|\| busy\}/, 'busy 時沒有停用按鈕');
  assert.match(src, /aria-busy=\{busy \|\| undefined\}/, '只把按鈕變灰，讀螢幕的人收不到');
});

test('表單擋得住連點兩次', () => {
  const src = readFileSync(path.join(ROOT, 'apps/web/components/Form.tsx'), 'utf8');
  // setState 是非同步的，快速連點兩次可能兩次都讀到 busy=false。
  // 派任務與交卷送出兩次是真的會出事的。
  assert.match(src, /inFlight\s*=\s*useRef/, '沒有同步的重複送出防護');
  assert.match(src, /if \(inFlight\.current\) return;/, '沒有在送出前檢查');
});

test('4xx 不會被當成成功', () => {
  const src = readFileSync(path.join(ROOT, 'apps/web/components/Form.tsx'), 'utf8');
  // fetch 不會對 4xx 丟錯。忘了檢查 res.ok 是最常見的一種靜默失敗。
  assert.match(src, /if \(!res\.ok\)/, 'submitJson 沒有檢查 res.ok');
  assert.match(
    src,
    /d\?\.error \?\? `伺服器回應 \$\{res\.status\}`/,
    '把伺服器寫好的錯誤訊息丟掉、只顯示狀態碼',
  );
});
