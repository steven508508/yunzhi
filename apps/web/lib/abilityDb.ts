/**
 * 能力分析的資料層：把 `lib/ability.mjs` 的公式接到資料庫上。
 *
 * # 為什麼檔名不是 ability.ts
 *
 * 因為同一個資料夾裡已經有 `ability.mjs`，而 **tsc 與 webpack 對
 * `@/lib/ability` 的解析順序相反**：TypeScript 先找 `.ts`，Next 的
 * webpack 先找 `.mjs`（`resolve.extensions` 是 `['.js','.mjs','.tsx','.ts',…]`）。
 *
 * 兩份實作的症狀非常難查：`npx tsc --noEmit` 全綠、`next build` 只印一行
 * 「Attempted import error」然後**照樣 exit 0**，而頁面在瀏覽器上炸在
 * 「xxx is not a function」。所以這裡直接換一個不會撞的檔名。
 *
 * # 這一層補的是一個「資料早就在了，只是沒有人把它們接起來」的缺口
 *
 * `AttemptAnswer.isCorrect` 逐題記著、`QuestionKnowledgePoint` 在入庫時
 * 就標好了、`KnowledgePoint.decayRate` 與 `KpPrerequisite` 也都在——
 * 而在這個檔案之前，**全 repo 沒有任何一個查詢同時碰 `attempt_answers`
 * 與 `question_knowledge_points`**。班級頁與學生頁上那兩句「還給不出
 * 章節分析」講的就是這件事。
 *
 * # 這一層刻意很薄
 *
 * 會算錯的東西全部在 `lib/ability.mjs`（純函式、有完整單元測試）。
 * 這裡只做三件事：讀出來、丟給它算、寫回去。**新的規則要加在
 * ability.mjs 而不是這裡**——這裡沒有測試保護，因為它需要資料庫。
 *
 * 更重要的是：讀寫的那一段（`refreshAbility`）本身也在 ability.mjs，
 * 由呼叫端把 client 傳進去。網頁端、整批重算腳本、端到端測試因此跑的
 * 是同一段程式。各寫一份的話，「交卷後逐次更新」與「整批重建」會算出
 * 不同的快照，而那時沒有人知道哪一個是對的。
 *
 * # 失敗一律吞掉
 *
 * 快照更新掛在計分之後，而**計分絕對不能被統計拖下水**（理由與
 * `lib/attempt.ts` 的 `gradeOnSubmit` 完全相同）。算不出快照的後果是
 * 能力分析少一格，看得見也補得回來；計分失敗的後果是學生看到錯誤畫面、
 * 以為沒交成功。
 */
import { prisma } from '@/lib/prisma';
import {
  MIN_CLASS_SAMPLE,
  SOLID,
  WEAK,
  classWeakness,
  knowledgePointsOfQuestions,
  nextStep,
  rebuildAbility,
  refreshAbility,
  typeBreakdown,
  weakestFirst,
} from '@/lib/ability.mjs';
import { requireTenant } from '@/lib/tenant';

export { MIN_CLASS_SAMPLE, SOLID, WEAK };

// ─────────────────────────────────────────────────────────────────
// 寫：快照更新
// ─────────────────────────────────────────────────────────────────

/**
 * 計分完成之後順手更新快照。**永遠不丟例外。**
 *
 * 只重算這份卷子碰到的知識點：一份數學卷子不該讓這位學生的物理快照
 * 也跑一次。但**證據取自他的全部作答**，不只這一份——否則掌握度會
 * 在每次交卷後被最後一份卷子覆蓋，一次考壞就等於前面全部歸零。
 *
 * @param userId 這一份作答是誰的
 * @param questionIds 這份卷子上的題目
 */
export async function refreshAbilityAfterGrading(
  userId: string,
  questionIds: string[],
): Promise<void> {
  try {
    const tenantId = requireTenant();
    const kpIds = await knowledgePointsOfQuestions(prisma, questionIds);
    // 一題都沒標知識點——上線初期的常態，不是錯誤，不必寫日誌。
    if (kpIds.length === 0) return;
    await refreshAbility(prisma, { tenantId, userId, knowledgePointIds: kpIds });
  } catch (e) {
    console.error('[ability] 計分後更新能力快照失敗，這位學生的分析會停在上一次', userId, e);
  }
}

/**
 * 重算一位學生的全部快照。**永遠不丟例外。**
 *
 * 作廢與撤銷作廢之後要跑這一支而不是上面那一支：作廢的是整份作答，
 * 而「這份作答碰到哪些知識點」在狀態已經改掉之後還要再查一次卷子。
 * 全部重算是幾十毫秒的事，而作廢一學期只發生幾次。
 */
export async function refreshAbilityForUser(userId: string): Promise<void> {
  try {
    const tenantId = requireTenant();
    await refreshAbility(prisma, { tenantId, userId, knowledgePointIds: null });
  } catch (e) {
    console.error('[ability] 重算能力快照失敗', userId, e);
  }
}

export type RebuildResult = {
  users: number;
  points: number;
  removed: number;
  failures: { userId: string; error: string }[];
};

/**
 * 整批重建。第一次上線時快照是空的，這是把既有作答補回來的路徑。
 *
 * 與逐次更新走同一支 `refreshAbility`，差別只在範圍不限定。
 * **兩條路徑算出不同答案的話沒有人知道哪一個對**，所以它們不能是
 * 兩份實作。
 *
 * @param classId 只重建這個班的在籍學生。不給就是整個租戶的學生。
 */
export async function rebuildAbilityFor(classId?: string | null): Promise<RebuildResult> {
  const tenantId = requireTenant();

  const userIds = classId
    ? (
        await prisma.classMembership.findMany({
          where: { classId, role: 'STUDENT', leftAt: null },
          select: { userId: true },
        })
      ).map((m) => m.userId)
    : (
        await prisma.user.findMany({
          // 老師自己試考的那幾份不進能力分析，與 `classStats` 同一條規則。
          where: { systemRole: 'STUDENT', deletedAt: null },
          select: { id: true },
        })
      ).map((u) => u.id);

  return rebuildAbility(prisma, { tenantId, userIds }) as Promise<RebuildResult>;
}

// ─────────────────────────────────────────────────────────────────
// 讀：學生
// ─────────────────────────────────────────────────────────────────

export type PointView = {
  id: string;
  name: string;
  subjectId: string;
  subjectName: string;
  mastery: number;
  reliable: boolean;
  correct: number;
  total: number;
  streakWrong: number;
  lastAnsweredAt: Date | null;
};

export type StudentPoint = PointView & {
  prereqs: PointView[];
  step: { kind: string; prereq: PointView | null; text: string };
};

export type StudentAbility = {
  /** 有足夠資料下結論的，弱的排前面。 */
  points: StudentPoint[];
  /** 資料不足的。**有名字、沒有數字**——一個看起來精確的小數會被當真。 */
  thin: StudentPoint[];
  subjects: { id: string; name: string; points: number; weak: number }[];
  /** 全系統有幾個知識點。0 代表圖譜還沒建，畫面要說得出下一步。 */
  totalPoints: number;
  /** 這位學生交過幾份卷。有作答卻沒有快照時，缺的是知識點標註。 */
  attempts: number;
};

/** 沒有快照的前置知識點：**不是掌握度 0，是不知道。** */
function unknownPoint(id: string, name: string, subjectId = '', subjectName = ''): PointView {
  return {
    id,
    name,
    subjectId,
    subjectName,
    mastery: 0,
    reliable: false,
    correct: 0,
    total: 0,
    streakWrong: 0,
    lastAnsweredAt: null,
  };
}

/**
 * 一位學生的能力分析。
 *
 * 回傳的東西要足以回答「我哪裡弱、接下來練什麼」，所以每一個知識點
 * 都帶著它的前置與一句可行動的下一步（`nextStep`，在純函式那一層）。
 * 只給一張雷達圖的話，學生看完只知道自己爛，不知道要做什麼。
 */
export async function studentAbility(userId: string): Promise<StudentAbility> {
  const [snaps, totalPoints, attempts] = await Promise.all([
    prisma.abilitySnapshot.findMany({
      where: { userId },
      select: {
        knowledgePointId: true,
        mastery: true,
        reliable: true,
        correct: true,
        total: true,
        streakWrong: true,
        lastAnsweredAt: true,
        knowledgePoint: {
          select: {
            id: true,
            name: true,
            subjectId: true,
            subject: { select: { name: true } },
          },
        },
      },
    }),
    prisma.knowledgePoint.count(),
    prisma.attempt.count({ where: { userId, status: { in: ['SUBMITTED', 'GRADED'] } } }),
  ]);

  const views: PointView[] = snaps.map((s) => ({
    id: s.knowledgePointId,
    name: s.knowledgePoint.name,
    subjectId: s.knowledgePoint.subjectId,
    subjectName: s.knowledgePoint.subject.name,
    mastery: s.mastery,
    reliable: s.reliable,
    correct: s.correct,
    total: s.total,
    streakWrong: s.streakWrong,
    lastAnsweredAt: s.lastAnsweredAt,
  }));
  const byId = new Map(views.map((v) => [v.id, v]));

  // 前置關係。**沒有快照的前置也要列出來**——「不知道他有沒有底」
  // 與「他有底」是兩件事，而後者會讓建議跳過真正該補的東西。
  const links = views.length
    ? await prisma.kpPrerequisite.findMany({
        where: { kpId: { in: views.map((v) => v.id) } },
        orderBy: { strength: 'desc' },
        select: {
          kpId: true,
          prereq: {
            select: { id: true, name: true, subjectId: true, subject: { select: { name: true } } },
          },
        },
      })
    : [];
  const prereqOf = new Map<string, PointView[]>();
  for (const l of links) {
    const list = prereqOf.get(l.kpId) ?? [];
    list.push(
      byId.get(l.prereq.id) ??
        unknownPoint(l.prereq.id, l.prereq.name, l.prereq.subjectId, l.prereq.subject.name),
    );
    prereqOf.set(l.kpId, list);
  }

  const withStep: StudentPoint[] = views.map((v) => {
    const prereqs = prereqOf.get(v.id) ?? [];
    // 斷言：`nextStep` 的 JSDoc 宣告的是 ability.mjs 自己那個比較窄的
    // 知識點型別（只有公式用得到的欄位），而這裡傳進去的是畫面用的
    // 完整型別。回傳的 `prereq` 就是傳進去的那一個物件。
    return { ...v, prereqs, step: nextStep(v, prereqs) as StudentPoint['step'] };
  });

  const ordered = weakestFirst(withStep) as StudentPoint[];
  const points = ordered.filter((p) => p.reliable);
  const thin = ordered.filter((p) => !p.reliable);

  const bySubject = new Map<string, { id: string; name: string; points: number; weak: number }>();
  for (const p of points) {
    const b = bySubject.get(p.subjectId) ?? {
      id: p.subjectId,
      name: p.subjectName,
      points: 0,
      weak: 0,
    };
    b.points++;
    if (p.mastery < WEAK) b.weak++;
    bySubject.set(p.subjectId, b);
  }

  return {
    points,
    thin,
    subjects: [...bySubject.values()].sort((a, b) => b.weak - a.weak || b.points - a.points),
    totalPoints,
    attempts,
  };
}

// ─────────────────────────────────────────────────────────────────
// 讀：班級
// ─────────────────────────────────────────────────────────────────

export type ClassWeakPoint = {
  id: string;
  name: string;
  students: number;
  reliableStudents: number;
  weakStudents: number;
  meanMastery: number | null;
  correct: number;
  total: number;
  enough: boolean;
};

export type ClassAbility = {
  subject: { id: string; name: string };
  students: number;
  /** 知識點層級的弱點，全班最不會的排前面。 */
  weak: ClassWeakPoint[];
  /** 依題型的表現。業主明講要「題目類型」的分析。 */
  types: { type: string; answered: number; correct: number; rate: number | null; pending: number }[];
  /** 納入題型分析的任務份數。 */
  assignments: number;
  /** 這一科建了幾個知識點。0 → 圖譜還沒建。 */
  knowledgePoints: number;
  /** 這個班考過的題目數，以及其中標了知識點的題數。空狀態要靠它說話。 */
  questionsSeen: number;
  questionsTagged: number;
  /** 有幾位學生已經有快照。0 而且考過卷 → 多半是還沒重建過。 */
  studentsWithData: number;
};

/** 題型分析一次看幾份任務。與班級成績頁的矩陣同一個量級。 */
const TYPE_WINDOW = 12;

/**
 * 一個班在一個科目上的弱點。
 *
 * 兩個問題各用各的資料來源，不能混：
 *
 *   **哪一個章節全班都不會** → 讀快照。它是時間加權過的，回答的是
 *   「現在」的狀態，而不是「這幾次考試的平均」。
 *
 *   **哪一種題型不行** → 讀作答記錄。題型與知識點是兩個獨立的維度，
 *   一個班可能每個章節都還好，但多選題全班都在扣分。
 */
export async function classAbility(classId: string, subjectId: string): Promise<ClassAbility> {
  const subject = await prisma.subject.findFirst({
    where: { id: subjectId },
    select: { id: true, name: true },
  });
  if (!subject) throw new Error('找不到這個科目');

  const members = await prisma.classMembership.findMany({
    where: { classId, role: 'STUDENT', leftAt: null },
    select: { userId: true },
  });
  const userIds = members.map((m) => m.userId);

  const points = await prisma.knowledgePoint.findMany({
    where: { subjectId },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  const nameOf = new Map(points.map((p) => [p.id, p.name]));

  const snaps =
    userIds.length && points.length
      ? await prisma.abilitySnapshot.findMany({
          where: { userId: { in: userIds }, knowledgePointId: { in: points.map((p) => p.id) } },
          select: {
            userId: true,
            knowledgePointId: true,
            mastery: true,
            reliable: true,
            correct: true,
            total: true,
          },
        })
      : [];

  const weak: ClassWeakPoint[] = classWeakness(snaps).map(
    (w: {
      knowledgePointId: string;
      students: number;
      reliableStudents: number;
      weakStudents: number;
      meanMastery: number | null;
      correct: number;
      total: number;
      enough: boolean;
    }) => ({
      id: w.knowledgePointId,
      name: nameOf.get(w.knowledgePointId) ?? '（已刪除的知識點）',
      students: w.students,
      reliableStudents: w.reliableStudents,
      weakStudents: w.weakStudents,
      meanMastery: w.meanMastery,
      correct: w.correct,
      total: w.total,
      enough: w.enough,
    }),
  );

  // ── 題型 ───────────────────────────────────────────────────────
  //
  // 只看最近幾份：一個班三年份的作答是好幾萬列，而題型的答對率是
  // 「這一陣子」的問題，把三年前的加進來只會把它稀釋掉。
  const assignments = await prisma.assignment.findMany({
    where: { targets: { some: { classId } }, paper: { subjectId } },
    orderBy: { createdAt: 'desc' },
    take: TYPE_WINDOW,
    select: { id: true },
  });

  const attempts =
    assignments.length && userIds.length
      ? await prisma.attempt.findMany({
          // 作廢的不算，進行中的也不算——與計分、班級統計同一條規則。
          where: {
            assignmentId: { in: assignments.map((a) => a.id) },
            userId: { in: userIds },
            status: { in: ['SUBMITTED', 'GRADED'] },
          },
          select: { id: true },
        })
      : [];

  const answers = attempts.length
    ? await prisma.attemptAnswer.findMany({
        where: { attemptId: { in: attempts.map((a) => a.id) } },
        select: { questionId: true, isCorrect: true, question: { select: { type: true } } },
      })
    : [];

  const types = typeBreakdown(
    answers.map((a) => ({ type: a.question.type as string, isCorrect: a.isCorrect })),
  ) as ClassAbility['types'];

  // 空狀態要說得出「為什麼這裡是空的」。最常見的原因不是沒考試，
  // 是**考過的題目沒有標知識點**——而那兩件事在畫面上長得一樣。
  const seen = [...new Set(answers.map((a) => a.questionId))];
  const tagged = seen.length
    ? await prisma.questionKnowledgePoint.findMany({
        where: { questionId: { in: seen } },
        select: { questionId: true },
        distinct: ['questionId'],
      })
    : [];

  return {
    subject,
    students: userIds.length,
    weak,
    types,
    assignments: assignments.length,
    knowledgePoints: points.length,
    questionsSeen: seen.length,
    questionsTagged: tagged.length,
    studentsWithData: new Set(snaps.map((s) => s.userId)).size,
  };
}

/**
 * 一位學生在一個科目上的知識點狀況。班級頁裡的個人頁用。
 *
 * 與 `studentAbility` 分開是因為老師問的問題不同：學生問的是
 * 「我接下來練什麼」（要跨科、要前置、要一句話的建議），
 * 老師在約談前問的是「這孩子這一科哪幾個單元有問題」。
 */
export async function studentSubjectAbility(userId: string, subjectId?: string | null) {
  const snaps = await prisma.abilitySnapshot.findMany({
    where: {
      userId,
      ...(subjectId ? { knowledgePoint: { subjectId } } : {}),
    },
    select: {
      knowledgePointId: true,
      mastery: true,
      reliable: true,
      correct: true,
      total: true,
      streakWrong: true,
      lastAnsweredAt: true,
      knowledgePoint: {
        select: { id: true, name: true, subjectId: true, subject: { select: { name: true } } },
      },
    },
  });

  const views: PointView[] = snaps.map((s) => ({
    id: s.knowledgePointId,
    name: s.knowledgePoint.name,
    subjectId: s.knowledgePoint.subjectId,
    subjectName: s.knowledgePoint.subject.name,
    mastery: s.mastery,
    reliable: s.reliable,
    correct: s.correct,
    total: s.total,
    streakWrong: s.streakWrong,
    lastAnsweredAt: s.lastAnsweredAt,
  }));

  return weakestFirst(views) as PointView[];
}

/**
 * 這個租戶的知識點圖譜建到什麼程度。
 *
 * **每一頁在沒有資料時都要說得出「為什麼這裡是空的、要做什麼才有」**，
 * 而那句話的內容取決於卡在哪一關：一個知識點都沒有（要去建）、
 * 有知識點但題目沒標（要去標）、都有但學生還沒考（等考試）。
 * 三種的下一步完全不同，畫面上不能都寫「沒有資料」。
 */
export async function abilityReadiness() {
  const [points, taggedQuestions, snapshots] = await Promise.all([
    prisma.knowledgePoint.count(),
    // 用 count 加關聯條件，不是把 question_knowledge_points 整張撈回來
    // 再去重。後者在一個上萬題的題庫上，是每一次頁面重繪都搬一次
    // 整張表——而這三個數字只是為了決定空狀態要顯示哪一句話。
    prisma.question.count({ where: { knowledgePoints: { some: {} } } }),
    prisma.abilitySnapshot.count(),
  ]);
  return { points, taggedQuestions, snapshots };
}
