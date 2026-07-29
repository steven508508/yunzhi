/**
 * 科目的建立、改名與停用。
 *
 * # 這一塊擋住的是什麼
 *
 * 標準的 13 科由開機種子建好（見 `lib/subjects.mjs`），所以這一頁
 * 不是「裝完之後的第一件工作」。它補的是另外三件事：
 *
 *   · **改名。** 每一家補習班的講法不同——「公民」與「公民與社會」、
 *     「地科」與「地球科學」。名字出現在老師的每一個下拉選單與學生的
 *     成績單上，改不了的話，全機構就要遷就一個寫死在種子裡的字串。
 *   · **加科。** 學測考科以外的東西（作文班、英聽、術科）在補習班是
 *     真的存在的，而它們也要能出題、派卷、算成績。
 *   · **停用。** 一科停開之後，它還會出現在每一個下拉選單裡，老師遲早
 *     會挑錯，然後那份卷子掛在一個沒有人在教的科目底下。
 *
 * # 為什麼代碼建立之後不能改
 *
 * `Subject.code` 是 AI 匯入管線與網頁端之間的契約（管線送回來的是
 * `apps/ai/pipeline/canonical.py` 的 `SubjectCode` 字串），而分科的
 * `parentCode` 指的也是代碼而不是 id。
 *
 * 改一次代碼，兩件事會同時安靜地壞掉：管線送回 `CHEMISTRY` 的題目
 * 對不上任何一科（匯入畫面上仍然是綠燈，題目落在候選裡沒有人看得到），
 * 而所有 `parentCode` 指著舊代碼的分科會失去上層——級分換算查不到
 * 滿分，成績頁的級分欄整欄空白。
 *
 * 兩者都沒有錯誤訊息。所以這裡只開放改**名稱**，代碼一經建立就固定；
 * 真的要換代碼就建一個新科目，讓舊的停用。
 */
import { prisma } from '@/lib/prisma';
import { requireTenant } from '@/lib/tenant';
import {
  checkParentCode,
  checkSubjectCode,
  checkSubjectName,
} from '@/lib/subjects.mjs';

export type SubjectInput = {
  code: string;
  name: string;
  /** 分科所屬的學測合科代碼。合科本身留空。 */
  parentCode?: string | null;
  /** 學測滿分。分科沒有自己的滿分，一律留空。 */
  gsatFullScore?: number | null;
};

/**
 * 現有科目的代碼 → 它的上層代碼。`checkParentCode` 要用它判斷
 * 「指到的那一科存不存在、是不是自己也是分科」。
 */
async function codeToParent(): Promise<Map<string, string | null>> {
  const rows = await prisma.subject.findMany({
    select: { code: true, parentCode: true },
  });
  return new Map(rows.map((r) => [r.code, r.parentCode]));
}

export async function createSubject(input: SubjectInput, actorId: string) {
  const tenantId = requireTenant();
  const known = await codeToParent();

  const code = (input.code ?? '').trim().toUpperCase();
  const codeProblem = checkSubjectCode(code, new Set(known.keys()));
  if (codeProblem) throw new Error(codeProblem);

  const name = (input.name ?? '').trim();
  const nameProblem = checkSubjectName(name);
  if (nameProblem) throw new Error(nameProblem);

  const parentCode = (input.parentCode ?? '').trim() || null;
  const parentProblem = checkParentCode(parentCode, known);
  if (parentProblem) throw new Error(parentProblem);

  // 分科不給滿分。給了的話級分換算會用分科自己的滿分算，而分科不是
  // 獨立考科——那個級分沒有任何意義，但畫面上它看起來與其他科一樣。
  const gsatFullScore = parentCode ? null : (input.gsatFullScore ?? null);
  if (gsatFullScore !== null && (!Number.isInteger(gsatFullScore) || gsatFullScore <= 0)) {
    throw new Error('學測滿分要是正整數（國英數 100、自然 128、社會 144）。');
  }

  // 排在最後。插在中間的話，全機構每一個下拉選單的科目順序都會在
  // 這一次之後改變，而老師是靠位置在記的。
  const last = await prisma.subject.findFirst({
    orderBy: { order: 'desc' },
    select: { order: true },
  });

  const created = await prisma.subject.create({
    data: {
      tenantId,
      code,
      name,
      parentCode,
      gsatFullScore,
      order: (last?.order ?? 0) + 1,
    },
  });
  await audit(tenantId, actorId, 'subject.create', created.id, {
    code,
    name,
    parentCode,
    gsatFullScore,
  });
  return created;
}

/**
 * 改名。**只有名稱**——代碼與上層合科不從這裡改，理由見檔頭。
 */
export async function renameSubject(subjectId: string, rawName: string, actorId: string) {
  const tenantId = requireTenant();
  const before = await prisma.subject.findFirst({ where: { id: subjectId } });
  if (!before) throw new Error('找不到這個科目');

  const name = (rawName ?? '').trim();
  const problem = checkSubjectName(name);
  if (problem) throw new Error(problem);
  if (name === before.name) return before;

  const after = await prisma.subject.update({
    where: { id: subjectId },
    data: { name },
  });
  await audit(tenantId, actorId, 'subject.rename', subjectId, {
    code: before.code,
    from: before.name,
    to: name,
  });
  return after;
}

/**
 * 一個科目正在被誰用著。停用前要說得出來——「不能停用」是句廢話，
 * 「這一科底下有 812 題與 6 份卷子」才讓人知道下一步要做什麼。
 *
 * 不對外開放：畫面上的數字走頁面自己的 `_count`（那一次查詢本來就要做），
 * 這裡的版本是給**擋下停用**用的，兩者的用途不同——一個是資訊，
 * 一個是規則，而規則不該有第二個呼叫端悄悄繞過去。
 */
type SubjectUsage = {
  questions: number;
  papers: number;
  knowledgePoints: number;
  teachers: number;
  children: number;
};

async function subjectUsage(subjectId: string): Promise<SubjectUsage> {
  const subject = await prisma.subject.findFirst({
    where: { id: subjectId },
    select: { code: true },
  });
  if (!subject) throw new Error('找不到這個科目');

  const [questions, papers, knowledgePoints, teachers, children] = await Promise.all([
    prisma.question.count({ where: { subjectId } }),
    prisma.examPaper.count({ where: { subjectId } }),
    prisma.knowledgePoint.count({ where: { subjectId } }),
    prisma.classSubjectTeacher.count({ where: { subjectId } }),
    // 分科掛在合科底下靠的是 parentCode 這個**字串**而不是外鍵，
    // 所以停用合科時資料庫不會擋——要自己數。
    prisma.subject.count({ where: { parentCode: subject.code, active: true } }),
  ]);
  return { questions, papers, knowledgePoints, teachers, children };
}

/**
 * 停用或重新啟用。
 *
 * # 為什麼停用會被擋下來
 *
 * 停用之後這一科從所有下拉選單消失（`/bank`、`/import/new`、`/papers`、
 * `/knowledge` 查的都是 `where: { active: true }`）。題庫裡還有 800 題
 * 掛在它底下的話，那 800 題就**從畫面上整個消失**——沒有刪除、沒有
 * 警告、沒有一個地方看得到它們，而老師會以為題庫壞了然後重新匯入一次。
 *
 * 卷子同理：一份掛在停用科目上的卷子，組卷頁挑不到題、派卷也選不到它。
 *
 * 所以有題目或卷子在用就擋下來，並且**說出數量**——「不能停用」是句
 * 廢話，「這一科底下有 812 題與 6 份卷子」才讓人知道下一步要做什麼。
 *
 * 知識點、授課老師與分科不擋：它們沒有題目那種「東西不見了」的後果，
 * 但會一併列出來，因為停用之後那些老師確實會失去這一科的成績檢視權。
 *
 * **重新啟用一律放行。** 它只會讓東西重新出現，不會弄壞任何東西，
 * 而擋住它等於把誤停用變成一條死路。
 */
export async function setSubjectActive(
  subjectId: string,
  active: boolean,
  actorId: string,
) {
  const tenantId = requireTenant();
  const before = await prisma.subject.findFirst({ where: { id: subjectId } });
  if (!before) throw new Error('找不到這個科目');
  if (before.active === active) return before;

  if (!active) {
    const use = await subjectUsage(subjectId);
    if (use.questions > 0 || use.papers > 0) {
      const parts: string[] = [];
      if (use.questions > 0) parts.push(`${use.questions} 題`);
      if (use.papers > 0) parts.push(`${use.papers} 份卷子`);
      throw new Error(
        `「${before.name}」底下還有 ${parts.join('、')}在用，不能停用。` +
          '停用之後這一科會從題庫、匯入、組卷的科目清單裡消失，' +
          '那些題目與卷子在畫面上就找不到了——沒有刪除，但也沒有任何入口。' +
          '請先把它們搬到別的科目或封存那幾份卷子。',
      );
    }
  }

  const after = await prisma.subject.update({
    where: { id: subjectId },
    data: { active },
  });
  await audit(
    tenantId,
    actorId,
    active ? 'subject.reactivate' : 'subject.deactivate',
    subjectId,
    { code: before.code, name: before.name },
  );
  return after;
}

/**
 * 稽核。分類用 SYSTEM 而不是 USER，與學年度同一個理由：科目是機構的
 * 結構設定，改它會影響之後所有題目與卷子的歸屬，與帳號異動不是同一類事。
 * 查的人翻 SYSTEM 就看得到「這個機構的結構被誰動過」的完整時間線。
 */
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
      category: 'SYSTEM',
      action,
      actorId,
      targetType: 'Subject',
      targetId,
      after: after as never,
    },
  });
}
