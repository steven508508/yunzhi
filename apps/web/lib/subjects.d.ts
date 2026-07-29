/** 型別宣告。實作在 subjects.mjs——開機種子與網頁端共用同一份清單。 */

export type StandardSubject = {
  code: string;
  name: string;
  parentCode: string | null;
  gsatFullScore: number | null;
  order: number;
};

export declare const STANDARD_SUBJECTS: readonly StandardSubject[];

export declare const STANDARD_CODES: ReadonlySet<string>;

export declare function checkSubjectCode(
  raw: string,
  taken?: ReadonlySet<string>,
): string | null;

export declare function checkSubjectName(raw: string): string | null;

export declare function checkParentCode(
  parentCode: string | null | undefined,
  codeToParent: ReadonlyMap<string, string | null>,
): string | null;

export declare function seedStandardSubjects(
  prisma: { subject: { findMany: Function; create: Function } },
  tenantId: string,
): Promise<{ created: string[]; existing: number }>;
