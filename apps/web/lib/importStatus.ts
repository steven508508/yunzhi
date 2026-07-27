/**
 * 匯入工作的狀態呈現。
 *
 * 抽出來共用，是因為進度頁（伺服器端渲染）與輪詢的 API 端點
 * 必須產生**完全一樣**的形狀——兩份實作會讓輪詢時畫面跳動，
 * 而那種 bug 很難重現也很難描述。
 */
import { prisma } from '@/lib/prisma';

export const STAGES = [
  'NORMALIZING',
  'SEGMENTING',
  'EXTRACTING',
  'SOLVING',
  'ANNOTATING',
  'DEDUPING',
] as const;

export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  NORMALIZING: '檔案處理',
  SEGMENTING: '版面切分',
  EXTRACTING: '題目結構化',
  SOLVING: 'AI 自答',
  ANNOTATING: '知識點標註',
  DEDUPING: '重複比對',
};

export const STATUS_LABELS: Record<string, string> = {
  QUEUED: '排隊中',
  ...STAGE_LABELS,
  READY_FOR_REVIEW: '待校對',
  COMMITTING: '入庫中',
  COMMITTED: '已入庫',
  FAILED: '失敗',
};

/**
 * 每個階段的一句話說明。
 *
 * 老師看到「正規化」不知道那是什麼，看到「把 PDF 轉成頁面影像」
 * 就知道了。而知道系統在做什麼，等待就沒那麼難熬。
 */
const STAGE_NOTES: Partial<Record<Stage, string>> = {
  NORMALIZING: '把檔案轉成頁面影像，並評估掃描品質',
  SEGMENTING: '找出題號、題幹、選項的位置',
  EXTRACTING: '把版面轉成一題一題的資料',
  SOLVING: '對沒有附答案的題目獨立推導多次並投票',
  ANNOTATING: '判斷每題考的是哪些知識點',
  DEDUPING: '比對是否與既有題目重複',
};

export async function loadProgress(jobId: string, tenantId: string) {
  const job = await prisma.importJob.findFirst({
    where: { id: jobId, tenantId },
    include: {
      subject: { select: { name: true } },
      files: { select: { fileName: true, role: true, qualityNote: true } },
    },
  });
  if (!job) return null;

  const detail = (job.stageDetail as Record<string, any> | null) ?? {};
  const done: Record<string, any> = detail.stages ?? {};
  const failedAt: string | null = detail.failedAt ?? null;
  const permanent: boolean = detail.permanent === true;

  const doneIndex = job.lastCompletedStage
    ? STAGES.indexOf(job.lastCompletedStage as Stage)
    : -1;

  const stages = STAGES.map((key, i) => {
    let state: 'done' | 'running' | 'pending' | 'failed';
    if (failedAt === key) state = 'failed';
    else if (i <= doneIndex) state = 'done';
    else if (job.status === key) state = 'running';
    else state = 'pending';

    return {
      key,
      label: STAGE_LABELS[key],
      state,
      elapsedMs: done[key]?.elapsedMs,
      note: stageNote(key, done[key], state),
    };
  });

  return {
    jobId: job.id,
    title: job.title,
    subjectName: job.subject.name,
    status: job.status,
    error: job.error,
    permanent,
    lastCompletedStage: job.lastCompletedStage,
    stages,
    totalPages: job.totalPages,
    totalCandidates: job.totalCandidates,
    aiCostTwd: Number(job.aiCostTwd ?? 0),
    attemptCount: job.attemptCount,
    files: job.files,
  };
}

/**
 * 階段完成後的具體說明。
 *
 * 完成的階段講「做了什麼、結果如何」而不是重複階段名稱——
 * 「7 頁走純程式切分、0 頁需要視覺辨識」這種訊息，
 * 在成本超出預期時是唯一查得到原因的線索。
 */
function stageNote(key: Stage, d: Record<string, any> | undefined, state: string) {
  if (state === 'pending' || state === 'running') return STAGE_NOTES[key];
  if (!d) return STAGE_NOTES[key];

  switch (key) {
    case 'NORMALIZING':
      return d.totalPages ? `共 ${d.totalPages} 頁` : undefined;
    case 'SEGMENTING': {
      const parts: string[] = [];
      if (d.visionPages) parts.push(`${d.visionPages} 頁需要影像辨識`);
      else parts.push('全部走文字層，未使用影像辨識');
      if (d.failedPages?.length) parts.push(`${d.failedPages.length} 頁未能解析`);
      if (d.groupRanges?.length) parts.push(`偵測到 ${d.groupRanges.length} 組題組`);
      return parts.join('　');
    }
    case 'EXTRACTING': {
      const parts: string[] = [];
      if (d.extracted != null) parts.push(`抽出 ${d.extracted} 題`);
      if (d.sectionWarnings?.length) {
        parts.push(`${d.sectionWarnings.length} 個配分加總對不上，已標記`);
      }
      return parts.join('　');
    }
    case 'SOLVING': {
      const parts: string[] = [];
      if (d.solved != null) parts.push(`${d.solved} 題已推導`);
      if (d.failed) parts.push(`${d.failed} 題推導失敗，需手動填答`);
      return parts.join('　');
    }
    case 'ANNOTATING':
      if (d.skipped) return d.skipped;
      return d.annotated != null ? `${d.annotated} 題已標註` : undefined;
    case 'DEDUPING':
      return d.duplicates ? `發現 ${d.duplicates} 題可能重複` : '沒有發現重複';
    default:
      return STAGE_NOTES[key];
  }
}
