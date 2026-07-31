/**
 * 型別宣告。實作在 takeState.mjs——純判斷，不碰 DOM 也不碰網路，所以測得動。
 *
 * **副檔名是 `.d.mts` 而不是 `.d.ts`。** TypeScript 為 `./x.mjs` 找宣告檔時
 * 只看 `./x.d.mts`；放成 `x.d.ts` 它會安靜地略過，改用 `allowJs` 從實作
 * 推論出來的形狀——而預設參數 `savedAtLabel = null` 推出來的型別是
 * `null | undefined`，於是傳一個字串進去會被判成錯誤，錯誤訊息指的地方
 * 跟原因差很遠。
 */

export declare const FETCH_TIMEOUT_MS: {
  load: number;
  save: number;
  status: number;
  submit: number;
};

export type SaveKind = 'idle' | 'saving' | 'saved' | 'retrying';

export declare function saveIndicator(input?: {
  inFlight?: boolean;
  pendingCount?: number;
  failures?: number;
  savedAtLabel?: string | null;
}): { kind: SaveKind; urgent: boolean; label: string; detail: string | null };

/**
 * 待送出佇列與**正在飛的那一批**合起來還有幾題沒到伺服器。
 * 泛型：作答頁的 `Pending` 形狀由那一頁定義，這裡只要求有 `questionId`。
 */
export declare function unsentAnswers<T extends { questionId: string }>(
  inFlightBatch: readonly T[] | null | undefined,
  pending: ReadonlyMap<string, T> | null | undefined,
): T[];

export declare function answeredGap(input?: {
  local?: number | null;
  server?: number | null;
  /** 傳 `unsentAnswers(...).length`，不是 `pending.size`。 */
  pendingCount?: number;
}): { kind: 'unknown' | 'ok' | 'pending' | 'lost'; gap: number; detail: string | null };

export declare function submitCheck(input?: {
  local?: number | null;
  server?: number | null;
  total?: number | null;
}): {
  kind: 'unknown' | 'ok' | 'short' | 'mismatch';
  local: number;
  server: number | null;
  total: number;
  missing: number;
  blank: number;
};

/** 只讀這幾個欄位，所以不必依賴 `TakeQuestion` 的完整形狀。 */
export type StimulusSource = {
  order: number;
  stimulus: string | null;
  stimulusLabel: string | null;
  /** 題組共用的附圖。`unknown`：這一層不認得 Prisma 的 Json 型別。 */
  stimulusAssets?: unknown;
  groupId: string | null;
};

export declare function stimulusFor(
  questions: readonly StimulusSource[],
  index: number,
): {
  stimulus: string;
  label: string | null;
  /** 與 `stimulus` 同一題來源的附圖。沒有圖是 `null`，不是 `undefined`。 */
  assets: unknown;
  inherited: boolean;
} | null;

export declare function groupRange(
  questions: readonly StimulusSource[],
  index: number,
): { from: number; to: number; count: number } | null;

export declare const TIME_ALERTS: number[];

export declare function timeAlert(
  prev: number | null | undefined,
  left: number | null | undefined,
): { threshold: number; minutes: number } | null;

export declare function listUnanswered(
  items: readonly { order: number; answered: boolean }[],
  max?: number,
): { count: number; orders: number[]; text: string };

export declare const SUBMIT_RETRY_MS: number[];

export declare function submitRetryDelay(failures: number): number | null;
