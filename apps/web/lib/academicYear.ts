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
