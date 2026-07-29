/** 型別宣告。實作在 math.mjs——純字串處理加 KaTeX，不碰資料庫，所以測得動。 */

export type MathSegment = {
  /** `text` 的 value 還沒轉義；`inline` 與 `display` 的 value 是不含分隔符的 TeX。 */
  kind: 'text' | 'inline' | 'display';
  value: string;
};

export declare function escapeHtml(value: unknown): string;
export declare function splitMath(source: string | null | undefined): MathSegment[];
export declare function hasMath(source: string | null | undefined): boolean;
/** 回傳可直接放進 `dangerouslySetInnerHTML` 的 HTML。純文字片段已轉義。 */
export declare function renderMathHtml(source: string | null | undefined): string;
