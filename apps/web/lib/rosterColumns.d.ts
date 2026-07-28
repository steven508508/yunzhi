export declare const ROSTER_COLUMNS: Record<string, readonly string[]> & {
  username: readonly string[];
  displayName: readonly string[];
  guardianEmail: readonly string[];
  email: readonly string[];
  birthDate: readonly string[];
};
export declare function parseBirth(raw: unknown): Date | null;
