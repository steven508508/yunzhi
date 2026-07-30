/**
 * 評分規準：把 `Rubric` / `RubricDimension` / `RubricBand` 接到畫面上。
 *
 * # 這三張表從第一版就在 schema 裡，而在這個檔案之前沒有一行程式寫過它們
 *
 * 全 repo 唯一提到 rubric 的地方是匯入頁的檔案角色下拉選單，而那一項
 * 的標籤寫著「評分原則（不會被讀取）」。Python 端甚至已經有一支
 * `RUBRIC_SYSTEM` 提示詞與 `RubricOut` 的不變量驗證（抽取大考中心公布的
 * 評分原則），但抽出來的東西沒有地方可以存。
 *
 * 所以這個檔案補的是「老師手建」那一條路，而它與 Python 那一條路
 * **共用同一組不變量**（`lib/gradingProposal.mjs` 的 `checkRubricDraft`
 * 對上 `pipeline/schemas.py` 的 `RubricOut._invariants`）：各面向上限
 * 加起來等於總分、等第的分數帶連續不重疊、最高等第上限等於配分。
 * 兩邊算出不同結果的症狀是「建得起來的規準，AI 評分時每一份都被判成
 * 加總不對」。
 *
 * # internalOnly 是這個檔案最重要的一件事
 *
 * `Rubric.internalOnly` 預設為真，schema 的註解寫著理由：**評分原則的
 * 描述文字受著作權保護（文件 16 §3），內部閱卷可呈現，不得散布或匯出
 * 給學生。**
 *
 * 「把畫面藏起來」不算擋住。所以這裡的做法是：
 *
 *   · **只有一支函式回得出描述文字**（`loadRubricForGrading`），
 *     而它自己做授課權限判斷，不是靠呼叫端記得判斷。
 *   · 學生那一側有一支專用的投影（`rubricNoticeForStudent`），
 *     它的回傳型別裡**沒有任何欄位裝得下 descriptor**——不是「記得
 *     不要填」，是填不進去。
 *   · 任何匯出的方向要先過 `assertRubricExportable`，`internalOnly`
 *     的一律丟例外。
 *
 * 第二點是這三者裡唯一擋得住「下一個人忘記」的：型別上沒有那個欄位，
 * 忘記也寫不出來。
 *
 * # 為什麼改規準是「原地換內容」而不是「刪掉重建」
 *
 * 因為 `AnswerGradeProposal.rubricId` 記著這一筆建議是照哪一份規準評的
 * （沒有外鍵，所以刪掉不會有錯誤訊息，只會有一個對不回去的 id）。
 * 原地更新讓那個指向一直有效——事後看一筆奇怪的建議時，
 * 「當時的規準是什麼」與 `promptVersion` 一樣重要。
 *
 * 代價是改了規準之後，舊的建議對應的其實是舊的描述文字。這一點沒有
 * 辦法在不加欄位的前提下解決，所以規準頁上會寫出來。
 */
import type { Prisma } from '@prisma/client';

import type { SessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { checkRubricDraft, rubricTemplates } from '@/lib/gradingProposal.mjs';
import { mayGrade } from '@/lib/scoring';
import { requireTenant } from '@/lib/tenant';

// ─────────────────────────────────────────────────────────────────
// 錯誤
// ─────────────────────────────────────────────────────────────────

export class RubricError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'RubricError';
    this.status = status;
  }
}

// ─────────────────────────────────────────────────────────────────
// 形狀
// ─────────────────────────────────────────────────────────────────

export type RubricDimensionView = {
  id: string;
  name: string;
  nameEn: string | null;
  maxScore: number;
  descriptor: string | null;
  order: number;
};

export type RubricBandView = {
  id: string;
  grade: string;
  scoreMin: number;
  scoreMax: number;
  descriptor: string;
  dimensionId: string | null;
  dimensionName: string | null;
  order: number;
};

/**
 * 完整的規準，**含描述文字**。
 *
 * 這個型別只出現在老師端。它出現在任何一支學生會呼叫的函式的回傳型別
 * 裡，就是一次授權範圍的違反——所以 `tests/gradingWriteBarrier.test.mjs`
 * 會靜態檢查它沒有被學生端的檔案引用。
 */
export type RubricView = {
  id: string;
  questionId: string | null;
  name: string;
  totalScore: number;
  mode: string;
  internalOnly: boolean;
  sourceRef: string | null;
  dimensions: RubricDimensionView[];
  bands: RubricBandView[];
  updatedAt: Date;
};

/** 老師填的草稿。與 `checkRubricDraft` 的輸入同一個形狀。 */
export type RubricDraft = {
  name: string;
  totalScore: number;
  mode: string;
  sourceRef?: string | null;
  internalOnly?: boolean;
  dimensions: {
    name: string;
    nameEn?: string | null;
    maxScore: number;
    descriptor?: string | null;
    order?: number;
  }[];
  bands: {
    grade: string;
    scoreMin: number;
    scoreMax: number;
    descriptor: string;
    /** 面向的**名稱**（不是 id）。草稿裡的面向還沒有 id。 */
    dimensionName?: string | null;
    order?: number;
  }[];
};

export { rubricTemplates };

// ─────────────────────────────────────────────────────────────────
// 讀
// ─────────────────────────────────────────────────────────────────

const SELECT = {
  id: true,
  questionId: true,
  name: true,
  totalScore: true,
  mode: true,
  internalOnly: true,
  sourceRef: true,
  updatedAt: true,
  dimensions: {
    select: { id: true, name: true, nameEn: true, maxScore: true, descriptor: true, order: true },
    orderBy: { order: 'asc' as const },
  },
  bands: {
    select: {
      id: true,
      grade: true,
      scoreMin: true,
      scoreMax: true,
      descriptor: true,
      dimensionId: true,
      order: true,
    },
    orderBy: { order: 'asc' as const },
  },
};

type Row = Prisma.RubricGetPayload<{ select: typeof SELECT }>;

function toView(r: Row): RubricView {
  const dimName = new Map(r.dimensions.map((d) => [d.id, d.name]));
  return {
    id: r.id,
    questionId: r.questionId,
    name: r.name,
    totalScore: r.totalScore,
    mode: r.mode,
    internalOnly: r.internalOnly,
    sourceRef: r.sourceRef,
    updatedAt: r.updatedAt,
    dimensions: r.dimensions.map((d) => ({
      id: d.id,
      name: d.name,
      nameEn: d.nameEn,
      maxScore: d.maxScore,
      descriptor: d.descriptor,
      order: d.order,
    })),
    bands: r.bands.map((b) => ({
      id: b.id,
      grade: b.grade,
      scoreMin: b.scoreMin,
      scoreMax: b.scoreMax,
      descriptor: b.descriptor,
      dimensionId: b.dimensionId,
      dimensionName: b.dimensionId ? (dimName.get(b.dimensionId) ?? null) : null,
      order: b.order,
    })),
  };
}

/**
 * 這一題的規準，**含描述文字**。
 *
 * # 為什麼權限判斷在這裡面而不是交給呼叫端
 *
 * 因為呼叫端會忘記，而忘記的症狀是**沒有症狀**：畫面上多出一段
 * 出版社的評分原則，看起來就像功能做好了。所以這一支自己查題目的
 * 科目、自己問 `mayGrade`，判不過就丟 403。
 *
 * 這是唯一一支回得出 descriptor 的函式（AI 閱卷那一條路走
 * `loadRubricForAi`，它也在這個檔案裡、也不出去到瀏覽器）。
 */
export async function loadRubricForGrading(
  user: SessionUser,
  questionId: string,
): Promise<RubricView | null> {
  requireTenant();
  const q = await prisma.question.findFirst({
    where: { id: questionId },
    select: { id: true, subjectId: true },
  });
  if (!q) throw new RubricError('找不到這一題', 404);
  if (!(await mayGrade(user, q.subjectId))) {
    throw new RubricError(
      '評分規準的描述文字是內部閱卷用的（授權範圍不含散布），只有這一科的授課老師與管理員看得到。',
      403,
    );
  }
  const row = await prisma.rubric.findFirst({ where: { questionId }, select: SELECT });
  return row ? toView(row) : null;
}

/**
 * AI 閱卷要用的規準。**不做權限判斷，因為它的呼叫端是伺服器自己。**
 *
 * 分成兩支而不是加一個 `skipPermission` 旗標：旗標遲早會有一支呼叫端
 * 傳錯，而傳錯的方向是學生看得到規準原文。兩支不同名字的函式傳不錯。
 *
 * 這一支只在 `lib/gradingProposalDb.ts` 裡被呼叫，而那一段的輸出
 * （規準原文）只送到 Python 服務，不進任何 HTTP 回應。
 */
export async function loadRubricForAi(questionId: string): Promise<RubricView | null> {
  requireTenant();
  const row = await prisma.rubric.findFirst({ where: { questionId }, select: SELECT });
  return row ? toView(row) : null;
}

/**
 * 學生看得到的部分。
 *
 * # 這個型別裡沒有任何欄位裝得下描述文字
 *
 * 那是刻意的，而且它是這個檔案裡唯一擋得住「下一個人忘記」的機制：
 * 忘記過濾寫不出來，因為型別上沒有那個欄位。
 *
 * 那麼學生看得到什麼？**只有制度事實**：這一題有沒有規準、總分幾分、
 * 分成幾個面向、每個面向幾分。這幾個數字是配分，不是著作——學生本來
 * 就該知道一題 25 分裡「內容」占幾分。看不到的是每一級、每一個面向的
 * 描述文字，那才是受保護的表達。
 */
export type RubricNotice = {
  hasRubric: boolean;
  totalScore: number | null;
  /** 面向的名稱與配分。**沒有 descriptor。** */
  dimensions: { name: string; maxScore: number }[];
  bandCount: number;
  /** 給學生看的一句話。由這一支組出來，不是從資料庫來的。 */
  text: string;
};

export function rubricNoticeForStudent(rubric: RubricView | null): RubricNotice {
  if (!rubric) {
    return {
      hasRubric: false,
      totalScore: null,
      dimensions: [],
      bandCount: 0,
      text: '這一題由老師依作答內容給分。',
    };
  }
  const dims = rubric.dimensions.map((d) => ({ name: d.name, maxScore: d.maxScore }));
  const how =
    dims.length > 0
      ? `分成 ${dims.map((d) => `${d.name} ${d.maxScore} 分`).join('、')}`
      : rubric.bands.length > 0
        ? `依等第給分（共 ${rubric.bands.length} 級）`
        : '依評分原則給分';
  return {
    hasRubric: true,
    totalScore: rubric.totalScore,
    dimensions: dims,
    bandCount: rubric.bands.length,
    text:
      `這一題滿分 ${rubric.totalScore} 分，${how}。` +
      '評分原則的完整內容是內部閱卷用的，不對外提供——想知道自己為什麼是這個分數，' +
      '看老師寫的評語，或直接問他。',
  };
}

/**
 * 匯出的方向要先問過這一支。
 *
 * `internalOnly` 的規準一律丟例外，**不是回傳一個空的**：回空的話，
 * 匯出的檔案裡少一段而沒有人知道，下一次有人「修好」它就漏出去了。
 * 丟例外會讓那條路在開發時就走不通。
 */
export function assertRubricExportable(rubric: RubricView | null): void {
  if (rubric && rubric.internalOnly) {
    throw new RubricError(
      `規準「${rubric.name}」標為內部使用（評分原則的描述文字受著作權保護，` +
        '授權範圍是機構內部閱卷），不能匯出或印在給學生的東西上。',
      403,
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// 寫
// ─────────────────────────────────────────────────────────────────

/**
 * 存一份規準（沒有就建，有就原地換內容）。
 *
 * @param questionId 規準掛在題目上。一題最多一份——`Rubric.questionId`
 *   沒有唯一鍵（schema 允許一份規準不掛任何題目，那是給整卷共用的
 *   情況預留的），所以這裡自己保證「一題一份」：查得到就更新那一份。
 *
 * 為什麼整批換掉面向與等第而不是逐筆比對：逐筆比對要處理「老師把
 * 第二個面向刪掉、又新增一個同名的」這種情況，而那需要一個穩定的
 * 對應鍵——面向沒有。整批換掉的代價是面向的 id 會變，而唯一在意
 * 面向 id 的地方是 `AnswerGradeProposal.dimensions` 裡的快照，
 * 那一份**本來就該是快照**（老師改了規準，舊建議記的仍然是舊面向）。
 */
export async function saveRubric(
  user: SessionUser,
  questionId: string,
  draft: RubricDraft,
): Promise<RubricView> {
  const tenantId = requireTenant();
  const q = await prisma.question.findFirst({
    where: { id: questionId },
    select: { id: true, subjectId: true, type: true, score: true },
  });
  if (!q) throw new RubricError('找不到這一題', 404);
  if (!(await mayGrade(user, q.subjectId))) {
    throw new RubricError('只有這一科的授課老師與管理員可以建評分規準', 403);
  }

  const check = checkRubricDraft(draft);
  if (!check.ok) throw new RubricError(check.errors.join('\n'), 400);

  const existing = await prisma.rubric.findFirst({
    where: { questionId },
    select: { id: true },
  });

  const head = {
    tenantId,
    questionId,
    name: draft.name.trim(),
    totalScore: draft.totalScore,
    mode: draft.mode,
    sourceRef: draft.sourceRef?.trim() || null,
    // **預設為真，而且不接受「因為老師沒勾」而變成 false。**
    // 只有明確傳 false 才會關掉，而畫面上那一格旁邊寫著後果。
    internalOnly: draft.internalOnly === false ? false : true,
  };

  const rubricId = existing
    ? (await prisma.rubric.update({ where: { id: existing.id }, data: head, select: { id: true } }))
        .id
    : (await prisma.rubric.create({ data: head, select: { id: true } })).id;

  if (existing) {
    // 等第先刪：它可能掛在面向上（`RubricBand.dimensionId`），
    // 反過來刪的話會撞到外鍵。
    await prisma.rubricBand.deleteMany({ where: { rubricId } });
    await prisma.rubricDimension.deleteMany({ where: { rubricId } });
  }

  const dimIdByName = new Map<string, string>();
  for (const [i, d] of draft.dimensions.entries()) {
    const created = await prisma.rubricDimension.create({
      data: {
        rubricId,
        name: d.name.trim(),
        nameEn: d.nameEn?.trim() || null,
        maxScore: d.maxScore,
        descriptor: d.descriptor?.trim() || null,
        order: d.order ?? i,
      },
      select: { id: true, name: true },
    });
    dimIdByName.set(created.name, created.id);
  }

  for (const [i, b] of draft.bands.entries()) {
    await prisma.rubricBand.create({
      data: {
        rubricId,
        dimensionId: b.dimensionName ? (dimIdByName.get(b.dimensionName.trim()) ?? null) : null,
        grade: b.grade.trim(),
        scoreMin: b.scoreMin,
        scoreMax: b.scoreMax,
        descriptor: b.descriptor.trim(),
        order: b.order ?? i,
      },
    });
  }

  await prisma.auditLog.create({
    data: {
      tenantId,
      category: 'QUESTION',
      action: existing ? 'rubric.update' : 'rubric.create',
      actorId: user.id,
      targetType: 'Question',
      targetId: questionId,
      after: {
        rubricId,
        name: head.name,
        totalScore: head.totalScore,
        mode: head.mode,
        internalOnly: head.internalOnly,
        dimensions: draft.dimensions.length,
        bands: draft.bands.length,
      } as Prisma.InputJsonValue,
      // 配分對不上要留痕。規準總分 25 而卷面配分 18 時，AI 的每一份
      // 建議都會在「超過配分」那一條被擋下，而錯的是這裡。
      metadata: { questionScore: q.score, questionType: q.type } as Prisma.InputJsonValue,
    },
  });

  const row = await prisma.rubric.findFirst({ where: { id: rubricId }, select: SELECT });
  if (!row) throw new RubricError('規準存好了但讀不回來，請重新載入', 500);
  return toView(row);
}

/**
 * 刪掉一份規準。
 *
 * **不連帶刪掉已經產生的建議。** 那些建議是「AI 當時照這份規準評出
 * 什麼」的紀錄，而採用率與誤差只算得出來在它們還在的時候。
 * 代價是 `rubricId` 會指向一個不存在的 id，所以呼叫端讀不到規準時
 * 要說「規準已刪除」而不是「沒有規準」。
 */
export async function deleteRubric(user: SessionUser, questionId: string): Promise<void> {
  const tenantId = requireTenant();
  const q = await prisma.question.findFirst({
    where: { id: questionId },
    select: { subjectId: true },
  });
  if (!q) throw new RubricError('找不到這一題', 404);
  if (!(await mayGrade(user, q.subjectId))) {
    throw new RubricError('只有這一科的授課老師與管理員可以刪評分規準', 403);
  }
  const existing = await prisma.rubric.findFirst({
    where: { questionId },
    select: { id: true, name: true },
  });
  if (!existing) return;

  await prisma.rubric.delete({ where: { id: existing.id } });
  await prisma.auditLog.create({
    data: {
      tenantId,
      category: 'QUESTION',
      action: 'rubric.delete',
      actorId: user.id,
      targetType: 'Question',
      targetId: questionId,
      before: { rubricId: existing.id, name: existing.name } as Prisma.InputJsonValue,
    },
  });
}
