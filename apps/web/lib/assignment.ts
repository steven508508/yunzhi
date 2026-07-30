/**
 * 派任務。
 *
 * 一份卷子加上「派給誰、什麼時候、玩法是什麼」就是一個任務。
 * 這是題庫到成績那條線上，老師動作的最後一站——再往下就是學生作答（B3）。
 *
 * # 四個貫穿整份檔案的決定
 *
 * **一、只有 READY 的卷子派得出去。**
 *
 * DRAFT 是「還在編」：可能少了三題、可能有一題的答案還沒填。派出去的話
 * 學生會打開一份還在編輯中的東西，而老師在任務列表上看到的是一份
 * 長得完全正常的任務。這種錯要等到考試當天才會被發現。
 *
 * **二、已經有人開始作答之後，考試條件就凍結了。**
 *
 * 換卷子、改時限、改隨機——這些會讓「已經開始的人」與「還沒開始的人」
 * 拿到不同的考試，而他們的成績會被放在同一張統計表上比較。
 * 所以這幾欄在第一份 `Attempt` 出現之後就鎖住，錯誤訊息要說得出
 * 「已經有幾個人開始作答」，否則老師只會覺得系統壞了。
 *
 * 沒鎖住的是截止時間、遲交、次數、解析開放時機與派發對象——那幾樣
 * **本來就是要在進行中調整的**（最常見的請求就是「再延一天」）。
 *
 * **三、改動只看真的變了的欄位。**
 *
 * 編輯表單會把整份設定原封不動送回來，包含沒動過的時限。若用
 * 「有送就算要改」來判斷，考試開始後就連截止時間都改不了了。
 * 所以逐欄比對現值，只對真的不一樣的欄位喊停。
 *
 * **四、`resolveRecipients` 是唯一一份「這份任務派給了誰」。**
 *
 * 班級成員加上個別指定，去重。B3 要靠它決定誰可以開始作答、
 * B4 要靠它算「應交幾人」、催繳要靠它算「誰還沒交」。這種東西一旦
 * 有兩份實作，兩邊的人數就會對不起來，而沒有人知道哪一份是對的。
 */
import type { SessionUser } from '@/lib/auth';
import {
  attemptStranded,
  checkEndNow,
  checkExtend,
  checkExtendMinutes,
} from '@/lib/attemptClock.mjs';
import { countAnswered, rosterTally } from '@/lib/examOps.mjs';
import { notifyGradeReleased } from '@/lib/notifyDb';
import { prisma } from '@/lib/prisma';
import { countByAssignment } from '@/lib/scope.mjs';
import { requireTenant } from '@/lib/tenant';

/**
 * 名冊上算數的成員與帳號。
 *
 * 抽成常數而不是各處重打一次，是因為**「這份任務派給了誰」有兩份
 * 實作**：一份展開成完整名單（`expandRecipients`），一份只算人數
 * （`countRecipients`，列表頁用）。兩份的過濾條件只要差一個字，
 * 列表上的「派給 63 人」與任務內頁的名單就會對不起來，
 * 而沒有人說得出哪一個是對的。
 */
const STUDENT_MEMBERSHIP = { role: 'STUDENT', leftAt: null } as const;
const ACTIVE_STUDENT = { deletedAt: null, systemRole: 'STUDENT' } as const;

export type AssignmentMode = 'EXAM' | 'PRACTICE';
export type ReleasePolicy = 'IMMEDIATE' | 'ON_SUBMIT' | 'ON_DUE' | 'MANUAL' | 'NEVER';

/** 派給誰。兩者可以並存：整班加上補考的那兩位。 */
export type TargetInput = {
  classIds?: string[];
  userIds?: string[];
};

export type AssignmentInput = {
  paperId: string;
  title: string;
  mode?: AssignmentMode;
  openAt?: Date | null;
  dueAt?: Date | null;
  timeLimitMin?: number | null;
  allowLate?: boolean;
  maxAttempts?: number;
  shuffleQuestions?: boolean;
  shuffleOptions?: boolean;
  releasePolicy?: ReleasePolicy;
  targets: TargetInput;
};

// ─────────────────────────────────────────────────────────────────
// 建立
// ─────────────────────────────────────────────────────────────────

export async function createAssignment(input: AssignmentInput, actor: SessionUser) {
  const tenantId = requireTenant();
  const actorId = actor.id;

  const title = input.title.trim();
  if (!title) throw new Error('請填寫任務名稱');
  if (title.length > 120) throw new Error('任務名稱太長。學生在自己的任務清單上看到的就是它。');

  const paper = await prisma.examPaper.findFirst({
    where: { id: input.paperId },
    select: { id: true, title: true, status: true, subjectId: true, totalScore: true },
  });
  if (!paper) throw new Error('找不到這份試卷');
  if (paper.status !== 'READY') {
    throw new Error(
      paper.status === 'DRAFT'
        ? `「${paper.title}」還是草稿。派出去的話，學生會打開一份還在編輯中的卷子，` +
          `而你在任務列表上看到的是一份長得完全正常的任務。` +
          `編好之後在試卷頁按「標記為可派發」。`
        : `「${paper.title}」已經封存，不能再派新的任務。`,
    );
  }

  const window = normalizeWindow(input.openAt ?? null, input.dueAt ?? null, { creating: true });
  const timeLimitMin = normalizeTimeLimit(input.timeLimitMin ?? null);
  const maxAttempts = normalizeAttempts(input.maxAttempts ?? 1);

  const targets = await resolveTargetInput(input.targets, actor, paper.subjectId);
  if (targets.rows.length === 0) {
    throw new Error(
      '請至少選一個班級或一位學生。沒有對象的任務不會有任何人收到，' +
        '但它在列表上與正常的任務長得一模一樣。',
    );
  }

  const assignment = await prisma.$transaction(async (tx) => {
    const created = await tx.assignment.create({
      data: {
        tenantId,
        paperId: paper.id,
        title,
        mode: (input.mode ?? 'EXAM') as never,
        openAt: window.openAt,
        dueAt: window.dueAt,
        timeLimitMin,
        allowLate: input.allowLate ?? false,
        maxAttempts,
        shuffleQuestions: input.shuffleQuestions ?? false,
        shuffleOptions: input.shuffleOptions ?? false,
        releasePolicy: (input.releasePolicy ?? 'ON_DUE') as never,
        createdBy: actorId,
      },
    });
    await tx.assignmentTarget.createMany({
      data: targets.rows.map((t) => ({ assignmentId: created.id, ...t })),
    });
    return created;
  });

  // 建完立刻算一次實際人數並回傳。老師要看到的是「派給了 63 人」，
  // 不是「派給了 2 個班」——空班或名冊還沒匯入時，兩個數字差很多。
  const recipients = await resolveRecipients(assignment.id);

  await audit(tenantId, actorId, 'assignment.create', assignment.id, {
    title,
    paper: paper.title,
    classes: targets.classNames,
    individuals: targets.userNames,
    recipients: recipients.length,
  });
  return { assignment, recipients: recipients.length };
}

// ─────────────────────────────────────────────────────────────────
// 修改
// ─────────────────────────────────────────────────────────────────

export type AssignmentPatch = Partial<Omit<AssignmentInput, 'targets'>> & {
  targets?: TargetInput;
  /** 手動放行解析（releasePolicy = MANUAL 時用）。 */
  released?: boolean;
};

/**
 * 改任務設定。
 *
 * 已經有人開始作答時，「會讓不同人拿到不同考試」的那幾欄鎖住。
 * 判斷的是**真的變了的欄位**，不是「有沒有送過來」——理由見檔案
 * 開頭的決定三。
 */
export async function updateAssignment(
  assignmentId: string,
  patch: AssignmentPatch,
  actor: SessionUser,
) {
  const tenantId = requireTenant();
  const actorId = actor.id;
  const before = await prisma.assignment.findFirst({
    where: { id: assignmentId },
    select: {
      id: true,
      title: true,
      paperId: true,
      mode: true,
      openAt: true,
      dueAt: true,
      timeLimitMin: true,
      allowLate: true,
      maxAttempts: true,
      shuffleQuestions: true,
      shuffleOptions: true,
      releasePolicy: true,
      releasedAt: true,
    },
  });
  if (!before) throw new Error('找不到這個任務');

  const started = await prisma.attempt.count({ where: { assignmentId } });

  const data: Record<string, unknown> = {};
  const frozen: string[] = [];

  /** 考試開始後就不能再變的欄位。變了就記下來，最後一起報。 */
  const guard = (label: string, changed: boolean, apply: () => void) => {
    if (!changed) return;
    if (started > 0) frozen.push(label);
    else apply();
  };

  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new Error('請填寫任務名稱');
    if (title !== before.title) data.title = title;
  }

  if (patch.paperId !== undefined && patch.paperId !== before.paperId) {
    // 這一項不走 guard()：換卷子還要多驗一次新卷子是不是可派發的，
    // 而那是個 await，塞不進同步的 callback。
    if (started > 0) frozen.push('試卷');
    else data.paperId = (await requireReadyPaper(patch.paperId)).id;
  }

  if (patch.mode !== undefined) {
    // mode 也在凍結名單裡：EXAM 與 PRACTICE 的計時、重做次數、
    // 即時解析全都不同，考試中途換模式與換卷子是同一種錯。
    guard('測驗模式', patch.mode !== before.mode, () => {
      data.mode = patch.mode;
    });
  }

  if (patch.timeLimitMin !== undefined) {
    const next = normalizeTimeLimit(patch.timeLimitMin);
    guard('作答時限', next !== before.timeLimitMin, () => {
      data.timeLimitMin = next;
    });
  }

  if (patch.shuffleQuestions !== undefined) {
    guard('題序隨機', patch.shuffleQuestions !== before.shuffleQuestions, () => {
      data.shuffleQuestions = patch.shuffleQuestions;
    });
  }

  if (patch.shuffleOptions !== undefined) {
    guard('選項隨機', patch.shuffleOptions !== before.shuffleOptions, () => {
      data.shuffleOptions = patch.shuffleOptions;
    });
  }

  if (frozen.length > 0) {
    throw new Error(
      `已經有 ${started} 人開始作答，${frozen.join('、')}不能再改了——` +
        `改了之後，已經開始的人與還沒開始的人拿到的是不同的考試，` +
        `而他們的成績會被放在同一張表上比較。` +
        `${frozen.length > 1 ? '這幾樣' : '這一項'}要換的話請另外派一個任務。`,
    );
  }

  // 以下幾項在進行中改是正常的：延長截止、開放遲交、多給一次機會、
  // 改解析開放時機。最常見的請求就是「再延一天」。
  if (patch.openAt !== undefined || patch.dueAt !== undefined) {
    const w = normalizeWindow(
      patch.openAt !== undefined ? patch.openAt : before.openAt,
      patch.dueAt !== undefined ? patch.dueAt : before.dueAt,
      { creating: false },
    );
    if (+(w.openAt ?? 0) !== +(before.openAt ?? 0)) data.openAt = w.openAt;
    if (+(w.dueAt ?? 0) !== +(before.dueAt ?? 0)) data.dueAt = w.dueAt;
  }
  if (patch.allowLate !== undefined && patch.allowLate !== before.allowLate) {
    data.allowLate = patch.allowLate;
  }
  if (patch.maxAttempts !== undefined) {
    const next = normalizeAttempts(patch.maxAttempts);
    // 調低次數不會回頭作廢已經寫過的那幾次——那些是成績。
    if (next !== before.maxAttempts) data.maxAttempts = next;
  }
  if (patch.releasePolicy !== undefined && patch.releasePolicy !== before.releasePolicy) {
    data.releasePolicy = patch.releasePolicy;
  }
  if (patch.released !== undefined) {
    const next = patch.released ? (before.releasedAt ?? new Date()) : null;
    if (+(next ?? 0) !== +(before.releasedAt ?? 0)) data.releasedAt = next;
  }

  // 對象與設定是兩次寫入，不在同一個交易裡。可以接受的理由是：
  // 上面所有會擋下來的檢查都在任何一次寫入之前跑完了，所以走到這裡
  // 只剩資料庫層級的意外；而那時「對象換了、設定沒換」是看得出來的
  // 狀態（畫面上人數變了、設定沒變），不是安靜的錯。
  if (patch.targets) {
    await setAssignmentTargets(assignmentId, patch.targets, actor);
  }
  if (Object.keys(data).length === 0) return before;

  const after = await prisma.assignment.update({ where: { id: assignmentId }, data });
  await audit(tenantId, actorId, 'assignment.update', assignmentId, {
    title: before.title,
    patch: data,
    started,
  });

  // 手動放行的那一刻要告訴學生。
  //
  // 這是整個系統裡唯一一件「做了之後學生完全沒有跡象」的事：MANUAL 的
  // 任務交完卷之後，學生畫面上只有一句「老師還沒有開放」，而開放的
  // 那一秒沒有任何訊號——他唯一的辦法是每天回來按一次。
  //
  // **只在 `releasedAt` 真的從無變有的時候。** 收回（變成 null）不通知，
  // 上面的逐欄比對已經保證了「值沒變就不會出現在 data 裡」。
  //
  // 通知失敗一律吞掉（見 `lib/notifyDb.ts`）：放行已經寫進資料庫了，
  // 讓這一行有能力把整個請求變成 500 的話，老師會以為放行沒成功、
  // 再按一次，然後撞到「這份任務已經放行過了」。
  if (data.releasedAt instanceof Date) {
    const recipientIds = [...(await resolveRecipientIds(assignmentId))];
    await notifyGradeReleased(assignmentId, {
      tenantId,
      title: after.title,
      recipientIds,
    });
  }

  return after;
}

/**
 * 換一組派發對象。**整組替換**，不是增量。
 *
 * 前端的多選本來就是一次送出完整的一組，增量指令（加這個、拿掉那個）
 * 要在伺服器端重建同一個結果，等於兩份實作。
 *
 * 加人隨時可以（補考的那兩位）。**拿掉已經作答的人不行**：那些作答
 * 記錄還在，但那位學生從此看不到自己的成績，而老師的「應交人數」
 * 會與「已交人數」對不起來。
 */
export async function setAssignmentTargets(
  assignmentId: string,
  targets: TargetInput,
  actor: SessionUser,
) {
  const tenantId = requireTenant();
  const actorId = actor.id;
  const assignment = await prisma.assignment.findFirst({
    where: { id: assignmentId },
    // 科目要一起查出來：可以派給哪幾個班是**依卷子的科目**判定的，
    // 任務本身沒有科目欄位。
    select: { id: true, title: true, paper: { select: { subjectId: true } } },
  });
  if (!assignment) throw new Error('找不到這個任務');

  const next = await resolveTargetInput(targets, actor, assignment.paper.subjectId);
  if (next.rows.length === 0) {
    throw new Error('請至少留一個班級或一位學生。沒有對象的任務不會有任何人收到。');
  }

  // **先算完再寫。** 換對象是「刪掉全部再建一組」，若等寫完才發現
  // 拿掉了已經作答的人，就得把剛剛刪掉的那組原樣還原回去——而還原
  // 本身也可能失敗。算在前面就沒有這個問題：資料庫要嘛沒動，要嘛是對的。
  const before = await resolveRecipients(assignmentId);
  const after = await expandRecipients(next.rows);
  const afterIds = new Set(after.map((r) => r.userId));
  const dropped = before.filter((r) => !afterIds.has(r.userId));

  if (dropped.length > 0) {
    const answered = await prisma.attempt.findMany({
      where: { assignmentId, userId: { in: dropped.map((d) => d.userId) } },
      select: { userId: true },
      distinct: ['userId'],
    });
    if (answered.length > 0) {
      const hit = new Set(answered.map((a) => a.userId));
      const names = dropped.filter((d) => hit.has(d.userId)).map((d) => d.displayName);
      throw new Error(
        `${names.slice(0, 5).join('、')}${names.length > 5 ? ` 等 ${names.length} 位` : ''}` +
          `已經作答過，不能從派發對象裡拿掉——他們的作答記錄還在，` +
          `但會變成看不到自己的成績。派發對象沒有變動。`,
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.assignmentTarget.deleteMany({ where: { assignmentId } });
    await tx.assignmentTarget.createMany({
      data: next.rows.map((t) => ({ assignmentId, ...t })),
    });
  });

  await audit(tenantId, actorId, 'assignment.targets', assignmentId, {
    title: assignment.title,
    classes: next.classNames,
    individuals: next.userNames,
    recipients: after.length,
  });
  return after;
}

/**
 * 刪除任務。**已經有人作答就擋下來。**
 *
 * `Attempt` 的外鍵是 Cascade，刪任務會連學生寫的答案一起刪掉，
 * 而那些是成績的來源、也是申訴時唯一能拿出來的東西。
 * 真的要作廢一場考試是另一件事（把 Attempt 標成 VOIDED），
 * 不是把整個任務刪掉。
 */
export async function deleteAssignment(assignmentId: string, actorId: string) {
  const tenantId = requireTenant();
  const assignment = await prisma.assignment.findFirst({
    where: { id: assignmentId },
    select: { id: true, title: true, _count: { select: { attempts: true } } },
  });
  if (!assignment) throw new Error('找不到這個任務');

  if (assignment._count.attempts > 0) {
    throw new Error(
      `「${assignment.title}」已經有 ${assignment._count.attempts} 份作答記錄，不能刪除——` +
        `那些記錄是成績的來源，刪了就沒有了。要停止這場考試，` +
        `請把截止時間改成現在。`,
    );
  }

  await prisma.assignment.delete({ where: { id: assignmentId } });
  await audit(tenantId, actorId, 'assignment.delete', assignmentId, {
    title: assignment.title,
  });
  return assignment;
}

// ─────────────────────────────────────────────────────────────────
// 這份任務實際派給了誰
// ─────────────────────────────────────────────────────────────────

export type Recipient = {
  userId: string;
  username: string;
  displayName: string;
  /** 帳號狀態。PENDING_CONSENT 的學生登不進來，畫面上要標出來。 */
  status: string;
  /** 透過哪些班級收到的。只有個別指定的人這裡是空的。 */
  classNames: string[];
  /** 有沒有被個別指定（補考的那兩位）。 */
  individual: boolean;
};

/**
 * 這份任務實際派給了哪些學生。班級成員加上個別指定的，去重。
 *
 * **這是唯一一份名單。** B3 靠它決定誰開得了考卷、B4 靠它算「應交幾人」、
 * 催繳靠它算「誰還沒交」。兩份實作的話，人數會對不起來而且沒有人
 * 知道哪一份對。
 *
 * 三件刻意的事：
 *
 *   · **已經離班的（`leftAt` 不是 null）不算。** 他上個月轉出去了，
 *     不該收到這個月的考卷。
 *   · **只算 `role = STUDENT` 的成員。** 班上的老師與助教也在
 *     `class_memberships` 裡，而把考卷派給老師自己會讓應交人數多幾個。
 *   · **軟刪除的帳號不算，但停權與未同意的算。** 前者已經不是這裡的人；
 *     後者是「暫時進不來」，老師要看得到他們在名單上、也要看得到
 *     他們為什麼進不來——名單上少了一個人比多了一個人難查得多。
 */
export async function resolveRecipients(assignmentId: string): Promise<Recipient[]> {
  requireTenant();

  const targets = await prisma.assignmentTarget.findMany({
    where: { assignmentId },
    select: { classId: true, userId: true },
  });
  return expandRecipients(targets);
}

/**
 * 同一份名單，只要 id 的集合。
 *
 * 「這位學生開得了這份考卷嗎」是作答那條線上每一次請求都要問的事，
 * 而它只需要一個 `has()`。獨立一支是為了讓那邊不必自己再寫一份
 * 判定——**「誰收得到這份任務」有兩個答案的時候，沒有人說得出
 * 哪一個是對的**，而症狀是某個學生在清單上看得到、按下去卻說沒派給他。
 */
export async function resolveRecipientIds(assignmentId: string): Promise<Set<string>> {
  const list = await resolveRecipients(assignmentId);
  return new Set(list.map((r) => r.userId));
}

/** 派發對象的一列：班或人。 */
type TargetRow = { classId?: string | null; userId?: string | null };

/**
 * 把派發對象展開成學生名單。
 *
 * 抽出來是為了讓「還沒寫進資料庫的一組對象」也算得出人數——
 * 換對象時要先知道會不會拿掉已經作答的人，見 `setAssignmentTargets`。
 */
async function expandRecipients(targets: TargetRow[]): Promise<Recipient[]> {
  if (targets.length === 0) return [];

  // 一列可以同時帶班級與個人（schema 只要求至少一邊有值），兩邊
  // 各自處理就是對的：班的加班上的人，個人的加那個人。
  const classIds = [...new Set(targets.flatMap((t) => (t.classId ? [t.classId] : [])))];
  const directIds = [...new Set(targets.flatMap((t) => (t.userId ? [t.userId] : [])))];

  // 班名另外查而不是跟著 target 一起 join 出來：班名只用在名單的
  // 分組顯示上，而這個函式最常見的呼叫是「算人數」——那時它是白費的。
  const classes = classIds.length
    ? await prisma.class.findMany({
        where: { id: { in: classIds } },
        select: { id: true, name: true },
      })
    : [];
  const classNameById = new Map(classes.map((c) => [c.id, c.name]));

  const memberships = classIds.length
    ? await prisma.classMembership.findMany({
        where: { classId: { in: classIds }, ...STUDENT_MEMBERSHIP },
        select: { classId: true, userId: true },
      })
    : [];

  const userIds = [...new Set([...memberships.map((m) => m.userId), ...directIds])];
  if (userIds.length === 0) return [];

  const users = await prisma.user.findMany({
    where: { id: { in: userIds }, ...ACTIVE_STUDENT },
    select: { id: true, username: true, displayName: true, status: true },
  });

  const byUser = new Map<string, Recipient>();
  for (const u of users) {
    byUser.set(u.id, {
      userId: u.id,
      username: u.username,
      displayName: u.displayName,
      status: u.status,
      classNames: [],
      individual: directIds.includes(u.id),
    });
  }
  for (const m of memberships) {
    const r = byUser.get(m.userId);
    const name = classNameById.get(m.classId);
    if (r && name && !r.classNames.includes(name)) r.classNames.push(name);
  }

  // 依班級再依學號。老師掃這份名單時是一班一班看的。
  return [...byUser.values()].sort((a, b) => {
    const ca = a.classNames[0] ?? '';
    const cb = b.classNames[0] ?? '';
    if (ca !== cb) return ca.localeCompare(cb, 'zh-Hant');
    return a.username.localeCompare(b.username, 'zh-Hant');
  });
}

/**
 * 這個人是不是被**個別指定**進這份任務的（不管他是不是學生）。
 *
 * 用途只有一個：老師把自己加進去試考。`resolveRecipients` 只認學生
 * 帳號（應交人數不可以把老師算進去），所以試考的那一位不會出現在
 * 名單裡——於是「他開不開得了這份考卷」需要另外一句，就是這一句。
 *
 * **它不放寬任何班級權限**：`assignment_targets` 裡有他的 userId 這件事
 * 本身就是一次明確的指定，而寫進去的那一刻已經過了 `resolveTargetInput`。
 */
export async function isNamedTarget(assignmentId: string, userId: string): Promise<boolean> {
  requireTenant();
  const hit = await prisma.assignmentTarget.findFirst({
    where: { assignmentId, userId },
    select: { id: true },
  });
  return hit != null;
}

/**
 * 一次算出好幾份任務各自的實際人數。**查詢次數與任務數無關。**
 *
 * 列表頁對每一份呼叫 `resolveRecipients` 是 4 次查詢乘上任務數：
 * 一頁 100 份就是 400 次往返，而且是同時打出去的。連線池只有幾條，
 * 症狀是任務一多，整個列表頁開始逾時——而看起來完全不像是
 * 「派給幾人」這一欄造成的，因為那一欄畫面上只是一個數字。
 *
 * 這裡固定三次查詢：對象、班級成員、學生帳號。判定條件與
 * `expandRecipients` 共用同一組常數，見檔案上方。
 */
export async function countRecipients(assignmentIds: string[]): Promise<Map<string, number>> {
  requireTenant();
  const counts = new Map<string, number>(assignmentIds.map((id) => [id, 0]));
  if (assignmentIds.length === 0) return counts;

  const targets = await prisma.assignmentTarget.findMany({
    where: { assignmentId: { in: assignmentIds } },
    select: { assignmentId: true, classId: true, userId: true },
  });
  if (targets.length === 0) return counts;

  const classIds = [...new Set(targets.flatMap((t) => (t.classId ? [t.classId] : [])))];
  const directIds = [...new Set(targets.flatMap((t) => (t.userId ? [t.userId] : [])))];

  const memberships = classIds.length
    ? await prisma.classMembership.findMany({
        where: { classId: { in: classIds }, ...STUDENT_MEMBERSHIP },
        select: { classId: true, userId: true },
      })
    : [];

  const candidates = [...new Set([...memberships.map((m) => m.userId), ...directIds])];
  // 已軟刪除、或根本不是學生帳號的（名冊裡的助教）不算。少了這一道，
  // 「應交人數」永遠比實際多幾個，而催繳清單上會有幾個交不出來的人。
  const valid = candidates.length
    ? new Set(
        (
          await prisma.user.findMany({
            where: { id: { in: candidates }, ...ACTIVE_STUDENT },
            select: { id: true },
          })
        ).map((u) => u.id),
      )
    : new Set<string>();

  const membersOfClass = new Map<string, string[]>();
  for (const m of memberships) {
    const list = membersOfClass.get(m.classId);
    if (list) list.push(m.userId);
    else membersOfClass.set(m.classId, [m.userId]);
  }

  // 去重與「一列可以同時帶班級與個人」的處理在 lib/scope.mjs，那裡有
  // 測試。這一支只負責把三份資料查出來。
  for (const [id, n] of countByAssignment(targets, membersOfClass, valid)) counts.set(id, n);
  return counts;
}

// ─────────────────────────────────────────────────────────────────
// 一份任務的收件名單與現在的狀態
// ─────────────────────────────────────────────────────────────────

/** 名單上一位學生現在走到哪裡。四種狀態互斥，加起來就是應交人數。 */
export type RosterState = 'UNTOUCHED' | 'IN_PROGRESS' | 'SUBMITTED' | 'VOIDED';

export type RosterEntry = Recipient & {
  state: RosterState;
  /** 進行中那一份的 id。要延長時間或代為結算時用它。 */
  attemptId: string | null;
  startedAt: Date | null;
  expiresAt: Date | null;
  submittedAt: Date | null;
  totalScore: number | null;
  /** 進行中而且已經寫不進去了——老師要處理的就是這幾份。 */
  stranded: boolean;
  /** 真的寫了幾題。與學生自己畫面上的計數同一個口徑（見 lib/examOps.mjs）。 */
  answered: number;
  /** 開過幾次（含作廢的）。可作答多次的任務上才有意義。 */
  attempts: number;
};

export type AssignmentRoster = {
  assignmentId: string;
  title: string;
  paperId: string;
  paperTitle: string;
  subjectId: string;
  subjectName: string;
  mode: string;
  openAt: Date | null;
  dueAt: Date | null;
  timeLimitMin: number | null;
  allowLate: boolean;
  maxAttempts: number;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  releasePolicy: string;
  releasedAt: Date | null;
  createdBy: string | null;
  questionCount: number;
  /** 應交 = 名單人數。**以名單為準，不是以作答為準。** */
  expected: number;
  started: number;
  submitted: number;
  inProgress: number;
  untouched: number;
  entries: RosterEntry[];
  /** 有作答記錄但不在名單上的（老師自己試考的那一份）。 */
  trials: { attemptId: string; displayName: string; status: string; totalScore: number | null }[];
};

/**
 * 這份任務派給了誰、誰開了、誰交了、誰還沒動。
 *
 * # 為什麼要有這一支
 *
 * `resolveRecipients` 回的形狀**正好就是這一頁需要的**（姓名、學號、
 * 帳號狀態、透過哪幾個班收到、是不是個別指定），而它的兩個呼叫端
 * 一個是「這位學生開不開得了考卷」，另一個把整份名單算出來之後
 * `return { recipients: recipients.length }` ——**名單當場丟掉，只留一個數字**。
 *
 * 結果是「有人說沒收到」時無路可走：`classStats` 只查 `Attempt`，
 * 所以連考卷都沒打開的那一位在成績頁的每一塊裡都不存在（不在全班表、
 * 不在未完成、不在已作廢），而少的那一個是誰、為什麼少，畫面上
 * 一個字都沒有。
 *
 * # 為什麼「未動作」要點得出名字而不只是一個數字
 *
 * 因為那是老師當下要打電話的名單。而且四種原因（不在班級名冊、
 * 已離班、帳號還沒有家長同意所以登不進來、派錯班）裡，第三種的答案
 * 就在 `Recipient.status` 裡——那一欄的註解本來就寫著「畫面上要標出來」。
 */
export async function assignmentRoster(assignmentId: string): Promise<AssignmentRoster | null> {
  requireTenant();

  const assignment = await prisma.assignment.findFirst({
    where: { id: assignmentId },
    select: {
      id: true,
      title: true,
      mode: true,
      openAt: true,
      dueAt: true,
      timeLimitMin: true,
      allowLate: true,
      maxAttempts: true,
      shuffleQuestions: true,
      shuffleOptions: true,
      releasePolicy: true,
      releasedAt: true,
      createdBy: true,
      paper: {
        select: {
          id: true,
          title: true,
          subjectId: true,
          subject: { select: { name: true } },
          _count: { select: { items: true } },
        },
      },
    },
  });
  if (!assignment) return null;

  const [recipients, attempts] = await Promise.all([
    resolveRecipients(assignmentId),
    prisma.attempt.findMany({
      where: { assignmentId },
      select: {
        id: true,
        userId: true,
        status: true,
        startedAt: true,
        expiresAt: true,
        submittedAt: true,
        totalScore: true,
        user: { select: { displayName: true, systemRole: true } },
        // 「已作答 N 題」要與學生自己畫面上的計數一致，所以查的是
        // 作答內容而不是 `_count.answers`——後者把只按了「標記待複查」
        // 與點了又取消的題目都算進去，而老師會照著那個偏高的數字
        // 決定要不要讓他繼續寫。
        answers: { select: { answerKeys: true, answerText: true, answerSlots: true } },
      },
      orderBy: { startedAt: 'asc' },
    }),
  ]);

  const now = new Date();
  const clockCtx = { dueAt: assignment.dueAt, allowLate: assignment.allowLate };
  const byUser = new Map<string, typeof attempts>();
  for (const a of attempts) {
    const bucket = byUser.get(a.userId);
    if (bucket) bucket.push(a);
    else byUser.set(a.userId, [a]);
  }

  const entries: RosterEntry[] = recipients.map((r) => {
    const mine = byUser.get(r.userId) ?? [];
    // 顯示哪一份：進行中的優先（那是現在要處理的），其次最後交的一份。
    const open = mine.find((a) => a.status === 'IN_PROGRESS');
    const done = [...mine].reverse().find((a) => a.status === 'SUBMITTED' || a.status === 'GRADED');
    const pick = open ?? done ?? mine[mine.length - 1] ?? null;

    let state: RosterState = 'UNTOUCHED';
    if (open) state = 'IN_PROGRESS';
    else if (done) state = 'SUBMITTED';
    else if (mine.length > 0) state = 'VOIDED';

    return {
      ...r,
      state,
      attemptId: pick?.id ?? null,
      startedAt: pick?.startedAt ?? null,
      expiresAt: open?.expiresAt ?? pick?.expiresAt ?? null,
      submittedAt: done?.submittedAt ?? null,
      totalScore: done?.totalScore ?? null,
      stranded: open ? attemptStranded({ ...open, assignment: clockCtx }, now) : false,
      answered: pick ? countAnswered(pick.answers) : 0,
      attempts: mine.length,
    };
  });

  const known = new Set(recipients.map((r) => r.userId));
  const trials = attempts
    .filter((a) => !known.has(a.userId) && a.user.systemRole !== 'STUDENT')
    .map((a) => ({
      attemptId: a.id,
      displayName: a.user.displayName,
      status: a.status as string,
      totalScore: a.totalScore,
    }));

  const tally = rosterTally(recipients, attempts);

  return {
    assignmentId: assignment.id,
    title: assignment.title,
    paperId: assignment.paper.id,
    paperTitle: assignment.paper.title,
    subjectId: assignment.paper.subjectId,
    subjectName: assignment.paper.subject.name,
    mode: assignment.mode as string,
    openAt: assignment.openAt,
    dueAt: assignment.dueAt,
    timeLimitMin: assignment.timeLimitMin,
    allowLate: assignment.allowLate,
    maxAttempts: assignment.maxAttempts,
    shuffleQuestions: assignment.shuffleQuestions,
    shuffleOptions: assignment.shuffleOptions,
    releasePolicy: assignment.releasePolicy as string,
    releasedAt: assignment.releasedAt,
    createdBy: assignment.createdBy,
    questionCount: assignment.paper._count.items,
    expected: tally.expected,
    started: tally.started,
    submitted: tally.submitted,
    inProgress: tally.inProgress,
    untouched: tally.untouched,
    entries,
    trials,
  };
}

// ─────────────────────────────────────────────────────────────────
// 同一份卷子還被誰用著
// ─────────────────────────────────────────────────────────────────

export type CohortAssignment = {
  id: string;
  title: string;
  dueAt: Date | null;
  releasePolicy: string;
  /** 這一份有沒有人交過卷。派卷時的警語要說得出「已經考完了沒」。 */
  submitted: number;
};

/**
 * 同一份卷子上的其他任務。
 *
 * # 為什麼這一句以前不存在
 *
 * 三個班考同一份卷子是補習班的常態（教室不夠、班別不同），而系統
 * 從頭到尾沒有問過「這份卷子還被哪些任務用著」——`prisma.assignment
 * .findMany({ where: { paperId } })` 全 repo 只出現在 `attemptsOnPaper`
 * 裡，而它只被拿來擋編輯。
 *
 * 於是忠班週五 15:00 截止那一刻，`maySeeResult` 依 ON_DUE 對忠班開放
 * 整份題目、標準答案與詳解，而孝仁兩班週六早上才考同一份。
 * **那一刻是自動發生的：沒有通知、沒有待辦、沒有紅字。**
 *
 * 這一支是那個判斷的資料來源，三個地方用它：學生端的放行判斷
 * （`lib/result.ts` → `cohortGate`）、派卷表單的警告、任務內頁的提醒。
 *
 * @param paperId 卷子
 * @param exceptAssignmentId 排除自己。建立新任務時傳 null。
 */
export async function paperCohort(
  paperId: string,
  exceptAssignmentId: string | null,
): Promise<CohortAssignment[]> {
  requireTenant();
  const rows = await prisma.assignment.findMany({
    where: {
      paperId,
      ...(exceptAssignmentId ? { id: { not: exceptAssignmentId } } : {}),
    },
    orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      title: true,
      dueAt: true,
      releasePolicy: true,
      _count: { select: { attempts: true } },
    },
  });
  return rows.map((a) => ({
    id: a.id,
    title: a.title,
    dueAt: a.dueAt,
    releasePolicy: a.releasePolicy as string,
    submitted: a._count.attempts,
  }));
}

/**
 * 同卷任務裡**還沒考完的**那幾個。派卷與成績頁的警告用這一份。
 *
 * 「還沒考完」＝ 沒設截止時間，或截止時間還在未來。已經截止的那些
 * 擋不住任何東西，列出來只會讓警告變成一句每次都出現的雜訊。
 */
export function unfinishedCohort(
  cohort: CohortAssignment[],
  now = new Date(),
): CohortAssignment[] {
  return cohort.filter((a) => a.dueAt == null || a.dueAt > now);
}

// ─────────────────────────────────────────────────────────────────
// 考試當天：改進行中作答的到期時刻
//
// 這一段補的是一個兩層都堵死的洞。全班斷網十分鐘之後老師要補回來：
//
//   · 改任務的 `timeLimitMin` —— 在有人開始作答之後就凍結了
//   · 就算解凍也沒有用 —— `expiresAt` 是開始作答那一刻算好寫死的，
//     任務設定改了不會回頭重算已經開始的那幾份
//
// 反方向也一樣：`AssignmentTools` 教老師「要立刻結束這場考試，把截止
// 時間改成現在」，而那停不掉正在寫的人——`attemptWritable` 只看
// `expiresAt`，不看 `assignment.dueAt`。
//
// 所以這兩支直接改 `attempts.expiresAt`。合不合法的判斷在
// `lib/attemptClock.mjs`（純函式、有測試），這裡只負責查、寫、記稽核。
//
// **學生端不必做任何事就會跟上**：作答頁每 30 秒打一次
// `GET /api/attempts/:id` 校時，那一支回的 `remainingSeconds` 是拿
// 資料庫裡的 `expiresAt` 現算的。
// ─────────────────────────────────────────────────────────────────

export type ClockChange = {
  /** 真的改了幾份。 */
  changed: number;
  /** 本來已經寫不進去、改完之後又寫得進去的份數。延長時老師最在意這個。 */
  reopened: number;
  /** 沒有動到的份數（已交卷、已作廢、或本來就結束了）。 */
  skipped: number;
  /** 新的到期時刻，逐份。畫面上要說得出「延長到幾點」。 */
  expiresAt: Date | null;
};

type ClockRow = {
  id: string;
  status: string;
  expiresAt: Date | null;
  userId: string;
};

/** 這份任務裡還掛在進行中的作答。兩支時鐘動作共用同一個查詢。 */
async function inProgressAttempts(
  assignmentId: string,
  attemptId: string | null,
): Promise<ClockRow[]> {
  return prisma.attempt.findMany({
    where: {
      assignmentId,
      status: 'IN_PROGRESS',
      ...(attemptId ? { id: attemptId } : {}),
    },
    select: { id: true, status: true, expiresAt: true, userId: true },
    orderBy: { startedAt: 'asc' },
  });
}

/**
 * 延長作答時間。整份任務一次，或只延長某一位（遲到、特殊需求的學生）。
 *
 * **已交卷的一份都不動**——那是這個功能能不能被信任的前提。
 *
 * @param opts.attemptId 只延長這一份。不給就是整份任務的進行中作答。
 */
export async function extendAttempts(
  assignmentId: string,
  opts: { minutes: number; attemptId?: string | null; actorId: string; reason?: string },
): Promise<ClockChange> {
  const tenantId = requireTenant();
  const valid = checkExtendMinutes(opts.minutes);
  if (!valid.ok) throw new Error(valid.error);

  const now = new Date();
  const rows = await inProgressAttempts(assignmentId, opts.attemptId ?? null);
  if (rows.length === 0) {
    throw new Error(
      opts.attemptId
        ? '這一份已經不在進行中了，延長時間對它沒有作用。'
        : '這份任務現在沒有進行中的作答。已經交卷的人不會因為延長而改變。',
    );
  }

  const writes: { id: string; expiresAt: Date }[] = [];
  let reopened = 0;
  /** 只延長一位時，被擋下來的理由要原樣回給老師，不能吞掉。 */
  let firstError: string | null = null;

  for (const row of rows) {
    const r = checkExtend(row, valid.minutes, now);
    if (!r.ok) {
      firstError ??= r.error;
      continue;
    }
    writes.push({ id: row.id, expiresAt: r.expiresAt });
    if (r.reopened) reopened++;
  }

  if (writes.length === 0) {
    throw new Error(
      firstError ??
        '沒有一份作答延長得了。沒有設作答時限也沒有設截止時間的任務本來就沒有時間壓力。',
    );
  }

  // 逐份寫而不是一句 updateMany：每個人的 `expiresAt` 不同（開始作答的
  // 時刻不同），而「全班一起多 N 分鐘」的意思正是各自往後推 N 分鐘。
  // 一句 `expiresAt = 某個固定值` 會把所有人拉到同一個時刻，於是晚開始
  // 的人反而被縮短。
  await prisma.$transaction(
    writes.map((w) =>
      prisma.attempt.update({ where: { id: w.id }, data: { expiresAt: w.expiresAt } }),
    ),
  );

  await audit(tenantId, opts.actorId, 'assignment.extend_attempts', assignmentId, {
    minutes: valid.minutes,
    attempts: writes.length,
    reopened,
    scope: opts.attemptId ? 'one' : 'all',
    reason: opts.reason ?? null,
    students: rows.filter((r) => writes.some((w) => w.id === r.id)).map((r) => r.userId),
  });

  return {
    changed: writes.length,
    reopened,
    skipped: rows.length - writes.length,
    expiresAt: writes.length === 1 ? writes[0].expiresAt : null,
  };
}

/**
 * 立刻結束這場考試：把所有進行中作答的到期時刻設成現在。
 *
 * **這是唯一停得掉正在作答的人的動作。** 把任務的截止時間改成現在
 * 只擋得住還沒開始的人，而畫面上那句提示一直在教老師走那條路。
 *
 * 結束之後那幾份會變成「卡住」，成績頁上就會出現「代為結算」——
 * 那是刻意的：收卷不可逆，該由人再按一次。
 */
export async function endAttemptsNow(
  assignmentId: string,
  opts: { actorId: string; reason?: string },
): Promise<ClockChange> {
  const tenantId = requireTenant();
  const now = new Date();
  const rows = await inProgressAttempts(assignmentId, null);

  const ids: string[] = [];
  for (const row of rows) {
    if (checkEndNow(row, now).ok) ids.push(row.id);
  }
  if (ids.length === 0) {
    throw new Error(
      rows.length === 0
        ? '這份任務現在沒有進行中的作答，不需要結束。'
        : '進行中的那幾份作答時間都已經結束了，不需要再結束一次。',
    );
  }

  await prisma.attempt.updateMany({
    where: { id: { in: ids } },
    data: { expiresAt: now },
  });

  await audit(tenantId, opts.actorId, 'assignment.end_now', assignmentId, {
    attempts: ids.length,
    at: now.toISOString(),
    reason: opts.reason ?? null,
  });

  return { changed: ids.length, reopened: 0, skipped: rows.length - ids.length, expiresAt: now };
}

// ─────────────────────────────────────────────────────────────────
// 誰可以派給誰
// ─────────────────────────────────────────────────────────────────

/**
 * 這個人可以把**這一科**的任務派給哪幾個班。`null` 代表不受限制。
 *
 * # 為什麼光有「科目授課權」不夠
 *
 * `canEditSubject` 問的是「你教不教這一科」，答案來自
 * `class_subject_teachers` 而它**不看班級**。所以只擋科目的話，
 * 甲班的數學老師可以把卷子派進乙班——那一份任務會出現在乙班每一位
 * 學生的任務清單上、會產生作答記錄、會進乙班的成績統計，
 * 而乙班的老師只會看到一份自己沒派過的考試。這不是不方便，
 * 是一個人動到了另一個人的學生。
 *
 * 可以派的班有兩種：**這一科在那個班的授課老師**，以及**那個班的
 * 職員**（導師、協同、助教——導師派跨科的小考是正常的事）。
 *
 * @param subjectId 要派的是哪一科。傳 `null` 代表「我教的任何一科」——
 *   只有畫面上先列出可勾選的班時才用得到（那時老師還沒選卷子）。
 *   **真的要寫進資料庫時一律傳實際的科目**，`null` 是比較寬的。
 *   刻意做成必填而不是可省略的參數：省略掉的那一次不會有任何症狀。
 */
export async function assignableClassIds(
  actor: SessionUser,
  subjectId: string | null,
): Promise<string[] | null> {
  if (actor.systemRole === 'SYS_ADMIN' || actor.systemRole === 'SCHOOL_ADMIN') return null;
  if (actor.systemRole === 'SUBJECT_LEAD') return null;

  const [teaching, staffOf] = await Promise.all([
    prisma.classSubjectTeacher.findMany({
      where: { userId: actor.id, ...(subjectId ? { subjectId } : {}) },
      select: { classId: true },
    }),
    prisma.classMembership.findMany({
      // 學生也在 class_memberships 裡，所以一定要排除 STUDENT——
      // 否則被派到某個班當作答對象的老師會取得那個班的派發權。
      where: { userId: actor.id, leftAt: null, role: { not: 'STUDENT' } },
      select: { classId: true },
    }),
  ]);
  return [...new Set([...teaching.map((t) => t.classId), ...staffOf.map((m) => m.classId)])];
}

/**
 * 這個人可以個別指定哪些學生：**可派發班級裡的在學學生**。
 *
 * 個別指定的實際用途是「整班加上補考的那兩位」，而那兩位本來就在
 * 自己的班上。沒有這一道的話，個別指定就是一個繞過班級限制的後門：
 * 全校任何一位學生的 id 都收得到任務。
 */
async function assignableStudentIds(classIds: string[]): Promise<Set<string>> {
  if (classIds.length === 0) return new Set();
  const rows = await prisma.classMembership.findMany({
    where: { classId: { in: classIds }, ...STUDENT_MEMBERSHIP },
    select: { userId: true },
  });
  return new Set(rows.map((r) => r.userId));
}

// ─────────────────────────────────────────────────────────────────

type TargetRows = {
  /**
   * 可以直接寫進 assignment_targets 的列，也直接餵得進 expandRecipients。
   *
   * 沒有值的那一邊**明確寫 null，不是省略**。批次寫入是一句 INSERT，
   * 各列的欄位集合不一樣時，少掉的那一欄會變成「這一列沒有指定」——
   * 而 `assignment_targets_one_side` 的 CHECK 要求至少一邊有值，
   * 於是整批寫入失敗，錯誤訊息還是資料庫的英文約束名。
   */
  rows: { classId: string | null; userId: string | null }[];
  classNames: string[];
  userNames: string[];
};

/**
 * 把「選了哪幾個班、哪幾位學生」查成可以寫進去的列，順便驗一遍。
 *
 * 驗的三件事都會安靜出錯：不存在的 id（RLS 之下別家的班級查不到，
 * 症狀是「派了但沒人收到」）、把任務派給非學生帳號（老師自己會出現在
 * 應交名單上，永遠差一個人沒交），以及**派給不是自己的班**
 * （見 `assignableClassIds`）。
 *
 * 權限擋在這裡而不是擋在路由上，是因為建立與換對象是兩條路徑而
 * 這是它們唯一的交會點。擋在路由上就是擋兩次，而漏掉的那一次
 * 不會有任何症狀——直到有人的卷子出現在別人的班上。
 */
async function resolveTargetInput(
  input: TargetInput,
  actor: SessionUser,
  subjectId: string,
): Promise<TargetRows> {
  const classIds = [...new Set(input.classIds ?? [])].filter(Boolean);
  const userIds = [...new Set(input.userIds ?? [])].filter(Boolean);

  const classes = classIds.length
    ? await prisma.class.findMany({
        where: { id: { in: classIds } },
        select: { id: true, name: true },
      })
    : [];
  if (classes.length !== classIds.length) {
    throw new Error('有一個班級找不到，它可能剛剛被刪掉了。請重新整理再選一次。');
  }

  const allowedClasses = await assignableClassIds(actor, subjectId);
  if (allowedClasses !== null) {
    const denied = classes.filter((c) => !allowedClasses.includes(c.id));
    if (denied.length > 0) {
      throw new Error(
        `你不是${denied.map((c) => `「${c.name}」`).join('、')}的授課老師或導師，` +
          `不能把任務派進去——派進去的話那一班的學生會收到一份他們的老師沒派過的考試。` +
          `要跨班派同一份卷子，請學科召集人或管理員來派。`,
      );
    }
  }

  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds }, deletedAt: null },
        select: { id: true, displayName: true, systemRole: true },
      })
    : [];
  if (users.length !== userIds.length) {
    throw new Error('有一位學生找不到。請重新整理再選一次。');
  }
  // **唯一的例外是「派給自己試考」。**
  //
  // 出卷的老師到現在都沒有辦法從頭到尾看過自己出的卷子：沒有整卷
  // 預覽、印不出來，而唯一一條看得到學生畫面的路徑（開始作答）被
  // 這一道擋著。結果是**第一個從頭到尾看過那份卷子的人是考試當天的
  // 學生**，而「第 12 題印錯了」正是這樣來的。
  //
  // 擋住其他人的理由沒有變（把任務派給同事會讓應交人數永遠多幾個），
  // 而自己這一份不會進應交名單——`expandRecipients` 只認
  // `systemRole = STUDENT`，所以試考的那一份在名單與統計裡都不存在。
  const notStudent = users.filter((u) => u.systemRole !== 'STUDENT' && u.id !== actor.id);
  if (notStudent.length > 0) {
    throw new Error(
      `${notStudent.map((u) => u.displayName).join('、')}不是學生帳號，不能當作派發對象。` +
        `要自己先試考一份，把自己加進來就可以——試考不會算進應交人數，也不進成績統計。`,
    );
  }

  // 個別指定不可以是繞過班級限制的後門。用的是「可派發的班」而不是
  // 「這次選到的班」——補考的那一位常常不在這次勾選的班裡。
  // 自己（試考）不必在名冊裡，班級權限上面已經擋過一次了。
  const students = users.filter((u) => u.id !== actor.id);
  if (allowedClasses !== null && students.length > 0) {
    const reachable = await assignableStudentIds(allowedClasses);
    const outside = students.filter((u) => !reachable.has(u.id));
    if (outside.length > 0) {
      throw new Error(
        `${outside.map((u) => u.displayName).join('、')}不在你帶的班裡，不能個別指定。` +
          `要派給他，請他的班級老師派，或請管理員代為處理。`,
      );
    }
  }

  return {
    rows: [
      ...classes.map((c) => ({ classId: c.id, userId: null })),
      ...users.map((u) => ({ classId: null, userId: u.id })),
    ],
    classNames: classes.map((c) => c.name),
    userNames: users.map((u) => u.displayName),
  };
}

/** 開放與截止時間。資料庫有 CHECK，這裡先擋是為了給一句人話。 */
function normalizeWindow(
  openAt: Date | null,
  dueAt: Date | null,
  opts: { creating: boolean },
): { openAt: Date | null; dueAt: Date | null } {
  if (openAt && dueAt && openAt >= dueAt) {
    throw new Error('截止時間要在開放時間之後。現在這樣設定，沒有人交得出來。');
  }
  if (opts.creating && dueAt && dueAt.getTime() < Date.now()) {
    // 建立時擋，修改時不擋：把截止時間改成現在，是「立刻結束這場考試」
    // 的正常做法。
    throw new Error('截止時間已經過了。請確認年份與日期。');
  }
  return { openAt, dueAt };
}

function normalizeTimeLimit(min: number | null): number | null {
  if (min === null || min === undefined) return null;
  if (!Number.isInteger(min) || min <= 0) {
    throw new Error('作答時限要是正整數的分鐘數。不限時請留白。');
  }
  if (min > 600) throw new Error('作答時限超過 10 小時，這通常是打錯了');
  return min;
}

function normalizeAttempts(n: number): number {
  if (!Number.isInteger(n) || n < 1) throw new Error('作答次數至少是 1 次');
  if (n > 50) throw new Error('作答次數超過 50 次，這通常是打錯了');
  return n;
}

async function requireReadyPaper(paperId: string) {
  const paper = await prisma.examPaper.findFirst({
    where: { id: paperId },
    select: { id: true, title: true, status: true },
  });
  if (!paper) throw new Error('找不到這份試卷');
  if (paper.status !== 'READY') {
    throw new Error(`「${paper.title}」不是可派發的狀態，不能換上去。`);
  }
  return paper;
}

async function audit(
  tenantId: string,
  actorId: string,
  action: string,
  targetId: string,
  after: Record<string, unknown>,
) {
  await prisma.auditLog.create({
    data: {
      tenantId,
      category: 'EXAM',
      action,
      actorId,
      targetType: 'Assignment',
      targetId,
      after: after as never,
    },
  });
}
