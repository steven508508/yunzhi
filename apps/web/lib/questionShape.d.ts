export declare function normalizeOptions(
  raw: unknown,
  answerKeys?: number[],
): {
  options: { order: number; label: string; content: string }[];
  answerKeys: number[];
  dropped: number[];
  /** 內容一模一樣的選項，成對列出標籤（多半是向量箭頭或上標被讀掉了）。 */
  duplicates: string[][];
};

/** 一張入庫後的題目附圖。形狀由 `normalizeAssets` 決定。 */
export type CommittedAsset = {
  /** 題幹裡 `![[a:id]]` 指的名字。講義那條路產出的圖沒有 id。 */
  id: string | null;
  key: string;
  page: number | null;
  bbox: unknown;
  alt: string;
  caption: string;
  /** 這張圖該畫多大（CSS 像素）。舊資料沒有，所以可能是 null。 */
  width: number | null;
  height: number | null;
  kind: string;
};

/**
 * 題目附圖，入庫時的形狀。沒有物件鍵的項目丟掉；
 * 一張都不剩時回 `undefined`（那一欄存 null 而不是 `[]`）。
 */
export declare function normalizeAssets(raw: unknown): CommittedAsset[] | undefined;
