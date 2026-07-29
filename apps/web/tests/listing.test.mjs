/**
 * 清單的分頁、搜尋與篩選。
 *
 * 這一支測的是**邊界**，因為分頁會出錯的地方全部在邊界上，而且
 * 每一種的症狀都不是當機：
 *
 *   · 頁碼是 `abc` → `skip: NaN` → Prisma 丟一個看不出原因的錯誤
 *   · 忘記把多取的那一筆切掉 → 每一頁最後多一列，而它在下一頁重覆出現
 *   · 翻頁時把篩選弄丟 → 篩選變成「只在第一頁有用」的功能
 *   · 日期上界用 `lte` → 那一整天的東西不見了，而畫面上看不出原因
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PAGE_SIZE,
  keepQuery,
  pageQuery,
  pageSlice,
  parseDayRange,
  parsePage,
  parseSearch,
  resolveYearFilter,
} from '../lib/listing.mjs';

// ── 頁碼 ─────────────────────────────────────────────────────────

test('讀不懂的頁碼一律回第 1 頁，不是丟錯', () => {
  // 這個值來自網址列，使用者手改或連結被截斷都會發生，
  // 而一個 500 頁面對「頁碼打錯」是過度的反應。
  assert.equal(parsePage(undefined), 1);
  assert.equal(parsePage(''), 1);
  assert.equal(parsePage('abc'), 1);
  assert.equal(parsePage('0'), 1);
  assert.equal(parsePage('-5'), 1);
  assert.equal(parsePage(null), 1);
});

test('正常的頁碼讀得出來', () => {
  assert.equal(parsePage('1'), 1);
  assert.equal(parsePage('7'), 7);
  assert.equal(parsePage(3), 3);
});

test('大得離譜的頁碼被夾住', () => {
  // `?page=99999999999` 會變成一次 OFFSET 4e11 的查詢，
  // 而 Postgres 會認真地掃過去。
  assert.equal(parsePage('99999999999'), 10_000);
});

test('小數點與科學記號不會變成 NaN', () => {
  assert.equal(parsePage('2.7'), 2);
  // parseInt('1e9') 是 1，那是對的——重點是它不是 NaN。
  assert.ok(Number.isInteger(parsePage('1e9')));
});

// ── skip / take ─────────────────────────────────────────────────

test('第 1 頁不 skip，而且多取一筆', () => {
  const q = pageQuery('1', 40);
  assert.equal(q.skip, 0);
  assert.equal(q.take, 41);
});

test('第 3 頁跳過前兩頁', () => {
  const q = pageQuery('3', 40);
  assert.equal(q.skip, 80);
  assert.equal(q.take, 41);
});

test('壞掉的頁碼在 skip 上也是安全的', () => {
  const q = pageQuery('abc', 40);
  assert.equal(q.skip, 0);
  assert.ok(Number.isFinite(q.skip));
});

test('預設一頁的筆數三頁共用', () => {
  assert.equal(pageQuery('1').take, PAGE_SIZE + 1);
});

// ── 切片 ─────────────────────────────────────────────────────────

test('剛好滿一頁時沒有下一頁', () => {
  // 邊界：正好 size 筆。多取的那一筆沒有回來，所以後面沒有東西了。
  const rows = Array.from({ length: 40 }, (_, i) => i);
  const p = pageSlice(rows, '1', 40);
  assert.equal(p.rows.length, 40);
  assert.equal(p.hasNext, false);
  assert.equal(p.hasPrev, false);
  assert.equal(p.from, 1);
  assert.equal(p.to, 40);
});

test('多取的那一筆一定要被切掉', () => {
  // 漏掉 slice 的話，每一頁的最後會多出一列，而它在下一頁的第一列
  // 重覆出現——看的人會以為資料重複了。
  const rows = Array.from({ length: 41 }, (_, i) => i);
  const p = pageSlice(rows, '1', 40);
  assert.equal(p.rows.length, 40);
  assert.equal(p.hasNext, true);
  assert.equal(p.rows.at(-1), 39, '第 41 筆被畫出來了');
});

test('第 2 頁的序號接得上第 1 頁', () => {
  const rows = Array.from({ length: 41 }, (_, i) => i);
  const p = pageSlice(rows, '2', 40);
  assert.equal(p.from, 41);
  assert.equal(p.to, 80);
  assert.equal(p.hasPrev, true);
  assert.equal(p.hasNext, true);
});

test('最後一頁只有幾筆時，序號不會超過實際筆數', () => {
  const rows = [1, 2, 3];
  const p = pageSlice(rows, '2', 40);
  assert.equal(p.from, 41);
  assert.equal(p.to, 43);
  assert.equal(p.hasNext, false);
});

test('空的一頁：from 是 0，而且沒有下一頁', () => {
  // 最後一頁被刪光之後 page 還停在那裡。這時要能安靜地顯示空狀態，
  // 而不是「第 41–40 筆」這種讀不懂的東西。
  const p = pageSlice([], '3', 40);
  assert.equal(p.rows.length, 0);
  assert.equal(p.from, 0);
  assert.equal(p.hasNext, false);
  assert.equal(p.hasPrev, true, '第 3 頁一定回得去第 2 頁');
});

test('第 1 頁沒有上一頁', () => {
  assert.equal(pageSlice([1], '1', 40).hasPrev, false);
});

// ── 查詢字串 ─────────────────────────────────────────────────────

test('翻頁時保留篩選', () => {
  // 少了這一件，篩選就變成「只在第一頁有用」的功能。
  const url = keepQuery('/grades', { subject: 'math', from: '2026-09-01' }, { page: '2' });
  assert.match(url, /subject=math/);
  assert.match(url, /from=2026-09-01/);
  assert.match(url, /page=2/);
});

test('空值與 undefined 的鍵會被拿掉，網址不累積空參數', () => {
  const url = keepQuery('/grades', { subject: '', q: undefined, page: '3' }, {});
  assert.equal(url, '/grades?page=3');
});

test('把頁碼設成 undefined 就是回第 1 頁而且網址乾淨', () => {
  const url = keepQuery('/bank', { subject: 'math', page: '5' }, { page: undefined });
  assert.equal(url, '/bank?subject=math');
});

test('什麼都沒有時回原本的路徑，不是一個空的問號', () => {
  assert.equal(keepQuery('/bank', {}, {}), '/bank');
  assert.equal(keepQuery('/bank', { q: '' }, {}), '/bank');
});

test('換篩選條件時把頁碼歸零', () => {
  // 停在第 5 頁換一個只有 30 題的科目會得到一片空白，
  // 而使用者看到的是「這一科沒有題目」。
  const url = keepQuery('/bank', { subject: 'a', page: '5' }, { page: undefined, subject: 'b' });
  assert.equal(url, '/bank?subject=b');
});

// ── 日期區間 ─────────────────────────────────────────────────────

test('上界含當天最後一秒', () => {
  // `lte: 9/30 00:00` 會把 9 月 30 日整天排除掉——一份 9/30 下午
  // 截止的考試不見了，而畫面上完全看不出原因。
  const r = parseDayRange(null, '2026-09-30');
  assert.ok(r.lt);
  // 台北 10/1 00:00 = UTC 9/30 16:00
  assert.equal(r.lt.toISOString(), '2026-09-30T16:00:00.000Z');
});

test('下界是台北時間那一天的開始，不是 UTC 的', () => {
  // 用 UTC 午夜切的話，9/1 08:00（台北）之前的東西會落到 8 月。
  const r = parseDayRange('2026-09-01', null);
  assert.equal(r.gte.toISOString(), '2026-08-31T16:00:00.000Z');
});

test('同一天的起訖是一個 24 小時的區間', () => {
  const r = parseDayRange('2026-09-15', '2026-09-15');
  assert.equal(r.lt.getTime() - r.gte.getTime(), 24 * 3600 * 1000);
});

test('讀不懂的日期當作沒填，不丟錯', () => {
  const r = parseDayRange('九月一號', 'x');
  assert.equal(r.gte, null);
  assert.equal(r.lt, null);
});

test('不存在的日期當作沒填', () => {
  // 2026-02-30：Date 會自動進位成 3 月 2 日而不報錯。
  // 進位之後那個區間看起來完全正常，只是少了兩天的資料。
  const r = parseDayRange('2026-02-30', null);
  assert.equal(r.gte, null);
});

test('兩端都沒填時兩個都是 null', () => {
  const r = parseDayRange(undefined, undefined);
  assert.equal(r.gte, null);
  assert.equal(r.lt, null);
});

// ── 搜尋字 ───────────────────────────────────────────────────────

test('空的搜尋字回 null，讓呼叫端直接展開', () => {
  assert.equal(parseSearch(''), null);
  assert.equal(parseSearch('   '), null);
  assert.equal(parseSearch(undefined), null);
});

test('前後空白拿掉', () => {
  assert.equal(parseSearch('  第一次段考  '), '第一次段考');
});

test('太長的截斷而不是拒絕', () => {
  // 搜尋框被貼進一整段文字是常見的事（複製了一整列），
  // 而回一句「太長」對使用者沒有任何幫助。
  const long = 'a'.repeat(500);
  assert.equal(parseSearch(long).length, 80);
});

// ── 學年度篩選 ───────────────────────────────────────────────────

const Y = (id, isCurrent = false) => ({ id, isCurrent });

test('沒指定時預設看當前學年度', () => {
  // isCurrent 在此之前唯一有行為的使用是開班對話框的下拉預選。
  // 沒有這個預設的話，第二年開學時班級列表上是十四個班，
  // 其中七個已經沒有人了，而看的人分不出是哪七個。
  assert.equal(resolveYearFilter(undefined, [Y('a'), Y('b', true)]), 'b');
  assert.equal(resolveYearFilter('', [Y('a'), Y('b', true)]), 'b');
});

test('`all` 代表全部年度', () => {
  // 預設藏起來而沒有出口的話，那不是篩選，那是資料不見了。
  assert.equal(resolveYearFilter('all', [Y('a', true)]), null);
});

test('指定一個存在的年度就看那一年', () => {
  assert.equal(resolveYearFilter('a', [Y('a'), Y('b', true)]), 'a');
});

test('認不得的 id 退回預設，不是查一個不存在的年度', () => {
  // 舊書籤或被刪掉的年度。直接拿去查會得到一張空表，
  // 而空表與「這一年沒有班」長得一模一樣。
  assert.equal(resolveYearFilter('ghost', [Y('a'), Y('b', true)]), 'b');
});

test('一個學年度都還沒建的時候回 null 而不是 undefined', () => {
  // 回 undefined 的話，展開成 where 條件會變成
  // `academicYearId: undefined`，而 Prisma 對它的解讀是「不限」——
  // 剛好對，但那是碰巧，換一個寫法就錯。
  assert.equal(resolveYearFilter(undefined, []), null);
  assert.equal(resolveYearFilter('x', []), null);
});

test('沒有任何一年是當前時顯示全部，不是顯示空的', () => {
  assert.equal(resolveYearFilter(undefined, [Y('a'), Y('b')]), null);
});
