/**
 * 組卷。
 *
 * # 這一塊把題庫接到學生身上
 *
 * 在此之前，題目進了題庫就停在那裡：`ExamPaper` 只存在於 schema，
 * 沒有任何程式建得出一份卷子，於是也沒有東西可以派、可以作答、
 * 可以計分。藍圖 B2 的前半段就是這個檔案。
 *
 * # 五個貫穿整份檔案的決定
 *
 * **一、`totalScore` 是算出來寫回去的，不是每次列表再加總一次。**
 *
 * 一份卷子的總分在列表頁、任務頁、成績頁、學生的作答畫面上都要出現。
 * 每次都 join `exam_paper_items` 加總，等於為了一個幾乎不變的數字
 * 反覆掃一張會長到幾十萬列的表。所以每一次題目變動（加、減、改配分、
 * 重排）都在**同一個交易裡**重算並寫回——快取與來源不同步的唯一防法
 * 是不給它們不同步的機會。
 *
 * **二、只有校對完的題目進得了卷子。**
 *
 * `DRAFT` 的題目是匯入之後還沒有人逐字看過的：選項可能少一個、
 * 答案可能是錯的、數學式可能沒轉好。那種題目出現在考卷上，
 * 代價是整場考試的成績都要重算。所以這裡只收 `PUBLISHED` 與
 * `PENDING_REVIEW`——後者是「校對過但還沒發布」，內容是可信的。
 *
 * **三、已經有人開始作答的卷子不給改。**
 *
 * `Attempt.layout` 會把題目順序與配分快照起來，所以改題目不會影響
 * **正在作答**的人（見 schema 的區塊註解一）。但它保護不了還沒開始的人：
 * 老師在第一節課後加了一題，第二節課的班就多寫一題，而兩班的成績
 * 會被放在同一張統計表上比較。這件事不會有任何錯誤訊息。
 *
 * **四、重排是整批送、在一個交易裡做、而且分兩階段。**
 *
 * `UNIQUE (paperId, order)` 不是 deferrable，Postgres 在每一個
 * UPDATE 當下就檢查。所以「把第 3 題移到第 1 題」若一列一列改，
 * 第一次 UPDATE 就會撞上還沒讓開的那一列。理由與做法見
 * `reorderPaperItems`。
 *
 * **五、分科的題目進得了合科的卷子。**
 *
 * 學測的自然與社會是合科考卷，補習班卻是分科教的。只比對 subjectId
 * 的話，自然與社會的模考卷一題都組不出來。見 `subjectAllows`。
 */
import { prisma } from '@/lib/prisma';
import { requireTenant } from '@/lib/tenant';
import { mayUse } from '@/lib/nav';
import { alreadyPicked, usageByQuestion } from '@/lib/paperPlan.mjs';

/** 進得了卷子的題目狀態。理由見檔案開頭的決定二。 */
export const COMPOSABLE_QUESTION_STATUS = ['PUBLISHED', 'PENDING_REVIEW'] as const;

/**
 * 誰進得了組卷與派任務這一區。
 *
 * 規則的正本是 `lib/nav.ts`——那個檔案的開頭寫得很清楚：連結畫不畫
 * 與頁面擋不擋必須是同一份規則，否則學生改一下網址就進來了。
 *
 * 這個函式在 `/papers` 與 `/assignments` 還沒登錄進 `NAV_ITEMS` 的
 * 那幾個小時裡，暫時自己帶了一份角色清單。**現在兩條路徑都登錄了，
 * 那份清單已經刪掉**——留著只是多一個會跟正本對不起來的地方。
 *
 * 函式本身保留，因為它把「這一區只吃這兩條路徑」寫進了型別：
 * 打錯字會在編譯期被抓到，而 `mayUse()` 收任意字串、打錯只會安靜地
 * 回 false，症狀是整區的人都進不去而且沒有錯誤訊息。
 */
export function mayComposeArea(systemRole: string, href: '/papers' | '/assignments'): boolean {
  return mayUse(systemRole, href);
}

// ─────────────────────────────────────────────────────────────────
// 試卷
// ─────────────────────────────────────────────────────────────────

export type PaperInput = {
  subjectId: string;
  title: string;
  instructions?: string | null;
};

export async function createPaper(input: PaperInput, actorId: string) {
  const tenantId = requireTenant();
  const title = input.title.trim();
  if (!title) throw new Error('請填寫卷名');
  if (title.length > 120) throw new Error('卷名太長。它會印在考卷最上方。');

  const subject = await prisma.subject.findFirst({
    where: { id: input.subjectId },
    select: { id: true, name: true },
  });
  if (!subject) throw new Error('找不到這個科目');

  // 同名不擋。「第一次段考模擬」每個學期都會出現一份，而它們是
  // 不同的卷子——擋掉只會逼老師在卷名後面加日期，那本來就有
  // createdAt 可以看。
  const paper = await prisma.examPaper.create({
    data: {
      tenantId,
      subjectId: subject.id,
      title,
      instructions: input.instructions?.trim() || null,
      createdBy: actorId,
    },
  });
  await audit(tenantId, actorId, 'paper.create', paper.id, { subject: subject.name, title });
  return paper;
}

/** 更名與改說明文字。兩者都不影響已經派出去的任務。 */
export async function updatePaper(
  paperId: string,
  patch: { title?: string; instructions?: string | null },
  actorId: string,
) {
  const tenantId = requireTenant();
  const before = await prisma.examPaper.findFirst({
    where: { id: paperId },
    select: { id: true, title: true, instructions: true },
  });
  if (!before) throw new Error('找不到這份試卷');

  const data: { title?: string; instructions?: string | null } = {};
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new Error('請填寫卷名');
    if (title.length > 120) throw new Error('卷名太長。它會印在考卷最上方。');
    if (title !== before.title) data.title = title;
  }
  if (patch.instructions !== undefined) {
    const text = patch.instructions?.trim() || null;
    if (text !== before.instructions) data.instructions = text;
  }
  if (Object.keys(data).length === 0) return before;

  const after = await prisma.examPaper.update({ where: { id: paperId }, data });
  await audit(tenantId, actorId, 'paper.update', paperId, { before: before.title, patch: data });
  return after;
}

export type PaperStatus = 'DRAFT' | 'READY' | 'ARCHIVED';

/**
 * 改試卷狀態。
 *
 * 三個狀態對應三件真實的事：還在編（DRAFT）、可以派了（READY）、
 * 這學期不用了（ARCHIVED）。
 *
 * **標記為 READY 之前一定要有題目。** 一份沒有題目的卷子派出去，
 * 學生打開會看到一頁空白，而老師在列表上看到的是一份長得完全正常的
 * 任務——這是那種「要等到考試當天才會發現」的錯。
 *
 * 從 READY 退回 DRAFT 是允許的（發現有一題出錯要抽掉），但已經有人
 * 作答的卷子不給退：那等於在考試進行中把卷子收回去編輯。
 */
export async function setPaperStatus(paperId: string, status: PaperStatus, actorId: string) {
  const tenantId = requireTenant();
  const paper = await prisma.examPaper.findFirst({
    where: { id: paperId },
    select: { id: true, title: true, status: true, totalScore: true },
  });
  if (!paper) throw new Error('找不到這份試卷');
  if (paper.status === status) return paper;

  if (status === 'READY') {
    const n = await prisma.examPaperItem.count({ where: { paperId } });
    if (n === 0) {
      throw new Error(
        `「${paper.title}」還沒有任何題目。空白的卷子派出去，學生會打開一頁空白，` +
          `而你在任務列表上看到的是一份長得完全正常的任務。`,
      );
    }
    if (paper.totalScore <= 0) {
      throw new Error(
        `「${paper.title}」的總分是 0。請先給每一題配分——` +
          `總分 0 的卷子交出來每個人都是滿分。`,
      );
    }
  }

  if (status === 'DRAFT') {
    const busy = await attemptsOnPaper(paperId);
    if (busy.total > 0) {
      throw new Error(
        `「${paper.title}」已經有 ${busy.total} 人開始作答（${busy.where}），` +
          `退回草稿等於在考試進行中把卷子收回去編輯。`,
      );
    }
  }

  const after = await prisma.examPaper.update({ where: { id: paperId }, data: { status } });
  await audit(tenantId, actorId, 'paper.status', paperId, {
    title: paper.title,
    from: paper.status,
    to: status,
  });
  return after;
}

/**
 * 刪除試卷。**只有從來沒被派過的才刪得掉。**
 *
 * 派過的卷子是成績的來源——`Assignment.paperId` 的外鍵是 Restrict，
 * 硬刪會被資料庫擋下來，但那時使用者看到的是一句 Prisma 的英文錯誤。
 * 在這裡先擋，並且說得出「被哪幾個任務用著」以及「不用了請封存」。
 */
export async function deletePaper(paperId: string, actorId: string) {
  const tenantId = requireTenant();
  const paper = await prisma.examPaper.findFirst({
    where: { id: paperId },
    select: {
      id: true,
      title: true,
      _count: { select: { items: true, assignments: true } },
    },
  });
  if (!paper) throw new Error('找不到這份試卷');

  if (paper._count.assignments > 0) {
    throw new Error(
      `「${paper.title}」已經派給 ${paper._count.assignments} 個任務，不能刪除——` +
        `那些任務的成績要靠它才知道每一題值幾分。不再使用請改成封存。`,
    );
  }

  // 題目本身不會跟著消失：exam_paper_items 是引用，onDelete 是
  // Cascade 刪掉引用，questions 那邊是 Restrict 動不到。
  await prisma.examPaper.delete({ where: { id: paperId } });
  await audit(tenantId, actorId, 'paper.delete', paperId, {
    title: paper.title,
    items: paper._count.items,
  });
  return paper;
}

/**
 * 複製一份卷子。
 *
 * # 為什麼這件事是必要的，而不是方便
 *
 * `requireEditablePaper` 在有人開始作答之後就鎖住整份卷子，錯誤訊息叫
 * 老師「另外建一份」——而在此之前，「另外建一份」的意思是**從幾百題裡
 * 重挑 25 題**。那句話把老師推向一條系統沒有鋪的路，而且通常是在
 * 考試已經開始、發現有一題印錯的那個當下。
 *
 * 更日常的一種：「上次段考那份改幾題」是出卷最常見的起點。
 *
 * # 三個決定
 *
 * **一、新卷子一律是 DRAFT。** 複製出來的東西還沒有人看過。直接是
 * READY 的話，它會出現在派任務的下拉選單裡，與原本那一份只差卷名。
 *
 * **二、配分照抄，不重算。** `ExamPaperItem.score` 是「這一份卷子上
 * 這一題值幾分」，與題庫的預設配分無關（schema 的欄位註解）。回頭去讀
 * 題庫的話，一份調好配分的卷子複製出來會全部變回 1 分。
 *
 * **三、順序用 1..n 重新編號，不照抄原本的 order。** 原卷刪過題的話
 * order 會有洞（`removePaperItem` 不重新編號），照抄會把洞一起帶過來，
 * 而那個洞在新卷子上沒有任何意義。
 */
export async function duplicatePaper(paperId: string, actorId: string, title?: string) {
  const tenantId = requireTenant();
  const src = await prisma.examPaper.findFirst({
    where: { id: paperId },
    select: {
      id: true,
      subjectId: true,
      title: true,
      instructions: true,
      items: {
        orderBy: { order: 'asc' },
        select: { questionId: true, score: true },
      },
    },
  });
  if (!src) throw new Error('找不到這份試卷');

  const name = (title?.trim() || `${src.title}（複本）`).slice(0, 120);

  const copy = await prisma.$transaction(async (tx) => {
    const created = await tx.examPaper.create({
      data: {
        tenantId,
        subjectId: src.subjectId,
        title: name,
        instructions: src.instructions,
        createdBy: actorId,
      },
    });
    if (src.items.length > 0) {
      await tx.examPaperItem.createMany({
        data: src.items.map((it, i) => ({
          paperId: created.id,
          questionId: it.questionId,
          order: i + 1,
          score: it.score,
        })),
      });
    }
    // 與其他寫入路徑同一條規則：總分在同一個交易裡算出來寫回去。
    // 少了這一行，複本的總分是 0，而它的題目與配分都在——那是
    // 「派得出去、學生考完每個人都滿分」的形狀。
    await recalcTotal(tx, created.id);
    return created;
  });

  await audit(tenantId, actorId, 'paper.duplicate', copy.id, {
    from: src.id,
    fromTitle: src.title,
    title: name,
    items: src.items.length,
  });
  return copy;
}

// ─────────────────────────────────────────────────────────────────
// 卷上的題目
// ─────────────────────────────────────────────────────────────────

/**
 * 加一題到卷子最後面。
 *
 * 配分預設取題目自己的 `score`；那一欄是 0 或空的時候給 1 分。
 * 給 0 的話這一題等於不計分，而畫面上看起來與其他題完全一樣——
 * 學生寫完發現「我明明對了為什麼沒分」。1 分是一個看得見的預設值，
 * 老師會注意到它不對然後改掉。
 */
export async function addPaperItem(
  paperId: string,
  questionId: string,
  actorId: string,
  score?: number,
) {
  const tenantId = requireTenant();
  const paper = await requireEditablePaper(paperId);

  const question = await prisma.question.findFirst({
    where: { id: questionId },
    select: { id: true, subjectId: true, status: true, score: true, familyId: true },
  });
  if (!question) throw new Error('找不到這一題');

  // 兩科一次查回來。分開 join 出來也可以，但這條路徑一次只處理一題，
  // 而少一層巢狀 select 讓這一段可以直接對著真的資料庫驗。
  const subjects = await prisma.subject.findMany({
    where: { id: { in: [paper.subjectId, question.subjectId] } },
    select: { id: true, name: true, code: true, parentCode: true },
  });
  const paperSubject = subjects.find((s) => s.id === paper.subjectId);
  const questionSubject = subjects.find((s) => s.id === question.subjectId);
  if (!paperSubject || !questionSubject) throw new Error('找不到科目');

  if (!subjectAllows(paperSubject, questionSubject)) {
    // 跨科目的題目不是「不合理」，是**篩選條件錯了**：老師在
    // 化學卷上加到生物題，通常是因為左邊的科目篩選沒切過來。
    throw new Error(
      `這一題是${questionSubject.name}，不屬於「${paperSubject.name}」這份卷子的範圍。` +
        `請確認左邊的科目篩選。`,
    );
  }
  if (!(COMPOSABLE_QUESTION_STATUS as readonly string[]).includes(question.status)) {
    throw new Error(
      question.status === 'DRAFT'
        ? '這一題還沒有人校對過，不能出現在考卷上——匯入的題目在校對前，' +
          '選項可能少一個、答案可能是錯的。請先在題庫完成校對。'
        : '這一題已經下架，不能加進卷子。',
    );
  }

  // 重複的兩種：同一列題目，以及**同一題的另一個版本**。
  // 後者資料庫擋不住——`UNIQUE (paperId, questionId)` 看到的是兩個
  // 不同的 id，而它們是同一題改過一次的前後兩版（familyId 跨版本穩定）。
  // 放行的結果是學生在同一張卷子上看到兩題只差一個字的題目，
  // 而那件事在夾成兩行的挑題畫面上看不出來。判斷本身在 paperPlan.mjs。
  const onPaper = await prisma.examPaperItem.findMany({
    where: { paperId },
    select: { order: true, questionId: true, question: { select: { familyId: true } } },
  });
  const dup = alreadyPicked(
    onPaper.map((i) => ({
      questionId: i.questionId,
      familyId: i.question.familyId,
      order: i.order,
    })),
    { questionId: question.id, familyId: question.familyId },
  );
  if (dup) {
    throw new Error(
      dup.kind === 'same'
        ? `這一題已經在卷子上了（第 ${dup.order} 題）`
        : `這一題的另一個版本已經在卷子上了（第 ${dup.order} 題）。` +
          `兩個版本只差在後來修訂的地方，同一張卷子上會出現兩題幾乎一樣的題目。`,
    );
  }

  const value = score !== undefined ? score : question.score > 0 ? question.score : 1;
  assertScore(value);

  const append = () =>
    prisma.$transaction(async (tx) => {
      // 排在最後面。max+1 而不是 count+1——中間刪過題的話 count 會
      // 撞上既有的 order，而那是 UNIQUE 約束，會直接爆。
      const last = await tx.examPaperItem.findFirst({
        where: { paperId },
        orderBy: { order: 'desc' },
        select: { order: true },
      });
      const created = await tx.examPaperItem.create({
        data: { paperId, questionId, order: (last?.order ?? 0) + 1, score: value },
      });
      await recalcTotal(tx, paperId);
      return created;
    });

  // 兩位老師同時在同一份卷子上按「加入」時，兩邊都會讀到同一個
  // max(order)，於是第二個 INSERT 撞上 UNIQUE (paperId, order)。
  // 交易的隔離等級是 READ COMMITTED，這個窗口關不掉，只能重試——
  // 而不重試的話老師看到的是一整段英文的 Prisma 約束錯誤，
  // 題目其實沒加進去，他會再按一次然後看到同一段英文。
  let item: Awaited<ReturnType<typeof append>>;
  try {
    item = await append();
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // 重試一次就夠：第二次讀到的是對方已經寫進去的順序。連續撞上
    // 兩次代表有很多人同時在改同一份卷子，那時該說的是「重新整理」
    // 而不是無止盡地重試。
    try {
      item = await append();
    } catch (again) {
      if (!isUniqueViolation(again)) throw again;
      throw new Error(
        '有人正在同時編輯這份卷子，剛剛那一題沒有加進去。請重新整理，看到最新的內容再加一次。',
      );
    }
  }

  await audit(tenantId, actorId, 'paper.item.add', paperId, {
    paper: paper.title,
    questionId,
    order: item.order,
    score: value,
  });
  return item;
}

/** 從卷子上移除一題。**不重新編號**，理由見 `reorderPaperItems`。 */
export async function removePaperItem(itemId: string, actorId: string) {
  const tenantId = requireTenant();
  const item = await prisma.examPaperItem.findFirst({
    where: { id: itemId },
    select: { id: true, paperId: true, order: true, questionId: true },
  });
  if (!item) throw new Error('找不到這一題，它可能已經被移除了');
  const paper = await requireEditablePaper(item.paperId);

  await prisma.$transaction(async (tx) => {
    await tx.examPaperItem.delete({ where: { id: itemId } });
    await recalcTotal(tx, item.paperId);
  });

  await audit(tenantId, actorId, 'paper.item.remove', item.paperId, {
    paper: paper.title,
    questionId: item.questionId,
    order: item.order,
  });
  return item;
}

/** 改某一題在這份卷子上的配分。題庫裡的預設配分不動。 */
export async function setPaperItemScore(itemId: string, score: number, actorId: string) {
  const tenantId = requireTenant();
  const item = await prisma.examPaperItem.findFirst({
    where: { id: itemId },
    select: { id: true, paperId: true, order: true, score: true },
  });
  if (!item) throw new Error('找不到這一題，它可能已經被移除了');
  const paper = await requireEditablePaper(item.paperId);
  assertScore(score);
  if (score === item.score) return item;

  const after = await prisma.$transaction(async (tx) => {
    const updated = await tx.examPaperItem.update({ where: { id: itemId }, data: { score } });
    await recalcTotal(tx, item.paperId);
    return updated;
  });

  await audit(tenantId, actorId, 'paper.item.score', item.paperId, {
    paper: paper.title,
    order: item.order,
    from: item.score,
    to: score,
  });
  return after;
}

/**
 * 整批改配分。
 *
 * # 為什麼要有這一支
 *
 * 因為 25 題的卷子每一題各送一次，是 25 次 PATCH ＋ 25 次整頁重繪，
 * 而它佔掉老師出一份卷子全部點擊數的四成。「每題 4 分、全部套用」與
 * 「平均分配到 100 分」這兩個一鍵動作，本質上就是一次送 25 個數字。
 *
 * # 為什麼不是在前端跑 25 次單題的那一支
 *
 * 因為那樣就有 25 個各自會失敗的請求，而失敗的那幾題會留在畫面上
 * 顯示新的數字、資料庫裡是舊的。**一個交易一個結果**：全部進去，
 * 或者一題都沒動。`recalcTotal` 也只跑一次，總分與題目不會有中間狀態。
 *
 * @param entries 要改的題目與新配分。沒列到的題目維持原本的配分。
 */
export async function setPaperItemScores(
  paperId: string,
  entries: readonly { itemId: string; score: number }[],
  actorId: string,
) {
  const tenantId = requireTenant();
  const paper = await requireEditablePaper(paperId);

  if (entries.length === 0) throw new Error('沒有要調整的配分');
  const seen = new Set(entries.map((e) => e.itemId));
  if (seen.size !== entries.length) {
    throw new Error('同一題送了兩個配分。請重新整理再試一次。');
  }
  for (const e of entries) assertScore(e.score);

  const total = await prisma.$transaction(async (tx) => {
    // 集合比對放在交易裡，理由與 reorderPaperItems 相同：把「查完到
    // 改完」之間別人動手的空窗縮到最小。這裡還多守一件事——itemId
    // 一定要屬於這份卷子，否則呼叫端拿別份卷子的 id 進來就繞過了
    // 上一層對「這份卷子的科目」判過的權限。
    const mine = await tx.examPaperItem.findMany({
      where: { paperId, id: { in: [...seen] } },
      select: { id: true },
    });
    if (mine.length !== entries.length) {
      throw new Error(
        `送來的 ${entries.length} 題裡有 ${entries.length - mine.length} 題不在這份卷子上。` +
          `通常是有人同時在改同一份卷子——請重新整理，看到最新的內容再改一次。`,
      );
    }
    for (const e of entries) {
      await tx.examPaperItem.update({ where: { id: e.itemId }, data: { score: e.score } });
    }
    return recalcTotal(tx, paperId);
  });

  await audit(tenantId, actorId, 'paper.item.scores', paperId, {
    paper: paper.title,
    count: entries.length,
    total,
  });
  return { count: entries.length, totalScore: total };
}

/**
 * 這幾題**在別的卷子上**用過幾次、用在哪幾份。
 *
 * # 為什麼這一句查詢值得存在
 *
 * `ExamPaperItem` 上的 `@@index([questionId])` 就是為了這個方向建的，
 * 而在這之前全 repo 沒有任何一句用 questionId 反查——索引建了沒人用。
 *
 * 老師實際要回答的問題是「這一題上次段考考過了沒有」。段考卷裡放一題
 * 剛考過的，背過答案的人分數會虛高，而那個異常在成績頁上看起來只是
 * 「這一題答對率特別高」。在這之前唯一的做法是開第二個分頁人工比對
 * 兩份卷子被夾成兩行的題幹。
 *
 * 一次查完再分組，不是一題一句（60 題就是 60 次往返）。
 *
 * @param exceptPaperId 排除掉「這一份」——同一份卷子上的重複由
 *                      `alreadyPicked` 負責，兩件事的訊息完全不同。
 */
export type QuestionUsage = Map<
  string,
  { count: number; papers: { id: string; title: string }[]; more: number }
>;

export async function questionUsage(
  questionIds: readonly string[],
  exceptPaperId: string,
  limit = 2,
): Promise<QuestionUsage> {
  if (questionIds.length === 0) return new Map();
  const rows = await prisma.examPaperItem.findMany({
    where: { questionId: { in: [...questionIds] }, paperId: { not: exceptPaperId } },
    select: {
      questionId: true,
      paperId: true,
      paper: { select: { title: true, updatedAt: true } },
    },
    // 由新到舊：老師要的是「最近哪一份考過」，不是全部的歷史。
    orderBy: { paper: { updatedAt: 'desc' } },
    // 一題被三十份卷子用過是可能的（複習卷抄來抄去），而畫面上只列
    // 前兩份。上限擋住的是「60 題 × 30 份」這種一次拉幾千列的情況。
    take: 400,
  });
  return usageByQuestion(
    rows.map((r) => ({ questionId: r.questionId, paperId: r.paperId, paperTitle: r.paper.title })),
    limit,
  );
}

/**
 * 整批重排。送進來的是**這份卷子全部的題目 id，照新的順序排好**。
 *
 * # 為什麼是整批而不是「把第 3 題移到第 1 題」
 *
 * 因為前端的排序（拖曳或上下移動）本來就是一次算出一個完整的新順序，
 * 而「移動一題」這種增量指令要在伺服器端重建同一個結果，兩邊各算一次
 * 就有兩份實作。整批送的另一個好處是它天然帶著樂觀鎖：id 的集合對不上
 * 就代表有人同時在改，見下面的檢查。
 *
 * # 為什麼要分兩階段
 *
 * `UNIQUE (paperId, order)` 不是 DEFERRABLE，Postgres 在每一個 UPDATE
 * 的當下就檢查唯一性，而不是等到交易結束。所以把第 3 題改成第 1 題時，
 * 現在的第 1 題還坐在那個位置上——直接改會撞上約束。
 *
 * （撞上約束本身是好事：它代表資料庫不會讓卷子出現兩個第 1 題。
 * 但使用者不該看到 "duplicate key value violates unique constraint"。）
 *
 * 所以先把每一題搬到它的**目標順序的負數**（-1、-2、…，彼此唯一，
 * 也不可能撞上任何既有的正數），再一次翻正。兩個階段在同一個交易裡，
 * 中途失敗會整個回滾，不會留下一份順序是負數的卷子。
 */
export async function reorderPaperItems(paperId: string, itemIds: string[], actorId: string) {
  const tenantId = requireTenant();
  const paper = await requireEditablePaper(paperId);

  const seen = new Set(itemIds);
  if (seen.size !== itemIds.length) {
    throw new Error('送來的順序裡有重複的題目。請重新整理再試一次。');
  }

  await prisma.$transaction(async (tx) => {
    // 集合比對放在交易裡，把「查完到改完」之間別人動手的空窗縮到最小。
    const current = await tx.examPaperItem.findMany({
      where: { paperId },
      select: { id: true },
    });
    const known = new Set(current.map((i) => i.id));

    if (current.length !== itemIds.length) {
      throw new Error(
        `這份卷子現在有 ${current.length} 題，但送來的順序有 ${itemIds.length} 題。` +
          `通常是有人同時在改同一份卷子——請重新整理，看到最新的內容再排一次。`,
      );
    }
    // 數目對但有一題不是這份卷子的。分開報，因為「現在有 4 題，
    // 送來也是 4 題」這種訊息只會讓人覺得系統壞了。
    if (itemIds.some((id) => !known.has(id))) {
      throw new Error('送來的順序裡有一題不在這份卷子上。請重新整理再排一次。');
    }

    // 第一階段：全部搬到負數。
    for (const [i, id] of itemIds.entries()) {
      await tx.examPaperItem.update({ where: { id }, data: { order: -(i + 1) } });
    }
    // 第二階段：翻正。此時這份卷子上沒有任何正數順序，撞不到東西。
    for (const [i, id] of itemIds.entries()) {
      await tx.examPaperItem.update({ where: { id }, data: { order: i + 1 } });
    }
  });

  await audit(tenantId, actorId, 'paper.reorder', paperId, {
    paper: paper.title,
    count: itemIds.length,
  });
  return { count: itemIds.length };
}

// ─────────────────────────────────────────────────────────────────

type Tx = Omit<
  typeof prisma,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * 重算並寫回總分。**每一次題目變動都要呼叫，而且要在同一個交易裡。**
 *
 * 分開做的話，中間任何一個失敗都會留下一個「總分與題目對不上」的卷子，
 * 而那不會有任何症狀——直到有人拿它去算成績百分比。
 */
async function recalcTotal(tx: Tx, paperId: string): Promise<number> {
  const items = await tx.examPaperItem.findMany({
    where: { paperId },
    select: { score: true },
  });
  const total = round2(items.reduce((sum, i) => sum + i.score, 0));
  await tx.examPaper.update({ where: { id: paperId }, data: { totalScore: total } });
  return total;
}

/**
 * 浮點數加總會漏出來。
 *
 * 20 題各 2.5 分加起來可能是 49.99999999999999，而那個數字會被印在
 * 卷頭上、被拿去算「得分 / 總分」的百分比。配分不會有超過兩位小數，
 * 所以在這裡收乾淨。
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 這是不是「撞到唯一鍵」。
 *
 * 用字串比對而不是 `instanceof Prisma.PrismaClientKnownRequestError`：
 * 那個 class 要從 `@prisma/client` 匯入一個執行期的值，而這個檔案
 * 目前只需要型別。P2002 是 Prisma 的唯一鍵違反，這個代碼很穩定。
 */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';
}

function assertScore(score: number) {
  if (!Number.isFinite(score)) throw new Error('配分要是一個數字');
  // 資料庫有 CHECK ("score" >= 0)，這裡先擋是為了給一句人話。
  if (score < 0) throw new Error('配分不能是負的。要扣分請調整其他題的配分，不要給負分。');
  if (score > 1000) throw new Error('一題超過 1000 分，這通常是打錯了');
}

/**
 * 這份卷子被哪些任務用著、已經有幾個人動手作答。
 *
 * `where` 回傳一句可以直接接在錯誤訊息裡的話，因為老師需要知道的是
 * 「哪一班已經考了」而不是一個數字。
 */
async function attemptsOnPaper(paperId: string): Promise<{ total: number; where: string }> {
  const used = await prisma.assignment.findMany({
    where: { paperId },
    select: { id: true, title: true, _count: { select: { attempts: true } } },
  });
  const busy = used.filter((a) => a._count.attempts > 0);
  const total = busy.reduce((n, a) => n + a._count.attempts, 0);
  return {
    total,
    where: busy.map((a) => `「${a.title}」`).join('、'),
  };
}

/**
 * 這一題進得了這份卷子嗎——科目的部分。
 *
 * 同一科當然可以。**分科的題目也進得了合科的卷子**：學測的自然與
 * 社會是合科考卷，而補習班是分科教的（化學老師傳的是化學講義），
 * 所以一份「自然」模考卷的題目本來就散在化學、生物、物理底下。
 * 只比對 subjectId 的話，自然與社會的卷子一題都組不出來，
 * 而錯誤訊息會是「這一題不屬於這份卷子的科目」——完全看不出原因。
 *
 * 反方向不通：合科的題目不往分科的卷子裡放。那種題目通常是題組，
 * 拆進單科的卷子會缺上下文。
 */
export function subjectAllows(
  paperSubject: { id: string; code: string },
  questionSubject: { id: string; parentCode: string | null },
): boolean {
  if (questionSubject.id === paperSubject.id) return true;
  return questionSubject.parentCode === paperSubject.code;
}

/**
 * 取出卷子，並確認它現在改得動。
 *
 * 改不動的唯一理由是「已經有人開始作答」。封存的卷子仍然改得動——
 * 封存只代表不再派新的任務，老師把舊卷子拿出來修一修再開封是正常的。
 */
async function requireEditablePaper(paperId: string) {
  const paper = await prisma.examPaper.findFirst({
    where: { id: paperId },
    select: { id: true, title: true, subjectId: true, status: true },
  });
  if (!paper) throw new Error('找不到這份試卷');

  const busy = await attemptsOnPaper(paperId);
  if (busy.total > 0) {
    throw new Error(
      `「${paper.title}」已經有 ${busy.total} 人開始作答（${busy.where}），現在改題目，` +
        `改之前與改之後的人拿到的會是不同的卷子，而他們的成績會被放在同一張表上比較。` +
        `要出一份不一樣的卷子，請另外建一份。`,
    );
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
      // 組卷與派任務都歸 EXAM：schema 的說明是「任務派發、場次作廢」，
      // 而一份卷子的內容變動與派發是同一條事件線上的事。
      category: 'EXAM',
      action,
      actorId,
      targetType: 'ExamPaper',
      targetId,
      after: after as never,
    },
  });
}
