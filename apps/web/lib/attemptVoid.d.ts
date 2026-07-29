/** 型別宣告。實作在 attemptVoid.mjs——純狀態判斷，不碰資料庫，所以測得動。 */
export type VoidAttempt = {
  status: string;
  submittedAt?: Date | null;
};

export declare const MIN_REASON: number;
export declare const MAX_REASON: number;

export declare function checkReason(
  reason: unknown,
): { ok: true; reason: string } | { ok: false; error: string };

export declare function checkVoid(
  attempt: VoidAttempt,
): { ok: true } | { ok: false; error: string };

export declare function restoreStatus(attempt: VoidAttempt): 'IN_PROGRESS' | 'SUBMITTED';

export declare function checkUnvoid(
  attempt: VoidAttempt,
): { ok: true; status: 'IN_PROGRESS' | 'SUBMITTED' } | { ok: false; error: string };
