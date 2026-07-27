/**
 * 背景工作者。
 *
 * 兩類工作：
 *   · 週期性維護（清 session、解鎖帳號、找出卡住的匯入）
 *   · 佇列消費（匯入管線；評分、解析生成、通知依路線圖加入）
 *
 * 兩者共用一個行程但**不共用失敗**：任何一邊出錯都不能拖垮另一邊。
 * 一個壞掉的清理工作不該讓老師的題本匯入停擺。
 */
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { runImport, stageLabel } from './import-pipeline.mjs';

const prisma = new PrismaClient();
const ALIVE_FILE = '/tmp/worker-alive';

// BullMQ 需要一條 maxRetriesPerRequest = null 的連線（它自己會做
// 阻塞式的 BRPOPLPUSH，有重試上限會被中斷）。與 web 端那條分開。
const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
connection.on('error', (e) => {
  if (process.env.LOG_LEVEL === 'debug') console.error('[redis]', e.message);
});

let shuttingDown = false;

// ─────────────────────────────────────────────────────────────
// 週期性工作
// ─────────────────────────────────────────────────────────────

const jobs = [];
function registerJob(name, intervalMs, fn) {
  jobs.push({ name, intervalMs, fn, lastRun: 0 });
}

registerJob('cleanup-sessions', 10 * 60 * 1000, async () => {
  const { count } = await prisma.session.deleteMany({
    where: { expires: { lt: new Date() } },
  });
  if (count > 0) console.log(`[cleanup-sessions] 清除 ${count} 筆過期 session`);
});

registerJob('unlock-accounts', 5 * 60 * 1000, async () => {
  const { count } = await prisma.user.updateMany({
    where: { lockedUntil: { lt: new Date() } },
    data: { lockedUntil: null, failedLoginCount: 0 },
  });
  if (count > 0) console.log(`[unlock-accounts] 解鎖 ${count} 個帳號`);
});

/**
 * 找出卡住的匯入工作。
 *
 * 工作可能因為行程被 kill（OOM、部署重啟）而永遠停在某個中間狀態，
 * 這時 BullMQ 那邊的 job 也不見了，沒有任何人會再碰它。
 * 老師只會看到一個轉了三小時的進度條。
 *
 * 這裡不自動重跑——重跑要花錢，該由人決定。只標成失敗並寫清楚
 * 發生什麼事，讓進度頁能顯示「繼續」按鈕。
 */
const STUCK_AFTER_MS = 45 * 60 * 1000;

registerJob('detect-stuck-imports', 5 * 60 * 1000, async () => {
  const cutoff = new Date(Date.now() - STUCK_AFTER_MS);
  const stuck = await prisma.importJob.findMany({
    where: {
      status: { notIn: ['QUEUED', 'READY_FOR_REVIEW', 'COMMITTED', 'FAILED'] },
      stageStartedAt: { lt: cutoff },
    },
    select: { id: true, status: true, lastCompletedStage: true, stageStartedAt: true },
  });

  for (const j of stuck) {
    const mins = Math.round((Date.now() - j.stageStartedAt.getTime()) / 60000);
    await prisma.importJob.update({
      where: { id: j.id },
      data: {
        status: 'FAILED',
        error:
          `${stageLabel(j.status)}階段停在 ${mins} 分鐘沒有進展，判定為中斷` +
          `（多半是服務重啟造成）。` +
          (j.lastCompletedStage
            ? `已完成到「${stageLabel(j.lastCompletedStage)}」，可以從那裡繼續，不必重跑。`
            : '尚未完成任何階段，重新開始即可。'),
      },
    });
    console.warn(`[detect-stuck-imports] ${j.id} 卡在 ${j.status} 已 ${mins} 分鐘，標記為失敗`);
  }
});

async function tick() {
  const now = Date.now();
  for (const job of jobs) {
    if (now - job.lastRun < job.intervalMs) continue;
    job.lastRun = now;
    try {
      await job.fn();
    } catch (e) {
      // 單一工作失敗不能拖垮整個 worker —— 否則一個壞掉的
      // 清理工作會讓匯入佇列也停擺。
      console.error(`[${job.name}] 失敗：${e.message}`);
    }
  }
  writeFileSync(ALIVE_FILE, String(now));
}

// ─────────────────────────────────────────────────────────────
// 匯入佇列
// ─────────────────────────────────────────────────────────────

/**
 * 併發 1。
 *
 * 不是保守，是刻意：匯入是這台機器上最吃資源的工作（PDF 渲染、
 * 影像處理、大量並行的 AI 呼叫），而同一台機器還要服務正在
 * 考試的學生。兩份題本同時解析會讓考試端的回應時間明顯變差，
 * 而考試不能等，題本可以。
 *
 * 需要更快時，正確的做法是加一台專跑 worker 的機器，
 * 而不是在這裡把數字調大。
 */
const IMPORT_CONCURRENCY = Number(process.env.IMPORT_CONCURRENCY ?? 1);

const importWorker = new Worker(
  'import',
  async (job) => {
    const { jobId, fromStage } = job.data;
    console.log(`[import] 開始處理 ${jobId}${fromStage ? `（自 ${fromStage} 起）` : ''}`);

    const result = await runImport(prisma, jobId, {
      fromStage,
      onProgress: async ({ stage, index, total }) => {
        await job.updateProgress({ stage, label: stageLabel(stage), index, total });
      },
    });

    console.log(
      `[import] ${jobId} 完成` +
        (result.cost ? `，AI 成本約 NT$${result.cost.toFixed(2)}` : ''),
    );
    return result;
  },
  {
    connection,
    concurrency: IMPORT_CONCURRENCY,
    // 一份 200 頁的題本可能跑一個小時。鎖太短會讓 BullMQ 以為
    // 工作死了而重新指派，於是同一份題本被解析兩次——付兩次錢。
    lockDuration: 5 * 60_000,
    lockRenewTime: 60_000,
  },
);

importWorker.on('failed', async (job, err) => {
  const jobId = job?.data?.jobId;
  console.error(`[import] ${jobId ?? '?'} 失敗：${err.message}`);

  // 不可重試的錯誤要立刻停掉，不要走完三次退避。
  // 每一次重試都是真的錢。
  if (err.permanent && job) {
    try {
      await job.discard();
      console.error(`[import] ${jobId} 為不可重試的錯誤，已停止重試`);
    } catch (e) {
      console.error(`[import] 停止重試失敗：${e.message}`);
    }
  }
});

importWorker.on('error', (e) => {
  console.error(`[import] worker 錯誤：${e.message}`);
});

// ─────────────────────────────────────────────────────────────
// 生命週期
// ─────────────────────────────────────────────────────────────

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`收到 ${signal}，正在關閉…`);

  // 先讓 worker 把手上的工作做完（或至少釋放鎖），再斷資料庫。
  // 順序反了的話，正在跑的階段會以一個看不懂的 Prisma 錯誤結束，
  // 而那個工作會停在中間狀態。
  await importWorker.close().catch(() => {});
  await connection.quit().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

console.log(
  `工作者啟動：${jobs.length} 個週期性工作、匯入佇列併發 ${IMPORT_CONCURRENCY}`,
);
writeFileSync(ALIVE_FILE, String(Date.now()));

setInterval(() => {
  if (!shuttingDown) tick().catch((e) => console.error('tick 失敗：', e.message));
}, 30_000);
tick().catch((e) => console.error('首次 tick 失敗：', e.message));
