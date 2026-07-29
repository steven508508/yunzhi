/** 型別宣告。實作在 scope.mjs——純判斷，不碰資料庫，所以測得動。 */
export declare function subjectScope(
  systemRole: string,
  taughtSubjectIds: readonly string[],
): string[] | null;

export declare function maySeeGrades(
  scope: string[] | null,
  actorId: string,
  assignment: { subjectId: string; createdBy: string | null },
): boolean;

export declare function countByAssignment(
  targets: readonly { assignmentId: string; classId: string | null; userId: string | null }[],
  membersOfClass: Map<string, readonly string[]>,
  validUserIds: ReadonlySet<string>,
): Map<string, number>;
