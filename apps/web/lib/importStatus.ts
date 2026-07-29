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

  // 佇列現況。`IMPORT_CONCURRENCY` 預設是 1，所以第二份題本本來就要
  // 等第一份跑完整條管線（5–20 分鐘）——而進度頁原本只看「排隊超過
  // 兩分鐘」就跳出「多半是背景工作者沒有在跑」，把正常的排隊誣告成
  // 故障，還附一顆會把自己排到隊尾的按鈕。
  //
  // 這裡用資料庫算而不是問 Redis：查詢跑在租戶脈絡下（RLS），
  // 所以算到的是本租戶的工作。單校部署下這就是全部；多租戶時它會
  // 低估，而低估只會讓提示保守一點，不會產生假警報。
  const [ahead, running] = await Promise.all([
    prisma.importJob.count({
      where: { tenantId, status: 'QUEUED', createdAt: { lt: job.createdAt } },
    }),
    prisma.importJob.count({ where: { tenantId, status: { in: [...STAGES] } } }),
  ]);

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
    // ISO 字串而不是 Date：這一份資料有兩條路徑（伺服器端直接渲染、
    // 以及輪詢時經過 JSON），而 JSON 那條回來的一定是字串。
    // 兩邊型別不同的話，畫面會在第一次輪詢之後才壞掉。
    createdAt: job.createdAt.toISOString(),
    // 正在跑的那一階段是什麼時候開始的。**沒有它，進行中的那一列
    // 永遠是空的**——`elapsedMs` 只有在階段做完之後才寫進 stageDetail，
    // 而老師盯的正是還沒做完的那一列。資料一直都有（worker 的卡住
    // 偵測就是靠它算分鐘數），只是沒有被回傳。
    stageStartedAt: job.stageStartedAt ? job.stageStartedAt.toISOString() : null,
    /** 佇列裡排在這一份前面的工作數，以及現在有沒有工作正在跑。 */
    queuedAhead: ahead,
    othersRunning: running,
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
