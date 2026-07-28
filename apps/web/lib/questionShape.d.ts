export declare function normalizeOptions(
  raw: unknown,
  answerKeys?: number[],
): {
  options: { order: number; label: string; content: string }[];
  answerKeys: number[];
  dropped: number[];
};
