/**
 * 型別宣告。實作在 admissionSources.mjs——純資料與純字串組裝，
 * **一行 fetch 都沒有**（文件 07 §2.1 的硬規則）。
 *
 * **副檔名是 `.d.mts` 而不是 `.d.ts`**，理由見 takeState.d.mts：
 * TypeScript 為 `./x.mjs` 找宣告檔時只看 `./x.d.mts`。
 *
 * `url` 刻意宣告成 `string | null`。null 不是「還沒填」——它表示
 * **這一項網路上查不到**（在校百分比只有教務處有），而畫面要為那種情形
 * 顯示完全不同的東西。宣告成 `string` 再塞空字串的話，畫面會渲染出
 * 一個點下去什麼都不會發生的連結。
 */

/** 依學年度推導出來的。可能有效，可能已經搬家——一律附 caution 與 fallback。 */
export declare const URL_DERIVED: 'DERIVED';
/** 已經查證過的固定網址（首頁、機構入口）。 */
export declare const URL_FIXED: 'FIXED';
/** 推不出來。只能給入口加導覽指示，`url` 永遠不是深連結。 */
export declare const URL_NONE: 'NONE';

export type UrlKind = 'DERIVED' | 'FIXED' | 'NONE';

export declare const CAC_PORTAL: string;
export declare const CEEC: string;
export declare const JBCRC_CALENDAR: string;

export type SourceWhere = {
  url: string | null;
  urlKind: UrlKind;
  label: string;
  caution?: string;
  /** 從入口走到那一頁的步驟。推不出網址的那一類靠它。 */
  navigation?: string[];
  fallback?: string;
  fallbackLabel?: string;
};

export declare function starCircularUrl(year: number): SourceWhere;
export declare function sieveStandardGuide(): SourceWhere;
export declare function schoolOfficeOnly(): SourceWhere;

export type ChecklistStep = {
  key: string;
  when: string;
  title: string;
  what: string;
  where: SourceWhere[];
  /** 查到之後輸入到哪裡。null 表示這一項不必輸入系統。 */
  recordAs: { kind: string; label: string } | null;
  recordHint: string;
};

export declare function sourceChecklist(year?: number): ChecklistStep[];

export declare function whereToLookFor(
  kind: string,
  year?: number,
): { key: string; when: string; title: string; where: SourceWhere[] } | null;
