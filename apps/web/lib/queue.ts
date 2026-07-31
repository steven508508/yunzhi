/**
 * 背景佇列（BullMQ）。
 *
 * 匯入是這個系統裡唯一「使用者按下按鈕之後要等好幾分鐘」的動作，
 * 所以它必須是佇列而不是請求內處理：一份 200 頁的題本走完全部
 * 階段是分鐘級的，HTTP 連線撐不住，而老師關掉分頁不該讓工作消失。
 *
 * 兩個設計決定值得記下來：
 *
 *   1. **重試次數刻意壓低（3 次）**。匯入的每一次重試都可能是
 *      真金白銀的 AI 呼叫。無限重試在一個設定錯誤的環境裡，
 *      一夜之間可以燒掉整月預算。失敗留在佇列裡由人來看，
 *      比自動重試到破產好。
 *
 *   2. **階段化而非單一大工作**。job 的 payload 只帶 jobId 與
 *      「從哪一階段開始」，實際進度寫在資料庫。這樣第 7 階段
 *      失敗時可以只重跑第 7 階段，而不是把前面六階段的
 *      AI 費用再付一次。
 */
import { Queue, type JobsOptions } from 'bullmq';
// 冒號會被 BullMQ 拒絕；理由與測試見 lib/queueKey.mjs
import { importJobKey } from './queueKey.mjs';
import { redis } from '@/lib/redis';

export const IMPORT_QUEUE = 'import';

/** 管線階段。順序即執行順序，對應 ImportStatus 的同名值。 */
export const IMPORT_STAGES = [
  'NORMALIZING',
  'SEGMENTING',
  'EXTRACTING',
  'SOLVING',
  'ANNOTATING',
  'DEDUPING',
] as const;

export type ImportStage = (typeof IMPORT_STAGES)[number];

export type ImportJobPayload = {
  jobId: string;
  tenantId: string;
  /** 從這個階段開始跑。續跑時由 worker 依 stageDetail 決定。 */
  fromStage?: ImportStage;
};

const globalForQueue = globalThis as unknown as { importQueue?: Queue<ImportJobPayload> };

export const importQueue: Queue<ImportJobPayload> =
  globalForQueue.importQueue ??
  new Queue<ImportJobPayload>(IMPORT_QUEUE, {
    connection: redis,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      // 成功的工作留 200 筆／7 天，足夠回答「上週那份為什麼跑很久」。
      removeOnComplete: { age: 7 * 24 * 3600, count: 200 },
      // 失敗的留久一點 —— 它們才是需要被看的。
      removeOnFail: { age: 30 * 24 * 3600 },
    },
  });

if (process.env.NODE_ENV !== 'production') globalForQueue.importQueue = importQueue;

/**
 * 入列。
 *
 * jobId 直接當 BullMQ 的 job id：同一份匯入重複點兩次「開始」
 * 不會跑兩遍，而重複的 AI 呼叫就是重複的錢。
 */
export async function enqueueImport(payload: ImportJobPayload, opts?: JobsOptions) {
  return importQueue.add('run', payload, {
    jobId: importJobKey(payload.jobId),
    ...opts,
  });
}

/**
 * 續跑。
 *
 * 與 enqueueImport 分開，是因為 BullMQ 不允許重複的 jobId，
 * 而續跑必然是同一個 jobId。先移除舊記錄再入列。
 */
export async function requeueImport(payload: ImportJobPayload) {
  const existing = await importQueue.getJob(importJobKey(payload.jobId));
  // remove() 對執行中的工作會拋錯 —— 那正是我們要的：
  // 還在跑的工作不該被「續跑」擠掉。
  if (existing) await existing.remove();
  return enqueueImport(payload);
}

export async function importQueueHealth() {
  const counts = await importQueue.getJobCounts('waiting', 'active', 'failed', 'delayed');
  return counts;
}
