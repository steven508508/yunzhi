/** 型別宣告。實作在 listing.mjs——純函式，不碰資料庫，所以測得動。 */

export declare const PAGE_SIZE: number;

export declare function parsePage(raw: unknown): number;

export declare function pageQuery(
  page: unknown,
  size?: number,
): { skip: number; take: number; page: number; size: number };

export declare function pageSlice<T>(
  rows: readonly T[],
  page: unknown,
  size?: number,
): {
  rows: T[];
  page: number;
  hasNext: boolean;
  hasPrev: boolean;
  from: number;
  to: number;
};

export declare function keepQuery(
  base: string,
  current: Record<string, string | undefined>,
  patch: Record<string, string | undefined>,
): string;

export declare function parseDayRange(
  fromRaw: unknown,
  toRaw: unknown,
): { gte: Date | null; lt: Date | null };

export declare function resolveYearFilter(
  raw: unknown,
  years: readonly { id: string; isCurrent?: boolean }[],
): string | null;

export declare function parseSearch(raw: unknown, max?: number): string | null;
