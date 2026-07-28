/**
 * 候選題入庫。
 *
 * 這是整條匯入路徑的最後一步，也是唯一會產出「可以拿去考學生的
 * 東西」的一步。在這之前的所有階段都只是把資料搬進暫存區。
 *
 * 三個必須守住的規則：
 *
 * 1. **試題與解析分開存、分開標權利。** 試題依著作權法第 9 條
 *    不受保護，解析受保護（文件 16 §3）。把詳解寫進 Question.content
 *    等於把一份受保護的內容標成不受保護，那是這個系統最不該犯的錯。
 *
 * 2. **權利基礎未確認時，不原文收錄解析。** 資料庫有 CHECK 擋著
 *    （explanations_unverified_must_rewrite），但與其去踩那個約束，
 *    不如在這裡就不建那一列——原文仍留在候選題上，等 AI 改寫階段
 *    處理。資料不會遺失，只是還沒能給學生看。
 *
 * 3. **可以重跑。** 老師會分批校對、分批入庫。已入庫的候選題
 *    帶著 questionId，重跑時跳過，不會產生重複題目。
 */
import { prisma } from '@/lib/prisma';
import { normalizeOptions } from '@/lib/questionShape.mjs';
import type { Prisma } from '@prisma/client';

/** 允許原文收錄解析的權利基礎。其餘一律走 AI 改寫。 */
const VERBATIM_OK = new Set(['OWNED', 'LICENSED', 'OFFICIAL_PUBLIC']);

/**
 * 原文收錄的解析可以散布到哪裡。
 *
 * 題目與解析的著作權地位不同，所以散布範圍不能共用一個值：
 * 歷屆**試題**依著作權法第 9 條不受保護，可以 PUBLIC；同一份講義
 * 裡的**詳解**是出版社寫的，受保護，不可以。
 *
 * 資料庫有 CHECK 擋著（explanations_verbatim_not_public），但擋下來
 * 的形式是整題入庫失敗——與其讓老師看到一個看不懂的約束違反訊息，
 * 不如在這裡就把範圍降到合法的最大值，並在 sourceRef 旁留下痕跡。
 */
function explanationScope(questionScope: string): never {
  return (questionScope === 'PUBLIC' ? 'TENANT_NO_EXPORT' : questionScope) as never;
}

export type CommitResult = {
  committed: number;
  skipped: number;
  groups: number;
  explanations: number;
  pendingRewrite: number;
  errors: { candidateId: string; label: string; message: string }[];
};

type CandidateRow = {
  id: string;
  order: number;
  questionNo: string | null;
  subLabel: string | null;
  groupKey: string | null;
  label: string | null;
  type: string | null;
  content: string | null;
  stimulus: string | null;
  options: unknown;
  answerKeys: number[];
  answerSlots: unknown;
  answerText: string | null;
  score: number | null;
  explanationRaw: string | null;
  assets: unknown;
  kpSuggestions: unknown;
  sourcePage: number | null;
  sourceExam: string | null;
  nationalCorrectRate: number | null;
  questionId: string | null;
};

/**
 * 把一份匯入工作裡「已確認」的候選題寫進題庫。
 *
 * 只處理 CONFIRMED。存疑（FLAGGED）與待校（PENDING）留著，
 * 老師處理完可以再按一次——這正是分批入庫的用法。
 */
export async function commitJob(
  jobId: string,
  tenantId: string,
  userId: string,
): Promise<CommitResult> {
  const job = await prisma.importJob.findFirst({
    where: { id: jobId, tenantId },
    include: { subject: { select: { id: true, name: true } } },
  });
  if (!job) throw new Error('找不到匯入工作');

  const candidates = (await prisma.importCandidate.findMany({
    where: { jobId, state: 'CONFIRMED', questionId: null },
    orderBy: { order: 'asc' },
  })) as unknown as CandidateRow[];

  const result: CommitResult = {
    committed: 0,
    skipped: 0,
    groups: 0,
    explanations: 0,
    pendingRewrite: 0,
    errors: [],
  };

  if (candidates.length === 0) {
    return result;
  }

  // **搶鎖，而且是原子的。** 路由層有讀過一次 status !== 'COMMITTING'，
  // 但「讀」與「寫」之間隔著一次網路往返：老師開兩個分頁各按一次
  // 入庫，兩邊都讀到 READY，兩邊都取到同一批 `questionId: null` 的
  // 候選題，於是每一題各建兩列。`familyId` 每次都重新亂數產生，
  // 沒有任何唯一索引擋得住，而重複的題目是 DRAFT，題庫頁只顯示
  // 已發布的——會一路潛伏到老師按下發布那天。
  //
  // 同時把 stageStartedAt 設起來。worker 的卡住偵測要求它不是 null，
  // 而入庫途中被砍掉（部署、OOM）留下的 COMMITTING 沒有它就永遠
  // 不會被回收，老師只會一直看到「正在入庫中，請稍候再試」。
  const claimed = await prisma.importJob.updateMany({
    where: { id: jobId, tenantId, status: { not: 'COMMITTING' } },
    data: { status: 'COMMITTING', stageStartedAt: new Date() },
  });
  if (claimed.count === 0) {
    result.errors.push({
      candidateId: '',
      label: '',
      message: '這份題本正在入庫中，請稍候再試',
    });
    return result;
  }

  const verbatimAllowed = VERBATIM_OK.has(job.rightsBasis ?? '');
  const groupIds = new Map<string, string>();

  for (const c of candidates) {
    // 逐題一個交易。整批一個交易的話，第 40 題的資料問題會讓
    // 前 39 題的入庫一起消失——而老師已經花了 20 分鐘校對它們。
    try {
      const { options, answerKeys, dropped, duplicates } = normalizeOptions(
        c.options,
        c.answerKeys ?? [],
      );

      // 兩個選項一模一樣 → 這一題沒有唯一解。
      //
      // 與下面的 dropped 是同一類問題，但更隱蔽：選項數量對、答案是
      // 合法的序號、校對者掃過去不會停。被讀掉的通常是最細的那一筆
      // ——向量的箭頭、指數的上標、負號、單位——而物理與數學最常中招。
      // 讓它入庫的話，選到「另一個一樣的」的學生會被判錯。
      if (duplicates.length) {
        const pairs = duplicates.map(([a, b]) => `${a}／${b}`).join('、');
        await prisma.importCandidate.update({
          where: { id: c.id },
          data: {
            state: 'FLAGGED',
            reviewNote:
              `選項 ${pairs} 的內容完全一樣，這一題沒有唯一解。` +
              `多半是有東西被讀掉了——向量的箭頭、指數的上標、負號、單位。` +
              `請對照原稿補回差異。`,
          },
        });
        result.skipped++;
        result.errors.push({
          candidateId: c.id,
          label: c.label ?? c.questionNo ?? String(c.order),
          message: `選項 ${pairs} 內容重複，無法判定唯一答案`,
        });
        continue;
      }

      if (dropped.length) {
        // 答案指向一個入庫後不存在的選項。多半是掃描漏抓了一個選項。
        // **不猜、不硬塞、不靜默丟掉**：留在待校對，把原因寫給老師。
        // 硬塞一個看起來合理的答案，會讓每個答對的學生被判錯，
        // 而沒有任何跡象。
        await prisma.importCandidate.update({
          where: { id: c.id },
          data: {
            state: 'FLAGGED',
            reviewNote:
              `答案 (${dropped.join(')(')}) 找不到對應的選項，` +
              `本題共 ${options.length} 個選項。請確認是否有選項漏抓。`,
          },
        });
        result.skipped++;
        result.errors.push({
          candidateId: c.id,
          label: c.label ?? c.questionNo ?? String(c.order),
          message: `答案與選項對不上（答案 ${dropped.join('、')}，選項只有 ${options.length} 個）`,
        });
        continue;
      }

      await prisma.$transaction(async (tx) => {
        const groupId = c.groupKey
          ? await ensureGroup(tx, job, c, groupIds)
          : null;

        const question = await tx.question.create({
          data: {
            tenantId,
            subjectId: job.subjectId,
            // familyId 是跨版本穩定的識別；第一版讓它等於自己的 id
            // 不可行（id 還沒產生），所以用 cuid 另外給一個。
            familyId: newFamilyId(),
            version: 1,
            groupId,
            subLabel: c.subLabel,
            type: (c.type ?? 'SINGLE_CHOICE') as never,
            content: c.content ?? '',
            // 附圖跟著題目走。幾何題沒有圖就是不能用的題目，
            // 所以它與題幹一樣要在入庫時搬過去。
            contentAssets: normalizeAssets(c.assets),
            score: c.score ?? 0,
            // 已依重新編號後的選項序號對映過（見 normalizeOptions）
            answerKeys,
            answerSlots: (c.answerSlots as Prisma.InputJsonValue) ?? undefined,
            answerText: c.answerText,
            sourceType: job.sourceType,
            licenseScope: job.licenseScope,
            sourceRef: sourceRef(job.title, c),
            sourceExam: c.sourceExam,
            sourceImportJobId: jobId,
            // 原稿印的全國答對率，以及由它推得的難度先驗。
            // difficulty 的慣例是「1 = 最難」，而答對率越高代表越簡單，
            // 所以是 1 - rate。沒印答對率的題目維持 null，讓標註階段的
            // 模型估計去填——**估計值不會寫進 nationalCorrectRate**，
            // 那一欄只放原稿真的印出來的數字。
            nationalCorrectRate: c.nationalCorrectRate,
            nationalSampleNote: c.sourceExam
              ? `原稿標示：${c.sourceExam}`
              : null,
            difficulty:
              c.nationalCorrectRate == null
                ? undefined
                : 1 - c.nationalCorrectRate,
            // 校對確認的是「抽取正確」，不是「可以拿去考學生」——
            // 後者要科目老師另外發布。所以入庫是 PENDING_REVIEW
            // 而不是 PUBLISHED。
            //
            // **原本寫 DRAFT，而題庫頁只列 PUBLISHED 與 PENDING_REVIEW。**
            // 症狀是：老師按下「寫進題庫」，畫面回報「已寫入 2 題」，
            // 然後點到題庫看到「題庫是空的」。題目其實都在資料庫裡，
            // 只是永遠不會出現——而整個 repo 沒有任何一行程式會把
            // DRAFT 改成別的狀態，所以那是一條死路。
            //
            // 這是整條核心動線（匯入 → 校對 → 題庫）唯一的斷點。
            status: 'PENDING_REVIEW',
            createdBy: userId,
          },
          select: { id: true },
        });

        if (options.length) {
          await tx.questionOption.createMany({
            data: options.map((o) => ({
              questionId: question.id,
              order: o.order,
              label: o.label,
              content: o.content,
            })),
          });
        }

        for (const kp of normalizeKp(c.kpSuggestions)) {
          // 知識點可能已被刪除（校對期間有人整理過知識點樹）。
          // 連不上就跳過，不要讓整題入庫失敗。
          await tx.questionKnowledgePoint
            .create({
              data: {
                questionId: question.id,
                knowledgePointId: kp.id,
                weight: Math.min(1, Math.max(0.01, kp.weight)),
              },
            })
            .catch(() => {});
        }

        if (c.explanationRaw?.trim()) {
          if (verbatimAllowed) {
            await tx.explanation.create({
              data: {
                tenantId,
                questionId: question.id,
                origin: 'VERBATIM_IMPORT',
                rightsBasis: (job.rightsBasis ?? 'OWNED') as never,
                // **解析的散布範圍不能直接沿用題目的。**
                //
                // 一份「歷屆試題」的題目可以是 PUBLIC——試題依著作權法
                // 第 9 條不受保護。但同一份講義裡的**詳解是出版社寫的**，
                // 它受保護。照抄 job.licenseScope 的結果是把一段受保護的
                // 內容標成公開，而那正是這整套權利模型要防的事。
                licenseScope: explanationScope(job.licenseScope),
                displayMode: 'FULL',
                isPrimary: true,
                layers: { steps: [c.explanationRaw.trim()] },
                rawBody: c.explanationRaw,
                sourceRef: sourceRef(job.title, c),
                declaredBy: job.rightsDeclaredBy,
              },
            });
            result.explanations++;
          } else {
            // 權利未確認：不建解析列。原文留在候選題上，
            // 由 AI 改寫階段處理。硬建一列並標成 AI_REWRITTEN
            // 只是為了繞過 CHECK，那是對自己說謊。
            await tx.question.update({
              where: { id: question.id },
              data: {
                qualityFlags: {
                  explanationPendingRewrite: true,
                  reason: '權利基礎未確認，原稿詳解不可原文收錄',
                },
              },
            });
            result.pendingRewrite++;
          }
        }

        await tx.importCandidate.update({
          where: { id: c.id },
          data: { questionId: question.id },
        });
      });
      result.committed++;
    } catch (e) {
      result.errors.push({
        candidateId: c.id,
        label: c.label ?? c.questionNo ?? `第 ${c.order} 題`,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  result.groups = groupIds.size;

  const remaining = await prisma.importCandidate.count({
    where: { jobId, state: { in: ['PENDING', 'FLAGGED'] } },
  });
  const total = await prisma.importCandidate.count({
    where: { jobId, questionId: { not: null } },
  });

  await prisma.importJob.update({
    where: { id: jobId },
    data: {
      // 還有沒校完的就留在待校對，讓老師可以繼續分批處理。
      status: remaining > 0 ? 'READY_FOR_REVIEW' : 'COMMITTED',
      committedAt: remaining > 0 ? null : new Date(),
      // 放掉入庫鎖。留著的話，下一次按入庫會被自己擋掉。
      stageStartedAt: null,
      committedCount: total,
      commitDetail: {
        lastRun: {
          committed: result.committed,
          explanations: result.explanations,
          pendingRewrite: result.pendingRewrite,
          errors: result.errors.slice(0, 20),
        },
        remaining,
      },
    },
  });

  await prisma.auditLog.create({
    data: {
      tenantId,
      category: 'QUESTION',
      action: 'import.commit',
      actorId: userId,
      targetType: 'ImportJob',
      targetId: jobId,
      after: {
        committed: result.committed,
        explanations: result.explanations,
        pendingRewrite: result.pendingRewrite,
        errorCount: result.errors.length,
        sourceType: job.sourceType,
        licenseScope: job.licenseScope,
        rightsBasis: job.rightsBasis,
      },
    },
  });

  return result;
}

// ─────────────────────────────────────────────────────────────
// 輔助
// ─────────────────────────────────────────────────────────────

type Tx = Omit<
  typeof prisma,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * 題組。同一次匯入的同一個 groupKey 共用一列。
 *
 * 用 upsert 而非「先查再建」：老師可能開兩個分頁各按一次入庫，
 * 那時「先查再建」的兩個交易會各建一個題組。唯一索引加 upsert
 * 才擋得住。
 */
async function ensureGroup(
  tx: Tx,
  job: { id: string; tenantId: string; subjectId: string },
  c: CandidateRow,
  cache: Map<string, string>,
): Promise<string> {
  const key = c.groupKey!;
  const cached = cache.get(key);
  if (cached) return cached;

  const group = await tx.questionGroup.upsert({
    where: { sourceImportJobId_sourceGroupKey: { sourceImportJobId: job.id, sourceGroupKey: key } },
    update: {},
    create: {
      tenantId: job.tenantId,
      subjectId: job.subjectId,
      stimulus: c.stimulus ?? '',
      label: key,
      sourceImportJobId: job.id,
      sourceGroupKey: key,
    },
    select: { id: true },
  });
  cache.set(key, group.id);
  return group.id;
}

/**
 * 來源標註。
 *
 * 老師發現題目有問題時，第一件事是回頭看原稿。這個字串要能讓他
 * 直接翻到那一頁：「翰林數學(1) 4-1 / 範例 3 / 第 5 頁」。
 */
function sourceRef(title: string, c: CandidateRow): string {
  const parts = [title];
  if (c.label) parts.push(c.label);
  else if (c.questionNo) parts.push(`第 ${c.questionNo} 題`);
  if (c.sourcePage) parts.push(`第 ${c.sourcePage} 頁`);
  return parts.join(' / ');
}

function newFamilyId(): string {
  // 與 Prisma 的 cuid 同形狀即可，不需要真的 cuid ——
  // 它只是一個跨版本穩定的識別。
  return `fam_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * 題目附圖。只留下真的有物件鍵的那些——沒有鍵就沒有圖可顯示，
 * 留著只會讓前端出現破圖。
 */
function normalizeAssets(raw: unknown): Prisma.InputJsonValue | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === 'object')
    .filter((a) => typeof a.key === 'string' && a.key)
    .map((a) => ({
      key: a.key as string,
      page: typeof a.page === 'number' ? a.page : null,
      bbox: (a.bbox as Record<string, number>) ?? null,
      // 標籤先當替代文字用。正式的替代文字要由 AI 依題幹生成
      // （文件 01 的無障礙要求），那是另一個階段。
      alt: Array.isArray(a.labels) ? (a.labels as string[]).join(' ') : '',
    }));
  return out.length ? (out as unknown as Prisma.InputJsonValue) : undefined;
}

function normalizeKp(raw: unknown): { id: string; weight: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((k): k is Record<string, unknown> => Boolean(k) && typeof k === 'object')
    .map((k) => ({ id: String(k.id ?? ''), weight: Number(k.weight) || 1 }))
    .filter((k) => k.id);
}
