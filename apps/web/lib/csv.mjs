/**
 * CSV 讀取。**針對台灣的實際狀況，不是通用的解析器。**
 *
 * # 為什麼不用現成的套件
 *
 * 現成的套件解析得很好，但它們假設你已經有一個字串。而在台灣的
 * 補習班，名冊是這樣來的：
 *
 *   · 櫃檯用 Excel 開啟舊的名冊，「另存新檔 → CSV」
 *   · **Windows 版 Excel 的「CSV (逗號分隔)」在繁中系統存出來是 Big5**，
 *     不是 UTF-8。用 UTF-8 讀會得到一整份亂碼。
 *   · 選「CSV UTF-8」的話會帶 BOM，第一欄的標題會變成
 *     `﻿學號`，於是「找不到學號欄」。
 *   · 有些人是從 Google 試算表下載，那個是乾淨的 UTF-8。
 *   · 換行有 \r\n 也有 \n。
 *
 * 這四件事每一件都會讓匯入失敗，而失敗訊息會是「格式錯誤」——
 * 對櫃檯人員來說那等於「不知道為什麼」。**這個檔案存在的理由是
 * 讓那四種都能直接用。**
 *
 * # 編碼怎麼判
 *
 * 先看 BOM。沒有 BOM 就試 UTF-8 嚴格模式：Big5 的中文位元組序列
 * 在 UTF-8 底下幾乎一定是非法的，所以「UTF-8 解得開」是很強的證據。
 * 解不開才退回 Big5。
 *
 * 這個順序不能反：UTF-8 的中文用 Big5 解得開（會得到亂碼但不報錯），
 * 所以先試 Big5 會把好檔案讀成垃圾。
 */

/** 位元組 → 字串，自動判定編碼。回傳 { text, encoding }。 */
export function decodeCsv(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  // UTF-8 BOM
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return {
      text: new TextDecoder('utf-8').decode(buf.subarray(3)),
      encoding: 'utf-8-bom',
    };
  }
  // UTF-16 BOM。Excel 的「Unicode 文字」會存成這個，而且是 tab 分隔。
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf), encoding: 'utf-16le' };
  }
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buf), encoding: 'utf-16be' };
  }

  // 嚴格 UTF-8。解得開就是 UTF-8——Big5 的中文在 UTF-8 底下幾乎
  // 一定是非法序列，所以這個判斷很可靠。
  try {
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(buf),
      encoding: 'utf-8',
    };
  } catch {
    // 解不開 → 極可能是 Big5（Windows 版 Excel 在繁中系統的預設）
    return { text: new TextDecoder('big5').decode(buf), encoding: 'big5' };
  }
}

/**
 * 解析 CSV。支援引號、引號內的逗號與換行、以及 `""` 跳脫。
 *
 * 自己寫而不是用套件的理由與上面一樣：這是三十行的東西，而多一個
 * 相依就多一份要跟著 Node 版本升級的責任。行為刻意保守——
 * 遇到不認得的東西就當成一般字元，不要自作聰明。
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    // 完全空的一列（只有換行）不算資料。名冊末尾常有幾行空白。
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      i++;
      continue;
    }
    if (c === ',') {
      pushField();
      i++;
      continue;
    }
    if (c === '\r') {
      // \r\n 與單獨的 \r 都當成換行
      pushRow();
      i += text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (c === '\n') {
      pushRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== '' || row.length) pushRow();
  return rows;
}

/**
 * 欄位標題的比對。
 *
 * **不要求使用者改標題。** 名冊是既有的檔案，欄位可能叫「學號」、
 * 「學生學號」、「座號」、「ID」、「student_id」——要求櫃檯先把標題
 * 改成系統認得的名字，等於要求他們先做一次資料整理，而那正是
 * 他們想用系統來避免的事。
 *
 * 比對時忽略大小寫、空白、全形半形、以及常見的贅字。
 */
export function normalizeHeader(raw) {
  return String(raw ?? '')
    .replace(/^﻿/, '')
    .replace(/[\s　]/g, '')
    .replace(/[（(].*?[)）]/g, '')
    .toLowerCase();
}

/** 一組別名 → 正規欄位名。 */
export function matchColumns(headerRow, aliases) {
  /** @type {Record<string, number>} */
  const found = {};
  const used = new Set();
  headerRow.forEach((raw, index) => {
    const h = normalizeHeader(raw);
    for (const [field, names] of Object.entries(aliases)) {
      if (found[field] !== undefined) continue;
      if (names.some((n) => normalizeHeader(n) === h)) {
        found[field] = index;
        used.add(index);
        break;
      }
    }
  });
  return found;
}
