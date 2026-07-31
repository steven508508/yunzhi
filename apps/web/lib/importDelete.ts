/**
 * 刪掉一份題本（匯入工作）。
 *
 * 為什麼需要這個：裝機與試跑會產生一堆垃圾工作——辨識失敗的、
 * 傳錯檔的、拿來測試的。原本這些東西**一個都刪不掉**，只能一直
 * 留在列表上，而每一份都佔著原檔與整份的頁面影像（一份 200 頁的
 * 掃描件是好幾百 MB）。
 *
 * **已入庫的題目預設不動。** 題目一旦入庫就是獨立的題庫條目：
 * 可能已經被編輯過、發布過、選進卷子。「刪掉匯入紀錄」與
 * 「刪掉那些題目」是兩件不同的事，把它們綁在一起，老師想清理
 * 匯入列表時就會意外炸掉題庫。
 *
 * 需要整份撤銷時（匯錯科目、辨識全錯）給 `withQuestions`，
 * 但**只刪還沒被用過的**——已在卷子上或已有作答的照樣擋下來，
 * 那道規則在資料庫層（`onDelete: Restrict`），這裡只是先查一次
 * 好給看得懂的訊息。
 */
import type { SessionUser } from '@/lib/auth';
import { canEditSubject } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { deletePrefix, importPrefix } from '@/lib/storage';

export class ImportDeleteError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ImportDeleteError';
    this.status = status;
  }
}

export type DeleteImportResult = {
  jobId: string;
  deletedQuestions: number;
  keptQuestions: number;
  blockedQuestions: { id: string; onPapers: number; answered: number }[];
  objectsDeleted: number;
};

export async function deleteImportJob(
  jobId: string,
  user: SessionUser,
  opts: { withQuestions?: boolean } = {},
): Promise<DeleteImportResult> {
  const job = await prisma.importJob.findFirst({
    where: { id: jobId, tenantId: user.tenantId },
    select: { id: true, subjectId: true, status: true },
  });
  if (!job) throw new ImportDeleteError('找不到這份題本，它可能已經被刪除了。', 404);

  if (!(await canEditSubject(user, job.subjectId))) {
    throw new ImportDeleteError('你不是這一科的授課老師，不能刪除這份題本。', 403);
  }

  // 還在跑的工作不給刪：worker 正在寫這些資料列，刪到一半會留下
  // 半套狀態，而且畫面上的進度會停在一個永遠不會更新的數字。
  const RUNNING = [
    'QUEUED',
    'NORMALIZING',
    'SEGMENTING',
    'EXTRACTING',
    'SOLVING',
    'ANNOTATING',
    'DEDUPING',
    // COMMITTING 也算——那一階段 worker 正在把候選題寫進題庫，
    // 刪到一半會留下「題目建好了但匯入紀錄不見了」的孤兒。
    'COMMITTING',
  ];
  if (RUNNING.includes(job.status)) {
    throw new ImportDeleteError(
      `這份題本還在處理中（${job.status}）。請先等它結束或標記失敗，再刪除。`,
      409,
    );
  }

  const blocked: DeleteImportResult['blockedQuestions'] = [];
  let deletedQuestions = 0;
  let keptQuestions = 0;

  // 這份工作產出、且已經入庫的題目
  const produced = await prisma.importCandidate.findMany({
    where: { jobId, questionId: { not: null } },
    select: { questionId: true },
  });
  const questionIds = [...new Set(produced.map((c) => c.questionId!).filter(Boolean))];

  if (opts.withQuestions && questionIds.length) {
    for (const qid of questionIds) {
      const [onPapers, answered] = await Promise.all([
        prisma.examPaperItem.count({ where: { questionId: qid } }),
        prisma.attemptAnswer.count({ where: { questionId: qid } }),
      ]);
      if (onPapers > 0 || answered > 0) {
        blocked.push({ id: qid, onPapers, answered });
        continue;
      }
      await prisma.question.delete({ where: { id: qid } });
      deletedQuestions++;
    }
    keptQuestions = blocked.length;
  } else {
    keptQuestions = questionIds.length;
  }

  // 資料列。ImportCandidate／ImportFile／ImportPage 都掛在 jobId 上。
  //
  // **物件儲存要在資料庫之前刪嗎？** 不。先刪物件、資料庫交易失敗的話，
  // 會留下一份「紀錄還在但原檔不見了」的工作——那比反過來糟：
  // 反過來只是孤兒物件，可以再清；正過來是畫面上點得開卻永遠 404。
  await prisma.$transaction([
    prisma.importCandidate.deleteMany({ where: { jobId } }),
    prisma.importPage.deleteMany({ where: { jobId } }),
    prisma.importFile.deleteMany({ where: { jobId } }),
    prisma.importJob.delete({ where: { id: jobId } }),
  ]);

  // 原檔與頁面影像。失敗不讓整個刪除失敗——資料庫那邊已經成交了，
  // 這裡再拋錯只會讓使用者以為沒刪成功而重按一次。
  let objectsDeleted = 0;
  try {
    objectsDeleted = await deletePrefix(importPrefix(user.tenantId, jobId));
  } catch (e) {
    console.warn(`[import] 題本 ${jobId} 的物件清理失敗，留下孤兒物件：${String(e)}`);
  }

  return { jobId, deletedQuestions, keptQuestions, blockedQuestions: blocked, objectsDeleted };
}
