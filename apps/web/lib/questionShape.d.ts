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
