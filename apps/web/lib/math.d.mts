/** 型別宣告。實作在 math.mjs——純字串處理加 KaTeX，不碰資料庫，所以測得動。 */

export type MathSegment = {
  /**
   * `text` 的 value 還沒轉義；`inline` 與 `display` 的 value 是不含分隔符的
   * TeX；`asset` 的 value 是附圖 id（不含 `![[a:` 與 `]]`）。
   */
  kind: 'text' | 'inline' | 'display' | 'asset';
  value: string;
};

/** 一張題目附圖。形狀由 `lib/commit.ts` 的 `normalizeAssets` 寫入。 */
export type QuestionAsset = {
  /** 題幹裡 `![[a:id]]` 指的名字。講義那條路產出的圖沒有 id。 */
  id: string | null;
  /** 物件儲存的鍵。**這是唯一必有的欄位**，沒有它就沒有圖可以顯示。 */
  key: string;
  alt: string;
  caption: string;
  labels: string[];
  /** 裁圖時量到的像素尺寸。舊資料沒有，所以可能是 null。 */
  width: number | null;
  height: number | null;
  kind: string;
};

export declare function escapeHtml(value: unknown): string;
export declare function splitMath(source: string | null | undefined): MathSegment[];
export declare function hasMath(source: string | null | undefined): boolean;
/** 這一段引用了哪幾張附圖，依出現順序、去重。 */
export declare function referencedAssets(source: string | null | undefined): string[];
/** 回傳可直接放進 `dangerouslySetInnerHTML` 的 HTML。純文字片段已轉義。 */
export declare function renderMathHtml(source: string | null | undefined): string;
/** 把 Json 欄位讀成附圖清單。壞掉的項目略過，不丟例外。 */
export declare function readAssets(raw: unknown): QuestionAsset[];
/** 替代文字。**永遠不是空字串**，理由見 math.mjs。 */
export declare function figureAlt(
  asset: QuestionAsset | null | undefined,
  opts?: { label?: string; index?: number; count?: number },
): string;
