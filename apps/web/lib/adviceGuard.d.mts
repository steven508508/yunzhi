/**
 * 型別宣告。實作在 adviceGuard.mjs——純函式，輸入是字串與一組事實，
 * 輸出是判斷，所以測得動。
 *
 * **副檔名是 `.d.mts` 而不是 `.d.ts`**，理由見 takeState.d.mts 與
 * admissionRef.d.mts：TypeScript 為 `./x.mjs` 找宣告檔時只看 `./x.d.mts`。
 */

import type { AdviceBasis } from './admissionRef.d.mts';

/**
 * 單位 → 那個單位下可以出現的制度常數。**單位是白名單的一部分**：
 * 1 至 8「名」是名額與推薦序，1 至 8「%」是繁星頂標學生的在校百分比。
 */
export declare const INSTITUTION_NUMBERS: Readonly<Record<string, readonly string[]>>;

/** 中文數字讀成數值。讀不出來回 `null`（一律當成「對不回來源」）。 */
export declare function cnNumber(text: unknown): number | null;

export declare function normalizeForAdvice(text: unknown): string;

export type AdviceFacts = {
  /** 這位學生**真的查到**的數字（正規化成 `String(Number(x))`）。 */
  numbers: string[];
  /** 制度常數。單位 → 值。 */
  institutionNumbers: Readonly<Record<string, readonly string[]>>;
  /** 可以說「近三年」的年數：**同一個校系**最多有幾年。 */
  yearCount: number;
  thresholdCount: number;
  hasOfficialDoc: boolean;
  allYears: number[];
};

export declare function adviceFacts(basis?: Partial<AdviceBasis>): AdviceFacts;

export type AdviceViolation = {
  code: string;
  /** FAKE 一定重新生成；STYLE 重來一次還這樣就收下。 */
  severity: 'FAKE' | 'STYLE';
  detail: string;
};

export declare function checkAdvice(
  advice: unknown,
  facts?: Partial<AdviceFacts>,
  opts?: { maxChars?: number },
): { ok: boolean; violations: AdviceViolation[]; fabricated: boolean };

/** 給伺服器日誌與老師端。**會引用被擋掉的數字。** */
export declare function describeAdviceViolations(
  violations: AdviceViolation[] | null | undefined,
): string;

export declare const VIOLATION_LABELS: Record<string, string>;

/** 給學生看的說明。**不含任何被擋掉的數字**，理由見 adviceGuard.mjs。 */
export declare function summarizeAdviceViolations(
  violations: AdviceViolation[] | null | undefined,
): string[];

/** 只陳述事實的版本。由程式組出來，所以它不可能製造假的精確度。 */
export declare function safeAdvice(basis?: Partial<AdviceBasis>): string;
