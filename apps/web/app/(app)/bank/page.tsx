import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export default async function BankPage({
  searchParams,
}: {
  searchParams: Promise<{ subject?: string; q?: string }>;
}) {
  const user = await requireUser();
  if (!user) redirect('/login');
  const sp = await searchParams;

  const subjects = await prisma.subject.findMany({
    where: { tenantId: user.tenantId, active: true },
    orderBy: { order: 'asc' },
  });

  const questions = await prisma.question.findMany({
    where: {
      tenantId: user.tenantId,
      status: { in: ['PUBLISHED', 'PENDING_REVIEW'] },
      ...(sp.subject ? { subjectId: sp.subject } : {}),
      ...(sp.q ? { content: { contains: sp.q, mode: 'insensitive' as const } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      subject: { select: { name: true } },
      options: { select: { id: true }, take: 1 },
    },
  });

  return (
    <div className="yz-app">
      <header className="yz-head">
        <span className="yz-head__title">題庫</span>
        <span className="yz-head__sub">{questions.length} 題</span>
        <span className="yz-head__right">
          <Link href="/import">匯入</Link>
          <form action="/api/auth/logout" method="post"><button type="submit">登出</button></form>
        </span>
      </header>

      <div style={{ padding: '9px 22px', borderBottom: '1px solid var(--rule)', display: 'flex', gap: 14, fontSize: 12 }}>
        <Link href="/bank" style={{ fontWeight: sp.subject ? 400 : 600 }}>全部</Link>
        {subjects.map((s) => (
          <Link key={s.id} href={`/bank?subject=${s.id}`} style={{ fontWeight: sp.subject === s.id ? 600 : 400 }}>
            {s.name}
          </Link>
        ))}
        <form style={{ marginLeft: 'auto' }}>
          {sp.subject && <input type="hidden" name="subject" value={sp.subject} />}
          <input name="q" defaultValue={sp.q ?? ''} placeholder="搜尋題幹"
                 style={{ padding: '3px 8px', border: '1px solid var(--rule)', borderRadius: 'var(--r-sm)',
                          background: 'var(--paper-raised)', fontSize: 12, width: 200 }} />
        </form>
      </div>

      <main className="yz-col" style={{ flex: 1 }}>
        <div className="yz-colbody">
          {questions.length === 0 ? (
            <p style={{ color: 'var(--ink-2)' }}>
              {sp.q ? `找不到含「${sp.q}」的題目。` : '題庫是空的。先匯入一份題本。'}
            </p>
          ) : (
            <table className="yz-table">
              <thead>
                <tr>
                  <th>題幹</th><th>科目</th><th>題型</th>
                  <th className="yz-table__num">配分</th>
                  <th className="yz-table__num">難度</th>
                  <th className="yz-table__num">作答</th>
                  <th className="yz-table__num">答對率</th>
                  <th>來源</th>
                </tr>
              </thead>
              <tbody>
                {questions.map((q) => (
                  <tr key={q.id}>
                    <td style={{ maxWidth: 460, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {q.content}
                    </td>
                    <td style={{ color: 'var(--ink-2)' }}>{q.subject.name}</td>
                    <td style={{ color: 'var(--ink-2)' }}>{TYPE[q.type] ?? q.type}</td>
                    <td className="yz-table__num">{q.score}</td>
                    <td className="yz-table__num">{q.difficulty?.toFixed(2) ?? '—'}</td>
                    <td className="yz-table__num">{q.responseCount || '—'}</td>
                    <td className="yz-table__num">
                      {q.correctRate != null ? `${(q.correctRate * 100).toFixed(0)}%` : '—'}
                    </td>
                    <td style={{ color: 'var(--ink-3)', fontSize: 11.5 }}>{q.sourceRef ?? SRC[q.sourceType]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </div>
  );
}

const TYPE: Record<string, string> = {
  SINGLE_CHOICE: '單選', MULTI_CHOICE: '多選', FILL_SLOT: '選填',
  FILL_TEXT: '填空', SHORT_ANSWER: '簡答', ESSAY: '作文', TRANSLATION: '翻譯', TRUE_FALSE: '是非',
};
const SRC: Record<string, string> = {
  OFFICIAL_PAST: '歷屆試題', TEACHER_ORIGINAL: '老師自編', SCHOOL_EXAM: '校內考卷',
  PUBLISHER_SCAN: '出版社題本', AI_GENERATED: 'AI 生成',
};
