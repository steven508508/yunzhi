/**
 * 認證。
 *
 * 用資料庫 session 而非純 JWT：考試場景需要「立刻登出某個帳號」
 * 這個能力——發現代考時，JWT 要等到過期才失效。
 */
import { cookies } from 'next/headers';
import { prisma } from '@/lib/prisma';

export const SESSION_COOKIE = 'yz_session';

export type SessionUser = {
  id: string;
  tenantId: string;
  username: string;
  displayName: string;
  systemRole: string;
  mustChangePassword: boolean;
};

export async function requireUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { sessionToken: token },
    include: { user: true },
  });
  if (!session || session.expires < new Date()) return null;
  if (session.user.status !== 'ACTIVE') return null;
  if (session.user.deletedAt) return null;

  return {
    id: session.user.id,
    tenantId: session.user.tenantId,
    username: session.user.username,
    displayName: session.user.displayName,
    systemRole: session.user.systemRole,
    mustChangePassword: session.user.mustChangePassword,
  };
}

/**
 * 科目授課權限。
 *
 * 訪談第 14 題：「派：科目或班級老師／催：班級老師／改：科目或班級老師」，
 * 且「有時候班級老師就是那一科的老師」。所以這兩種職權要分開判定，
 * 而且會重疊——不能用單一的 TEACHER 角色。
 */
export async function canEditSubject(user: SessionUser, subjectId: string): Promise<boolean> {
  if (user.systemRole === 'SYS_ADMIN' || user.systemRole === 'SCHOOL_ADMIN') return true;
  if (user.systemRole === 'SUBJECT_LEAD') return true;

  const teaches = await prisma.classSubjectTeacher.findFirst({
    where: { userId: user.id, subjectId },
    select: { id: true },
  });
  return Boolean(teaches);
}

/** 導師：負責催繳與班務，跨科目 */
export async function isHomeroomOf(userId: string, classId: string): Promise<boolean> {
  const m = await prisma.classMembership.findFirst({
    where: { userId, classId, isHomeroom: true, leftAt: null },
    select: { id: true },
  });
  return Boolean(m);
}
