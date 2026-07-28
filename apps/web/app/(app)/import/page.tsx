import Link from 'next/link';
import { Denied } from '@/components/Feedback';
import { mayUse } from '@/lib/nav';
import { scopedPage } from '@/lib/page';
import { prisma } from '@/lib/prisma';
import { STATUS_LABELS } from '@/lib/importStatus';

export const dynamic = 'force-dynamic';

export default async function ImportListPage() {
  return scopedPage(async (user) => {

  // 藏起連結不等於擋住。匯入紀錄裡有題本檔名與權利聲明，
  // 那是老師與行政的東西，不是學生該看的。
  if (!mayUse(user.systemRole, '/import')) {
    return (
      <main className="yz-panel">
        <Denied what="題本匯入" why="匯入是老師建立題庫的流程。" />
      </main>
    );
  }

  const jobs = await prisma.importJob.findMany({
    where: { tenantId: user.tenantId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { subject: { select: { name: true } } },
  });

  return (
    <div className="yz-app">
      {/* 姓名、登出、跨區連結都在共用導覽列上了，這裡只留這一頁自己的動作。 */}
      <header className="yz-head">
        <span className="yz-head__title">題本匯入</span>
        <span className="yz-head__right">
          <Link href="/import/new">匯入題本</Link>
        </span>
      </header>

      <main className="yz-col" style={{ flex: 1 }}>
        <div className="yz-colbody">
          {jobs.length === 0 ? (
            <p style={{ color: 'var(--ink-2)', lineHeight: 1.75 }}>
              尚無匯入紀錄。<Link href="/import/new">上傳一份題本</Link>
              （PDF、Word 或掃描檔都可以）開始。
            </p>
          ) : (
            <table className="yz-table">
              <thead>
                <tr>
                  <th>題本</th><th>科目</th><th>狀態</th>
                  <th className="yz-table__num">題數</th>
                  <th className="yz-table__num">校畢</th>
                  <th className="yz-table__num">存疑</th>
                  <th>建立</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <Link href={`/import/${j.id}`}>{j.title}</Link>
                    </td>
                    <td style={{ color: 'var(--ink-2)' }}>{j.subject.name}</td>
                    <td style={{ color: j.status === 'FAILED' ? 'var(--mark)' : undefined }}>
                      {STATUS_LABELS[j.status] ?? j.status}
                    </td>
                    <td className="yz-table__num">{j.totalCandidates}</td>
                    <td className="yz-table__num">{j.confirmedCount}</td>
                    <td className="yz-table__num" style={{ color: j.flaggedCount ? 'var(--mark)' : undefined }}>
                      {j.flaggedCount || ''}
                    </td>
                    <td style={{ color: 'var(--ink-3)', fontSize: 11.5 }}>
                      {j.createdAt.toLocaleDateString('zh-TW')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </div>
  );
  });
}
