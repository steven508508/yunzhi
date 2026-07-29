/** 型別宣告。實作在 paperPlan.mjs——純判斷，不碰資料庫，所以測得動。 */

export declare function spreadScores(count: number, total: number): number[];

export declare function uniformScores(count: number, score: number): number[];

export declare function sumScores(scores: readonly number[]): number;

export declare function alreadyPicked(
  existing: readonly { questionId: string; familyId: string; order: number }[],
  candidate: { questionId: string; familyId: string },
): { kind: 'same' | 'version'; order: number } | null;

export declare function usageByQuestion(
  rows: readonly { questionId: string; paperId: string; paperTitle: string }[],
  limit?: number,
): Map<string, { count: number; papers: { id: string; title: string }[]; more: number }>;

export declare function moveTo(ids: readonly string[], from: number, to: number): string[];
