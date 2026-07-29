/**
 * 授課老師與導師的指派。
 *
 * # 這一塊是老師帳號與「他真的能做事」之間唯一的橋
 *
 * 在此之前，`classSubjectTeacher.create` 只出現在 `tools/e2e-import.mjs`
 * 的測試夾具裡——**正式程式碼裡一次都沒有**。而這張表是四個判斷的
 * 唯一依據：
 *
 *   `lib/auth.ts` 的 `canEditSubject`      改不改得動這一科的題目與成績
 *   `lib/scope.mjs` 的 `subjectScope`      看不看得到這一科的成績
 *   `lib/assignment.ts` 的 `assignableClassIds`  派不派得了卷給這個班
 *   `lib/scoring.ts` 的 `gradeScopeWhere`  成績頁上查得到哪幾份任務
 *
 * 也就是說：**沒有指派的老師登得進來，但每一頁對他都是空的**。
 * 而空的畫面與「還沒有資料」長得一模一樣——他會以為系統還沒開始用，
 * 不會來說「我沒有權限」。README 上寫著「派卷之前確認授課老師名單」，
 * 而那份名單在此之前沒有任何介面產生得出來。
 *
 * # 授課老師與導師是兩種職權，不是一種
 *
 * 訪談第 14 題：「派：科目或班級老師／催：班級老師／改：科目或班級
 * 老師」，而且「有時候班級老師就是那一科的老師」。所以：
 *
 *   **授課老師**（`ClassSubjectTeacher`）綁在「班 × 科」上。化學老師
 *   看得到這個班的化學成績，看不到他們的國文成績。
 *
 *   **導師**（`ClassMembership.isHomeroom`）跨科目，管的是班務：
 *   改名冊、匯入名冊、重設全班密碼、催繳。他不會因為當導師就看得到
 *   每一科的成績。
 *
 * 兩者會重疊（一位老師可以同時是這個班的導師與化學老師），所以不能
 * 合成一個旗標。合了之後，要嘛導師看得到全部科目的成績（越權），
 * 要嘛科任老師改得動名冊（不該）。
 *
 * # 為什麼只有管理員能指派
 *
 * 因為這件事**發的是權限**，不是排課表。讓導師指派得動自己班的科任
 * 老師，等於讓他決定誰看得到自己班學生的成績與個人資料——那是機構
 * 要負責的事，不是班級層級的決定。與「開一個新班」同一條規則。
 */
import { prisma } from '@/lib/prisma';
import { requireTenant } from '@/lib/tenant';
import type { SessionUser } from '@/lib/auth';
import { STAFF_ROLE_SET } from '@/lib/staffRules.mjs';

/** 指派得出去的人：可以登入的教職員。學生不在裡面。 */
export async function assignableStaff() {
  return prisma.user.findMany({
    where: {
      // 學生也在 users 裡，而且數量是老師的一百倍。不濾掉的話，
      // 指派老師的下拉會變成一份全校名冊，而「王小明」既是學生
      // 也可能是老師的名字——指派錯的那一位會取得整個班的成績。
      systemRole: { in: [...STAFF_ROLE_SET] as never[] },
      status: 'ACTIVE',
      deletedAt: null,
    },
    orderBy: { displayName: 'asc' },
    select: { id: true, displayName: true, username: true, systemRole: true },
  });
}

/** 這個班目前的授課老師（含已停用的帳號——要看得到才移除得了）。 */
export async function classSubjectTeachers(classId: string) {
  return prisma.classSubjectTeacher.findMany({
    where: { classId },
    orderBy: [{ subject: { order: 'asc' } }, { assignedAt: 'asc' }],
    select: {
      id: true,
      subjectId: true,
      userId: true,
      isPrimary: true,
      subject: { select: { name: true, code: true, active: true } },
      user: { select: { displayName: true, username: true, status: true } },
    },
  });
}

/**
 * 這個人有沒有被指派教這個班（任何一科）。
 *
 * # 為什麼這一支非有不可
 *
 * 因為在此之前，班級頁的存取判定查的是 `ClassMembership`
 * （`classes/[classId]/page.tsx` 的 `mine`、`classes/page.tsx` 的
 * `where`），而授課指派寫的是 `ClassSubjectTeacher`——**兩張表對不上**。
 * 於是一位被指派教七個班數學的老師：
 *
 *   · `/classes` 上一個班都看不到，畫面寫「你還沒有帶任何班」
 *   · `/classes/[classId]` 整頁被 Denied
 *
 * 而重設密碼與登錄家長同意**兩支 API 本來就允許 TEACHER**，
 * 路由檔頭甚至寫了理由：「學生是在櫃檯或教室裡跟現場的那一位老師講
 * 的，而要求他去找導師或管理員，等於這個功能在最需要的那一刻不存在」。
 * **規則寫對了，畫面把它關起來了**——而畫面比 API 嚴是反的。
 *
 * 一週 5 人次的忘記密碼因此全部落在主任身上。
 *
 * # 為什麼不查 `subjectId`
 *
 * 因為問的是「他進不進得了這個班的名冊」，而名冊不分科。他教哪一科
 * 決定的是成績看得到哪幾份（`gradeScopeWhere`），那是另一條規則、
 * 在另一個地方，兩者不該合併。
 */
export async function teachesClass(userId: string, classId: string): Promise<boolean> {
  const row = await prisma.classSubjectTeacher.findFirst({
    where: { userId, classId },
    select: { id: true },
  });
  return Boolean(row);
}

/** 這個班目前的導師。 */
export async function classHomerooms(classId: string) {
  return prisma.classMembership.findMany({
    where: { classId, isHomeroom: true, leftAt: null },
    orderBy: { joinedAt: 'asc' },
    select: {
      id: true,
      userId: true,
      user: { select: { displayName: true, username: true, status: true, systemRole: true } },
    },
  });
}

/**
 * 指派一位老師教這個班的這一科。
 *
 * `isPrimary` 給第一位指派進來的人。一科三位老師是常態（訪談第 1 題），
 * 而「主授」與「協同」的差別日後會用在通知對象與批改責任上——現在
 * 沒有畫面在讀它，但**留一個永遠是 true 的欄位，等於日後要從稽核
 * 記錄裡回推誰是主授**，那時已經回推不出來了。
 */
export async function assignSubjectTeacher(
  classId: string,
  subjectId: string,
  userId: string,
  actor: SessionUser,
) {
  const tenantId = requireTenant();
  const { klass, subject, teacher } = await loadTargets(classId, subjectId, userId);

  const existing = await prisma.classSubjectTeacher.findFirst({
    where: { classId, subjectId, userId },
    select: { id: true },
  });
  if (existing) {
    throw new Error(`${teacher.displayName}已經是「${klass.name}」的${subject.name}老師了。`);
  }

  const already = await prisma.classSubjectTeacher.count({ where: { classId, subjectId } });

  const created = await prisma.classSubjectTeacher.create({
    data: { classId, subjectId, userId, isPrimary: already === 0 },
  });

  await audit(tenantId, actor.id, 'teaching.assign', created.id, {
    class: klass.name,
    subject: subject.name,
    teacher: teacher.username,
    isPrimary: already === 0,
  });
  return created;
}

/**
 * 取消一位老師的授課指派。
 *
 * **不是刪除他做過的事。** 他改過的成績、出過的題目、派過的任務全部
 * 留著——這裡拿掉的只是「他從今以後看不看得到」。所以用 delete 而不是
 * 軟刪除：這一列本身沒有歷史價值，誰在什麼時候被取消指派記在稽核裡。
 */
export async function removeSubjectTeacher(
  classId: string,
  subjectId: string,
  userId: string,
  actor: SessionUser,
) {
  const tenantId = requireTenant();
  const row = await prisma.classSubjectTeacher.findFirst({
    where: { classId, subjectId, userId },
    select: {
      id: true,
      isPrimary: true,
      subject: { select: { name: true } },
      user: { select: { username: true, displayName: true } },
      class: { select: { name: true } },
    },
  });
  if (!row) throw new Error('這筆授課指派已經不在了。請重新整理再看一次。');

  await prisma.classSubjectTeacher.delete({ where: { id: row.id } });

  // 主授被移掉之後，這個班這一科就沒有主授了。把最早指派的那一位
  // 接上去——留著一科零主授的話，日後依主授寄通知的功能會安靜地
  // 少寄一個班，而沒有人看得出少的是哪一個。
  if (row.isPrimary) {
    const next = await prisma.classSubjectTeacher.findFirst({
      where: { classId, subjectId },
      orderBy: { assignedAt: 'asc' },
      select: { id: true },
    });
    if (next) {
      await prisma.classSubjectTeacher.update({
        where: { id: next.id },
        data: { isPrimary: true },
      });
    }
  }

  await audit(tenantId, actor.id, 'teaching.unassign', row.id, {
    class: row.class.name,
    subject: row.subject.name,
    teacher: row.user.username,
  });
  return row;
}

/**
 * 指派導師。
 *
 * 導師在資料上就是一列 `ClassMembership`（`role: TEACHER`、
 * `isHomeroom: true`、`leftAt: null`）——`lib/auth.ts` 的 `isHomeroomOf`
 * 讀的就是這三個條件，所以這裡寫的必須完全對上它。
 *
 * 用 upsert 而不是 create：同一位老師可能之前被移除過（那時我們寫了
 * `leftAt`），而唯一鍵是 `[classId, userId, role]`——直接 create 會撞鍵，
 * 錯誤訊息是 P2002 加三個欄位名，看的人不會想到「他以前當過」。
 */
export async function setHomeroom(classId: string, userId: string, actor: SessionUser) {
  const tenantId = requireTenant();
  const { klass, teacher } = await loadTargets(classId, null, userId);

  const row = await prisma.classMembership.upsert({
    where: { classId_userId_role: { classId, userId, role: 'TEACHER' } },
    create: { classId, userId, role: 'TEACHER', isHomeroom: true },
    update: { isHomeroom: true, leftAt: null },
  });

  await audit(tenantId, actor.id, 'teaching.homeroom_set', row.id, {
    class: klass.name,
    teacher: teacher.username,
  });
  return row;
}

/**
 * 取消導師。
 *
 * **同時寫 `leftAt`**，不是只把 `isHomeroom` 關掉。留著一列
 * `leftAt: null` 的非學生成員，`lib/assignment.ts` 的 `assignableClassIds`
 * 仍然會把這個班算成他派得了卷的班——也就是「取消導師」之後他還是
 * 派得動這個班的任務，而畫面上導師欄已經沒有他了。那種「看起來取消了、
 * 實際上沒取消」的權限是最難發現的一種。
 */
export async function clearHomeroom(classId: string, userId: string, actor: SessionUser) {
  const tenantId = requireTenant();
  const row = await prisma.classMembership.findFirst({
    where: { classId, userId, role: 'TEACHER', isHomeroom: true, leftAt: null },
    select: { id: true, class: { select: { name: true } }, user: { select: { username: true } } },
  });
  if (!row) throw new Error('這個人已經不是這個班的導師了。請重新整理再看一次。');

  await prisma.classMembership.update({
    where: { id: row.id },
    data: { isHomeroom: false, leftAt: new Date() },
  });

  await audit(tenantId, actor.id, 'teaching.homeroom_clear', row.id, {
    class: row.class.name,
    teacher: row.user.username,
  });
  return row;
}

// ─────────────────────────────────────────────────────────────────

/**
 * 把班級、科目與老師一次讀出來並驗過。
 *
 * 三件事都會安靜出錯：RLS 之下別家的班級與科目查不到（症狀是
 * 「指派了但他還是看不到」）、把授課指派給學生帳號（那位學生會取得
 * 整個班的成績檢視權，而名冊上他看起來完全正常）、以及指派給一個
 * 已停用的科目（老師拿到一個在每一個選單裡都不存在的科目）。
 */
async function loadTargets(classId: string, subjectId: string | null, userId: string) {
  const [klass, subject, teacher] = await Promise.all([
    prisma.class.findFirst({ where: { id: classId }, select: { id: true, name: true } }),
    subjectId
      ? prisma.subject.findFirst({
          where: { id: subjectId },
          select: { id: true, name: true, active: true },
        })
      : Promise.resolve(null),
    prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, displayName: true, username: true, systemRole: true, status: true },
    }),
  ]);

  if (!klass) throw new Error('找不到這個班級，它可能剛剛被刪掉了。請重新整理再選一次。');
  if (subjectId && !subject) throw new Error('找不到這個科目。請重新整理再選一次。');
  if (subject && !subject.active) {
    throw new Error(
      `「${subject.name}」已經停用了，指派了他也選不到這一科。請先到「科目」把它重新啟用。`,
    );
  }
  if (!teacher) throw new Error('找不到這個帳號。');
  if (!STAFF_ROLE_SET.has(teacher.systemRole)) {
    throw new Error(
      `「${teacher.displayName}」不是教職員帳號，不能被指派為老師。` +
        '學生帳號被指派之後會看得到全班的成績與家長信箱。',
    );
  }
  if (teacher.status !== 'ACTIVE') {
    throw new Error(`「${teacher.displayName}」的帳號已停用，他登不進來。請先重新啟用他的帳號。`);
  }
  return { klass, subject: subject as { id: string; name: string; active: boolean }, teacher };
}

/**
 * 稽核。分類用 USER——schema 對它的定義是「帳號與權限異動」，
 * 而指派授課老師發出去的正是權限：這一位從此看得到那個班那一科的
 * 每一位學生的成績。記在 SYSTEM 的話，查「誰讓他看得到這些資料」
 * 的人會翻錯分類。
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
      category: 'USER',
      action,
      actorId,
      targetType: action.startsWith('teaching.homeroom') ? 'ClassMembership' : 'ClassSubjectTeacher',
      targetId,
      after: after as never,
    },
  });
}
