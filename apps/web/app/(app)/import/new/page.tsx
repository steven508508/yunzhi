import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import Upload from './Upload';

export const dynamic = 'force-dynamic';

export default async function NewImportPage() {
  const user = await requireUser();
  if (!user) redirect('/login');
  if (user.systemRole === 'STUDENT' || user.systemRole === 'GUARDIAN') redirect('/');

  // 只列這位老師能匯入的科目。
  //
  // 訪談第 14 題：權限來自「教不教這一科」，而一科有三位老師。
  // 把不能匯入的科目也列出來，只會讓老師選了之後才被拒絕——
  // 那是最沒有必要的一種挫折。
  const isAdmin =
    user.systemRole === 'SYS_ADMIN' ||
    user.systemRole === 'SCHOOL_ADMIN' ||
    user.systemRole === 'SUBJECT_LEAD';

  const subjects = await prisma.subject.findMany({
    where: {
      tenantId: user.tenantId,
      active: true,
      ...(isAdmin ? {} : { classTeachers: { some: { userId: user.id } } }),
    },
    select: { id: true, name: true },
    orderBy: { order: 'asc' },
  });

  if (subjects.length === 0) {
    return (
      <div className="yz-app">
        <header className="yz-head">
          <span className="yz-head__title">匯入題本</span>
          <span className="yz-head__right">
            <Link href="/import">返回</Link>
          </span>
        </header>
        <main className="yz-col" style={{ flex: 1 }}>
          <div className="yz-colbody">
            <p style={{ color: 'var(--ink-2)', maxWidth: 460, lineHeight: 1.7 }}>
              你目前沒有被指派任何科目，因此無法匯入題目。
              請學科召集人或管理員把你加入該科的授課名單。
            </p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="yz-app">
      <header className="yz-head">
        <span className="yz-head__title">匯入題本</span>
        <span className="yz-head__sub">{user.displayName}</span>
        <span className="yz-head__right">
          <Link href="/import">匯入紀錄</Link>
        </span>
      </header>

      <main className="yz-col" style={{ flex: 1 }}>
        <div className="yz-colbody">
          <Upload subjects={subjects} />
        </div>
      </main>
    </div>
  );
}
