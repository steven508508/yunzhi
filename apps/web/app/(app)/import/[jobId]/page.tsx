import Link from 'next/link';
import { notFound } from 'next/navigation';
import {canEditSubject} from '@/lib/auth';
import { MathText } from '@/components/MathText';
import { Note } from '@/components/Feedback';
import { scopedPage } from '@/lib/page';
import { loadJob, loadPages } from '@/lib/candidates';
import { loadProgress } from '@/lib/importStatus';
import { prisma } from '@/lib/prisma';
import Review from './Review';
import Progress from './Progress';

export const dynamic = 'force-dynamic';

/**
 * 已經可以校對的狀態。其餘都還在管線裡，要看進度而不是校對介面。
 *
 * # 為什麼 COMMITTED 不在裡面
 *
 * 它原本在，而那是一條**看起來會成功的死路**：已入庫的題本可以重新
 * 打開校對介面，改答案、按儲存（`saveReviews` 會安靜地寫進
 * `ImportCandidate`）、標頭亮起「已儲存」，然後按入庫得到
 * 「沒有已確認、且尚未入庫的題目」——而 `Question` 一個位元都沒動。
 *
 * 老師花二十分鐘改完的東西全部寫進了一張沒有人會再讀的暫存表。
 * 入庫之後題目的正本在題庫，所以這裡改成唯讀的結果，並指路過去。
 */
const REVIEWABLE = new Set(['READY_FOR_REVIEW', 'COMMITTING']);

export default async function Page({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return scopedPage(async (user) => {

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

  // 已入庫：唯讀的結果，加上到題庫的路。
  if (progress.status === 'COMMITTED') {
    const questions = await prisma.question.findMany({
      where: { sourceImportJobId: jobId },
      select: { id: true, content: true, type: true, status: true, score: true },
      orderBy: { createdAt: 'asc' },
    });

    return (
      <main className="yz-panel" style={{ maxWidth: 900 }}>
        <div className="yz-panel__head">
          <h1>{job.job.title}</h1>
          <p className="yz-panel__sub">
            {job.job.subject.name}　·　已入庫 {questions.length} 題
            　·　<Link href="/import">匯入紀錄</Link>
          </p>
        </div>

        {/* 這一段是這一頁存在的理由：老師來這裡多半是想改一題的答案，
            而正本已經不在這裡了。 */}
        <Note tone="info">
          這份題本<strong>已經入庫</strong>，題目的正本現在在題庫裡。
          在這一頁上改是沒有用的——校對介面改的是暫存的候選題，
          而學生考的是題庫裡的那一份。<strong>要改題目請點下面的題號</strong>
          ，到題庫的題目頁改標準答案、選項與詳解。
        </Note>

        {questions.length === 0 ? (
          <p className="yz-grade-hint">
            這份題本標記為已入庫，但題庫裡找不到來自它的題目。
            請把這一頁的網址告訴管理員。
          </p>
        ) : (
          <ol className="yz-qedit__uses">
            {questions.map((q, i) => (
              <li key={q.id}>
                {/* 題幹用 CSS 截斷而不是 `slice()`：字串切一半會把
                    `$\frac{3}{4}$` 切成沒有結尾的數學式，排出來是一串
                    原始碼，而老師正是要靠這一行認出「就是這一題」。 */}
                <Link
                  href={`/bank/${q.id}`}
                  style={{ display: 'block', maxWidth: 620, overflow: 'hidden',
                           textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  第 {i + 1} 題　<MathText>{q.content}</MathText>
                </Link>
                <span className="yz-muted">
                  {TYPE[q.type] ?? q.type}　{STATUS[q.status] ?? q.status}　配分 {q.score}
                </span>
              </li>
            ))}
          </ol>
        )}
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

  // 原稿頁面與這一科的知識點。兩個都在伺服器端一次查完——校對介面
  // 的原則是「一次把整份工作載完」，每切一題打一次 API 會讓體感卡頓，
  // 而卡頓直接吃掉每題 24 秒的預算。
  //
  // 頁面清單只有尺寸與品質，影像本身走 `/api/import/[jobId]/image`。
  const [pages, knowledgePoints] = await Promise.all([
    loadPages(jobId, user.tenantId),
    prisma.knowledgePoint.findMany({
      where: { subjectId: job.job.subjectId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
  ]);

  return (
    <Review
      jobId={jobId}
      title={job.job.title}
      subjectName={job.job.subject.name}
      candidates={job.candidates}
      fileNote={fileNote}
      pages={pages}
      knowledgePoints={knowledgePoints}
      reviewSeconds={job.job.reviewSeconds ?? 0}
    />
  );
  });
}

const TYPE: Record<string, string> = {
  SINGLE_CHOICE: '單選', MULTI_CHOICE: '多選', FILL_SLOT: '選填',
  FILL_TEXT: '填空', SHORT_ANSWER: '簡答', ESSAY: '作文', TRANSLATION: '翻譯', TRUE_FALSE: '是非',
};
const STATUS: Record<string, string> = {
  DRAFT: '未校對', PENDING_REVIEW: '待發布', PUBLISHED: '已發布', RETIRED: '已下架',
};
