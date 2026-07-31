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

/** 這一段文字引用了哪幾張附圖（`![[a:id]]`），依出現順序、去重。 */
export declare function referencedAssetIds(text: unknown): string[];

/**
 * 這一段文字裡指不到任何一張圖的標記 id。給已經分好欄位的資料用
 * （題庫裡的題目，三個欄位各存各的）。
 */
export declare function missingAssetRefs(text: unknown, assets: unknown): string[];

/**
 * 把一題的附圖分給題組素材、題幹與各個選項。校對頁的預覽與入庫
 * 走同一支，理由見 .mjs 的說明。
 */
export declare function partitionAssets(input: {
  assets?: unknown;
  stimulus?: unknown;
  content?: unknown;
  options?: unknown;
}): {
  stimulusAssets: Record<string, unknown>[];
  contentAssets: Record<string, unknown>[];
  optionAssets: { order: number; label: string; assets: Record<string, unknown>[] }[];
  /** 指向不存在的圖的標記。有值代表學生會在那個位置看到一行紅字。 */
  missing: { where: string; id: string }[];
};
