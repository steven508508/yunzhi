/**
 * 以檔案內容判定型態。
 *
 * 副檔名可以隨便改，而「老師把 .jpg 改名成 .pdf 上傳」這種事真的
 * 會發生（訪談第 10 題：校對者的電腦使用能力比較基礎）。用魔術
 * 位元組判定，才不會讓管線在第三階段才因為「這不是 PDF」而爆掉。
 *
 * 這裡的判定必須與 apps/ai/pipeline/normalize.py 的 sniff() 一致 ——
 * 兩邊不一致會造成「上傳時說可以、處理時說不行」這種最難解釋的
 * 失敗。tests/filetype.test.mjs 用同一組樣本驗兩邊。
 */

export type SourceKind = 'pdf' | 'image' | 'docx' | 'unknown';

const startsWith = (buf: Uint8Array, sig: number[], at = 0) =>
  sig.every((b, i) => buf[at + i] === b);

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

export function sniff(data: Uint8Array, filename = ''): SourceKind {
  if (startsWith(data, ascii('%PDF'))) return 'pdf';
  if (startsWith(data, [0xff, 0xd8])) return 'image'; // JPEG
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image'; // PNG
  if (startsWith(data, ascii('RIFF')) && startsWith(data, ascii('WEBP'), 8)) return 'image';
  if (startsWith(data, ascii('ftypheic'), 4) || startsWith(data, ascii('ftypheix'), 4)) {
    return 'image'; // HEIC，iPhone 的預設格式，老師拍講義最常見
  }
  // ZIP 容器。docx 與 odt 都是 ZIP，光看魔術位元組分不出來，
  // 也分不出它是不是一個普通的壓縮檔 —— 這是唯一需要副檔名輔助的情況。
  if (startsWith(data, ascii('PK')) && /\.(docx|odt)$/i.test(filename)) return 'docx';
  return 'unknown';
}

/** 給 S3 的 Content-Type。存錯會讓瀏覽器預覽變成下載。 */
export function mimeFor(kind: SourceKind, data: Uint8Array, filename: string): string {
  if (kind === 'pdf') return 'application/pdf';
  if (kind === 'docx') {
    return /\.odt$/i.test(filename)
      ? 'application/vnd.oasis.opendocument.text'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (kind === 'image') {
    if (startsWith(data, [0xff, 0xd8])) return 'image/jpeg';
    if (startsWith(data, [0x89, 0x50])) return 'image/png';
    if (startsWith(data, ascii('RIFF'))) return 'image/webp';
    return 'image/heic';
  }
  return 'application/octet-stream';
}

/** 依內容決定副檔名。不信任使用者給的那個。 */
export function extFor(kind: SourceKind, data: Uint8Array, filename: string): string {
  if (kind === 'pdf') return 'pdf';
  if (kind === 'docx') return /\.odt$/i.test(filename) ? 'odt' : 'docx';
  if (kind === 'image') {
    if (startsWith(data, [0xff, 0xd8])) return 'jpg';
    if (startsWith(data, [0x89, 0x50])) return 'png';
    if (startsWith(data, ascii('RIFF'))) return 'webp';
    return 'heic';
  }
  return 'bin';
}

/**
 * 給老師看的錯誤訊息。
 *
 * 「不支援的格式」對訪談第 10 題描述的使用者是沒有幫助的 ——
 * 要講清楚他手上那個檔是什麼、該怎麼辦。
 */
export function rejectReason(data: Uint8Array, filename: string): string {
  if (startsWith(data, ascii('PK'))) {
    return `「${filename}」看起來是壓縮檔或 Office 檔。如果是 Word，請確認副檔名是 .docx；如果是 .zip，請先解壓縮再逐份上傳。`;
  }
  if (startsWith(data, ascii('{\\rt'))) {
    return `「${filename}」是 RTF 格式。請用 Word 另存成 .docx 或列印成 PDF 後再上傳。`;
  }
  if (startsWith(data, [0xd0, 0xcf, 0x11, 0xe0])) {
    return `「${filename}」是舊版 Office 格式（.doc）。請用 Word 另存成 .docx 後再上傳。`;
  }
  if (startsWith(data, ascii('<!DO')) || startsWith(data, ascii('<htm'))) {
    return `「${filename}」是網頁檔。如果是從網站另存的題目，請改用列印成 PDF。`;
  }
  return `「${filename}」的格式無法辨識。目前支援 PDF、Word（.docx）、以及 JPG／PNG／HEIC 照片。`;
}
