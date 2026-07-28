/** 型別宣告。實作在 csv.mjs——它有兩個呼叫端，其中一個不經過 TypeScript。 */
export declare function decodeCsv(
  bytes: Uint8Array | ArrayBufferLike,
): { text: string; encoding: string };
export declare function parseCsv(text: string): string[][];
export declare function normalizeHeader(raw: unknown): string;
export declare function matchColumns(
  headerRow: string[],
  aliases: Record<string, readonly string[]>,
): Record<string, number | undefined>;
