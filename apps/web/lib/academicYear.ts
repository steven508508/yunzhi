/**
 * 學年度。
 *
 * # 為什麼這一塊擋住整個部署
 *
 * `Class.academicYearId` 是必填欄位，而在此之前 `AcademicYear`
 * 在程式裡**只被讀過，從來沒有任何寫入路徑**——班級頁面上甚至
 * 直接寫著「目前需要直接寫入資料庫」。
 *
 * 也就是說系統一部署起來，第一件要做的事（開第一個班）就做不了；
 * 而沒有班就沒有名冊、沒有派任務、沒有成績、沒有能力分析。
 * 唯一的解法是叫人去 psql 手動 INSERT 一列，那不是一個可以交付的系統。
 *
 * # isCurrent 只能有一個
 *
 * 「當前學年度」是一整排預設值的來源：開班時預選哪一年、成績統計
 * 的預設範圍、學生看到的是哪一年的班。同時有兩筆是當前的話，
 * 這些地方會各自挑到不同的一筆（取決於每支查詢怎麼排序），
 * 而症狀是「有時候對、有時候不對」——最難查的那一種。
 *
 * 所以「設為當前」是一個交易：先把其他的關掉，再開這一個。
 * schema 沒有辦法表達「這一欄最多只有一列是 true」，所以規則
 * 只能寫在這裡，也因此**改學年度一律要走這個檔案**。
 */
import { prisma } from '@/lib/prisma';
import { requireTenant } from '@/lib/tenant';

export type AcademicYearInput = {
  /** 「115學年度」。同一機構內不重複。 */
  name: string;
  /** `YYYY-MM-DD`。 */
  startDate: string;
  endDate: string;
  /** 建立後直接設為當前學年度。 */
  isCurrent?: boolean;
};

/**
 * 建立學年度。
 *
 * 機構裡還沒有任何「當前」學年度時，這一筆會自動成為當前——
 * 因為第一次部署時它必定是空的，而一個沒有當前學年度的系統，
 * 每一個「預設帶入本學年」的地方都只能亂猜。
 */
export async function createAcademicYear(input: AcademicYearInput, actorId: string) {
  const tenantId = requireTenant();
  const name = cleanName(input.name);
  const startDate = parseDay(input.startDate, '開始日期');
  const endDate = parseDay(input.endDate, '結束日期');
  requireOrder(startDate, endDate);

  const dup = await prisma.academicYear.findFirst({ where: { name }, select: { id: true } });
  if (dup) {
    // schema 有 @@unique([tenantId, name])，這裡先擋是為了訊息：
    // 資料庫丟出來的是 P2002 與欄位名，櫃檯看不懂那是什麼。
    throw new Error(`已經有一個「${name}」了。要改它的日期請直接編輯那一筆。`);
  }

  const created = await prisma.academicYear.create({
    data: { tenantId, name, startDate, endDate },
  });
  await audit(tenantId, actorId, 'year.create', created.id, {
    name,
    startDate: input.startDate,
    endDate: input.endDate,
  });

  const current = await prisma.academicYear.findFirst({
    where: { isCurrent: true },
    select: { id: true },
  });
  if (input.isCurrent || !current) {
    return setCurrentAcademicYear(created.id, actorId);
  }
  return created;
}

export type AcademicYearPatch = Partial<Omit<AcademicYearInput, 'isCurrent'>>;

/**
 * 改名稱或起訖日。
 *
 * 「當前」不從這裡改——見 `setCurrentAcademicYear`，那件事會動到
 * 其他列，不是單純的欄位更新。
 */
export async function updateAcademicYear(
  yearId: string,
  patch: AcademicYearPatch,
  actorId: string,
) {
  const tenantId = requireTenant();
  const before = await prisma.academicYear.findFirst({ where: { id: yearId } });
  if (!before) throw new Error('找不到這個學年度');

  const data: { name?: string; startDate?: Date; endDate?: Date } = {};

  if (patch.name !== undefined) {
    const name = cleanName(patch.name);
    if (name !== before.name) {
      const dup = await prisma.academicYear.findFirst({
        where: { name },
        select: { id: true },
      });
      if (dup) throw new Error(`已經有一個「${name}」了`);
      data.name = name;
    }
  }
  if (patch.startDate !== undefined) data.startDate = parseDay(patch.startDate, '開始日期');
  if (patch.endDate !== undefined) data.endDate = parseDay(patch.endDate, '結束日期');

  // 只改其中一個日期時，要拿另一個**既有的**來比。少了這一步，
  // 「把開始日期改到結束日期之後」會安靜地寫進去。
  requireOrder(data.startDate ?? before.startDate, data.endDate ?? before.endDate);

  if (Object.keys(data).length === 0) return before;

  const after = await prisma.academicYear.update({ where: { id: yearId }, data });
  await audit(tenantId, actorId, 'year.update', yearId, {
    before: { name: before.name, startDate: iso(before.startDate), endDate: iso(before.endDate) },
    after: { name: after.name, startDate: iso(after.startDate), endDate: iso(after.endDate) },
  });
  return after;
}

/**
 * 設為當前學年度。**其他的會同時被取消。**
 *
 * 兩個更新一定要在同一個交易裡。分兩次做的話，中間那一瞬間會出現
 * 「兩個都是當前」或「一個都不是」——而剛好在那一瞬間查詢的請求
 * 會拿到錯的預設值，事後完全查不出原因。
 */
export async function setCurrentAcademicYear(yearId: string, actorId: string) {
  const tenantId = requireTenant();
  const year = await prisma.academicYear.findFirst({ where: { id: yearId } });
  if (!year) throw new Error('找不到這個學年度');
  if (year.isCurrent) return year;

  const [, updated] = await prisma.$transaction([
    prisma.academicYear.updateMany({
      where: { isCurrent: true, id: { not: yearId } },
      data: { isCurrent: false },
    }),
    prisma.academicYear.update({ where: { id: yearId }, data: { isCurrent: true } }),
  ]);

  await audit(tenantId, actorId, 'year.set_current', yearId, { name: year.name });
  return updated;
}

/**
 * 結算一個學年度。**把它的班級收乾淨。**
 *
 * # 為什麼沒有這一支，第二年開學會是一場手工作業
 *
 * `deactivateClass`（`lib/roster.ts`）寫好了、有稽核，但**沒有任何
 * 呼叫端**，而班級沒有 PATCH 路由。所以第二年開學時：
 *
 *   · 舊的 7 個班還在 `/classes` 列表上，永遠
 *   · 200 位學生的 `leftAt` 還是 null
 *   · `listStudentTasks` 對每一位同時回**新舊兩年**的任務，
 *     舊班那幾十份排在他的「已完成」與「已逾期」裡
 *   · `/grades` 與 `/assignments` 的筆數上限被兩年份的資料一起佔
 *
 * 而唯一的收法是 200 次「移出班級」，每一次一個確認對話框，
 * 還要打開七個班的名冊逐列按。這件事一年只發生一次，
 * 所以到第一個學年結束前沒有人會發現——發現的那一天是開學前一週。
 *
 * # 離班日期用學年度的結束日，不是「今天」
 *
 * 因為 `leftAt` 記的是「他什麼時候不在那個班了」。八月中才想到要
 * 結算的話，用今天等於宣稱他在暑假期間還在上學期的班上——而那個
 * 日期會被拿去對照他那段時間的作答。用 `endDate` 是唯一說得通的答案。
 *
 * 例外：結束日還沒到就結算（學年度提早收），那時用今天——
 * 未來的離班日期會讓 `leftAt: null` 的判斷全部失效。
 *
 * # 為什麼是 updateMany 而不是逐位 leaveClass
 *
 * 因為 `leaveClass` 一位一次、還要各查一次 attempt，200 位就是 600 次
 * 往返落在同一個交易裡——那正是名冊匯入撞到的那面牆。這裡每一位的
 * 條件相同，所以一句 `updateMany` 就做得完。
 *
 * 代價是**不擋「有人正在作答」**，所以下面先查一次；有人在考試就整批
 * 停下來並說出是誰。結算是行政作業不是急件，等那一場考完再做。
 */
export async function closeAcademicYear(yearId: string, actorId: string) {
  const tenantId = requireTenant();
  const year = await prisma.academicYear.findFirst({
    where: { id: yearId },
    select: { id: true, name: true, endDate: true, isCurrent: true },
  });
  if (!year) throw new Error('找不到這個學年度');
  if (year.isCurrent) {
    // 把當前學年度收掉之後，開班的表單不知道要預選哪一年，
    // 而新開的班會掛在一個已經結算的年度底下。順序必須是
    // 「先建新的、設為當前，再結算舊的」。
    throw new Error(
      `「${year.name}」是目前的當前學年度，結算之後開班的表單會不知道預選哪一年。` +
        '請先建立新學年度並把它設為當前，再回來結算這一個。',
    );
  }

  const classes = await prisma.class.findMany({
    where: { academicYearId: yearId },
    select: { id: true, name: true, active: true },
  });
  if (classes.length === 0) {
    throw new Error(`「${year.name}」底下沒有任何班級，不需要結算。`);
  }
  const classIds = classes.map((c) => c.id);

  const busy = await prisma.attempt.findMany({
    where: {
      status: 'IN_PROGRESS',
      user: { memberships: { some: { classId: { in: classIds }, leftAt: null } } },
    },
    select: { user: { select: { displayName: true } } },
    take: 5,
  });
  if (busy.length > 0) {
    const names = [...new Set(busy.map((b) => b.user.displayName))].join('、');
    throw new Error(
      `${names} 現在有作答進行中，結算會讓那份考卷從他的清單上消失，所以整批都沒有執行。` +
        '等這場考完再結算。',
    );
  }

  const now = new Date();
  const leftAt = year.endDate < now ? year.endDate : now;

  const [members, deactivated] = await prisma.$transaction([
    prisma.classMembership.updateMany({
      where: { classId: { in: classIds }, leftAt: null },
      data: { leftAt },
    }),
    prisma.class.updateMany({
      where: { id: { in: classIds }, active: true },
      data: { active: false },
    }),
  ]);

  await audit(tenantId, actorId, 'year.close', yearId, {
    name: year.name,
    classes: classes.length,
    classesDeactivated: deactivated.count,
    membershipsClosed: members.count,
    leftAt: leftAt.toISOString(),
  });

  return {
    name: year.name,
    classes: classes.length,
    classesDeactivated: deactivated.count,
    membershipsClosed: members.count,
    leftAt,
  };
}

// ─────────────────────────────────────────────────────────────────

function cleanName(raw: string): string {
  const name = (raw ?? '').trim();
  if (!name) throw new Error('請填寫學年度名稱');
  if (name.length > 40) throw new Error('學年度名稱太長');
  return name;
}

/**
 * 把 `YYYY-MM-DD` 讀成日期。
 *
 * 存 UTC 午夜，因為學年度的起訖是「哪一天」而不是「哪一刻」。
 * 用本地時間存的話，伺服器時區改一次（例如換一台機器、或容器沒設
 * TZ），整批日期會集體跳到前一天——而那時沒有人會想到是時區。
 */
function parseDay(raw: string, what: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((raw ?? '').trim());
  if (!m) throw new Error(`${what}的格式要像 2026-08-01`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    // 2026-02-30 這種：Date 會自動進位成 3 月 2 日而不報錯。
    throw new Error(`${what}「${raw}」不是一個存在的日期`);
  }
  return date;
}

function requireOrder(startDate: Date, endDate: Date) {
  if (endDate.getTime() <= startDate.getTime()) {
    throw new Error(
      '結束日期要晚於開始日期。（115學年度通常是 2026-08-01 到 2027-07-31）',
    );
  }
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * 稽核。分類用 SYSTEM 而不是 USER：學年度是機構的結構設定，
 * 改它會影響之後所有班級的歸屬與統計範圍，與帳號異動不是同一類事。
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
      targetType: action.split('.')[0],
      targetId,
      after: after as never,
    },
  });
}
