/**
 * 出版社專屬題型：「問老師一次，之後記住」。
 *
 * 出版社常有自己設計的題型——翰林的「觀念速記」、南一的「圖表解碼」、
 * 龍騰的某種雙欄配對。它們呈現方式獨特，但**作答方式幾乎一定是標準
 * 的那幾種之一**，而那正是系統真正需要知道的：不必懂那個題型的教學
 * 設計，只要知道學生怎麼答、怎麼給分。
 *
 * 迴圈：
 *
 *   1. 模型遇到不認得的題型 → 標成 OTHER、保留原圖、提議一個名稱
 *   2. 校對介面把原圖與提議拿給老師，問三件事：
 *      這是什麼？學生怎麼作答？有沒有取得出版社授權？
 *   3. 老師確認 → 存成租戶層級的定義（本檔）
 *   4. 下一次匯入時定義進提示詞，模型直接認得
 *
 * 第 4 步是這整件事划算的地方。少了它，同一種題型每匯入一次就要
 * 重問一次，而那正是老師最不耐煩的事。
 */
import { prisma } from '@/lib/prisma';

/** 允許的授權基礎。與匯入工作用同一組值。 */
export const RIGHTS = ['OWNED', 'LICENSED', 'OFFICIAL_PUBLIC', 'UNVERIFIED'] as const;
export type Rights = (typeof RIGHTS)[number];

/**
 * 學生作答的方式。**這是系統真正需要知道的部分。**
 *
 * 刻意只給資料庫 QuestionType 有的值：一個專屬題型無論長得多特別，
 * 它的作答與評分都必須落到既有的機制上，否則系統存得下它卻沒辦法
 * 拿它考學生——那比不支援更糟，因為老師以為可以用。
 */
export const ANSWER_MODES = [
  'SINGLE_CHOICE',
  'MULTI_CHOICE',
  'TRUE_FALSE',
  'FILL_SLOT',
  'FILL_TEXT',
  'SHORT_ANSWER',
  'ESSAY',
  'TRANSLATION',
] as const;
export type AnswerMode = (typeof ANSWER_MODES)[number];

export type ConfirmInput = {
  name: string;
  description: string;
  answerMode: AnswerMode;
  publisherName?: string | null;
  recognitionHint?: string | null;
  exampleAssetKey?: string | null;
  rightsBasis: Rights;
  rightsNote?: string | null;
};

/**
 * 老師確認一個新題型。
 *
 * 同一租戶下同一出版社的名稱唯一，所以重複確認會更新既有的定義
 * 而不是建第二個——沒有這個行為的話，兩位老師各自確認一次就會
 * 產生兩個「觀念速記」，而篩選就失效了。
 */
export async function confirmType(
  tenantId: string,
  user: { id: string; displayName: string },
  input: ConfirmInput,
) {
  if (!input.name.trim()) throw new Error('請填寫題型名稱');
  if (!input.description.trim()) {
    // 只有名稱的定義對下一次辨識沒有幫助，而這一段會進提示詞。
    throw new Error('請說明這個題型長什麼樣、要學生做什麼');
  }
  if (!ANSWER_MODES.includes(input.answerMode)) {
    throw new Error(`不支援的作答方式：${input.answerMode}`);
  }
  if (!RIGHTS.includes(input.rightsBasis)) {
    throw new Error(`不支援的授權基礎：${input.rightsBasis}`);
  }

  const publisherName = input.publisherName?.trim() || null;

  const saved = await prisma.customQuestionType.upsert({
    where: {
      tenantId_publisherName_name: {
        tenantId,
        publisherName: publisherName as never,
        name: input.name.trim(),
      },
    },
    create: {
      tenantId,
      publisherName,
      name: input.name.trim(),
      description: input.description.trim(),
      answerMode: input.answerMode as never,
      recognitionHint: input.recognitionHint?.trim() || null,
      exampleAssetKey: input.exampleAssetKey || null,
      rightsBasis: input.rightsBasis,
      rightsNote: input.rightsNote?.trim() || null,
      confirmedBy: user.id,
      // 姓名快照。帳號日後被刪時 confirmedBy 會變成 NULL，但
      // 「誰確認這個題型可以用」是責任歸屬，不能跟著消失。
      confirmedName: user.displayName,
      confirmedAt: new Date(),
    },
    update: {
      description: input.description.trim(),
      answerMode: input.answerMode as never,
      recognitionHint: input.recognitionHint?.trim() || null,
      rightsBasis: input.rightsBasis,
      rightsNote: input.rightsNote?.trim() || null,
      confirmedBy: user.id,
      confirmedName: user.displayName,
      confirmedAt: new Date(),
      active: true,
    },
  });

  await prisma.auditLog.create({
    data: {
      tenantId,
      category: 'QUESTION',
      action: 'customType.confirm',
      actorId: user.id,
      targetType: 'CustomQuestionType',
      targetId: saved.id,
      after: {
        name: saved.name,
        publisher: publisherName,
        answerMode: input.answerMode,
        rightsBasis: input.rightsBasis,
      },
    },
  });

  return saved;
}

/**
 * 把一份匯入工作裡「模型提議但還沒確認」的題型收集起來，供校對
 * 介面詢問老師。
 *
 * 同一種題型在一份講義裡會出現很多次，所以依名稱收斂——不然老師
 * 要對同一個問題按二十次確認。
 */
export async function pendingTypes(jobId: string, tenantId: string) {
  const job = await prisma.importJob.findFirst({
    where: { id: jobId, tenantId },
    select: { id: true },
  });
  if (!job) throw new Error('找不到匯入工作');

  const rows = await prisma.importCandidate.findMany({
    where: { jobId, customTypeName: { not: null }, customTypeId: null },
    select: {
      id: true,
      customTypeName: true,
      content: true,
      assets: true,
      sourcePage: true,
    },
    orderBy: { order: 'asc' },
  });

  const byName = new Map<
    string,
    { name: string; count: number; sampleCandidateId: string; samplePage: number | null; sampleAssetKey: string | null; sampleStem: string }
  >();

  for (const r of rows) {
    const name = r.customTypeName!;
    const hit = byName.get(name);
    if (hit) {
      hit.count++;
      continue;
    }
    const assets = Array.isArray(r.assets) ? (r.assets as { key?: string }[]) : [];
    byName.set(name, {
      name,
      count: 1,
      sampleCandidateId: r.id,
      samplePage: r.sourcePage,
      // 拿一張原圖給老師看。只給文字的話，老師認不出那是哪一種
      // 題型——那些題型的辨識特徵本來就是版面而不是文字。
      sampleAssetKey: assets.find((a) => a.key)?.key ?? null,
      sampleStem: (r.content ?? '').slice(0, 200),
    });
  }

  return [...byName.values()].sort((a, b) => b.count - a.count);
}

/**
 * 老師確認之後，把這份工作裡同名的候選題全部接上新定義。
 *
 * 一次接完而不是逐題接：同一種題型在一份講義裡會出現二十次，
 * 而老師只該回答一次。
 */
export async function applyType(
  jobId: string,
  tenantId: string,
  typeName: string,
  typeId: string,
) {
  const job = await prisma.importJob.findFirst({
    where: { id: jobId, tenantId },
    select: { id: true },
  });
  if (!job) throw new Error('找不到匯入工作');

  const { count } = await prisma.importCandidate.updateMany({
    where: { jobId, customTypeName: typeName, customTypeId: null },
    data: { customTypeId: typeId },
  });
  return count;
}
