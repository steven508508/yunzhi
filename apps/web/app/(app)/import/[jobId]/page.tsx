import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireUser, canEditSubject } from '@/lib/auth';
import { loadJob } from '@/lib/candidates';
import { loadProgress } from '@/lib/importStatus';
import Review from './Review';
import Progress from './Progress';

export const dynamic = 'force-dynamic';

/** 已經可以校對的狀態。其餘都還在管線裡，要看進度而不是校對介面。 */
const REVIEWABLE = new Set(['READY_FOR_REVIEW', 'COMMITTING', 'COMMITTED']);

export default async function Page({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const user = await requireUser();
  if (!user) redirect('/login');

  const progress = await loadProgress(jobId, user.tenantId);
  if (!progress) notFound();

  // 科目授課權限。訪談第 14 題：科目老師與班級老師是兩種職權且會重疊。
  const job = await loadJob(jobId, user.tenantId);
  if (!job) notFound();

  if (!(await canEditSubject(user, job.job.subjectId))) {
    return (
      <main style={{ maxWidth: 520, margin: '80px auto', padding: 24 }}>
        <h1 style={{ fontFamily: 'var(--font-doc)', fontSize: 18, fontWeight: 600 }}>沒有權限</h1>
        <p style={{ color: 'var(--ink-2)', marginTop: 8, lineHeight: 1.7 }}>
          你不是「{job.job.subject.name}」的授課老師，無法校對這份匯入。
          若需要協助校對，請該科老師將你加入授課名單。
        </p>
      </main>
    );
  }

  // 還在解析（或失敗）→ 顯示進度，而不是一個空的校對介面。
  // 空的校對介面會讓老師以為「這份題本一題都沒抽出來」。
  if (!REVIEWABLE.has(progress.status)) {
    return (
      <div className="yz-app">
        <header className="yz-head">
          <span className="yz-head__title">匯入進度</span>
          <span className="yz-head__sub">{user.displayName}</span>
          <span className="yz-head__right">
            <Link href="/import">匯入紀錄</Link>
          </span>
        </header>
        <main className="yz-col" style={{ flex: 1 }}>
          <div className="yz-colbody">
            <Progress initial={progress} />
          </div>
        </main>
      </div>
    );
  }

  const scanned = job.job.files.find((f) => (f.qualityScore ?? 1) < 0.75);
  const fileNote = scanned
    ? `${scanned.fileName}（掃描品質偏低，建議逐題確認）`
    : (job.job.files[0]?.fileName ?? null);

  return (
    <Review
      jobId={jobId}
      title={job.job.title}
      subjectName={job.job.subject.name}
      candidates={job.candidates}
      fileNote={fileNote}
    />
  );
}
