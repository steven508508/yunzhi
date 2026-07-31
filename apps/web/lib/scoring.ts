/**
 * 計分與成績：把 `lib/grading.mjs` 接到資料庫上。
 *
 * # 這一層刻意很薄
 *
 * 所有會算錯的邏輯都在 `lib/grading.mjs`（純函式、有完整的單元測試）。
 * 這個檔案只做三件事：讀出來、丟給它算、寫回去。**新增的計分規則
 * 應該加在 grading.mjs 而不是這裡**——這裡沒有測試保護，因為它需要
 * 資料庫。
 *
 * # 重新計分只動計分欄位
 *
 * schema 的註解寫得很清楚：`answerKeys` 是學生選了什麼、`earnedScore`
 * 是它值幾分，兩者刻意分開存。老師改了標準答案或送分時只動後者，
 * **學生原本選了什麼永遠不變——那是申訴時唯一能拿出來的東西**。
 *
 * 所以這裡的每一次寫入都只碰 `isCorrect`、`earnedScore`、`scoreNote`
 * 這三欄。整份 upsert 或 `update({ data: answer })` 這種寫法會把
 * 作答內容一起蓋掉，而它只在「重跑」時出錯——第一次計分看起來完全正常。
 *
 * # 沒有作答記錄的題目不會被補一列
 *
 * 學生沒碰過的題目在 `attempt_answers` 裡沒有列。這裡不補——補了
 * 就等於在稽核上宣稱他在交卷三天後作答過。它的 0 分照樣算進總分
 * （`gradeAttempt` 以卷面題目為準，不是以作答記錄為準），
 * 班級統計也把它算成答錯。
 */
import type { Prisma } from '@prisma/client';

import { refreshAbilityAfterGrading, refreshAbilityForUser } from '@/lib/abilityDb';
import { resolveRecipients, type Recipient } from '@/lib/assignment';
import type { SessionUser } from '@/lib/auth';
import { attemptStranded } from '@/lib/attemptClock.mjs';
import { checkReason, checkUnvoid, checkVoid } from '@/lib/attemptVoid.mjs';
import {
  checkManualScore,
  countAnswered,
  isManualScore,
  manualScoreNote,
} from '@/lib/examOps.mjs';
import { notifyGradeChanged, notifyVoided } from '@/lib/notifyDb';
import { prisma } from '@/lib/prisma';
import { requireTenant } from '@/lib/tenant';
import { gradeAttempt, roundScore } from '@/lib/grading.mjs';
import { fullScoreFor, gsatLevels } from '@/lib/gsat.mjs';
import { maySeeGrades, subjectScope } from '@/lib/scope.mjs';

export type GradeResult = {
  attemptId: string;
  autoScore: number;
  totalScore: number;
  maxScore: number;
  /** 這次真的算出分數的題數 */
  gradedCount: number;
  /** 客觀題但資料有問題，要老師看一眼 */
  needsReview: number;
  /** 非選題，等人工或 AI 評分 */
  pendingManual: number;
  status: 'GRADED' | 'SUBMITTED';
  /** 與上一次計分相比，分數變了的題目（重新計分時老師最關心這個） */
  changed: { questionId: string; from: number | null; to: number | null }[];
};

type LayoutItem = {
  questionId: string;
  order?: number;
  score?: number;
  optionOrder?: number[];
  keysAreDisplayOrder?: boolean;
};

/**
 * 讀出這一份作答的題目清單。
 *
 * **優先用 `Attempt.layout` 的快照。** 它是學生開始作答時固定下來的
 * 題序與配分；老師在考試中改了卷子（加一題、改配分）不能影響
 * 已經開始的人。快照壞掉或還沒有時才退回卷子本身。
 */
function readLayout(raw: unknown): LayoutItem[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: LayoutItem[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') return null;
    const r = row as Record<string, unknown>;
    if (typeof r.questionId !== 'string' || !r.questionId) return null;
    out.push({
      questionId: r.questionId,
      order: typeof r.order === 'number' ? r.order : undefined,
      score: typeof r.score === 'number' ? r.score : undefined,
      optionOrder: Array.isArray(r.optionOrder)
        ? (r.optionOrder.filter((n) => typeof n === 'number') as number[])
        : undefined,
      keysAreDisplayOrder: r.keysAreDisplayOrder === true,
    });
  }
  return out;
}

/** 這一份作答屬於哪一科、哪一份任務。權限判斷要用。 */
export async function attemptTarget(attemptId: string) {
  const attempt = await prisma.attempt.findFirst({
    where: { id: attemptId },
    select: {
      id: true,
      status: true,
      userId: true,
      assignmentId: true,
      assignment: {
        select: {
          id: true,
          title: true,
          paper: { select: { id: true, subjectId: true, title: true } },
        },
      },
    },
  });
  if (!attempt) return null;
  return {
    attemptId: attempt.id,
    status: attempt.status,
    userId: attempt.userId,
    assignmentId: attempt.assignmentId,
    subjectId: attempt.assignment.paper.subjectId,
    paperTitle: attempt.assignment.paper.title,
    assignmentTitle: attempt.assignment.title,
  };
}

/**
 * 一份作答的自動計分。**可以重跑**（老師改了標準答案之後重新計分）。
 *
 * @param attemptId 要計分的作答
 * @param opts.actorId 誰按的。有值時寫一筆稽核。
 * @param opts.reason 為什麼重算。老師改了答案、送分、系統修正——
 *   這三件事在成績單上的意義完全不同，而事後只剩這一欄說得出來。
 * @param opts.audit 預設 true。整份任務重算時關掉，改寫一筆總的。
 */
export async function gradeAttemptById(
  attemptId: string,
  opts: { actorId?: string; reason?: string; audit?: boolean } = {},
): Promise<GradeResult> {
  const tenantId = requireTenant();

  const attempt = await prisma.attempt.findFirst({
    where: { id: attemptId },
    include: {
      answers: true,
      assignment: {
        select: {
          id: true,
          paperId: true,
          paper: {
            select: {
              subjectId: true,
              items: {
                select: { questionId: true, order: true, score: true },
                orderBy: { order: 'asc' },
              },
            },
          },
        },
      },
    },
  });
  if (!attempt) throw new Error('找不到這一份作答');

  // 作廢的不計分。誠信事件或系統故障作廢之後又被算出一個分數，
  // 那個分數會流進班級統計與能力分析，而沒有人記得它應該不存在。
  if (attempt.status === 'VOIDED') throw new Error('這一份作答已作廢，不計分');
  if (attempt.status === 'IN_PROGRESS') {
    throw new Error('這一份還在作答中，交卷後才計分');
  }

  const layout = readLayout(attempt.layout);
  const paperItems = attempt.assignment.paper.items;
  const source: LayoutItem[] =
    layout ??
    paperItems.map((i) => ({ questionId: i.questionId, order: i.order, score: i.score }));
  if (source.length === 0) throw new Error('這一份卷子沒有題目，無法計分');

  // 配分：快照優先，快照沒帶就用卷子上的（同一題在小考與模考的
  // 配分本來就不同，所以不能用題庫的預設配分）。
  const paperScore = new Map(paperItems.map((i) => [i.questionId, i.score]));

  const questions = await prisma.question.findMany({
    where: { id: { in: source.map((s) => s.questionId) } },
    select: {
      id: true,
      type: true,
      answerKeys: true,
      answerSlots: true,
      answerText: true,
      scoringRule: true,
      _count: { select: { options: true } },
    },
  });
  const byId = new Map(questions.map((q) => [q.id, q]));

  const items = source.map((s, i) => {
    const q = byId.get(s.questionId);
    return {
      questionId: s.questionId,
      order: s.order ?? i + 1,
      // 題目被刪掉（onDelete: Restrict 擋著，但版本切換有可能）時
      // type 是空字串，grading.mjs 會判成需人工確認而不是 0 分。
      type: q?.type ?? '',
      score: s.score ?? paperScore.get(s.questionId) ?? 0,
      correctKeys: q?.answerKeys ?? [],
      correctSlots: q?.answerSlots ?? null,
      correctText: q?.answerText ?? null,
      optionCount: q?._count.options ?? 0,
      scoringRule: (q?.scoringRule ?? null) as { mode?: string } | null,
      optionOrder: s.optionOrder,
      keysAreDisplayOrder: s.keysAreDisplayOrder === true,
    };
  });

  const answers = attempt.answers.map((a) => ({
    questionId: a.questionId,
    answerKeys: a.answerKeys,
    answerText: a.answerText,
    answerSlots: a.answerSlots,
  }));

  const graded = gradeAttempt(items, answers);

  // ── 寫回 ────────────────────────────────────────────────────
  const rowByQuestion = new Map(attempt.answers.map((a) => [a.questionId, a]));
  const changed: GradeResult['changed'] = [];
  const writes: Prisma.PrismaPromise<unknown>[] = [];

  /** 這次算不出分數、但已經有人給過分的題目。那些分數要留著並計入總分。 */
  let keptScore = 0;
  /** 還沒有人評的非選題。 */
  let pendingManual = 0;
  /** 還沒解決的「需人工確認」。已經有人給過分的就不算了。 */
  let unresolvedReview = 0;

  for (const r of graded.results) {
    const row = rowByQuestion.get(r.questionId);
    if (!row) continue; // 沒作答就沒有列可以更新，見檔頭

    // **老師手動給過分的題目，重算一律不碰。**
    //
    // 下面那一段只擋得住「這次算不出分數」的情況（非選題）。客觀題
    // 不一樣：自動計分每次都算得出一個分數，於是老師為了申訴手動改成
    // 4 分的那一題，會在下一次「全班重新計分」時無聲地變回 0 分——
    // 而重新計分是老師改完標準答案後一定會按的那顆按鈕。
    //
    // 記號在 `scoreNote` 的開頭（沒有欄位可以記，見 lib/examOps.mjs）。
    // 要回到自動計分，把人工分數收回去就好。
    if (isManualScore(row.scoreNote) && row.earnedScore !== null) {
      keptScore += row.earnedScore;
      continue;
    }

    if (r.earnedScore === null) {
      // 這次算不出分數：非選題，或客觀題但資料有問題。
      //
      // **「不確定」不可以蓋掉「有人確定過」。** 老師手動給過分的
      // 那一題，重新計分不該把它清成空的——那會讓一個已經處理完的
      // 個案在下一次重算時默默倒退，而且總分會少掉那幾分。
      if (row.earnedScore !== null) {
        keptScore += row.earnedScore;
        continue;
      }
      if (!r.autoGraded) pendingManual++;
      if (r.needsReview) unresolvedReview++;
    }

    if (row.earnedScore !== r.earnedScore) {
      changed.push({ questionId: r.questionId, from: row.earnedScore, to: r.earnedScore });
    }
    writes.push(
      prisma.attemptAnswer.update({
        where: { id: row.id },
        // **只有這三欄。** answerKeys / answerText / answerSlots 不在這裡。
        data: {
          isCorrect: r.isCorrect,
          earnedScore: r.earnedScore,
          scoreNote: r.scoreNote,
        },
      }),
    );
  }

  const totalScore = roundScore(graded.autoScore + keptScore);
  // **還有東西沒改完就不標成「已評分」。** 一份含作文的卷子只算完
  // 客觀題就標已評分，老師看到的是一份已完成的成績，
  // 然後那 25 分永遠不會被補上。
  const status: 'GRADED' | 'SUBMITTED' =
    pendingManual > 0 || unresolvedReview > 0 ? 'SUBMITTED' : 'GRADED';

  writes.push(
    prisma.attempt.update({
      where: { id: attempt.id },
      data: {
        autoScore: graded.autoScore,
        totalScore,
        gradedAt: new Date(),
        status,
      },
    }),
  );

  await prisma.$transaction(writes);

  // 能力快照。**這裡剛剛才知道每一題的對錯，所以順手更新。**
  //
  // 重算而不是累加，所以老師改標準答案、送分、人工給分之後，快照會
  // 跟著對——那三件事全部會走到這一行。
  //
  // `refreshAbilityAfterGrading` 自己吞掉所有例外（見 lib/abilityDb.ts），
  // 理由與 `lib/attempt.ts` 的 `gradeOnSubmit` 完全相同：**交卷與計分
  // 不能因為統計算不出來而失敗**。算不出快照的後果是能力分析少一格，
  // 而且下一次計分或整批重建就補回來了。
  await refreshAbilityAfterGrading(attempt.userId, source.map((s) => s.questionId));

  if (opts.audit !== false && opts.actorId) {
    await prisma.auditLog.create({
      data: {
        tenantId,
        category: 'GRADE',
        action: 'grade.recalculate',
        actorId: opts.actorId,
        targetType: 'Attempt',
        targetId: attempt.id,
        before: { autoScore: attempt.autoScore, totalScore: attempt.totalScore },
        after: { autoScore: graded.autoScore, totalScore, status },
        metadata: {
          reason: opts.reason ?? null,
          changed: changed.slice(0, 50),
          needsReview: unresolvedReview,
          pendingManual,
        } as Prisma.InputJsonValue,
      },
    });
  }

  return {
    attemptId: attempt.id,
    autoScore: graded.autoScore,
    totalScore,
    maxScore: graded.maxScore,
    gradedCount: graded.results.filter((r) => r.earnedScore !== null).length,
    needsReview: unresolvedReview,
    pendingManual,
    status,
    changed,
  };
}

/**
 * 整份任務重新計分。老師改了標準答案、或決定某一題送分之後跑這個。
 *
 * **一定會寫稽核。** 成績被整批改動而沒有記錄，日後家長問起
 * 「為什麼我小孩的分數變了」時，沒有人答得出來是誰在什麼時候
 * 因為什麼改的。這與單份重算不同——單份是老師在處理一件個案，
 * 整批是一個影響全班的決定。
 */
export async function regradeAssignment(
  assignmentId: string,
  opts: { actorId?: string; reason?: string } = {},
): Promise<{
  assignmentId: string;
  attempts: number;
  changedAttempts: number;
  needsReview: number;
  pendingManual: number;
  failures: { attemptId: string; error: string }[];
}> {
  const tenantId = requireTenant();

  const assignment = await prisma.assignment.findFirst({
    where: { id: assignmentId },
    select: { id: true, title: true },
  });
  if (!assignment) throw new Error('找不到這份任務');

  const attempts = await prisma.attempt.findMany({
    // 進行中的不重算（考試還沒結束），作廢的不重算。
    where: { assignmentId, status: { in: ['SUBMITTED', 'GRADED'] } },
    select: { id: true, userId: true, totalScore: true },
    orderBy: { startedAt: 'asc' },
  });

  const deltas: { attemptId: string; userId: string; from: number | null; to: number }[] = [];
  const failures: { attemptId: string; error: string }[] = [];
  let needsReview = 0;
  let pendingManual = 0;

  for (const a of attempts) {
    try {
      const r = await gradeAttemptById(a.id, { ...opts, audit: false });
      needsReview += r.needsReview;
      pendingManual += r.pendingManual;
      if (a.totalScore !== r.totalScore) {
        deltas.push({ attemptId: a.id, userId: a.userId, from: a.totalScore, to: r.totalScore });
      }
    } catch (e) {
      // 一份算不出來不該讓整批停住——那會變成「按了重新計分，
      // 前 12 個人算了、後 18 個人沒算」，而畫面上只有一句錯誤訊息。
      failures.push({ attemptId: a.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  await prisma.auditLog.create({
    data: {
      tenantId,
      category: 'GRADE',
      action: 'grade.regrade_assignment',
      actorId: opts.actorId ?? null,
      targetType: 'Assignment',
      targetId: assignmentId,
      after: {
        attempts: attempts.length,
        changedAttempts: deltas.length,
        needsReview,
        pendingManual,
        failures: failures.length,
      },
      metadata: {
        reason: opts.reason ?? null,
        // 分數變了的人全部列出來。這是稽核的重點，不截斷。
        deltas,
        failures: failures.slice(0, 20),
      } as Prisma.InputJsonValue,
    },
  });

  // **分數變了要讓學生知道。** 這裡改寫的是他已經看過的數字，而在
  // 這一行出現之前，他下一次自己點進去才會發現 78 變成 72——沒有
  // 任何線索說明為什麼，而重算頁上的確認視窗卻寫著「會立刻反映在
  // 他們自己看得到的成績上」。收件人怎麼算、放行前要不要送、
  // 文案吃哪幾個欄位，全部在 `lib/notifyDb.ts`；那一支自己吞掉所有
  // 例外，所以重算不會因為通知失敗而失敗。
  await notifyGradeChanged(assignmentId, {
    tenantId,
    title: assignment.title,
    changed: deltas.map((d) => ({ userId: d.userId, from: d.from })),
  });

  return {
    assignmentId,
    attempts: attempts.length,
    changedAttempts: deltas.length,
    needsReview,
    pendingManual,
    failures,
  };
}

// ─────────────────────────────────────────────────────────────
// 逐題人工給分
// ─────────────────────────────────────────────────────────────

export type ManualScoreResult = {
  attemptId: string;
  questionId: string;
  earnedScore: number | null;
  totalScore: number | null;
  status: string;
};

/**
 * 老師手動給一題的分數。
 *
 * # 這一支補的是一個資料層早就準備好、但沒有入口的功能
 *
 * `gradeAttemptById` 一直保留著「有人手動給過分就不覆蓋」的路徑，
 * 而**全系統沒有任何 API 或畫面寫得進那個值**。所以一份含作文的卷子
 * 永遠停在 SUBMITTED、「未計分」那一欄永遠是一個數字；而客觀題的
 * 個案（申訴成立、答案有爭議）也只能整題送分或不處理。
 *
 * # 三件刻意的事
 *
 * **一、只動 `earnedScore` / `isCorrect` / `scoreNote`。** 學生選了什麼
 * 永遠不變——那是申訴時唯一能拿出來的東西。
 *
 * **二、記號寫在 `scoreNote` 的開頭。** 沒有欄位可以記「這個分數是人
 * 給的」（不加遷移），而少了這個記號，下一次「全班重新計分」會把它
 * 蓋回自動計分的結果。見 `lib/examOps.mjs`。
 *
 * **三、給完之後整份重算一次。** 總分要跟著動，狀態也要（非選題改完
 * 之後那一份才從「待評分」變成「已評分」）。重算會讀到剛寫進去的記號，
 * 所以不會把這一題洗掉。
 *
 * @param score `null` 代表收回人工分數，讓這一題回到自動計分。
 */
export async function setManualScore(
  attemptId: string,
  questionId: string,
  opts: { score: number | null; note?: string | null; actorId: string },
): Promise<ManualScoreResult> {
  const tenantId = requireTenant();

  const attempt = await prisma.attempt.findFirst({
    where: { id: attemptId },
    select: {
      id: true,
      status: true,
      layout: true,
      assignmentId: true,
      assignment: {
        select: {
          paper: { select: { items: { select: { questionId: true, score: true } } } },
        },
      },
    },
  });
  if (!attempt) throw new Error('找不到這一份作答');
  if (attempt.status === 'IN_PROGRESS') {
    throw new Error('這一份還在作答中。學生還在寫的時候給分，他之後寫的答案會與分數對不起來。');
  }
  if (attempt.status === 'VOIDED') {
    throw new Error('這一份已經作廢，不計分。要給分請先撤銷作廢。');
  }

  // 配分**以版面快照為準**，與計分同一個口徑：老師在考試之後改了
  // 卷子上的配分，這位學生當時看到的仍然是舊的那個數字。
  const layout = readLayout(attempt.layout);
  const fromPaper = new Map(
    attempt.assignment.paper.items.map((i) => [i.questionId, i.score] as const),
  );
  const max =
    layout?.find((i) => i.questionId === questionId)?.score ?? fromPaper.get(questionId) ?? null;
  if (max === null) throw new Error('這一題不在這份考卷上');

  const valid = checkManualScore(opts.score, max);
  if (!valid.ok) throw new Error(valid.error);

  const row = await prisma.attemptAnswer.findFirst({
    where: { attemptId, questionId },
    select: { id: true, earnedScore: true, scoreNote: true },
  });
  if (!row) {
    // 沒有作答記錄就沒有列可以掛分數。**不憑空補一列**——那等於在
    // 稽核上宣稱他在交卷之後作答過。空白卷要給分請用「全班送分」。
    throw new Error(
      '這位學生這一題沒有作答記錄，給不了分數。' +
        '整題都要給分（含空白）請用各題答對率那張表上的「送分」。',
    );
  }

  await prisma.attemptAnswer.update({
    where: { id: row.id },
    data:
      valid.score === null
        ? { earnedScore: null, isCorrect: null, scoreNote: null }
        : {
            earnedScore: valid.score,
            // 滿分才算「答對」。部分給分的那幾題在答對率上就該算沒答對，
            // 否則各題答對率會被人工分數灌水。
            isCorrect: valid.score >= max,
            scoreNote: manualScoreNote(opts.note ?? null),
          },
  });

  await prisma.auditLog.create({
    data: {
      tenantId,
      category: 'GRADE',
      action: 'grade.manual_score',
      actorId: opts.actorId,
      targetType: 'Attempt',
      targetId: attemptId,
      before: { questionId, earnedScore: row.earnedScore, scoreNote: row.scoreNote },
      after: { questionId, earnedScore: valid.score },
      metadata: { note: opts.note ?? null, maxScore: max } as Prisma.InputJsonValue,
    },
  });

  // 重算總分與狀態。人工分數自己帶著記號，所以這一次重算不會把它洗掉。
  const re = await gradeAttemptById(attemptId, {
    actorId: opts.actorId,
    reason: '人工給分後重算總分',
    audit: false,
  });

  return {
    attemptId,
    questionId,
    earnedScore: valid.score,
    totalScore: re.totalScore,
    status: re.status,
  };
}

// ─────────────────────────────────────────────────────────────
// 作廢
// ─────────────────────────────────────────────────────────────

export type VoidResult = {
  attemptId: string;
  displayName: string;
  status: string;
};

/**
 * 作廢一份作答。誠信事件（抓到作弊）或系統故障（斷電毀掉一份卷子）。
 *
 * # 為什麼稽核分類是 GRADE，不是 SECURITY 也不是 EXAM
 *
 * 作廢的原因有兩種：誠信事件（schema 上屬於 SECURITY）與系統故障
 * （比較接近 EXAM 的「場次作廢」）。照原因分類的話，「查這個學生的
 * 成績出過什麼事」要翻兩個分類，而翻的人只會翻其中一個然後說沒有
 * 記錄。**而家長申訴時問的永遠是成績**——那條時間線要與重新計分、
 * 整批重算放在一起才讀得懂。誠信與否寫在 `reason` 裡。
 *
 * # 為什麼不順手把分數清成 null
 *
 * 因為分數是證據。作廢的意思是「這一份不算數」，不是「這件事沒發生
 * 過」——申訴成立而撤銷作廢時，原本的分數要還在。不計分是靠狀態
 * 達成的：`classStats` 只查 SUBMITTED / GRADED，`gradeAttemptById`
 * 直接拒絕，`startAttempt` 不把它算進次數，`maySeeResult` 給學生
 * 一句人話。**這四道原本就都寫好了，缺的只是有人把狀態改成 VOIDED。**
 */
export async function voidAttempt(
  attemptId: string,
  opts: { actorId: string; reason: string },
): Promise<VoidResult> {
  const tenantId = requireTenant();

  const attempt = await prisma.attempt.findFirst({
    where: { id: attemptId },
    select: {
      id: true,
      status: true,
      submittedAt: true,
      totalScore: true,
      autoScore: true,
      assignmentId: true,
      user: { select: { id: true, username: true, displayName: true } },
    },
  });
  if (!attempt) throw new Error('找不到這一份作答');

  // 理由與狀態轉移的合法性都在純函式裡判（lib/attemptVoid.mjs，有測試）。
  // 寫在這裡的話，路由、畫面與寫入前這三處會各判一次而且遲早不一致。
  const reason = checkReason(opts.reason);
  if (!reason.ok) throw new Error(reason.error);
  const allowed = checkVoid(attempt);
  if (!allowed.ok) throw new Error(allowed.error);

  await prisma.attempt.update({
    where: { id: attempt.id },
    data: { status: 'VOIDED' },
  });

  await prisma.auditLog.create({
    data: {
      tenantId,
      category: 'GRADE',
      action: 'grade.void_attempt',
      actorId: opts.actorId,
      targetType: 'Attempt',
      targetId: attempt.id,
      // 作廢前的狀態與分數一定要留：撤銷時要拿它對照，而家長問
      // 「原本考幾分」時，這是唯一還說得出來的地方。
      before: { status: attempt.status, totalScore: attempt.totalScore, autoScore: attempt.autoScore },
      after: { status: 'VOIDED' },
      metadata: {
        reason: reason.reason,
        assignmentId: attempt.assignmentId,
        student: attempt.user.username,
      } as Prisma.InputJsonValue,
    },
  });

  // **作廢的作答不能留在能力分析裡。** `refreshAbility` 只讀
  // SUBMITTED / GRADED 的作答，所以狀態改成 VOIDED 之後重算一次，
  // 那一份的每一題就從掌握度裡退出去了。
  //
  // 不做的話，一份因為作弊而作廢的滿分卷會繼續把掌握度撐高，而畫面上
  // 那是一個看起來完全正常的數字——分數已經抽掉了，能力分析沒有。
  // 一樣吞掉錯誤：作廢本身已經成功，不能被統計拖回去。
  await refreshAbilityForUser(attempt.user.id);

  // **學生必須知道這一份不算數了**，而且不能從一個 0 分自己猜。
  // 在此之前他唯一的線索是檢討頁那一句（`lib/release.mjs` 的 VOIDED
  // 分支）——而那要他自己點進去才看得到，成績單上那一格是空的。
  //
  // 通知裡**不含 `reason`**：作廢的原因有誠信事件與系統故障兩種，
  // 系統分不出來，而猜錯的方向是指控一個沒有作弊的孩子。詳見
  // `lib/notifyDb.ts` 的 `notifyVoided`。這一則是必收的（關不掉）。
  await notifyVoided(
    attempt.id,
    { tenantId, recipientId: attempt.user.id, assignmentId: attempt.assignmentId },
    true,
  );

  return { attemptId: attempt.id, displayName: attempt.user.displayName, status: 'VOIDED' };
}

/**
 * 撤銷作廢：誤判，或申訴成立。
 *
 * 還原成哪一個狀態由 `restoreStatus` 決定（見 lib/attemptVoid.mjs 的
 * 註解：交過卷的一律回 SUBMITTED 而不是 GRADED，因為猜錯的代價
 * 不對稱）。所以撤銷完成績頁上那一列會顯示「待評分」——**那不是
 * 缺陷，那是在說「這個分數需要你按一次重新計分來確認」**。
 *
 * 一樣要填理由。撤銷一個作廢與作廢本身同樣會被質疑：家長問的是
 * 「為什麼別人的作廢了、我小孩的又救回來」，而那一句只能從這裡拿。
 */
export async function unvoidAttempt(
  attemptId: string,
  opts: { actorId: string; reason: string },
): Promise<VoidResult> {
  const tenantId = requireTenant();

  const attempt = await prisma.attempt.findFirst({
    where: { id: attemptId },
    select: {
      id: true,
      status: true,
      submittedAt: true,
      totalScore: true,
      assignmentId: true,
      user: { select: { id: true, username: true, displayName: true } },
    },
  });
  if (!attempt) throw new Error('找不到這一份作答');

  const reason = checkReason(opts.reason);
  if (!reason.ok) throw new Error(reason.error);
  const allowed = checkUnvoid(attempt);
  if (!allowed.ok) throw new Error(allowed.error);

  await prisma.attempt.update({
    where: { id: attempt.id },
    data: { status: allowed.status },
  });

  await prisma.auditLog.create({
    data: {
      tenantId,
      category: 'GRADE',
      action: 'grade.unvoid_attempt',
      actorId: opts.actorId,
      targetType: 'Attempt',
      targetId: attempt.id,
      before: { status: 'VOIDED' },
      after: { status: allowed.status, totalScore: attempt.totalScore },
      metadata: {
        reason: reason.reason,
        assignmentId: attempt.assignmentId,
        student: attempt.user.username,
      } as Prisma.InputJsonValue,
    },
  });

  // 撤銷作廢：那一份又算數了，掌握度要把它加回去。與作廢同一支。
  await refreshAbilityForUser(attempt.user.id);

  // 恢復也要通知，而且理由與作廢完全一樣。少了這一則，一個被誤判的
  // 學生會永遠停在「我的卷子不算數」——他收到過作廢那一則，
  // 而恢復沒有任何人告訴他。同樣是必收的。
  await notifyVoided(
    attempt.id,
    { tenantId, recipientId: attempt.user.id, assignmentId: attempt.assignmentId },
    false,
  );

  return { attemptId: attempt.id, displayName: attempt.user.displayName, status: allowed.status };
}

// ─────────────────────────────────────────────────────────────
// 班級統計
// ─────────────────────────────────────────────────────────────

export type QuestionStat = {
  questionId: string;
  order: number;
  type: string;
  score: number;
  /** 有作答記錄的人數（未作答不算） */
  answered: number;
  /** 判定為答對的人數 */
  correct: number;
  /** 答對率。**未作答計為答錯**——老師問的是「這題全班多少人會」。 */
  correctRate: number | null;
  /** 平均得分率。多選部分給分時它與答對率差很多，而那個差就是資訊。 */
  earnedRate: number | null;
  needsReview: number;
};

export type ClassStats = {
  assignmentId: string;
  title: string;
  paperTitle: string;
  subject: { id: string; code: string; name: string; gsatFullScore: number | null };
  maxScore: number;
  /** 已交卷（含已評分）的份數 */
  submitted: number;
  graded: number;
  /** 交了但還沒有分數的份數。有值代表要按重新計分。 */
  ungraded: number;
  mean: number | null;
  median: number | null;
  max: number | null;
  min: number | null;
  /**
   * 應交人數。**來自 `resolveRecipients`，不是從作答記錄反推的。**
   *
   * 沒有它的話，一位從來沒有按下「開始作答」的學生在這一頁的每一塊裡
   * 都不存在——不在全班表、不在未完成、不在已作廢——而老師唯一
   * 察覺得到的是交卷人數少一個。少的那一個是誰，畫面上一個字都沒有。
   */
  expected: number;
  /** 名單上但連考卷都沒打開的人。**那是老師當下要打電話的名單。** */
  missing: Recipient[];
  scores: { attemptId: string; userId: string; displayName: string; username: string;
    status: string; totalScore: number | null; autoScore: number | null;
    needsReview: number; percentile: number | null; level: number | null; late: boolean;
    /** 交卷時刻。家長問「我孩子說他寫了」時，這是第一個要拿出來的東西。 */
    submittedAt: Date | null }[];
  questions: QuestionStat[];
  /** 級分換算（含小樣本的三種策略） */
  gsat: ReturnType<typeof gsatLevels>;
  /**
   * 開了但還沒交的作答。**沒有這一份清單的話，這些人在成績頁上
   * 完全不存在**——上面每一個統計都只算 SUBMITTED / GRADED，
   * 所以一個寫到一半就斷線的學生，看起來與從來沒點開考卷的人
   * 一模一樣。老師唯一會注意到的是交卷人數少一個，而少的那一個
   * 是誰、為什麼少，畫面上沒有任何線索。
   */
  unfinished: UnfinishedAttempt[];
  /**
   * 已作廢的作答。
   *
   * **不查它的話，作廢就是一條單行道。** 上面每一個統計都只算
   * SUBMITTED / GRADED / IN_PROGRESS，所以一份被作廢的作答會從這一頁
   * 上完全消失——連同「撤銷作廢」那顆按鈕。誤判的那一次就永遠救不回來，
   * 而老師看到的是一個從班上消失的學生。
   */
  voided: VoidedAttempt[];
};

export type VoidedAttempt = {
  attemptId: string;
  userId: string;
  displayName: string;
  username: string;
  /** 作廢前交過卷沒有。撤銷之後會回到哪個狀態靠它決定（見 attemptVoid.mjs）。 */
  submittedAt: Date | null;
  /** 作廢時保留下來的分數。撤銷之後它會原封不動回到統計裡。 */
  totalScore: number | null;
};

export type UnfinishedAttempt = {
  attemptId: string;
  userId: string;
  displayName: string;
  username: string;
  startedAt: Date;
  expiresAt: Date | null;
  /**
   * 時間已經到了卻還掛在進行中——寫不進去、也交不出來的那一種。
   * false 代表這個人現在真的還在考，放著就好。
   */
  stranded: boolean;
  /** 已經寫了幾題。老師要靠它判斷「這一份收出來有沒有意義」。 */
  answered: number;
};

/**
 * 全班的成績統計。
 *
 * **各題答對率是老師最常看的東西**，所以它算的是「全班有多少人會
 * 這一題」，而不是「有作答的人裡有多少人答對」——沒作答的人也是
 * 不會，把他們排除掉會讓最難的題目看起來反而簡單。
 */
export async function classStats(assignmentId: string): Promise<ClassStats> {
  const assignment = await prisma.assignment.findFirst({
    where: { id: assignmentId },
    select: {
      id: true,
      title: true,
      // 「卡住了沒」不能只看 `expiresAt`：一份沒設時限的作答，在任務
      // 截止而且不收遲交之後就再也不會有人來交它。首頁的待辦本來就是
      // 這樣算的，這一頁不跟著算的話，同一份作答在兩個畫面上一個算
      // 卡住、一個顯示「還在作答時間內」而且沒有代為結算鈕。
      dueAt: true,
      allowLate: true,
      paper: {
        select: {
          title: true,
          totalScore: true,
          subject: { select: { id: true, code: true, name: true, gsatFullScore: true, parentCode: true } },
          items: {
            select: {
              questionId: true,
              order: true,
              score: true,
              question: { select: { type: true } },
            },
            orderBy: { order: 'asc' },
          },
        },
      },
    },
  });
  if (!assignment) throw new Error('找不到這份任務');

  // 「這份任務派給了誰」與「誰動過」是兩份完全不同的資料，而這一頁
  // 一直只有後者。應交人數要從名單來——見 `ClassStats.expected`。
  const recipients = await resolveRecipients(assignmentId);

  const attempts = await prisma.attempt.findMany({
    // 老師派給自己試考的那一份不算成績（`systemRole` 不是 STUDENT）。
    // 混進來的話全班平均會被一份老師的滿分卷拉高，而那個數字看起來
    // 完全正常。試考的那幾份在任務內頁上單獨列出來。
    where: {
      assignmentId,
      status: { in: ['SUBMITTED', 'GRADED'] },
      user: { systemRole: 'STUDENT' },
    },
    select: {
      id: true,
      userId: true,
      status: true,
      totalScore: true,
      autoScore: true,
      late: true,
      submittedAt: true,
      user: { select: { displayName: true, username: true } },
      answers: {
        select: { questionId: true, isCorrect: true, earnedScore: true, scoreNote: true },
      },
    },
  });

  // 另外一次查詢而不是把 IN_PROGRESS 併進上面那一句：上面每一段統計
  // 都假設 `attempts` 裡的每一份都交過卷（答對率的分母、平均、級分）。
  // 混進沒交的那幾份，全班平均會被一份空白卷拉下來，而那個數字看起來
  // 完全正常。
  const openAttempts = await prisma.attempt.findMany({
    // **這一塊不濾掉老師的試考，上面那一句濾掉。**
    //
    // 差別在於它們是兩種東西：上面是統計（平均、答對率、級分），
    // 一份老師的滿分卷混進去會把數字拉高；這一塊是**待辦**——
    // 「還有誰掛在進行中」。老師自己開了考卷看一眼就關掉的那一份
    // 也會卡住，而首頁的待辦本來就把它算進去。這裡濾掉的話，
    // 首頁說「1 份卡在進行中」而點進來一份都沒有，那是一條死路。
    where: { assignmentId, status: 'IN_PROGRESS' },
    select: {
      id: true,
      userId: true,
      status: true,
      startedAt: true,
      expiresAt: true,
      user: { select: { displayName: true, username: true } },
      // **不是 `_count.answers`。** 那是 `attempt_answers` 的列數，而
      // 有列不代表有答案：按了「標記待複查」會 upsert 一列空的，
      // 點了選項又點一次取消也會把 answerKeys 覆蓋成空。25 題的卷子
      // 標了 5 題、清掉 2 題，老師看到「已作答 18/25」而學生自己畫面上
      // 是 11——而老師會照著那個數字決定要不要讓他繼續寫。
      answers: { select: { answerKeys: true, answerText: true, answerSlots: true } },
    },
    orderBy: { startedAt: 'asc' },
  });

  // 第三次查詢，理由與上面那一段一樣：作廢的一份都不能混進統計，
  // 但它必須在畫面上看得見——看不見就撤銷不了（見 ClassStats.voided）。
  const voidedRows = await prisma.attempt.findMany({
    where: { assignmentId, status: 'VOIDED' },
    select: {
      id: true,
      userId: true,
      submittedAt: true,
      totalScore: true,
      user: { select: { displayName: true, username: true } },
    },
    orderBy: { startedAt: 'asc' },
  });
  const voided: VoidedAttempt[] = voidedRows.map((a) => ({
    attemptId: a.id,
    userId: a.userId,
    displayName: a.user.displayName,
    username: a.user.username,
    submittedAt: a.submittedAt,
    totalScore: a.totalScore,
  }));

  const now = new Date();
  const clockCtx = { dueAt: assignment.dueAt, allowLate: assignment.allowLate };
  const unfinished: UnfinishedAttempt[] = openAttempts.map((a) => ({
    attemptId: a.id,
    userId: a.userId,
    displayName: a.user.displayName,
    username: a.user.username,
    startedAt: a.startedAt,
    expiresAt: a.expiresAt,
    stranded: attemptStranded({ ...a, assignment: clockCtx }, now),
    answered: countAnswered(a.answers),
  }));

  const items = assignment.paper.items;
  const maxScore = roundScore(items.reduce((s, i) => s + i.score, 0));

  // ── 各題 ────────────────────────────────────────────────────
  const stat = new Map<string, QuestionStat>();
  for (const [i, it] of items.entries()) {
    stat.set(it.questionId, {
      questionId: it.questionId,
      order: it.order ?? i + 1,
      type: it.question.type,
      score: it.score,
      answered: 0,
      correct: 0,
      correctRate: null,
      earnedRate: null,
      needsReview: 0,
    });
  }
  const earnedSum = new Map<string, number>();
  for (const a of attempts) {
    for (const ans of a.answers) {
      const s = stat.get(ans.questionId);
      // 卷子在作答之後被改過，這一題已經不在卷面上。它的作答記錄
      // 留著（那是學生真的寫過的東西），但不進統計——否則分母
      // 會包含一道現在的學生根本沒看到的題目。
      if (!s) continue;
      s.answered++;
      if (ans.isCorrect === true) s.correct++;
      if (ans.isCorrect === null && ans.earnedScore === null) s.needsReview++;
      earnedSum.set(ans.questionId, (earnedSum.get(ans.questionId) ?? 0) + (ans.earnedScore ?? 0));
    }
  }
  const denominator = attempts.length;
  for (const s of stat.values()) {
    if (denominator === 0) continue;
    s.correctRate = Math.round((s.correct / denominator) * 1000) / 10;
    s.earnedRate =
      s.score > 0
        ? Math.round(((earnedSum.get(s.questionId) ?? 0) / (denominator * s.score)) * 1000) / 10
        : null;
  }

  // ── 全班 ────────────────────────────────────────────────────
  const scored = attempts.filter((a) => a.totalScore !== null);
  const totals = scored.map((a) => a.totalScore as number).sort((x, y) => x - y);
  const mean = totals.length ? roundScore(totals.reduce((x, y) => x + y, 0) / totals.length) : null;
  const median = totals.length
    ? roundScore(
        totals.length % 2
          ? totals[(totals.length - 1) / 2]
          : (totals[totals.length / 2 - 1] + totals[totals.length / 2]) / 2,
      )
    : null;

  const gsat = gsatLevels(totals);
  const levelOf = new Map<number, number | null>();
  if (gsat.levels) for (const l of gsat.levels) levelOf.set(l.score, l.level);
  const percentileOfScore = new Map<number, number | null>();
  if (gsat.levels) for (const l of gsat.levels) percentileOfScore.set(l.score, l.percentile);

  const scores = attempts
    .map((a) => ({
      attemptId: a.id,
      userId: a.userId,
      displayName: a.user.displayName,
      username: a.user.username,
      status: a.status as string,
      totalScore: a.totalScore,
      autoScore: a.autoScore,
      late: a.late,
      submittedAt: a.submittedAt,
      needsReview: a.answers.filter((x) => x.isCorrect === null && x.earnedScore === null).length,
      percentile: a.totalScore === null ? null : percentileOfScore.get(a.totalScore) ?? null,
      level: a.totalScore === null ? null : levelOf.get(a.totalScore) ?? null,
    }))
    .sort((x, y) => (y.totalScore ?? -1) - (x.totalScore ?? -1));

  return {
    assignmentId,
    title: assignment.title,
    paperTitle: assignment.paper.title,
    subject: {
      id: assignment.paper.subject.id,
      code: assignment.paper.subject.code,
      name: assignment.paper.subject.name,
      gsatFullScore: fullScoreFor(assignment.paper.subject),
    },
    maxScore,
    expected: recipients.length,
    // 「沒有開始作答」＝ 名單上有他，但一份 attempt 都沒有（含作廢的：
    // 作廢過的人動過這份考卷，把他列進催繳名單是錯的）。
    missing: (() => {
      const touched = new Set([
        ...attempts.map((a) => a.userId),
        ...openAttempts.map((a) => a.userId),
        ...voidedRows.map((a) => a.userId),
      ]);
      return recipients.filter((r) => !touched.has(r.userId));
    })(),
    submitted: attempts.length,
    graded: attempts.filter((a) => a.status === 'GRADED').length,
    ungraded: attempts.filter((a) => a.totalScore === null).length,
    mean,
    median,
    max: totals.length ? totals[totals.length - 1] : null,
    min: totals.length ? totals[0] : null,
    scores,
    questions: [...stat.values()].sort((a, b) => a.order - b.order),
    gsat,
    unfinished,
    voided,
  };
}

/**
 * 這個人教哪幾科。`null` 代表「不受科目限制」。
 *
 * 抽出來的唯一理由是**下面三支必須是同一條規則**：能不能改分數、
 * 看不看得到某一份的成績、列表上列出哪幾份。三支各查一次
 * `class_subject_teachers` 的話，日後只要有人改了其中一支的條件
 * （例如加上「離職的老師不算」），另外兩支就安靜地與它不一致——
 * 而不一致的方向若是「列表看不到、內頁看得到」，那就是一個漏洞。
 *
 * 對外開放是為了**一次算完一整頁**。任務列表要對每一列決定「這個人
 * 動不動得了它」，逐列呼叫 `canEditSubject` 是一頁一百次查詢；
 * 而不畫按鈕與畫了按鈕按下去才被拒絕，對老師是兩件事——後者他會
 * 以為是系統壞了。**這裡放寬只影響畫不畫按鈕，真正的擋在路由上。**
 */
export async function teachingSubjectIds(user: SessionUser): Promise<string[] | null> {
  // 角色本身的判定（誰不受限制、認不得的角色算什麼）在 lib/scope.mjs，
  // 那裡有測試。這一支只負責把「他實際教哪幾科」查出來。
  if (subjectScope(user.systemRole, []) === null) return null;
  const rows = await prisma.classSubjectTeacher.findMany({
    where: { userId: user.id },
    select: { subjectId: true },
    distinct: ['subjectId'],
  });
  return subjectScope(user.systemRole, rows.map((r) => r.subjectId));
}

/**
 * 這個人能不能改這一份作答的分數。
 *
 * 學生不行——連自己的都不行。「重新計分」在學生手上等於
 * 「一直按到分數變高為止」，而它會寫稽核、會動班級統計。
 */
export async function mayGrade(user: SessionUser, subjectId: string): Promise<boolean> {
  const mine = await teachingSubjectIds(user);
  return mine === null || mine.includes(subjectId);
}

/**
 * 這個人**看得到**這一份任務的成績嗎。
 *
 * 比 `mayGrade` 多一種人：**自己派出去的任務**。導師派一份跨科的
 * 小考時他不是那一科的授課老師，但那是他發出去的東西——看不到
 * 自己派出去的任務的結果沒有道理。這一條與列表頁的範圍一致
 * （見 `gradeScopeWhere`）。
 *
 * **列表濾掉不等於內頁擋住。** 這是這一類漏洞最常見的形狀：
 * 導覽上看不到、列表上也不列，但把網址列的 id 換成別科的任務就
 * 看得到那一班每一位學生的姓名、學號與分數。
 */
export async function mayViewGrades(
  user: SessionUser,
  assignment: { subjectId: string; createdBy: string | null },
): Promise<boolean> {
  return maySeeGrades(await teachingSubjectIds(user), user.id, assignment);
}

/**
 * 成績列表看得到哪幾份任務——直接餵給 `prisma.assignment.findMany` 的
 * `where`。與 `mayViewGrades` 是同一條規則的兩種形狀，共用
 * `teachingSubjectIds` 是為了讓它們不可能分岐。
 */
export async function gradeScopeWhere(user: SessionUser): Promise<Prisma.AssignmentWhereInput> {
  const mine = await teachingSubjectIds(user);
  if (mine === null) return {};
  return { OR: [{ paper: { subjectId: { in: mine } } }, { createdBy: user.id }] };
}
