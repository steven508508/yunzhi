/**
 * 班級與名冊。
 *
 * # 這一塊擋住了整個系統
 *
 * 在此之前，`Class` 只在測試裡被建立過，`ClassMembership` 只被讀過
 * 從來沒被寫過——也就是說**沒有任何方式可以建一個班、把學生放進去**。
 * 而沒有班級與學生，就沒有派任務、沒有作答、沒有能力分析、
 * 沒有家長端。藍圖把它排在 B0 就是這個原因。
 *
 * # 兩個貫穿整份檔案的決定
 *
 * **一、名冊匯入是全有全無。**
 *
 * 一份 32 人的名冊，第 7 列的學號與既有帳號撞了。兩種處理方式：
 * 匯入前 6 位然後報錯，或者整份都不匯入然後報錯。
 *
 * 選後者。理由是**部分匯入之後沒有人知道現在是什麼狀態**：櫃檯人員
 * 改好第 7 列再匯一次，前 6 位就變成重複；他若不改而是手動補，
 * 又要記得從第 7 位開始。這件事發生在開學前一天、櫃檯同時在做
 * 五件事的時候，而錯了的代價是有學生登不進去。
 *
 * 全有全無的代價只是「要改完才能匯」，而那是可以承受的。
 *
 * **二、學生帳號預設不能登入，直到家長同意。**
 *
 * 個資法第 15 條與施行細則：蒐集未成年人的個人資料需法定代理人
 * 同意。系統處理的是未成年人的教育資料，這不是形式問題——
 * 沒有同意紀錄，整個資料庫的合法性都有疑問。
 *
 * 所以 `consentAt` 是 null 的學生帳號一律 `PENDING`，登入會被擋，
 * 而擋的訊息要說得出「請家長完成同意」而不是「帳號無法登入」。
 */
import { randomBytes } from 'node:crypto';

import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/password';
import { requireTenant } from '@/lib/tenant';
import { decodeCsv, matchColumns, parseCsv } from '@/lib/csv.mjs';
import { ROSTER_COLUMNS as COLUMNS, parseBirth } from '@/lib/rosterColumns.mjs';

// ─────────────────────────────────────────────────────────────────
// 班級
// ─────────────────────────────────────────────────────────────────

export type ClassInput = {
  academicYearId: string;
  name: string;
  type?: 'HOMEROOM' | 'GROUP';
};

export async function createClass(input: ClassInput, actorId: string) {
  const tenantId = requireTenant();
  const name = input.name.trim();
  if (!name) throw new Error('請填寫班級名稱');
  if (name.length > 60) throw new Error('班級名稱太長');

  const year = await prisma.academicYear.findFirst({
    where: { id: input.academicYearId },
    select: { id: true, name: true },
  });
  if (!year) throw new Error('找不到這個學年度');

  const dup = await prisma.class.findFirst({
    where: { academicYearId: year.id, name },
    select: { id: true, active: true },
  });
  if (dup) {
    // 訊息要說出「在哪個學年度」——同名班級在不同學年度是正常的，
    // 而櫃檯最常見的困惑就是「我明明沒有建過」。
    throw new Error(
      dup.active
        ? `${year.name}已經有一個「${name}」了`
        : `${year.name}有一個已停用的「${name}」。要重新啟用它，還是換個名稱？`,
    );
  }

  const created = await prisma.class.create({
    data: { tenantId, academicYearId: year.id, name, type: input.type ?? 'HOMEROOM' },
  });
  await audit(tenantId, actorId, 'class.create', created.id, { name, year: year.name });
  return created;
}

export async function renameClass(classId: string, name: string, actorId: string) {
  const tenantId = requireTenant();
  const before = await prisma.class.findFirst({
    where: { id: classId },
    select: { id: true, name: true, academicYearId: true },
  });
  if (!before) throw new Error('找不到這個班級');

  const clean = name.trim();
  if (!clean) throw new Error('請填寫班級名稱');
  if (clean === before.name) return before;

  const dup = await prisma.class.findFirst({
    where: { academicYearId: before.academicYearId, name: clean },
    select: { id: true },
  });
  if (dup) throw new Error(`這個學年度已經有一個「${clean}」了`);

  const after = await prisma.class.update({ where: { id: classId }, data: { name: clean } });
  await audit(tenantId, actorId, 'class.rename', classId, { from: before.name, to: clean });
  return after;
}

/**
 * 停用班級。**不刪除。**
 *
 * 刪掉一個班會連帶刪掉 membership（schema 是 onDelete: Cascade），
 * 而 membership 是「這位學生當時屬於哪個班」的唯一記錄——成績單、
 * 能力分析的班級比較、家長週報全部靠它。刪掉之後那些歷史資料就
 * 對不回班級了。
 *
 * 所以停用是把 active 設為 false，班級與名冊都留著。真的要刪除
 * 是另一件事，而且應該要有更高的權限與更明確的警告。
 */
export async function deactivateClass(classId: string, actorId: string) {
  const tenantId = requireTenant();
  const klass = await prisma.class.findFirst({
    where: { id: classId },
    select: { id: true, name: true, _count: { select: { memberships: true } } },
  });
  if (!klass) throw new Error('找不到這個班級');

  await prisma.class.update({ where: { id: classId }, data: { active: false } });
  await audit(tenantId, actorId, 'class.deactivate', classId, {
    name: klass.name,
    members: klass._count.memberships,
  });
  return klass;
}

// ─────────────────────────────────────────────────────────────────
// 名冊
// ─────────────────────────────────────────────────────────────────

export { ROSTER_COLUMNS } from '@/lib/rosterColumns.mjs';

export type RosterRow = {
  line: number;
  username: string;
  displayName: string;
  email?: string | null;
  guardianEmail?: string | null;
  birthDate?: Date | null;
};

export type RosterProblem = { line: number; column?: string; message: string };

export type RosterPlan = {
  encoding: string;
  rows: RosterRow[];
  problems: RosterProblem[];
  /** 這份名冊裡已經存在的帳號（會被加進班級，不會重建）。 */
  existing: string[];
  /** 會被新建的帳號。 */
  creating: string[];
};

/**
 * 讀一份名冊並產出「打算做什麼」，**但不寫入任何東西**。
 *
 * 分成 plan 與 apply 兩步，是為了讓櫃檯在按下確認之前看得到
 * 「會新增 28 位、其中 4 位已經有帳號、第 7 列有問題」。
 * 一次做完的話，錯誤只能在事後補救，而名冊匯入的事後補救很痛苦。
 */
export async function planRoster(bytes: Uint8Array): Promise<RosterPlan> {
  requireTenant();
  const { text, encoding } = decodeCsv(bytes);
  const table = parseCsv(text);
  const problems: RosterProblem[] = [];

  if (table.length === 0) throw new Error('這個檔案是空的');
  const cols = matchColumns(table[0], COLUMNS);

  for (const need of ['username', 'displayName'] as const) {
    if (cols[need] === undefined) {
      const names = (COLUMNS[need] as readonly string[]).slice(0, 3).join('、');
      throw new Error(
        `找不到「${need === 'username' ? '學號' : '姓名'}」欄。` +
          `第一列要是欄位標題，可以叫 ${names} 等等。` +
          `這個檔案的第一列是：${table[0].slice(0, 6).join('、')}`,
      );
    }
  }

  const rows: RosterRow[] = [];
  const seen = new Map<string, number>();

  for (let i = 1; i < table.length; i++) {
    const line = i + 1; // 給人看的列號，1 起算且含標題列
    const cell = (k: keyof typeof COLUMNS) =>
      (cols[k] !== undefined ? (table[i][cols[k]] ?? '') : '').trim();

    const username = cell('username');
    const displayName = cell('displayName');
    if (!username && !displayName) continue; // 空列
    if (!username) {
      problems.push({ line, column: '學號', message: '沒有學號' });
      continue;
    }
    if (!displayName) {
      problems.push({ line, column: '姓名', message: `學號 ${username} 沒有姓名` });
      continue;
    }
    if (seen.has(username)) {
      problems.push({
        line,
        column: '學號',
        message: `學號 ${username} 與第 ${seen.get(username)} 列重複`,
      });
      continue;
    }
    seen.set(username, line);

    const birthRaw = cell('birthDate');
    const birthDate = birthRaw ? parseBirth(birthRaw) : null;
    if (birthRaw && !birthDate) {
      problems.push({ line, column: '生日', message: `讀不懂的日期「${birthRaw}」` });
      continue;
    }

    const guardianEmail = cell('guardianEmail') || null;
    if (guardianEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(guardianEmail)) {
      problems.push({ line, column: '家長email', message: `不像信箱的「${guardianEmail}」` });
      continue;
    }

    rows.push({
      line,
      username,
      displayName,
      email: cell('email') || null,
      guardianEmail,
      birthDate,
    });
  }

  const names = rows.map((r) => r.username);
  const already = names.length
    ? await prisma.user.findMany({
        where: { username: { in: names } },
        select: { username: true },
      })
    : [];
  const existing = new Set(already.map((u) => u.username));

  return {
    encoding,
    rows,
    problems,
    existing: [...existing],
    creating: names.filter((n) => !existing.has(n)),
  };
}

export type RosterResult = {
  created: number;
  linked: number;
  /** 新帳號的初始密碼。**只在這一次回傳，不會再取得。** */
  credentials: { username: string; displayName: string; password: string }[];
};

/**
 * 把名冊套用到一個班級。**有任何問題就整份不做。**
 */
export async function applyRoster(
  classId: string,
  plan: RosterPlan,
  actorId: string,
): Promise<RosterResult> {
  const tenantId = requireTenant();
  if (plan.problems.length) {
    throw new Error(
      `名冊有 ${plan.problems.length} 個問題，整份都沒有匯入。` +
        `修正之後再匯一次——部分匯入之後沒有人知道現在是什麼狀態。`,
    );
  }
  if (plan.rows.length === 0) throw new Error('這份名冊沒有任何一列資料');

  const klass = await prisma.class.findFirst({
    where: { id: classId },
    select: { id: true, name: true },
  });
  if (!klass) throw new Error('找不到這個班級');

  const credentials: RosterResult['credentials'] = [];
  let created = 0;
  let linked = 0;

  // 一個交易。全有全無不是靠事後補救，是靠資料庫。
  await prisma.$transaction(async (tx) => {
    for (const row of plan.rows) {
      let user = await tx.user.findFirst({
        where: { username: row.username },
        select: { id: true, displayName: true },
      });

      if (!user) {
        const password = newPassword();
        user = await tx.user.create({
          data: {
            tenantId,
            username: row.username,
            displayName: row.displayName,
            email: row.email,
            guardianEmail: row.guardianEmail,
            birthDate: row.birthDate,
            systemRole: 'STUDENT',
            passwordHash: await hashPassword(password),
            mustChangePassword: true,
            // 家長同意之前不得登入。個資法第 15 條：蒐集未成年人的
            // 個人資料需法定代理人同意。這裡預設擋住，
            // 由 recordConsent 開啟。
            status: 'PENDING_CONSENT',
          },
          select: { id: true, displayName: true },
        });
        credentials.push({
          username: row.username,
          displayName: row.displayName,
          password,
        });
        created++;
      }

      await tx.classMembership.upsert({
        where: {
          classId_userId_role: { classId, userId: user.id, role: 'STUDENT' },
        },
        create: { classId, userId: user.id, role: 'STUDENT' },
        // 已經在班上就把 leftAt 清掉（重新入班），不要建第二筆。
        update: { leftAt: null },
      });
      linked++;
    }
  });

  await audit(tenantId, actorId, 'roster.import', classId, {
    class: klass.name,
    created,
    linked,
    encoding: plan.encoding,
  });

  return { created, linked, credentials };
}

/**
 * 初始密碼。
 *
 * 刻意避開容易看錯的字元（0/O、1/l/I）——這串密碼會被印在紙上發給
 * 學生，而「登不進去」的客服成本遠高於少幾個字元的熵。
 * 長度補回來：10 碼、28 種字元，約 48 bit，而且是一次性的
 * （mustChangePassword）。
 */
function newPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(10);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

// ─────────────────────────────────────────────────────────────────
// 家長與同意
// ─────────────────────────────────────────────────────────────────

/**
 * 記錄法定代理人的同意，並開啟學生帳號。
 *
 * **這是個資法的要件，不是一個核取方塊。** 要記得下來的是：
 * 誰同意的、什麼時候、以及是透過什麼方式。前兩者存在
 * `User.consentAt` 與稽核記錄裡；「什麼方式」寫在 audit 的 after，
 * 因為現場同意（櫃檯報名時當場簽）與線上同意的證據力不同。
 */
export async function recordConsent(
  studentId: string,
  actorId: string,
  method: 'IN_PERSON' | 'ONLINE' | 'PAPER',
  note?: string,
) {
  const tenantId = requireTenant();
  const student = await prisma.user.findFirst({
    where: { id: studentId, systemRole: 'STUDENT' },
    select: { id: true, displayName: true, username: true, consentAt: true },
  });
  if (!student) throw new Error('找不到這位學生');
  if (student.consentAt) return student;

  const updated = await prisma.user.update({
    where: { id: studentId },
    data: { consentAt: new Date(), status: 'ACTIVE' },
    select: { id: true, displayName: true, username: true, consentAt: true },
  });
  await audit(tenantId, actorId, 'consent.record', studentId, {
    student: student.username,
    method,
    note: note ?? null,
  });
  return updated;
}

/**
 * 綁定家長與學生。
 *
 * `verifiedAt` 預設是 null——**建立連結不等於驗證過**。櫃檯輸入的
 * 家長信箱可能打錯，而一個沒驗證過的連結若直接開始送成績通知，
 * 就是把學生的成績寄給陌生人。驗證流程（寄確認信）屬於 B5 通知模組，
 * 這裡先把關係與「還沒驗證」這件事記下來。
 */
export async function linkGuardian(guardianId: string, studentId: string, actorId: string) {
  const tenantId = requireTenant();
  const [guardian, student] = await Promise.all([
    prisma.user.findFirst({ where: { id: guardianId }, select: { id: true, username: true } }),
    prisma.user.findFirst({ where: { id: studentId }, select: { id: true, username: true } }),
  ]);
  if (!guardian) throw new Error('找不到這位家長帳號');
  if (!student) throw new Error('找不到這位學生');
  if (guardianId === studentId) throw new Error('不能把自己綁成自己的家長');

  const link = await prisma.guardianLink.upsert({
    where: { guardianId_studentId: { guardianId, studentId } },
    create: { guardianId, studentId },
    update: {},
  });
  await audit(tenantId, actorId, 'guardian.link', link.id, {
    guardian: guardian.username,
    student: student.username,
  });
  return link;
}

// ─────────────────────────────────────────────────────────────────

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
      category: 'USER',
      action,
      actorId,
      targetType: action.split('.')[0],
      targetId,
      after: after as never,
    },
  });
}
