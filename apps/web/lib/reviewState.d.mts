/**
 * 型別宣告。實作在 reviewState.mjs——純判斷，不碰 DOM 也不碰網路，所以測得動。
 *
 * **副檔名是 `.d.mts` 而不是 `.d.ts`。** TypeScript 為 `./x.mjs` 找宣告檔時
 * 只看 `./x.d.mts`；放成 `x.d.ts` 它會安靜地略過，改用 `allowJs` 從實作
 * 推論出來的形狀——而預設參數推出來的型別多半帶著 `undefined`，
 * 於是呼叫端傳一個正常的值進去會被判成錯誤，訊息指的地方跟原因差很遠。
 */

export type ReviewOption = { order: number; label: string; content: string };

export type OptionEdit = {
  options: ReviewOption[];
  answerKeys: number[];
  /** 對不上任何選項的答案鍵。有值代表答案被這次編輯弄掉了，要說出來。 */
  dropped: number[];
};

export declare function nextOptionLabel(options: readonly Partial<ReviewOption>[]): string;

export declare function addOption(
  options: readonly Partial<ReviewOption>[],
  answerKeys: readonly number[],
): OptionEdit;

export declare function removeOption(
  options: readonly Partial<ReviewOption>[],
  answerKeys: readonly number[],
  order: number,
): OptionEdit;

export declare function setOptionContent(
  options: readonly Partial<ReviewOption>[],
  answerKeys: readonly number[],
  order: number,
  content: string,
): OptionEdit;

export declare function moveOption(
  options: readonly Partial<ReviewOption>[],
  answerKeys: readonly number[],
  order: number,
  delta: number,
): OptionEdit;

export declare const CHOICE_TYPES: string[];

export declare function answerKeysForType(
  type: string | null,
  answerKeys: readonly number[],
): number[];

export declare function toggleAnswerKey(
  type: string | null,
  answerKeys: readonly number[],
  order: number,
): number[];

export declare function optionIssues(
  options: readonly Partial<ReviewOption>[],
  answerKeys: readonly number[],
  type: string | null,
): { code: string; detail: string }[];

export declare function saveBatchSize(failures?: number): number;

export declare const SAVE_RETRY_MS: number[];

export declare function saveRetryDelay(failures?: number): number;

export type SaveKind = 'idle' | 'saving' | 'saved' | 'failing';

export declare function saveIndicator(input?: {
  inFlight?: boolean;
  pendingCount?: number;
  failures?: number;
  savedAtLabel?: string | null;
  lastStatus?: number | null;
}): { kind: SaveKind; urgent: boolean; label: string; detail: string | null };

export declare function commitBlocked(input?: {
  failures?: number;
  pendingCount?: number;
  ready?: number;
}): { blocked: boolean; reason: string | null };

export declare function reviewSecondsDelta(
  reportedSec: number,
  currentSec: number,
  cap?: number,
): number;

export declare function paceEstimate(input?: {
  doneNow?: number;
  doneAtMount?: number;
  elapsedSec?: number;
  total?: number;
  targetSec?: number;
  minSamples?: number;
}): { per: number; est: number; remaining: number; ok: boolean } | null;

export declare function reviewSummary(input?: {
  total?: number;
  seconds?: number;
}): { perQuestion: number; minutes: number; text: string; projectedFifty: number } | null;

export declare function fmtDuration(sec: number): string;
