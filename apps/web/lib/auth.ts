/**
 * 認證。
 *
 * 用資料庫 session 而非純 JWT：考試場景需要「立刻登出某個帳號」
 * 這個能力——發現代考時，JWT 要等到過期才失效。
 */
import { cookies } from 'next/headers';
import { prisma } from '@/lib/prisma';
import { withoutTenantScope } from '@/lib/tenant';

export const SESSION_COOKIE = 'yz_session';

export type SessionUser = {
  id: string;
  tenantId: string;
  username: string;
  displayName: string;
  systemRole: string;
  mustChangePassword: boolean;
};

/**
 * 誰在看。
 *
 * **這是唯一一個必須跨租戶執行的查詢。** 它是雞生蛋的問題：要知道
 * 這次請求屬於哪個租戶，得先查出 session 是誰的；而查 session 本身
 * 就是一次資料庫查詢。
 *
 * 這樣安全，因為 sessionToken 是密碼學亂數——猜不到別的租戶的 token，
 * 所以「跨租戶查一個給定的 token」不會洩漏任何東西。
 *
 * 拿到之後**呼叫端要自己用 `withTenant(user.tenantId, ...)` 包住
 * 後續的工作**。忘記包的話會查不到任何資料（RLS 是 fail closed），
 * 所以錯誤會在開發時立刻現形，不是等到上線。
 */
export async function requireUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await withoutTenantScope(
    'session 查核：此時還不知道這次請求屬於哪個租戶',
    () =>
      prisma.session.findUnique({
        where: { sessionToken: token },
        include: { user: true },
      }),
  );
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
 * 這次請求屬於哪個租戶——**在還沒登入之前**。
 *
 * 登入頁需要它（要知道拿哪個租戶的帳號比對），而那時還沒有 session。
 * 集中在這裡而不是散在各個路由，是因為它需要跨租戶查詢，
 * 而能繞過隔離的地方愈少愈好。
 *
 * 目前是單一機構自架，所以租戶固定一筆。日後白牌多租戶時，
 * 這一支改成依 host 或子網域判定，**其餘程式一行都不用動**。
 */
export async function resolveRequestTenant(): Promise<string | null> {
  const t = await withoutTenantScope('解析這次請求屬於哪個租戶（登入前，尚無 session）', () =>
    prisma.tenant.findFirst({ select: { id: true }, orderBy: { createdAt: 'asc' } }),
  );
  return t?.id ?? null;
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
