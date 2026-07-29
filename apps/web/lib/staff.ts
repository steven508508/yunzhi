/**
 * 教職員帳號：建立、改角色、停用、重設密碼。
 *
 * # 這一塊擋住了整個權限模型
 *
 * 在此之前，全 repo 的 `user.create` 只有兩處：`lib/roster.ts` 的名冊
 * 匯入（寫死 `systemRole: 'STUDENT'`）與開機種子（建一個 SYS_ADMIN）。
 * 也就是說**沒有任何介面可以建立老師帳號**——六個角色的權限模型
 * 實際上只有管理員與學生能動，而系統裡每一處「老師」的判斷都指向
 * 一個不存在的帳號類型。
 *
 * 沒有老師帳號，就沒有授課老師指派（`ClassSubjectTeacher`），
 * 而 `canEditSubject`、`gradeScopeWhere`、`assignableClassIds` 全部
 * 建立在那張表上——整條「老師出題、派卷、看成績」的動線都走不通。
 *
 * # 三個貫穿這個檔案的決定
 *
 * **一、這一頁建不出學生帳號。** 學生走名冊匯入，那條路徑會一併處理
 * 家長同意、未成年判定、入班關係與整班密碼列印。兩條路徑都能建學生
 * 的話，從這裡建出來的那一個不在任何班上、沒有同意紀錄，登不進去，
 * 而名冊上找不到他——櫃檯人員會以為系統壞了。規則在
 * `lib/staffRules.mjs` 的 `checkStaffRole`。
 *
 * **二、最後一個系統管理員救不回來。** 停用或降級它之後，沒有人能
 * 進管理功能，而把權限拿回來需要一個管理員帳號——那正是被停掉的那個。
 * 唯一的解法是進機房用 psql 手改一列。所以那件事在
 * `lib/staffRules.mjs` 被擋死，而且有測試。
 *
 * **三、bcrypt 不進交易。** `hashPassword` 一次 0.31 秒，而 Prisma 的
 * 互動式交易上限是 5 秒。這裡一次只處理一個帳號，看起來離上限很遠，
 * 但把雜湊寫進 `$transaction(async (tx) => …)` 就是在等它變成一個
 * 「平常都好、忙的時候整批失敗」的東西——而錯誤訊息是
 * `Transaction already closed`，完全看不出與密碼有關。理由詳見
 * `lib/roster.ts` 的 `mintPasswords`。所以這裡一律**先算好雜湊，
 * 再開交易**。
 */
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/password';
import { newPassword } from '@/lib/roster';
import { requireTenant } from '@/lib/tenant';
import type { SessionUser } from '@/lib/auth';
import {
  ASSIGNABLE_ROLES,
  STAFF_ROLE_SET,
  checkGrant,
  checkActOn,
  checkRoleChange,
  checkStaffName,
  checkStaffUsername,
  checkStatusChange,
} from '@/lib/staffRules.mjs';
import {
  ERASED_STAFF_NAME,
  checkUsernameChange,
  erasedUsername,
} from '@/lib/accountRules.mjs';

export type StaffInput = {
  displayName: string;
  username: string;
  systemRole: string;
  email?: string | null;
};

/**
 * 一組交到人手上的臨時憑證。**只在回傳的那一次拿得到。**
 *
 * 不存明文、不寫進稽核、不寫進 log——與學生的重設密碼同一個規則
 * （見 `lib/roster.ts` 的 `ResetCredential`）：稽核記錄會被匯出、
 * log 會被複製到維運機器上，而一份含可用密碼的檔案流出去，
 * 等於整個系統的帳號都失守。
 */
export type StaffCredential = {
  userId: string;
  username: string;
  displayName: string;
  password: string;
};

/**
 * 還有幾個「可以登入的系統管理員」，可以排除其中一個。
 *
 * 排除的那一個是這次動作的對象：規則要問的是「把他拿掉之後還剩幾個」，
 * 而讓呼叫端自己減一，減錯的那一次正好是只剩一個的那一次。
 *
 * `deletedAt: null` 一定要在：軟刪除的帳號登不進去（見 `requireUser`），
 * 把它算進來的話，一個已經離職的管理員會讓「最後一個管理員」的保護
 * 失效——而那正是最需要它的時候。
 */
async function otherActiveSysAdmins(exceptUserId: string): Promise<number> {
  return prisma.user.count({
    where: {
      systemRole: 'SYS_ADMIN',
      status: 'ACTIVE',
      deletedAt: null,
      id: { not: exceptUserId },
    },
  });
}

/** 這一頁列得出來的人：教職員，含已停用的。學生與家長不在裡面。 */
export async function listStaff() {
  return prisma.user.findMany({
    where: {
      // ASSIGNABLE_ROLES 來自 .mjs，型別是 string[]。轉成 Prisma 的
      // SystemRole 而不是把清單複製一份到這裡：兩份清單就是兩個會
      // 分岐的地方，而分岐的方向若是這裡漏了一個角色，那個角色的
      // 帳號會從教職員頁上整個消失——他還在，只是沒有人管得到他。
      systemRole: { in: ASSIGNABLE_ROLES as unknown as never[] },
      deletedAt: null,
    },
    orderBy: [{ status: 'asc' }, { username: 'asc' }],
    select: {
      id: true,
      username: true,
      displayName: true,
      email: true,
      systemRole: true,
      status: true,
      lastLoginAt: true,
      mustChangePassword: true,
      _count: { select: { subjectTeaching: true } },
    },
  });
}

/**
 * 建立一個教職員帳號。回傳的密碼**只有這一次看得到**。
 *
 * `status` 直接是 ACTIVE：家長同意那一套是給未成年學生的（個資法
 * 第 15 條），老師不適用。但 `mustChangePassword` 是 true——這串字
 * 經過管理員的手、可能被抄在便條紙上或貼進聊天室，不該長期作為
 * 有效憑證。
 */
export async function createStaff(
  input: StaffInput,
  actor: SessionUser,
): Promise<StaffCredential> {
  const tenantId = requireTenant();

  const grant = checkGrant(actor.systemRole, input.systemRole);
  if (grant) throw new Error(grant);

  const displayName = (input.displayName ?? '').trim();
  const nameProblem = checkStaffName(displayName);
  if (nameProblem) throw new Error(nameProblem);

  // 已經被用掉的帳號一起帶進去檢查。schema 有 @@unique([tenantId, username])
  // 會擋，但這裡先擋是為了訊息：資料庫丟出來的是 P2002 加一個欄位名，
  // 而管理員最可能撞到的是**某位學生的學號**——他在教職員清單裡
  // 找不到那個人，然後以為系統壞了。
  const username = (input.username ?? '').trim();
  const taken = username
    ? await prisma.user.findFirst({ where: { username }, select: { id: true } })
    : null;
  const userProblem = checkStaffUsername(
    username,
    taken ? new Set([username]) : undefined,
  );
  if (userProblem) throw new Error(userProblem);

  // 空字串要變成 null。`@@unique([tenantId, email])` 之下，兩個空字串
  // 會撞在一起——第二位不填信箱的老師會建不起來，而錯誤訊息是
  // 資料庫的 P2002 加一個欄位名，看的人不會想到是「都沒填」。
  const email = (input.email ?? '').trim() || null;

  if (email) {
    const dupMail = await prisma.user.findFirst({ where: { email }, select: { id: true } });
    if (dupMail) throw new Error(`信箱「${email}」已經登記在另一個帳號上了。`);
  }

  // 雜湊算在建立之前，不在任何交易裡。理由見檔頭第三點。
  const password = newPassword();
  const passwordHash = await hashPassword(password);

  const created = await prisma.user.create({
    data: {
      tenantId,
      username,
      displayName,
      email,
      passwordHash,
      systemRole: input.systemRole as never,
      status: 'ACTIVE',
      mustChangePassword: true,
    },
    select: { id: true, username: true, displayName: true },
  });

  await audit(tenantId, actor.id, 'staff.create', created.id, {
    username,
    displayName,
    systemRole: input.systemRole,
    // **不寫明文密碼。** 稽核記錄會被匯出，而一份含可用密碼的匯出檔
    // 等於把帳號一起交出去。
  });

  return {
    userId: created.id,
    username: created.username,
    displayName: created.displayName,
    password,
  };
}

/**
 * 改角色。
 *
 * 擋掉什麼見 `lib/staffRules.mjs` 的 `checkRoleChange`——一句話：
 * 最後一個系統管理員降不得，自己的角色改不得。
 */
export async function changeStaffRole(
  userId: string,
  nextRole: string,
  actor: SessionUser,
) {
  const tenantId = requireTenant();
  const target = await loadStaff(userId);

  const problem = checkRoleChange({
    actor: { id: actor.id, systemRole: actor.systemRole },
    target,
    nextRole,
    otherActiveSysAdmins: await otherActiveSysAdmins(target.id),
  });
  if (problem) throw new Error(problem);
  if (target.systemRole === nextRole) return target;

  const updated = await prisma.user.update({
    where: { id: target.id },
    data: { systemRole: nextRole as never },
    select: { id: true, username: true, displayName: true, systemRole: true, status: true },
  });

  await audit(tenantId, actor.id, 'staff.role_change', target.id, {
    username: target.username,
    from: target.systemRole,
    to: nextRole,
  });
  return updated;
}

/**
 * 停用或重新啟用。
 *
 * **停用時把所有 session 一起作廢。** 只改 `status` 的話，已經登入的
 * 那個瀏覽器要等到下一次 `requireUser` 才會被擋——而那可能是幾秒後，
 * 也可能是他把分頁留著不動的一整天。會需要「立刻停用一個帳號」的
 * 場合（發現異常存取、當天離職）等不了那一整天。
 *
 * **不用軟刪除（`deletedAt`）。** 停用是可逆的、看得到的；刪掉的帳號
 * 在這一頁上會消失，而他出過的題目、派過的卷子仍然指著他，
 * 於是畫面上會出現一個查不到名字的建立者。
 */
export async function setStaffStatus(
  userId: string,
  nextStatus: 'ACTIVE' | 'SUSPENDED',
  actor: SessionUser,
) {
  const tenantId = requireTenant();
  const target = await loadStaff(userId);

  const problem = checkStatusChange({
    actor: { id: actor.id, systemRole: actor.systemRole },
    target,
    nextStatus,
    otherActiveSysAdmins: await otherActiveSysAdmins(target.id),
  });
  if (problem) throw new Error(problem);
  if (target.status === nextStatus) return target;

  const [updated] = await prisma.$transaction([
    prisma.user.update({
      where: { id: target.id },
      data: {
        status: nextStatus,
        // 重新啟用時一併解鎖。被停用期間有人試過他的密碼並把它鎖住
        // 的話，啟用完他還是登不進去，而畫面上只會說「請稍後再試」。
        ...(nextStatus === 'ACTIVE' ? { failedLoginCount: 0, lockedUntil: null } : {}),
      },
      select: { id: true, username: true, displayName: true, systemRole: true, status: true },
    }),
    ...(nextStatus === 'SUSPENDED'
      ? [prisma.session.deleteMany({ where: { userId: target.id } })]
      : []),
  ]);

  await audit(
    tenantId,
    actor.id,
    nextStatus === 'SUSPENDED' ? 'staff.suspend' : 'staff.reactivate',
    target.id,
    { username: target.username, systemRole: target.systemRole },
  );
  return updated;
}

/**
 * 改姓名、登入代號與信箱。
 *
 * # 為什麼這一支非有不可
 *
 * `PATCH /api/staff/[userId]` 在此之前只收 `systemRole` 與 `status`，
 * 而 `User.displayName` 全 repo **只在 `user.create` 時寫過一次**。
 * 也就是說老師的名字打錯了就是一輩子——導覽列右上角、成績表上的
 * 建立者、教職員清單，每一處都印著那個錯字，而唯一的補救是停用他、
 * 用另一個代號重建一個，於是他出過的題目與派過的卷子留在舊帳號上。
 *
 * 主任自己的名字也一樣改不掉。
 *
 * # 改代號會把他登出
 *
 * 他正拿著舊代號在登入。不作廢 session 的話，他手上那個分頁還活著、
 * 下一次登入卻用不了舊代號，而畫面上只會說「帳號或密碼錯誤」——
 * 他會以為自己記錯密碼，然後試五次把帳號鎖住。
 *
 * # 為什麼改代號不必是系統管理員專屬
 *
 * 因為它不發任何權限（那是 `changeStaffRole` 的事）。能動這個帳號的
 * 人（`checkActOn`）就改得動它的名字——校務管理員動不了系統管理員，
 * 那一道已經在了。
 */
export async function updateStaffProfile(
  userId: string,
  patch: { displayName?: string; username?: string; email?: string | null },
  actor: SessionUser,
) {
  const tenantId = requireTenant();
  const target = await loadStaff(userId);

  const problem = checkActOn(actor.systemRole, target);
  if (problem) throw new Error(problem);

  const before = await prisma.user.findFirst({
    where: { id: target.id },
    select: { id: true, username: true, displayName: true, email: true },
  });
  if (!before) throw new Error('找不到這個帳號');

  const data: Record<string, string | null> = {};

  if (patch.displayName !== undefined) {
    const nameProblem = checkStaffName(patch.displayName);
    if (nameProblem) throw new Error(nameProblem);
    const name = patch.displayName.trim();
    if (name !== before.displayName) data.displayName = name;
  }

  let usernameChanged = false;
  if (patch.username !== undefined) {
    const next = (patch.username ?? '').trim();
    // 「被誰佔走了」要在這一側查。撞到的多半是某位學生的學號——
    // 管理員在教職員清單裡找不到那個人，然後以為系統壞了。
    const takenByOther =
      next && next !== before.username
        ? Boolean(
            await prisma.user.findFirst({
              where: { username: next, id: { not: before.id } },
              select: { id: true },
            }),
          )
        : false;
    const userProblem = checkUsernameChange({
      current: before.username,
      next,
      takenByOther,
    });
    if (userProblem) throw new Error(userProblem);
    if (next !== before.username) {
      data.username = next;
      usernameChanged = true;
    }
  }

  if (patch.email !== undefined) {
    // 空字串要變成 null——`@@unique([tenantId, email])` 之下兩個空字串
    // 會撞在一起。與 `createStaff` 同一條規則。
    const email = (patch.email ?? '').trim() || null;
    if (email && email !== before.email) {
      const dup = await prisma.user.findFirst({
        where: { email, id: { not: before.id } },
        select: { id: true },
      });
      if (dup) throw new Error(`信箱「${email}」已經登記在另一個帳號上了。`);
    }
    if (email !== before.email) data.email = email;
  }

  if (Object.keys(data).length === 0) return before;

  const [after] = await prisma.$transaction([
    prisma.user.update({
      where: { id: before.id },
      data,
      select: { id: true, username: true, displayName: true, email: true },
    }),
    // 只有改代號才作廢 session。改一個錯字不該把正在改考卷的人踢出去。
    ...(usernameChanged
      ? [prisma.session.deleteMany({ where: { userId: before.id } })]
      : []),
  ]);

  await audit(tenantId, actor.id, 'staff.update', before.id, {
    before: { username: before.username, displayName: before.displayName, email: before.email },
    after: { username: after.username, displayName: after.displayName, email: after.email },
    loggedOut: usernameChanged,
  });
  return after;
}

/**
 * 刪除一個教職員帳號。**軟刪除，而且把登入代號放回去。**
 *
 * # 停用與刪除的差別，以及為什麼兩個都要有
 *
 * 停用（`setStaffStatus`）是可逆的：他還在清單上、授課指派還在、
 * 重新啟用之後一切照舊。那是給「留職停薪」「先關掉再說」用的。
 *
 * 但停用**不釋放登入代號**。`@@unique([tenantId, username])` 之下，
 * 一個停用的帳號仍然佔著 `T001`，而新來接手的老師最自然的代號正是
 * `T001`——建立時會撞鍵，而錯誤訊息說「已經有人在用了」，
 * 那個人是一位半年前離職的老師。
 *
 * 所以離職要有一個真的刪除：`deletedAt` 寫入（`requireUser` 據此拒絕
 * 登入）、代號換成 `[deleted]<內部 id>`、姓名去識別化、session 清空。
 * `User.deletedAt` 在此之前**只被讀、從來沒有被寫過**——十七處引用
 * 全是 `deletedAt: null` 的查詢條件。
 *
 * # 為什麼不是 DELETE
 *
 * 因為他出過的題目、組過的卷子、派過的任務都指著他（schema 是
 * SetNull）。真的刪掉那一列之後，畫面上會出現一堆查不到名字的建立者，
 * 而「這一題是誰出的」在題庫的權利聲明上是有意義的。
 *
 * # 授課指派要一起清掉
 *
 * 不清的話，`gradeScopeWhere` 的 `createdBy` 分支之外還多一條路：
 * 那幾筆 `ClassSubjectTeacher` 仍然在，而 `/settings/staff` 上一位被
 * 刪除的老師已經不在清單裡——沒有人看得到它們，也沒有人移得掉。
 */
export async function deleteStaff(userId: string, actor: SessionUser) {
  const tenantId = requireTenant();
  const target = await loadStaff(userId);

  const problem = checkActOn(actor.systemRole, target);
  if (problem) throw new Error(problem);
  if (actor.id === target.id) {
    throw new Error(
      '不能刪除自己的帳號。刪掉之後你下一次點擊就會被登出，而且自己救不回來——' +
        '請找另一位管理員來做這件事。',
    );
  }
  if (target.systemRole === 'SYS_ADMIN' && (await otherActiveSysAdmins(target.id)) === 0) {
    throw new Error(
      `「${target.displayName}」是目前唯一一位可以登入的系統管理員，不能刪除。` +
        '刪掉之後沒有任何人進得了管理功能，而系統裡沒有把權限拿回來的路徑——' +
        '只能進機房改資料庫。請先指派另一位系統管理員。',
    );
  }

  const teaching = await prisma.classSubjectTeacher.count({ where: { userId: target.id } });

  await prisma.$transaction([
    prisma.user.update({
      where: { id: target.id },
      data: {
        username: erasedUsername(target.id),
        displayName: ERASED_STAFF_NAME,
        email: null,
        passwordHash: null,
        mustChangePassword: false,
        failedLoginCount: 0,
        lockedUntil: null,
        status: 'ARCHIVED',
        deletedAt: new Date(),
      },
    }),
    prisma.session.deleteMany({ where: { userId: target.id } }),
    prisma.classSubjectTeacher.deleteMany({ where: { userId: target.id } }),
    // 導師身分寫在 ClassMembership 上。留著一列 `leftAt: null` 的話，
    // `assignableClassIds` 仍然把那個班算成他派得了卷的班——一個已經
    // 刪除的帳號登不進來，所以不會出事，但那一列會讓班級頁的導師欄
    // 顯示一個沒有名字的人。
    prisma.classMembership.updateMany({
      where: { userId: target.id, leftAt: null },
      data: { isHomeroom: false, leftAt: new Date() },
    }),
  ]);

  await audit(tenantId, actor.id, 'staff.delete', target.id, {
    formerUsername: target.username,
    systemRole: target.systemRole,
    teachingRemoved: teaching,
    // 學號／代號留在稽核裡是刻意的：它是這次刪除的識別依據，
    // 而它已經不再指向任何可用的帳號——同時它也是「這個代號什麼時候
    // 被放回去的」唯一說得出來的地方。
  });
  return { username: target.username, displayName: target.displayName, teachingRemoved: teaching };
}

/**
 * 重設一位教職員的密碼。
 *
 * 與學生那一支（`lib/roster.ts` 的 `resetStudentPassword`）做同樣的
 * 三件事，理由也一樣：
 *
 *   一、**清掉鎖定與失敗計數**——會來要重設的人多半已經試錯五次被鎖了
 *       15 分鐘，不清的話新密碼照樣登不進去，兩邊都會以為是重設壞了。
 *   二、**作廢所有既有 session**——需要重設的常見原因之一是密碼外洩，
 *       留著舊 session 等於那個人還在裡面。
 *   三、**標記 mustChangePassword**——這串字經過別人的手。
 *
 * **對象限定教職員。** 不限定的話，一位校務管理員可以對著任何一個
 * userId 打這支 API 然後用那個身分登入；而學生的重設走
 * `resetStudentPassword`，那一支同樣只認 STUDENT。兩邊各自守住自己的
 * 那一半，中間沒有縫。
 */
export async function resetStaffPassword(
  userId: string,
  actor: SessionUser,
): Promise<StaffCredential> {
  const tenantId = requireTenant();
  const target = await loadStaff(userId);

  const problem = checkActOn(actor.systemRole, target);
  if (problem) throw new Error(problem);

  // 雜湊算在交易外面。理由見檔頭第三點。
  const password = newPassword();
  const passwordHash = await hashPassword(password);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: target.id },
      data: {
        passwordHash,
        mustChangePassword: true,
        passwordChangedAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
      },
    }),
    prisma.session.deleteMany({ where: { userId: target.id } }),
  ]);

  // action 名稱與學生那一支相同（`auth.password_reset`），分類也一樣是
  // AUTH。**這是刻意的**：個資事件調查要的是「這個帳號的密碼被誰動過
  // 幾次」這一條時間線，而同一件事分散在兩個 action 名稱底下，
  // 查的人會只翻其中一個然後說「沒有記錄」。
  await prisma.auditLog.create({
    data: {
      tenantId,
      category: 'AUTH',
      action: 'auth.password_reset',
      actorId: actor.id,
      targetType: 'User',
      targetId: target.id,
      after: {
        staff: target.username,
        systemRole: target.systemRole,
        accountStatus: target.status,
      } as never,
    },
  });

  return {
    userId: target.id,
    username: target.username,
    displayName: target.displayName,
    password,
  };
}

// ─────────────────────────────────────────────────────────────────

/**
 * 讀出一個教職員帳號。
 *
 * **找不到與「找到但那是學生」回同一種錯誤是不行的**：後者要說得出
 * 「這不是教職員帳號」，否則管理員會以為帳號不見了然後重建一個，
 * 而那會撞到唯一鍵。
 */
async function loadStaff(userId: string) {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: {
      id: true,
      username: true,
      displayName: true,
      systemRole: true,
      status: true,
    },
  });
  if (!user) throw new Error('找不到這個帳號');
  if (!STAFF_ROLE_SET.has(user.systemRole)) {
    throw new Error(
      `「${user.displayName}」不是教職員帳號，這一頁動不了它。` +
        '學生帳號請到他所屬的班級頁處理。',
    );
  }
  return user;
}

/**
 * 稽核。分類用 USER——schema 對它的定義就是「帳號與權限異動」，
 * 而這裡每一個動作都是。密碼那一件記在 AUTH（見 `resetStaffPassword`）。
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
      targetType: 'User',
      targetId,
      after: after as never,
    },
  });
}
