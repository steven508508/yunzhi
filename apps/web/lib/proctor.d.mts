/**
 * 型別宣告。實作在 proctor.mjs——純邏輯，不碰 DOM、不碰網路、不讀
 * 系統時間，所以在測試裡可以直接餵一串時間序列。
 *
 * **副檔名是 `.d.mts` 而不是 `.d.ts`。** TypeScript 為 `./x.mjs` 找宣告檔
 * 時只看 `./x.d.mts`；放成 `x.d.ts` 它會安靜地略過，改用 `allowJs` 從
 * 實作推論——而推論出來的形狀（例如預設參數推成 `null | undefined`）
 * 會讓正確的呼叫被判成錯誤，而錯誤訊息指的地方跟原因差很遠。
 * 見 takeState.d.mts 的同一段說明。
 */

export type ProctorType =
  | 'TAB_HIDDEN'
  | 'TAB_VISIBLE'
  | 'WINDOW_BLUR'
  | 'WINDOW_FOCUS'
  | 'FULLSCREEN_EXIT'
  | 'FULLSCREEN_ENTER'
  | 'PASTE'
  | 'LONG_ABSENCE';

export declare const PROCTOR_TYPES: ProctorType[];

export declare const PROCTOR: {
  MIN_AWAY_MS: number;
  MERGE_GAP_MS: number;
  LONG_ABSENCE_MS: number;
  FLUSH_DEBOUNCE_MS: number;
  MAX_BATCH: number;
  MAX_QUEUE: number;
  MAX_OFFSET_MS: number;
  WIDESPREAD_MIN_COUNT: number;
  WIDESPREAD_MIN_STUDENTS: number;
  STANDOUT_MIN_COUNT: number;
  STANDOUT_LONG_MS: number;
};

/** 貼上的字元數等。**刻意沒有任何可以放內容的欄位。** */
export type ProctorMeta = {
  chars?: number;
  count?: number;
  bursts?: number;
} | null;

/** 合併之後的一列。`at` 用的是呼叫端的時鐘（應該是單調時鐘）。 */
export type ProctorRecord = {
  type: ProctorType;
  at: number;
  durationMs: number | null;
  questionOrder: number | null;
  meta: ProctorMeta;
};

/** 送給伺服器的形狀。時刻換算成「幾毫秒之前」，見 toProctorPayload。 */
export type ProctorWire = {
  type: ProctorType;
  atOffsetMs: number;
  durationMs: number | null;
  questionOrder: number | null;
  meta: ProctorMeta;
};

export type ProctorTracker = {
  setQuestion(order: number | null | undefined): void;
  hidden(at: number): void;
  visible(at: number): void;
  blur(at: number): void;
  focus(at: number): void;
  fullscreen(isFull: boolean, at: number): void;
  paste(chars: number, at: number): void;
  close(at: number): void;
  drain(): ProctorRecord[];
  pending(): number;
  stats(): { pending: number; dropped: number; away: boolean; fullscreen: boolean };
};

export declare function createProctorTracker(init?: {
  questionOrder?: number | null;
}): ProctorTracker;

export declare function toProctorPayload(
  records: ProctorRecord[],
  now: number,
): ProctorWire[];

/** 一位學生這一場的整理結果。**每一欄都是事實，沒有判斷。** */
export type ProctorSummary = {
  awayCount: number;
  awayMs: number;
  longestMs: number;
  /** 切走之後沒有再回到這個畫面的次數。**不可以當成 0 秒。** */
  unfinished: number;
  fullscreenExits: number;
  pastes: number;
  pasteChars: number;
  total: number;
};

export declare function summarizeEvents(
  events: { type: string; durationMs?: number | null; meta?: unknown }[],
): ProctorSummary;

export type ProctorBaseline = {
  students: number;
  withEvents: number;
  medianCount: number;
  maxCount: number;
  /** 多數人都有一定數量的事件——先看環境，不要先看人。 */
  widespread: boolean;
  busy: number;
};

export declare function classBaseline(
  summaries: { awayCount?: number }[],
): ProctorBaseline;

export declare function rankStudents<T extends { summary: ProctorSummary }>(
  rows: T[],
): {
  rows: (T & { standsOut: boolean; why: string[] })[];
  baseline: ProctorBaseline;
};

export declare function durationText(ms: number | null | undefined): string;

export declare function eventText(e: {
  type: string;
  durationMs?: number | null;
  meta?: unknown;
}): string;
