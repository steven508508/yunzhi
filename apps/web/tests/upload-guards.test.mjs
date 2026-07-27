/**
 * 上傳關卡的測試：檔案型態判定與權利聲明。
 *
 * 這兩件事都在「老師按下上傳」與「花錢解析」之間，所以它們錯掉的
 * 代價不對稱：放行不該放行的，代價是一份跑了半小時才失敗的匯入、
 * 或一批日後不能用的題目；擋掉不該擋的，代價是一句看不懂的錯誤。
 * 兩邊都值得測到具體案例，而不只是 happy path。
 *
 * 用 node --experimental-strip-types 直接吃 .ts，不必先編譯——
 * 少一個建置步驟，測試就少一個「忘了重新編譯」的失敗模式。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sniff, mimeFor, extFor, rejectReason } from '../lib/filetype.ts';
import {
  allowedScopes,
  defaultScope,
  validateDeclaration,
  explanationPolicy,
} from '../lib/rights.ts';

const bytes = (...parts) => {
  const out = [];
  for (const p of parts) {
    if (typeof p === 'string') out.push(...[...p].map((c) => c.charCodeAt(0)));
    else out.push(...p);
  }
  return new Uint8Array(out);
};

const pad = (n) => new Uint8Array(n).fill(0x41);

// ── 檔案型態 ─────────────────────────────────────────────────

test('依內容判定型態，不看副檔名', () => {
  const jpeg = bytes([0xff, 0xd8, 0xff, 0xe0], pad(40));
  // 老師把照片改名成 .pdf 上傳——這在真實世界會發生
  assert.equal(sniff(jpeg, '數學講義.pdf'), 'image');
  assert.equal(mimeFor(sniff(jpeg, 'x.pdf'), jpeg, 'x.pdf'), 'image/jpeg');
  assert.equal(extFor(sniff(jpeg, 'x.pdf'), jpeg, 'x.pdf'), 'jpg');
});

test('認得各種真實會遇到的格式', () => {
  const cases = [
    ['PDF', bytes('%PDF-1.7', pad(20)), 'pdf'],
    ['PNG', bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], pad(20)), 'image'],
    ['JPEG', bytes([0xff, 0xd8, 0xff], pad(20)), 'image'],
    ['WebP', bytes('RIFF', pad(4), 'WEBP', pad(20)), 'image'],
    ['HEIC', bytes(pad(4), 'ftypheic', pad(20)), 'image'],
  ];
  for (const [name, data, want] of cases) {
    assert.equal(sniff(data, `x.${want}`), want, `${name} 判定錯誤`);
  }
});

test('HEIC 是 iPhone 預設格式，一定要收', () => {
  // 老師用手機拍講義，多數 iPhone 存的是 HEIC 而不是 JPEG。
  // 不收的話，最常見的一種上傳方式會直接被擋掉。
  const heic = bytes([0, 0, 0, 0x18], 'ftypheic', pad(20));
  assert.equal(sniff(heic, 'IMG_1234.HEIC'), 'image');
  assert.equal(mimeFor('image', heic, 'IMG_1234.HEIC'), 'image/heic');
});

test('ZIP 容器要靠副檔名才分得出是不是 docx', () => {
  const zip = bytes('PK', [0x03, 0x04], pad(30));
  assert.equal(sniff(zip, '講義.docx'), 'docx');
  assert.equal(sniff(zip, '講義.odt'), 'docx');
  assert.equal(sniff(zip, '講義.zip'), 'unknown');
  assert.equal(
    extFor('docx', zip, '講義.odt'),
    'odt',
    'ODT 不能被寫成 docx，LibreOffice 靠副檔名決定怎麼讀',
  );
});

test('無法辨識時，訊息要告訴老師下一步怎麼做', () => {
  const cases = [
    [bytes('PK', [3, 4], pad(20)), '講義.zip', /解壓縮/],
    [bytes([0xd0, 0xcf, 0x11, 0xe0], pad(20)), '舊講義.doc', /另存成 \.docx/],
    [bytes('{\\rtf1', pad(20)), '講義.rtf', /RTF/],
    [bytes('<!DOCTYPE html>', pad(20)), '網頁.html', /列印成 PDF/],
    [bytes([0x00, 0x01, 0x02, 0x03], pad(20)), '不明檔', /支援 PDF/],
  ];
  for (const [data, name, pattern] of cases) {
    const msg = rejectReason(data, name);
    assert.match(msg, pattern, `「${name}」的訊息沒有給出下一步：${msg}`);
    assert.ok(msg.includes(name), '訊息要指出是哪個檔案');
  }
});

// ── 權利聲明 ─────────────────────────────────────────────────

test('出版社講義一律不可匯出', () => {
  const scopes = allowedScopes('PUBLISHER_SCAN');
  assert.deepEqual(scopes, ['TENANT_NO_EXPORT', 'INTERNAL_USE_ONLY']);
  assert.equal(defaultScope('PUBLISHER_SCAN'), 'TENANT_NO_EXPORT');

  const err = validateDeclaration({
    sourceType: 'PUBLISHER_SCAN',
    licenseScope: 'TENANT_EXPORTABLE',
    rightsBasis: 'LICENSED',
    rightsNote: '已取得同意',
  });
  assert.match(err ?? '', /不可匯出/);
});

test('只有歷屆試題可以設為公開', () => {
  assert.ok(allowedScopes('OFFICIAL_PAST').includes('PUBLIC'));
  for (const s of ['TEACHER_ORIGINAL', 'SCHOOL_EXAM', 'PUBLISHER_SCAN', 'AI_GENERATED']) {
    assert.ok(!allowedScopes(s).includes('PUBLIC'), `${s} 不該能設為公開`);
  }
  const err = validateDeclaration({
    sourceType: 'SCHOOL_EXAM',
    licenseScope: 'PUBLIC',
    rightsBasis: 'LICENSED',
    rightsNote: '學校同意',
  });
  assert.match(err ?? '', /只有歷屆試題/);
});

test('聲明「已取得書面同意」時必須寫下依據', () => {
  const withoutNote = validateDeclaration({
    sourceType: 'PUBLISHER_SCAN',
    licenseScope: 'TENANT_NO_EXPORT',
    rightsBasis: 'LICENSED',
  });
  assert.match(withoutNote ?? '', /備註|來源與日期/);

  const withNote = validateDeclaration({
    sourceType: 'PUBLISHER_SCAN',
    licenseScope: 'TENANT_NO_EXPORT',
    rightsBasis: 'LICENSED',
    rightsNote: '2026/03 與翰林業務確認',
  });
  assert.equal(withNote, null);
});

test('出版社講義不能宣稱是官方公開資料', () => {
  const err = validateDeclaration({
    sourceType: 'PUBLISHER_SCAN',
    licenseScope: 'TENANT_NO_EXPORT',
    rightsBasis: 'OFFICIAL_PUBLIC',
  });
  assert.match(err ?? '', /不是官方公開資料/);
});

test('合規的組合要放行', () => {
  const ok = [
    { sourceType: 'OFFICIAL_PAST', licenseScope: 'PUBLIC', rightsBasis: 'OFFICIAL_PUBLIC' },
    {
      sourceType: 'TEACHER_ORIGINAL',
      licenseScope: 'TENANT_EXPORTABLE',
      rightsBasis: 'OWNED',
    },
    {
      sourceType: 'PUBLISHER_SCAN',
      licenseScope: 'INTERNAL_USE_ONLY',
      rightsBasis: 'UNVERIFIED',
    },
  ];
  for (const d of ok) {
    assert.equal(validateDeclaration(d), null, `${d.sourceType} 不該被擋：${validateDeclaration(d)}`);
  }
});

test('未確認權利時要先告知解析會被改寫', () => {
  // 這句話出現在上傳當下，而不是等到學生看解析時才發現內容不一樣。
  assert.match(explanationPolicy('UNVERIFIED'), /重新撰寫/);
  assert.match(explanationPolicy('OWNED'), /可以原文收錄/);
});
