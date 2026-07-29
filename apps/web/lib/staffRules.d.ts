/** 型別宣告。實作在 staffRules.mjs——純判斷，不碰資料庫，所以測得動。 */

export type StaffRole = 'TEACHER' | 'SUBJECT_LEAD' | 'SCHOOL_ADMIN' | 'SYS_ADMIN';

export type StaffTarget = {
  id: string;
  systemRole: string;
  displayName?: string;
  status: string;
};

export declare const ASSIGNABLE_ROLES: readonly StaffRole[];

export declare const STAFF_ROLE_SET: ReadonlySet<string>;

export declare function checkStaffUsername(
  raw: string,
  taken?: ReadonlySet<string>,
): string | null;

export declare function checkStaffName(raw: string): string | null;

export declare function checkStaffRole(role: string): string | null;

export declare function checkGrant(actorRole: string, targetRole: string): string | null;

export declare function checkActOn(
  actorRole: string,
  target: { systemRole: string; displayName?: string },
): string | null;

export declare function checkRoleChange(p: {
  actor: { id: string; systemRole: string };
  target: { id: string; systemRole: string; displayName?: string };
  nextRole: string;
  otherActiveSysAdmins: number;
}): string | null;

export declare function checkStatusChange(p: {
  actor: { id: string; systemRole: string };
  target: { id: string; systemRole: string; displayName?: string; status: string };
  nextStatus: string;
  otherActiveSysAdmins: number;
}): string | null;
