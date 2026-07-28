/**
 * commit.ts 的 .mjs 包裝，給端到端測試用。
 *
 * lib/commit.ts 是 TypeScript 而且直接 import 全域的 prisma 單例；
 * 測試裡用的是 pg-shim（見 tools/pg-shim.mjs 的說明）。這支把同一套
 * 邏輯改寫成吃外部傳入的 client，讓測試驗得到真正的資料庫行為。
 *
 * **兩份實作有分岐的風險**，所以這裡刻意只做最小的搬移：
 * 邏輯與 commit.ts 逐行對應，改的只有 prisma 的來源。
 * 日後改 commit.ts 一定要同步改這裡，否則測試會綠燈而正式環境會壞。
 */
const VERBATIM_OK = new Set(['OWNED', 'LICENSED', 'OFFICIAL_PUBLIC']);

export async function commitJob(prisma, jobId, tenantId, userId) {
  const job = await prisma.importJob.findFirst({ where: { id: jobId, tenantId } });
  if (!job) throw new Error('找不到匯入工作');

  const candidates = await prisma.importCandidate.findMany({
    where: { jobId, state: 'CONFIRMED', questionId: null },
    orderBy: { order: 'asc' },
  });

  const result = {
    committed: 0, skipped: 0, groups: 0,
    explanations: 0, pendingRewrite: 0, errors: [],
  };
  if (candidates.length === 0) return result;

  await prisma.importJob.update({ where: { id: jobId }, data: { status: 'COMMITTING' } });

  const verbatimAllowed = VERBATIM_OK.has(job.rightsBasis ?? '');
  const groupIds = new Map();

  for (const c of candidates) {
    try {
      let groupId = null;
      if (c.groupKey) {
        groupId = groupIds.get(c.groupKey) ?? null;
        if (!groupId) {
          const g = await prisma.questionGroup.create({
            data: {
              tenantId, subjectId: job.subjectId,
              stimulus: c.stimulus ?? '', label: c.groupKey,
              sourceImportJobId: jobId, sourceGroupKey: c.groupKey,
            },
          });
          groupId = g.id;
          groupIds.set(c.groupKey, groupId);
        }
      }

      const question = await prisma.question.create({
        data: {
          tenantId, subjectId: job.subjectId,
          familyId: `fam_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`,
          version: 1, groupId, subLabel: c.subLabel,
          type: c.type ?? 'SINGLE_CHOICE',
          content: c.content ?? '',
          score: c.score ?? 0,
          answerKeys: c.answerKeys ?? [],
          answerSlots: c.answerSlots ?? null,
          answerText: c.answerText,
          sourceType: job.sourceType,
          licenseScope: job.licenseScope,
          sourceRef: [job.title, c.label ?? (c.questionNo && `第 ${c.questionNo} 題`),
                      c.sourcePage && `第 ${c.sourcePage} 頁`].filter(Boolean).join(' / '),
          sourceExam: c.sourceExam,
          sourceImportJobId: jobId,
          nationalCorrectRate: c.nationalCorrectRate,
          nationalSampleNote: c.sourceExam ? `原稿標示：${c.sourceExam}` : null,
          difficulty: c.nationalCorrectRate == null ? undefined : 1 - c.nationalCorrectRate,
          status: 'DRAFT',
          createdBy: userId,
        },
      });

      const opts = (Array.isArray(c.options) ? c.options : [])
        .filter((o) => o && String(o.content ?? '').trim())
        .map((o, i) => ({
          questionId: question.id,
          order: i + 1,
          label: String(o.label ?? i + 1),
          content: String(o.content),
        }));
      if (opts.length) await prisma.questionOption.createMany({ data: opts });

      if (c.explanationRaw?.trim()) {
        if (verbatimAllowed) {
          await prisma.explanation.create({
            data: {
              tenantId, questionId: question.id,
              origin: 'VERBATIM_IMPORT',
              rightsBasis: job.rightsBasis ?? 'OWNED',
              licenseScope: job.licenseScope,
              displayMode: 'FULL', isPrimary: true,
              layers: { steps: [c.explanationRaw.trim()] },
              rawBody: c.explanationRaw,
              declaredBy: job.rightsDeclaredBy,
            },
          });
          result.explanations++;
        } else {
          await prisma.question.update({
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

      await prisma.importCandidate.update({
        where: { id: c.id }, data: { questionId: question.id },
      });
      result.committed++;
    } catch (e) {
      result.errors.push({ candidateId: c.id, message: e.message });
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
      status: remaining > 0 ? 'READY_FOR_REVIEW' : 'COMMITTED',
      committedAt: remaining > 0 ? null : new Date(),
      committedCount: total,
      commitDetail: { lastRun: { committed: result.committed }, remaining },
    },
  });

  await prisma.auditLog.create({
    data: {
      tenantId, category: 'QUESTION', action: 'import.commit',
      actorId: userId, targetType: 'ImportJob', targetId: jobId,
      after: { committed: result.committed, explanations: result.explanations },
    },
  });

  return result;
}
