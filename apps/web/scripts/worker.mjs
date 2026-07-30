/**
 * 背景工作者。
 *
 * 兩類工作：
 *   · 週期性維護（清 session、解鎖帳號、找出卡住的匯入、產生與送出通知）
 *   · 佇列消費（匯入管線；評分、解析生成依路線圖加入）
 *
 * 兩者共用一個行程但**不共用失敗**：任何一邊出錯都不能拖垮另一邊。
 * 一個壞掉的清理工作不該讓老師的題本匯入停擺。
 */
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { UnrecoverableError, Worker } from 'bullmq';
import Redis from 'ioredis';
import { runImport, stageLabel } from './import-pipeline.mjs';
import { deliverDue, examBusy, generateAll } from '../lib/notify.mjs';
import { tenantScoped } from '../lib/prismaClient.mjs';
import { withoutTenantScope } from '../lib/tenantContext.mjs';

const prisma = tenantScoped(new PrismaClient());
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

/** 間隔 0 = 每一輪 tick 都跑（見 `tick` 的間隔判斷）。 */
const EVERY_TICK = 0;
/**
 * 週期性維護一律**跨租戶**執行。
 *
 * 這些工作本來就是跨租戶的：清掉所有租戶的過期 session、解鎖所有
 * 租戶的帳號、找出所有租戶卡住的匯入。工作者不屬於任何一家補習班。
 *
 * 包在這裡而不是每個工作各自寫，是為了讓「跨租戶」只出現一次——
 * 那是唯一能繞過隔離的地方，出現次數愈少愈好，而
 * `tools/rls-check.mjs` 會盯著它。
 */
function registerJob(name, intervalMs, fn) {
  jobs.push({
    name,
    intervalMs,
    fn: () => withoutTenantScope(`背景維護工作：${name}`, fn),
    lastRun: 0,
  });
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

// ─────────────────────────────────────────────────────────────
// 通知
//
// 兩支工作，刻意分開而且節奏差很多：
//
//   產生（15 分鐘）  掃過所有租戶的任務、作答、匯入。這是整個模組
//                    最重的查詢，而它跟考試搶同一個資料庫。
//   送出（每一輪）    只撈 QUEUED 而且到期的那幾列，有數量上限。
//
// 合成一支的話，要嘛送出被拖到 15 分鐘一次（老師按下放行，學生
// 十五分鐘後才看到「成績開放了」——他早就自己重整過八次了），
// 要嘛掃描每 30 秒跑一次（考試中的資料庫多了一個每半分鐘的全表掃描）。
// ─────────────────────────────────────────────────────────────

/**
 * 產生通知。
 *
 * **冪等。** 工作者重啟、跑兩次、或同時跑兩個實例都不會送出兩份：
 * 每一則都帶 `dedupeKey`，而 `@@unique([tenantId, dedupeKey])` 讓
 * 第二次寫入撞在資料庫上（`lib/notify.mjs` 的 `enqueueMany` 把那個
 * 衝突當成正常結果）。**不是靠「先查有沒有」**——兩個實例會同時查到
 * 沒有、同時寫進去。
 *
 * 有考試正在進行時整輪跳過。掃描補得回來（下一輪的結果一樣），
 * 考試不能等——這與匯入併發設成 1 是同一個決定。
 */
registerJob('notify-generate', 15 * 60 * 1000, async () => {
  if (await examBusy(prisma)) {
    console.log('[notify-generate] 有考試正在進行，這一輪跳過（下一輪會補上）');
    return;
  }
  const r = await generateAll(prisma, { log: (m) => console.log(m) });
  for (const f of r.failures) {
    // 一支掃描壞掉不該讓其他三支的結果消失，所以失敗是回傳值而不是
    // 例外；但它一定要印出來，否則「通知怎麼都沒有」查不到原因。
    console.error(`[notify-generate] ${f}`);
  }
});

/**
 * 送出到期的通知。
 *
 * 站內通知的「送出」是 QUEUED → SENT 的狀態轉換——**什麼都沒有離開
 * 這台機器**。仍然讓它走一次工作者，理由見 `lib/notify.mjs` 的檔頭：
 * 免打擾與節流只在一個地方生效、失敗與重試的帳從第一天就記著、
 * 而日後真的接上 LINE 時管線已經在那裡。
 *
 * 每一輪都跑（tick 是 30 秒），因為老師按下放行之後學生應該很快
 * 看得到。查詢很輕：`(status, scheduledAt)` 有索引，而且有數量上限。
 */
registerJob('notify-deliver', EVERY_TICK, async () => {
  const r = await deliverDue(prisma);
  if (r.rescued > 0) {
    console.warn(`[notify-deliver] ${r.rescued} 則卡在送出中，放回佇列重試`);
  }
  if (r.sent > 0 || r.failed > 0 || r.dead > 0 || r.suppressed > 0) {
    console.log(
      `[notify-deliver] 送出 ${r.sent} 則` +
        (r.failed > 0 ? `、失敗待重試 ${r.failed} 則` : '') +
        (r.dead > 0 ? `、達重試上限 ${r.dead} 則` : '') +
        (r.suppressed > 0 ? `、抑制 ${r.suppressed} 則` : ''),
    );
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

    let result;
    try {
      result = await runImport(prisma, jobId, {
        fromStage,
        onProgress: async ({ stage, index, total }) => {
          await job.updateProgress({ stage, label: stageLabel(stage), index, total });
        },
      });
    } catch (e) {
      // **不可重試的錯誤要在這裡就轉成 UnrecoverableError。**
      //
      // 原本是在 'failed' 事件裡呼叫 job.discard()，但 BullMQ 是
      // 先 moveToFailed（那時候就已經決定要不要重試了）再發事件，
      // discard 旗標根本來不及被讀到；而且 discard() 在 5.x 已標成
      // deprecated，官方的作法就是 UnrecoverableError。
      //
      // 差別是真的錢：模型名稱打錯 → 502 → PermanentError →
      // 照樣重跑最貴的自答階段三次。
      if (e?.permanent) {
        const wrapped = new UnrecoverableError(e.message);
        wrapped.stage = e.stage;
        wrapped.permanent = true;
        throw wrapped;
      }
      throw e;
    }

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

importWorker.on('failed', (job, err) => {
  const jobId = job?.data?.jobId;
  console.error(`[import] ${jobId ?? '?'} 失敗：${err.message}`);
  if (err?.permanent) {
    console.error(`[import] ${jobId} 為不可重試的錯誤，不會再重跑`);
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
