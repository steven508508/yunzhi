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
  /**
   * 選項。**這裡沒有 `assets`，是刻意的。**
   *
   * 物理題的四個選項可以是四張力圖（`![[a:o1]]` 寫在選項內容裡），
   * 而校對頁與入庫都要知道「哪一張圖屬於哪一個選項」。另一個看起來
   * 也合理的作法是在這個 Json 裡多存一個 `assets` 欄位，讓管線寫進去。
   *
   * 不選它的理由是**那會有兩份真相**：標記寫在文字裡、歸屬存在旁邊，
   * 而老師在校對頁把 `![[a:o1]]` 從甲選項剪到乙選項時只會改到文字。
   * 歸屬由文字算出來（`lib/questionShape.mjs` 的 `partitionAssets`）
   * 的話，剪貼之後自然就對了，而且校對頁與 `lib/commit.ts` 用的是
   * 同一支函式——「校對畫面等於學生畫面」才守得住。
   */
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
  /**
   * 這一題在原稿頁面上的位置（頁寬高的 0–1 比例）。
   * 校對介面靠它在原稿影像上框出這一題——沒有它，老師要自己在
   * 一整頁裡找第幾題，那是每題 2–8 秒的翻頁稅。
   */
  sourceBbox: { page?: number; x0: number; y0: number; x1: number; y1: number } | null;
  /**
   * 這一題的附圖，**一整包**：題幹的、選項的、題組素材的都在裡面。
   * 幾何題沒有圖就是不能校的題目。
   *
   * 原樣帶過去，不重新整形：校對介面把它交給 `partitionAssets` 分到
   * 各段文字上，再餵給 `<MathText assets>`，而那一支自己會濾掉壞掉的
   * 項目（見 lib/math.mjs 的 readAssets）。在這裡多做一次「只留 key」
   * 的整形，結果是題幹裡的 `![[a:fig1]]` 對不到任何一張圖——**而那正是
   * 校對介面要老師確認的那件事**。
   *
   * 為什麼是一整包而不是分好的三份：`ImportCandidate` 只有一個
   * `assets` 欄位，而分派要看文字裡的標記——那是入庫那一刻才定案的事
   * （老師在校對時還會改文字）。分派的規則只有一份，在 questionShape.mjs。
   */
  assets: unknown[];
  /** 入庫時被退回的原因。寫得很好，而在這之前沒有任何畫面讀得到。 */
  reviewNote: string | null;
  /**
   * 已經入庫的話是題目 id。
   *
   * 少了這一欄，校對介面在結構上就分不出「已入庫」與「還沒入庫」——
   * 於是已入庫的題目仍然可以改，改了寫進一張沒有人會再讀的暫存表，
   * 而畫面亮著「已儲存」。
   */
  questionId: string | null;
  /** 出版社專屬題型：模型提議、還沒確認。 */
  customTypeName: string | null;
  state: string;
};

/**
 * 原稿頁面。校對介面左欄要顯示的就是它。
 *
 * 影像本身不放進這裡（一份 36 頁的題本是幾十 MB），只帶尺寸與品質；
 * 位元組走 `/api/import/[jobId]/image`，那一支才有權限檢查。
 */
export type PageView = {
  fileId: string;
  fileName: string;
  index: number;
  width: number;
  height: number;
  quality: number;
  qualityNotes: string[];
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

/**
 * 這份工作的原稿頁面清單。
 *
 * 只取題本與未知角色的檔案：候選題的 `sourcePage` 是切分階段給的，
 * 而切分階段只看這兩種角色（`import-pipeline.mjs`）。把答案卷的頁面
 * 也列進來的話，頁碼會對到另一份檔案的第 12 頁——**那比沒有影像更糟**，
 * 因為老師會拿一張不相干的頁面當成原稿去比對。
 */
export async function loadPages(jobId: string, tenantId: string): Promise<PageView[]> {
  const job = await prisma.importJob.findFirst({
    where: { id: jobId, tenantId },
    select: { id: true },
  });
  if (!job) return [];

  const pages = await prisma.importPage.findMany({
    where: { jobId, file: { role: { in: ['QUESTION_BOOK', 'UNKNOWN'] } } },
    orderBy: [{ fileId: 'asc' }, { index: 'asc' }],
    select: {
      fileId: true,
      index: true,
      width: true,
      height: true,
      quality: true,
      qualityNotes: true,
      file: { select: { fileName: true } },
    },
  });

  return pages.map((p) => ({
    fileId: p.fileId,
    fileName: p.file.fileName,
    index: p.index,
    width: p.width,
    height: p.height,
    quality: p.quality ?? 1,
    qualityNotes: Array.isArray(p.qualityNotes) ? (p.qualityNotes as string[]) : [],
  }));
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
    sourceBbox: c.sourceBbox ?? null,
    assets: Array.isArray(c.assets) ? c.assets.filter((a: any) => a?.key) : [],
    reviewNote: c.reviewNote ?? null,
    questionId: c.questionId ?? null,
    customTypeName: c.customTypeId ? null : (c.customTypeName ?? null),
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
  /**
   * 這一批涵蓋的校對秒數（**增量**，不是累計）。
   *
   * 業主的驗收標準是「50 題 20 分鐘」，而在這之前這個數字送上來被
   * zod 收下就丟掉了——`schema.prisma` 為它留的兩欄零寫入端。
   * 驗收時沒有任何一份資料能回答「我們實際上校一份題本要多久」。
   *
   * 收增量而不是「本次開頁到現在」，是因為老師會分好幾次校完一份
   * 題本；增量在這裡直接累加，跨場次自然接得起來。
   */
  reviewSeconds = 0,
) {
  const job = await prisma.importJob.findFirst({ where: { id: jobId, tenantId } });
  if (!job) throw new Error('找不到匯入工作，或不屬於此租戶');

  // 上限是防線而不是禮貌：一個掛在背景整晚的分頁會把八小時算進校對
  // 用時，而那正好是驗收要看的那個數字。前端也夾一次（reviewState.mjs），
  // 但那一層是可以被繞過的。
  const seconds = Math.max(0, Math.min(Math.floor(reviewSeconds) || 0, 3600));

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
      data: {
        confirmedCount: confirmed,
        flaggedCount: flagged,
        // increment 而不是覆寫：同一份題本會分好幾次校完，而且
        // sendBeacon 那條路不保證只送一次——用累計值覆寫的話，
        // 第二場次一開頁就會把第一場次的用時抹掉。
        ...(seconds > 0 ? { reviewSeconds: { increment: seconds } } : {}),
        // 第一次有人動這份題本的時刻。之後不再改寫，否則「從什麼時候
        // 開始校的」會一路被推到最後一次存檔。
        ...(job.reviewStartedAt ? {} : { reviewStartedAt: new Date() }),
      },
    });
  });
}
