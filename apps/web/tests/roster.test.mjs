/**
 * 名冊 CSV 的讀取。
 *
 * 這一支測的全部是**真實世界的髒東西**，不是 happy path：
 * Big5、BOM、民國年、引號裡的逗號、重複學號、空列。
 *
 * 每一項都對應到一個具體的失敗場景：櫃檯人員在開學前一天匯入
 * 32 人的名冊，然後看到「格式錯誤」。對他來說那等於「不知道
 * 為什麼」，而下一步就是打電話問，或者放棄改用 Excel。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeCsv, matchColumns, normalizeHeader, parseCsv } from '../lib/csv.mjs';
import { ROSTER_COLUMNS, parseBirth } from '../lib/rosterColumns.mjs';

// ── 編碼 ─────────────────────────────────────────────────────────

test('Windows 版 Excel 存出來的 Big5 讀得出來', () => {
  // 「學號,姓名\r\n1,王小明」的 Big5 位元組。台灣的櫃檯用 Excel
  // 「另存新檔 → CSV (逗號分隔)」存出來就是這個，而不是 UTF-8。
  const big5 = Buffer.from([
    0xbe, 0xc7, 0xb8, 0xb9, 0x2c, 0xa9, 0x6d, 0xa6, 0x57, 0x0d, 0x0a,
    0x31, 0x2c, 0xa4, 0xfd, 0xa4, 0x70, 0xa9, 0xfa,
  ]);
  const { text, encoding } = decodeCsv(big5);
  assert.equal(encoding, 'big5');
  assert.ok(text.includes('學號'), `Big5 沒解對：${JSON.stringify(text)}`);
  assert.ok(text.includes('王小明'));
});

test('UTF-8 不會被誤判成 Big5', () => {
  // 順序很重要：UTF-8 的中文用 Big5 解得開（會得到亂碼但不報錯），
  // 所以必須先試 UTF-8。反過來的話好檔案會被讀成垃圾。
  const { text, encoding } = decodeCsv(Buffer.from('學號,姓名\n1,王小明', 'utf8'));
  assert.equal(encoding, 'utf-8');
  assert.ok(text.includes('王小明'));
});

test('UTF-8 BOM 不會污染第一個欄位標題', () => {
  // Excel 的「CSV UTF-8」會加 BOM。不處理的話第一欄標題是
  // `﻿學號`，於是「找不到學號欄」——而檔案看起來完全正常。
  const { text, encoding } = decodeCsv(
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('學號,姓名\n1,王', 'utf8')]),
  );
  assert.equal(encoding, 'utf-8-bom');
  const cols = matchColumns(parseCsv(text)[0], ROSTER_COLUMNS);
  assert.equal(cols.username, 0, 'BOM 讓學號欄對不上了');
});

// ── 解析 ─────────────────────────────────────────────────────────

test('引號裡的逗號不會把欄位切開', () => {
  const rows = parseCsv('學號,姓名,備註\n1,王小明,"轉學生, 需補課"');
  assert.deepEqual(rows[1], ['1', '王小明', '轉學生, 需補課']);
});

test('引號裡的換行與跳脫引號', () => {
  const rows = parseCsv('a,b\n"第一行\n第二行","他說""好"""');
  assert.equal(rows.length, 2);
  assert.equal(rows[1][0], '第一行\n第二行');
  assert.equal(rows[1][1], '他說"好"');
});

test('CRLF 與 LF 都吃', () => {
  assert.equal(parseCsv('a,b\r\n1,2\r\n').length, 2);
  assert.equal(parseCsv('a,b\n1,2\n').length, 2);
});

test('末尾的空白列不算資料', () => {
  // 名冊末尾常有幾行空白，尤其是從 Excel 存出來的。
  const rows = parseCsv('學號,姓名\n1,王\n\n,\n\n');
  assert.equal(rows.length, 2, `多讀了空列：${JSON.stringify(rows)}`);
});

// ── 欄位比對 ─────────────────────────────────────────────────────

test('欄位標題不必改成系統認得的名字', () => {
  // 名冊是既有的檔案。要求櫃檯先整理一次資料，等於要求他們先做
  // 那件他們想用系統來避免的事。
  for (const header of [
    ['學號', '姓名'],
    ['學生學號', '學生姓名'],
    ['座號', '名字'],
    ['ID', 'Name'],
    ['student_id', 'student_name'],
    ['學號 ', ' 姓名'],
    ['學號(必填)', '姓名'],
  ]) {
    const cols = matchColumns(header, ROSTER_COLUMNS);
    assert.equal(cols.username, 0, `認不得 ${header[0]}`);
    assert.equal(cols.displayName, 1, `認不得 ${header[1]}`);
  }
});

test('欄位順序不固定也認得', () => {
  const cols = matchColumns(['姓名', '家長信箱', '學號'], ROSTER_COLUMNS);
  assert.equal(cols.displayName, 0);
  assert.equal(cols.guardianEmail, 1);
  assert.equal(cols.username, 2);
});

test('normalizeHeader 去掉全形空白與括號註記', () => {
  assert.equal(normalizeHeader('學　號'), '學號');
  assert.equal(normalizeHeader('學號（必填）'), '學號');
  assert.equal(normalizeHeader(' Name '), 'name');
});

// ── 民國年 ───────────────────────────────────────────────────────

test('民國年不會被當成西元年', () => {
  // 「95/3/2」是民國 95 年（西元 2006），不是西元 95 年。差 1911 年，
  // 而它直接影響「這位學生是不是未成年」——那決定要不要取得法定
  // 代理人同意（個資法第 15 條）。判錯的不是一個顯示問題。
  const roc = parseBirth('95/3/2');
  assert.equal(roc.getUTCFullYear(), 2006);
  assert.equal(roc.getUTCMonth(), 2);
  assert.equal(roc.getUTCDate(), 2);

  // 四位數就是西元
  assert.equal(parseBirth('2006/3/2').getUTCFullYear(), 2006);
  // 常見的分隔符都吃
  assert.equal(parseBirth('95-03-02').getUTCFullYear(), 2006);
  assert.equal(parseBirth('95.3.2').getUTCFullYear(), 2006);
  assert.equal(parseBirth('95／3／2').getUTCFullYear(), 2006);
});

test('不存在的日期要被擋下來，不是靜靜地滑到下個月', () => {
  // JS 的 Date 會把 2 月 30 日變成 3 月 2 日，不報錯。
  // 名冊上的錯字就這樣變成一個看起來正常的生日。
  assert.equal(parseBirth('95/2/30'), null);
  assert.equal(parseBirth('95/13/1'), null);
  assert.equal(parseBirth('民國95年'), null);
  assert.equal(parseBirth(''), null);
  assert.equal(parseBirth(null), null);
});

// ── 家長同意欄 ───────────────────────────────────────────────────

test('同意欄的常見標題都對得上', () => {
  // 這一欄是 200 人補習班第一天唯一真的做不完的那一步的出口：
  // 逐位登錄是 27 分鐘的純點擊，而在那之前那 200 個帳號一個都登不進去。
  // 對不上標題的話，櫃檯填了一整欄而系統當它不存在——
  // 而畫面上會說匯入成功。
  for (const head of ['家長同意', '同意', '法定代理人同意', '回條', 'consent']) {
    const cols = matchColumns(['學號', '姓名', head], ROSTER_COLUMNS);
    assert.equal(cols.consent, 2, `「${head}」沒有被認出來`);
  }
});

test('沒有同意欄的名冊照樣讀得動', () => {
  // 大部分既有的名冊不會有這一欄，而要求櫃檯先加一欄才匯得進來，
  // 等於要求他們先做一次資料整理——那正是他們想用系統來避免的事。
  const cols = matchColumns(['學號', '姓名'], ROSTER_COLUMNS);
  assert.equal(cols.username, 0);
  assert.equal(cols.consent, undefined);
});

test('同意欄不會把「家長信箱」搶走', () => {
  // 兩個標題都以「家長」開頭。搶錯的話，一整欄的信箱會被當成同意，
  // 而每一個信箱都是「讀不懂的值」——整份名冊匯不進來。
  const cols = matchColumns(['學號', '姓名', '家長信箱', '家長同意'], ROSTER_COLUMNS);
  assert.equal(cols.guardianEmail, 2);
  assert.equal(cols.consent, 3);
});
