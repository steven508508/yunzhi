/** 型別宣告。實作在 accountRules.mjs——純判斷，不碰資料庫，所以測得動。 */

export type ConsentMethod = 'IN_PERSON' | 'ONLINE' | 'PAPER';

export declare const ERASED_NAME: string;

export declare function checkDisplayName(raw: string): string | null;

export declare function checkUsernameChange(p: {
  current: string;
  next: string;
  takenByOther?: boolean;
}): string | null;

export declare function erasedUsername(userId: string): string;

export declare function isErasedUsername(username: string): boolean;

export declare function planConsentBatch(
  students: readonly { id: string; displayName?: string; consentAt?: unknown }[],
  requestedIds?: readonly string[] | null,
): { toRecord: string[]; alreadyDone: string[]; missing: string[] };

export declare function parseConsentCell(raw: unknown): ConsentMethod | false | null;
