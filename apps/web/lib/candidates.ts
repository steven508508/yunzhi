/**
 * 匯入候選題的讀寫。
 *
 * 校對介面的效能目標很具體：50 題 20 分鐘，等於每題 24 秒。
 * 因此這一層的原則是「一次把整份工作載完」——每切一題都打一次
 * API 會讓體感卡頓，而卡頓直接吃掉那 24 秒。
 */
import type { Prisma } from '@prisma/client';
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
 * 校對時可以改的欄位。**白名單，不是黑名單。**
 *
 * 校對介面送上來的 patch 原本是直接展開進 Prisma 的。Prisma 產生的
 * `ImportCandidateUncheckedUpdateInput` 包含 `id`、`jobId`、`questionId`
 * 這些結構欄位，於是一個 patch 就能：
 *
 *   · 把候選題搬到別人的工作底下（改 `jobId`）
 *   · 把已入庫的題目重新標成未入庫（`questionId: null`）再入庫一次
 *   · 改掉 `state` 繞過校對流程
 *
 * 同一條管線對「內部信任的 AI 服務」反而做了白名單
 * （`scripts/import-pipeline.mjs` 的 `pickPatch`），對「外部送進來的
 * 使用者輸入」卻沒有——那是漏掉，不是設計。
 */
const EDITABLE = new Set([
  'questionNo',
  'subLabel',
  'groupKey',
  'type',
  'content',
  'stimulus',
  'options',
  'answerKeys',
  'answerSlots',
  'answerText',
  'score',
  'kpSuggestions',
  'sourceExam',
  'nationalCorrectRate',
]);

/** 校對者可以把候選題設成的狀態。PENDING 是回到未校對。 */
const REVIEW_STATES = new Set(['PENDING', 'CONFIRMED', 'FLAGGED', 'DISCARDED']);

function pickEditable(patch: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (EDITABLE.has(k)) out[k] = v;
    else rejected.push(k);
  }
  return { out, rejected };
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
    const audit: Prisma.InputJsonValue[] = [];

    for (const ch of changes) {
      const { out: patch, rejected } = pickEditable(ch.patch ?? {});
      if (ch.state && !REVIEW_STATES.has(ch.state)) {
        throw new Error(`不允許的校對狀態：${ch.state}`);
      }

      // **where 一定要帶 jobId。** 只用 id 的話，上面驗過的
      // 「這份工作屬於本租戶」完全沒有保護到這一行——任何人拿
      // 自己的 jobId 進來，就能改別份工作、別個租戶的候選題。
      // `import_candidates` 沒有 tenantId 欄位，jobId 是唯一的繫繩。
      const changed = await tx.importCandidate.updateMany({
        where: { id: ch.id, jobId },
        data: {
          ...patch,
          ...(ch.state ? { state: ch.state as never } : {}),
          reviewedBy: userId,
          reviewedAt: new Date(),
          ...(ch.note ? { reviewNote: ch.note } : {}),
        },
      });
      if (changed.count === 0) {
        throw new Error(`候選題 ${ch.id} 不屬於這份匯入工作`);
      }
      audit.push({
        id: ch.id,
        state: ch.state ?? null,
        fields: Object.keys(patch),
        ...(rejected.length ? { rejected } : {}),
      });
    }

    const [confirmed, flagged] = await Promise.all([
      tx.importCandidate.count({ where: { jobId, state: 'CONFIRMED' } }),
      tx.importCandidate.count({ where: { jobId, state: 'FLAGGED' } }),
    ]);

    // 校對是全系統唯一會改到題幹與答案的路徑，而改完的東西會直接
    // 進題庫拿去考學生。上傳、續跑、入庫都有稽核，這裡沒有——
    // 於是「誰把第 12 題的答案從 (3) 改成 (4)」查不出來。
    if (audit.length) {
      await tx.auditLog.create({
        data: {
          tenantId,
          category: 'QUESTION',
          actorId: userId,
          action: 'import.review',
          targetType: 'ImportJob',
          targetId: jobId,
          // 只留「改了哪幾題的哪幾個欄位」，不留整段題幹——
          // 稽核表會被長期保存，把題本內容整份複製進去等於多了
          // 一份不受權利標記管轄的副本。
          after: { changes: audit.slice(0, 200), total: audit.length },
        },
      });
    }

    return tx.importJob.update({
      where: { id: jobId },
      data: { confirmedCount: confirmed, flaggedCount: flagged },
    });
  });
}
