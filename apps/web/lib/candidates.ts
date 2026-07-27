/**
 * 匯入候選題的讀寫。
 *
 * 校對介面的效能目標很具體：50 題 20 分鐘，等於每題 24 秒。
 * 因此這一層的原則是「一次把整份工作載完」——每切一題都打一次
 * API 會讓體感卡頓，而卡頓直接吃掉那 24 秒。
 */
import { prisma } from '@/lib/prisma';

export type CandidateView = {
  id: string;
  order: number;
  questionNo: string | null;
  subLabel: string | null;
  groupKey: string | null;
  type: string | null;
  content: string | null;
  stimulus: string | null;
  options: { order: number; label: string; content: string }[];
  answerKeys: number[];
  answerSlots: { slot: string; value: string }[] | null;
  answerText: string | null;
  score: number | null;
  confidence: number;
  confidenceReasons: { code: string; detail: string; severity: string }[];
  answerOrigin: string | null;
  selfConsistency: number | null;
  solveTrace: unknown;
  kpSuggestions: { id: string; name: string; weight: number; evidence?: string }[];
  sourcePage: number | null;
  state: string;
};

export async function loadJob(jobId: string, tenantId: string) {
  const job = await prisma.importJob.findFirst({
    where: { id: jobId, tenantId },
    include: {
      subject: { select: { id: true, name: true, code: true } },
      files: { select: { id: true, fileName: true, role: true, pageCount: true, qualityScore: true, qualityNote: true } },
    },
  });
  if (!job) return null;

  const candidates = await prisma.importCandidate.findMany({
    where: { jobId },
    orderBy: { order: 'asc' },
  });

  return { job, candidates: candidates.map(toView) };
}

function toView(c: Record<string, any>): CandidateView {
  return {
    id: c.id,
    order: c.order,
    questionNo: c.questionNo,
    subLabel: c.subLabel,
    groupKey: c.groupKey,
    type: c.type,
    content: c.content,
    stimulus: c.stimulus,
    options: Array.isArray(c.options) ? c.options : [],
    answerKeys: c.answerKeys ?? [],
    answerSlots: c.answerSlots ?? null,
    answerText: c.answerText,
    score: c.score,
    confidence: c.confidence ?? 0,
    confidenceReasons: Array.isArray(c.confidenceReasons) ? c.confidenceReasons : [],
    answerOrigin: c.answerOrigin,
    selfConsistency: c.selfConsistency,
    solveTrace: c.solveTrace,
    kpSuggestions: Array.isArray(c.kpSuggestions) ? c.kpSuggestions : [],
    sourcePage: c.sourcePage,
    state: c.state,
  };
}

/**
 * 批次儲存校對結果。
 *
 * 刻意做成批次而非逐題送出：網路是熱點分享（訪談第 17 題，
 * 20–50Mbps 分給 50 台 iPad），每題一次往返在那個環境下會很痛。
 * 前端累積變更，定期或離開時整批送。
 */
export async function saveReviews(
  jobId: string,
  tenantId: string,
  userId: string,
  changes: { id: string; state?: string; patch?: Record<string, unknown>; note?: string }[],
) {
  const job = await prisma.importJob.findFirst({ where: { id: jobId, tenantId } });
  if (!job) throw new Error('找不到匯入工作，或不屬於此租戶');

  // 單一交易。部分成功會讓校對進度與實際狀態不一致，
  // 而老師無從得知哪幾題沒存到。
  // tx 的型別由 Prisma 產生的 client 決定；此處明確標註，
  // 讓 CI 在尚未執行 prisma generate 時也能通過型別檢查。
  type Tx = Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;
  return prisma.$transaction(async (tx: Tx) => {
    for (const ch of changes) {
      await tx.importCandidate.update({
        where: { id: ch.id },
        data: {
          ...(ch.patch ?? {}),
          ...(ch.state ? { state: ch.state as never } : {}),
          reviewedBy: userId,
          reviewedAt: new Date(),
          ...(ch.note ? { reviewNote: ch.note } : {}),
        },
      });
    }
    const [confirmed, flagged] = await Promise.all([
      tx.importCandidate.count({ where: { jobId, state: 'CONFIRMED' } }),
      tx.importCandidate.count({ where: { jobId, state: 'FLAGGED' } }),
    ]);
    return tx.importJob.update({
      where: { id: jobId },
      data: { confirmedCount: confirmed, flaggedCount: flagged },
    });
  });
}
