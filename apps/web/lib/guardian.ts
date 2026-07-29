/**
 * 家長端：連結、帳號，以及「家長看得到什麼」那條線。
 *
 * # 這個功能的缺口不在畫面，在連結
 *
 * `GUARDIAN` 這個角色從第一天就存在、`guardian_links` 這張表從第一份
 * 遷移就在、名冊匯入一直在收家長信箱——但 `linkGuardian` **沒有任何
 * 呼叫端**，所以那張表永遠是空的。也就是說，就算把家長端的每一頁都
 * 畫出來，也沒有一筆資料能讓它顯示。
 *
 * 所以這個檔案的前半是「怎麼把家長接到孩子身上」，後半才是「他接上
 * 之後看得到什麼」。前半沒有，後半沒有意義。
 *
 * # 界線：這是整個功能能不能上線的關鍵
 *
 * 依規格書文件 06 第 9.5 節與這個專案的既有立場，**家長看得到**：
 * 孩子的任務清單與完成狀況、老師放行後的成績、成績與班級平均的
 * 相對位置、以及時程。**看不到**：
 *
 *   · 學習歷程的撰寫內容與 AI 對話（學生可能寫下不希望家長看到的事）
 *   · 智慧老師的對話（`TutorSession` / `TutorMessage`）——那是他求助
 *     的紀錄，而求助的內容比答錯本身更私人
 *   · 逐題的作答內容與檢討——那是學習過程，要看應該透過學生或老師
 *   · 考試行為偵測的事件（`ProctorEvent`）——那是給老師判斷用的證據，
 *     不是給家長的。把它交給家長等於讓系統去指控一個孩子
 *   · 其他學生的任何資料，包含班級平均裡反推得出來的那些
 *
 * **每一項都是在程式裡真的擋住的，不是把連結藏起來。** 具體怎麼擋：
 *
 *   一、**這個檔案不查那幾張表。** 全檔沒有 `tutorSession`、
 *       `tutorMessage`、`attemptAnswer`、`proctorEvent` 任何一個字。
 *       畫面層漏畫一個 `if` 是很平常的事，漏查一個查詢不是。
 *       `tests/guardian.test.mjs` 會讀這個檔案的原始碼把這件事釘住。
 *   二、**那幾張表的既有進入點全部自己比對 `userId`。**
 *       `loadAttemptResult`、`loadTutorSession`、`recordProctorEvents`
 *       收的都是「誰在問」，而家長的 userId 永遠不等於作答者的。
 *       所以家長直接打那幾支 API 拿到的是 403，不是資料。
 *       `tools/e2e-guardian.mjs` 真的去打，驗的就是這件事。
 *   三、**家長端沒有自己的讀取 API。** 這幾頁是伺服器元件，資料在
 *       伺服器端組好才送到瀏覽器。多一支 API 就多一個要重新判斷
 *       「這個 id 是不是他的孩子」的地方，而 `app/api/guardians/**`
 *       底下每一支都是給職員用的。
 *
 * # 家長看到的是學生那一份的投影
 *
 * 任務清單走 `listStudentTasks`（學生自己那一支），再用
 * `projectTask` 挑欄位。**不另外寫一份查詢。** 兩份查詢的口徑遲早
 * 會分岐，而分岐的方向不會是家長看得比較少——最可能的是老師還沒
 * 放行的成績出現在家長的手機上，而學生自己的畫面上還寫著
 * 「老師還沒有開放」。
 */
import { listStudentTasks } from '@/lib/attempt';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/password';
// 初始密碼與名冊、教職員共用同一個產生器。**不要在這裡再寫一個**：
// 兩份實作遲早會分岐，而分岐的那一天，櫃檯會發現家長的初始密碼與
// 學生的長得不一樣，然後開始懷疑其中一邊是壞的。理由詳見
// `lib/roster.ts` 的 `newPassword`。
import { newPassword } from '@/lib/roster';
import { requireTenant } from '@/lib/tenant';
// 型別與值都從 `.mjs` 進來（那邊用 JSDoc 標的，與 `lib/release.mjs`
// 相同）。**不要另外開一份 `guardianView.d.ts`**：`allowJs` 之下，
// 帶副檔名的 import 拿到的是 JS 推導出來的型別，而 `.d.ts` 只服務
// 不帶副檔名的那條路徑——於是同一個函式在兩個呼叫端有兩種型別。
import {
  compareToClass,
  noDataReason,
  projectTask,
  summarizeChild,
  type ChildSummary,
  type ClassComparison,
  type GuardianTask,
} from '@/lib/guardianView.mjs';

// ─────────────────────────────────────────────────────────────────
// 錯誤
// ─────────────────────────────────────────────────────────────────

export type GuardianErrorCode = 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT' | 'INVALID';

export class GuardianError extends Error {
  readonly code: GuardianErrorCode;
  readonly status: number;
  constructor(code: GuardianErrorCode, message: string, status: number) {
    super(message);
    this.name = 'GuardianError';
    this.code = code;
    this.status = status;
  }
}

/**
 * 誰動得了家長連結：**不是學生也不是家長的人**。
 *
 * 用排除法而不是列舉四種職員角色：日後多一種職員角色（規格裡的
 * FRONT_DESK）時，列舉的那一份會漏掉它，而症狀是「櫃檯明明有帳號
 * 卻按不動」——與首頁待辦算 `staffCount` 同一條規則。
 *
 * 家長自己也在排除之列，而那是刻意的：他不可以把自己接到另一個
 * 孩子身上，也不可以看到別的家長是誰。
 */
export function isStaff(systemRole: string): boolean {
  return systemRole !== 'STUDENT' && systemRole !== 'GUARDIAN';
}

/** 把錯誤轉成路由要回的東西。與 `attemptFailure` 同一個形狀。 */
export function guardianFailure(e: unknown): {
  status: number;
  body: { error: string; code?: string };
} {
  if (e instanceof GuardianError) {
    return { status: e.status, body: { error: e.message, code: e.code } };
  }
  return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } };
}

// ─────────────────────────────────────────────────────────────────
// verifiedAt：誰驗證、驗證什麼、沒驗證的連結能做什麼
// ─────────────────────────────────────────────────────────────────

/**
 * `GuardianLink.verifiedAt` 記的是**「這組帳號密碼確實交到那位法定
 * 代理人手上」被人確認的時刻**，不是「這個信箱收得到信」。
 *
 * # 誰來驗證：老師，當面按下去
 *
 * 不是寄一封確認信。這套系統跑在補習班的封閉網段，對外的 SMTP 是
 * `ERR_TUNNEL_CONNECTION_FAILED`——與「刻意不做寄信的忘記密碼流程」
 * （`lib/roster.ts` 的 `resetStudentPassword`）完全同一個現實。
 * 做一個寄不出去的驗證信，比沒有更糟：那條線會永遠停在「待驗證」，
 * 然後所有人學會忽略它。
 *
 * 補習班真正的流程是「家長來接小孩、櫃檯把那張紙交給他」。所以
 * 驗證的實體動作就是那一次交付，而按下按鈕的那位職員在稽核上
 * （`guardian.verify`）為它負責。
 *
 * # 驗證什麼：交付對象正確，不是信箱可達
 *
 * 名冊上的家長信箱是櫃檯打的，打錯的方向不是「寄不到」而是
 * 「寄到另一個人那裡」。而初始密碼**不經由信箱發送**——它印在
 * 匯入完成的那張紙上、當面交出去。所以真正的風險是「交錯人」，
 * 而那件事只有現場的人確認得了。
 *
 * # 沒驗證的連結能做什麼
 *
 * **一、登入之後看得到孩子的資料。** 因為進得來就代表他手上有那組
 * 只顯示一次的密碼——密碼沒交出去的帳號，實務上就是一把沒發出去的
 * 鑰匙。把未驗證的連結也擋在登入之後，等於在已經有鑰匙的人面前
 * 再加一道他自己解不開的鎖，而唯一的效果是櫃檯電話。
 *
 * **二、名冊上會標成「還沒交付」。** 那是「密碼印出來卻忘了發」的
 * 唯一線索。沒有這個標記的話，一個從來沒登入過的家長帳號，
 * 與一個家長自己不想用的帳號，在畫面上長得一模一樣。
 *
 * **三、不得作為任何推播出去的收件人。** 這是 `verifiedAt` 真正
 * 擋住東西的地方，而它擋的正是「把成績寄給陌生人」——通知是推出去
 * 的，收件人不需要持有密碼，所以上面第一條的理由在這裡不成立。
 * 通知模組（藍圖 B5）還沒有做，但這一條**不是一句註解**：
 * `notifiableGuardians` 就是那個唯一的入口，而它有測試。
 * 一個綠燈的假保證比沒有保證更糟。
 *
 * **四、家長端首頁會告訴家長這件事**，而且順帶問一句「如果這不是
 * 你的孩子請立刻告訴補習班」。打錯的信箱因此會在第一次登入時被
 * 發現，而不是等到期末。
 */
export async function notifiableGuardians(studentId: string) {
  requireTenant();
  const links = await prisma.guardianLink.findMany({
    where: { studentId, verifiedAt: { not: null } },
    select: { guardianId: true },
  });
  if (links.length === 0) return [];
  return prisma.user.findMany({
    where: {
      id: { in: links.map((l) => l.guardianId) },
      systemRole: 'GUARDIAN',
      status: 'ACTIVE',
      deletedAt: null,
    },
    select: { id: true, username: true, displayName: true, email: true },
  });
}

// ─────────────────────────────────────────────────────────────────
// 建立與解除連結
// ─────────────────────────────────────────────────────────────────

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * 家長帳號的登入代號就是他的信箱。
 *
 * 學生用學號，因為學號是補習班給的、家長沒有。家長唯一一個
 * 「補習班已經知道、而他自己也記得住」的識別就是信箱，
 * 而發明一組「家長編號」等於在交付那一刻多一件要抄的東西。
 *
 * 一律小寫：櫃檯打 `Mom@Example.com`、家長登入打 `mom@example.com`，
 * 那是同一個人，而 `@@unique([tenantId, username])` 認為不是。
 */
export function guardianUsername(email: string): string {
  return email.trim().toLowerCase();
}

function checkEmail(raw: string): string {
  const email = guardianUsername(raw ?? '');
  if (!email) throw new GuardianError('INVALID', '請填寫家長的信箱。', 400);
  if (!EMAIL.test(email)) {
    throw new GuardianError('INVALID', `「${email}」看起來不像一個信箱。`, 400);
  }
  return email;
}

/**
 * 家長帳號的顯示名稱。
 *
 * 「王大明家長」而不是信箱本身：櫃檯在名冊上看到的要是一個人，
 * 而 `a1234@gmail.com` 讀不出那是誰的家長。
 *
 * **接上第二個孩子時不改名。** 那個帳號屬於一個人，不屬於一個孩子；
 * 跟著改的話，兩個孩子輪流匯入名冊會讓同一位家長的名字來回跳，
 * 而畫面上看不出為什麼。
 */
function guardianDisplayName(studentName: string): string {
  return `${studentName}家長`;
}

async function loadStudent(studentId: string) {
  const student = await prisma.user.findFirst({
    where: { id: studentId, systemRole: 'STUDENT', deletedAt: null },
    select: { id: true, username: true, displayName: true, guardianEmail: true },
  });
  if (!student) {
    // 與 `loadResettableStudent` 同一句話：找不到與「那是老師的帳號」
    // 回同一種錯誤，分開講等於告訴對方「這個 id 是一個老師的帳號」。
    throw new GuardianError('NOT_FOUND', '找不到這位學生。只有學生帳號綁得了家長。', 404);
  }
  return student;
}

/**
 * 綁定家長與學生。
 *
 * `@@unique([guardianId, studentId])` 允許兩種真實情況，兩種都要成立：
 * **一位家長兩個孩子**（同一個 guardianId 兩列）與**一位學生兩位
 * 監護人**（同一個 studentId 兩列）。所以這裡不做任何「一位學生
 * 只能有一位家長」的檢查——那種檢查會在離婚、隔代教養、以及
 * 「爸爸負責繳費、媽媽負責看成績」這三種都很常見的情況下擋錯人。
 *
 * `verifiedAt` 預設 null：建立連結不等於憑證交到人手上。見上面
 * `notifiableGuardians` 的長註解。
 */
export async function linkGuardian(guardianId: string, studentId: string, actorId: string) {
  const tenantId = requireTenant();
  if (guardianId === studentId) {
    throw new GuardianError('INVALID', '不能把自己綁成自己的家長。', 400);
  }

  const [guardian, student] = await Promise.all([
    prisma.user.findFirst({
      where: { id: guardianId, deletedAt: null },
      select: { id: true, username: true, systemRole: true, status: true },
    }),
    loadStudent(studentId),
  ]);
  if (!guardian) throw new GuardianError('NOT_FOUND', '找不到這個家長帳號。', 404);
  // **只有 GUARDIAN 帳號綁得上。** 少了這一道，一支「給我兩個 userId
  // 就建立關係」的 API 可以把一位學生綁成另一位學生的家長——而那一位
  // 立刻看得到別人的成績。角色檢查在這裡而不是在路由，是因為路由有三支。
  if (guardian.systemRole !== 'GUARDIAN') {
    throw new GuardianError(
      'CONFLICT',
      '這個帳號不是家長帳號，不能綁定。家長帳號請用信箱新增。',
      409,
    );
  }

  const existing = await prisma.guardianLink.findFirst({
    where: { guardianId, studentId },
    select: { id: true, verifiedAt: true },
  });
  let link = existing;
  if (!link) {
    try {
      link = await prisma.guardianLink.create({
        data: { guardianId, studentId },
        select: { id: true, verifiedAt: true },
      });
    } catch {
      // `@@unique([guardianId, studentId])` 擋下來的競態：另一個分頁
      // （或連按兩下）在上面那次查詢與這次寫入之間剛好建好了同一條。
      // **那正是我們要的結果**，所以把它讀回來而不是把 P2002 丟給
      // 使用者看——他按下的是「新增家長」，而那位家長現在確實接上了。
      link = await prisma.guardianLink.findFirst({
        where: { guardianId, studentId },
        select: { id: true, verifiedAt: true },
      });
      if (!link) throw new GuardianError('CONFLICT', '這條連結建不起來，請重新整理再試一次。', 409);
    }
  }

  // 停用過的家長帳號在重新接上孩子時放回可登入。停用發生在
  // 「最後一個孩子的連結被移除」那一刻（見 `unlinkGuardian`），
  // 所以這裡是它的反向；不放回來的話，重新綁定之後家長仍然登不進去，
  // 而畫面上顯示連結建好了。
  if (guardian.status === 'ARCHIVED') {
    await prisma.user.update({
      where: { id: guardianId },
      data: { status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null },
    });
  }

  if (!existing) {
    await audit(tenantId, actorId, 'guardian.link', link.id, {
      guardian: guardian.username,
      student: student.username,
      studentName: student.displayName,
    });
  }
  return { ...link, created: !existing, guardianId, studentId };
}

/**
 * 找出或建立一個家長帳號，並接到這位學生身上。
 *
 * 回傳的 `credential` 只在**這一次真的建了新帳號**時才有值，
 * 而且只有這一次拿得到——與名冊匯入的初始密碼同一條規則。
 * 已經存在的帳號不會產生新密碼：那位家長可能已經在用它看另一個
 * 孩子，重設等於把他登出。要重設走 `resetGuardianPassword`。
 */
export async function addGuardianForStudent(
  studentId: string,
  rawEmail: string,
  actorId: string,
): Promise<{
  linkId: string;
  guardianId: string;
  username: string;
  displayName: string;
  created: boolean;
  credential: { username: string; displayName: string; password: string } | null;
}> {
  requireTenant();
  const email = checkEmail(rawEmail);
  const student = await loadStudent(studentId);

  const taken = await prisma.user.findFirst({
    where: { username: email },
    select: { id: true, systemRole: true, displayName: true, deletedAt: true },
  });
  if (taken && (taken.systemRole !== 'GUARDIAN' || taken.deletedAt)) {
    // **絕對不能靜靜地接上去。** 一個與學生學號或老師代號相同的
    // 「信箱」撞進來時，把連結建上去等於把那個人變成這位學生的家長，
    // 而那個人現在看得到成績。訊息不說出對方是誰（那會透露一個
    // 帳號的存在與角色），只說這條路走不通。
    throw new GuardianError(
      'CONFLICT',
      `「${email}」已經被另一個帳號用作登入代號了，不能當成家長帳號。` +
        '請改用另一個信箱，或請系統管理員處理那個帳號。',
      409,
    );
  }

  let guardianId = taken?.id ?? null;
  let credential: { username: string; displayName: string; password: string } | null = null;
  let created = false;
  const displayName = taken?.displayName ?? guardianDisplayName(student.displayName);

  if (!guardianId) {
    // 雜湊算在建立之前，**不在任何交易裡**。bcrypt 一次 0.31 秒而
    // Prisma 互動式交易上限 5 秒——理由詳見 `lib/roster.ts` 的
    // `mintPasswords`。這裡一次只有一個帳號，但把它寫進交易裡就是
    // 在等它變成一個「平常都好、忙的時候整批失敗」的東西。
    const password = newPassword();
    const passwordHash = await hashPassword(password);
    const tenantId = requireTenant();
    const guardian = await prisma.user.create({
      data: {
        tenantId,
        username: email,
        // `email` 也一起寫。`@@unique([tenantId, email])` 會擋住兩位
        // 家長共用同一個信箱，而那正是我們要的——同一個信箱就是
        // 同一個帳號、接兩個孩子。
        email,
        displayName,
        systemRole: 'GUARDIAN',
        passwordHash,
        mustChangePassword: true,
        // 家長是成年人，**沒有家長同意這一關**。個資法第 15 條管的是
        // 蒐集未成年人的個人資料，而這個帳號的主體就是法定代理人本人。
        // 給他 `PENDING_CONSENT` 的話，要等的是他自己同意自己。
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    guardianId = guardian.id;
    created = true;
    credential = { username: email, displayName, password };
  }

  const link = await linkGuardian(guardianId, studentId, actorId);

  // 名冊上那一欄空著的話順手補上，讓「整班重建家長帳號」下次跑出來的
  // 結果與現在一致。**已經有值就不覆蓋**：一位學生可能有兩位監護人，
  // 而 `User.guardianEmail` 只放得下一個——用第二位蓋掉第一位，
  // 會讓名冊上顯示的聯絡人變成一個沒有人決定過的選擇。
  if (!student.guardianEmail) {
    await prisma.user.update({ where: { id: student.id }, data: { guardianEmail: email } });
  }

  return {
    linkId: link.id,
    guardianId,
    username: email,
    displayName,
    created,
    credential,
  };
}

/**
 * 解除連結。
 *
 * # 為什麼要跟著停用帳號
 *
 * 因為一個沒有任何孩子的家長帳號登進來只會看到空畫面，而它仍然是
 * 一組有效的憑證。而移除連結最常見的原因正是**「這個信箱不是他的」**
 * ——櫃檯打錯了、或那是前一位監護人的。那時留著一個登得進來的帳號
 * 是錯的，即使他現在什麼都看不到：日後任何一次誤操作把他接到別的
 * 孩子身上，那組密碼還在別人手裡。
 *
 * 還有孩子的話不動帳號——一位家長兩個孩子，退掉其中一個不該影響另一個。
 *
 * # 為什麼是刪除那一列，而不是寫一個 leftAt
 *
 * 與 `ClassMembership` 不同：班籍是歷史成績要對回去的依據，
 * 而家長連結沒有任何歷史資料掛在上面。留著一列「曾經是家長」
 * 只會讓「他現在看不看得到」多一個要判斷的欄位，而判斷錯的方向
 * 是他還看得到。誰在什麼時候解除的留在稽核裡。
 */
export async function unlinkGuardian(linkId: string, actorId: string) {
  const tenantId = requireTenant();
  const link = await prisma.guardianLink.findFirst({
    where: { id: linkId },
    select: { id: true, guardianId: true, studentId: true },
  });
  if (!link) throw new GuardianError('NOT_FOUND', '找不到這一筆家長連結。', 404);

  const [guardian, student] = await Promise.all([
    prisma.user.findFirst({
      where: { id: link.guardianId },
      select: { id: true, username: true, displayName: true },
    }),
    prisma.user.findFirst({
      where: { id: link.studentId },
      select: { id: true, username: true, displayName: true },
    }),
  ]);

  await prisma.guardianLink.deleteMany({ where: { id: linkId } });

  const left = await prisma.guardianLink.count({ where: { guardianId: link.guardianId } });
  if (left === 0) {
    await prisma.user.updateMany({
      where: { id: link.guardianId, systemRole: 'GUARDIAN' },
      data: { status: 'ARCHIVED' },
    });
    // session 一起清掉。少了這一句，正在看的那個分頁還活著——
    // 而它下一次重新整理才會發現自己已經沒有孩子了。
    await prisma.session.deleteMany({ where: { userId: link.guardianId } });
  }

  await audit(tenantId, actorId, 'guardian.unlink', linkId, {
    guardian: guardian?.username ?? link.guardianId,
    student: student?.username ?? link.studentId,
    studentName: student?.displayName ?? null,
    guardianArchived: left === 0,
  });
  return {
    guardianName: guardian?.displayName ?? '這位家長',
    studentName: student?.displayName ?? '這位學生',
    archived: left === 0,
  };
}

/**
 * 標記「初始密碼已經交到這位家長手上」，或把標記撤回。
 *
 * 撤回是刻意留的：按錯的時候唯一的替代方案是把連結刪掉重建，
 * 而那會產生一組新密碼、把一個其實正常的家長登出。
 */
export async function setGuardianDelivered(
  linkId: string,
  delivered: boolean,
  actorId: string,
) {
  const tenantId = requireTenant();
  const link = await prisma.guardianLink.findFirst({
    where: { id: linkId },
    select: { id: true, guardianId: true, studentId: true, verifiedAt: true },
  });
  if (!link) throw new GuardianError('NOT_FOUND', '找不到這一筆家長連結。', 404);
  if (Boolean(link.verifiedAt) === delivered) return link;

  const verifiedAt = delivered ? new Date() : null;
  await prisma.guardianLink.updateMany({ where: { id: linkId }, data: { verifiedAt } });

  const guardian = await prisma.user.findFirst({
    where: { id: link.guardianId },
    select: { username: true },
  });
  await audit(tenantId, actorId, delivered ? 'guardian.verify' : 'guardian.unverify', linkId, {
    guardian: guardian?.username ?? link.guardianId,
    basis: delivered
      ? '帳號密碼當面交付給法定代理人'
      : '先前的交付標記撤回（按錯，或交錯人）',
  });
  return { ...link, verifiedAt };
}

/**
 * 重設一位家長的密碼。
 *
 * # 為什麼參數是 linkId 而不是 guardianId
 *
 * 因為那讓這支 API 只能作用在「一個真的接在某位學生身上的家長」上。
 * 收 userId 的話，它就是一支「給我任何 userId 就產生一組可用密碼」
 * 的 API，而權限發到老師手上——一位老師對著管理員的 id 打一次就
 * 拿到了管理員的密碼。這是 `resetStudentPassword` 用
 * `systemRole: 'STUDENT'` 擋住的同一條提權路徑，這裡改用連結擋，
 * 因為家長沒有「屬於哪個班」可以判定。
 *
 * 底下再擋一次 `systemRole: 'GUARDIAN'`——連結那一頭理論上只可能是
 * 家長帳號（`linkGuardian` 擋過），但這種「理論上」正是提權的溫床。
 */
export async function resetGuardianPassword(linkId: string, actorId: string) {
  const tenantId = requireTenant();
  const link = await prisma.guardianLink.findFirst({
    where: { id: linkId },
    select: { guardianId: true },
  });
  if (!link) throw new GuardianError('NOT_FOUND', '找不到這一筆家長連結。', 404);

  const guardian = await prisma.user.findFirst({
    where: { id: link.guardianId, systemRole: 'GUARDIAN', deletedAt: null },
    select: { id: true, username: true, displayName: true, status: true },
  });
  if (!guardian) throw new GuardianError('NOT_FOUND', '找不到這個家長帳號。', 404);

  const password = newPassword();
  const passwordHash = await hashPassword(password);
  await prisma.$transaction([
    prisma.user.update({
      where: { id: guardian.id },
      data: {
        passwordHash,
        mustChangePassword: true,
        passwordChangedAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
      },
    }),
    // 會需要重設，常見的原因之一是密碼被別人看到了。留著舊 session
    // 等於那個人還在裡面。與 `resetStudentPassword` 同一條規則。
    prisma.session.deleteMany({ where: { userId: guardian.id } }),
  ]);

  await prisma.auditLog.create({
    data: {
      tenantId,
      // 密碼相關的稽核一律 AUTH，與學生、教職員那兩支同一個分類——
      // 同一件事分散在兩個分類裡，出事時查的人會只翻其中一個然後說
      // 「沒有記錄」。理由詳見 `lib/roster.ts` 的 `auditAuth`。
      category: 'AUTH',
      action: 'auth.password_reset',
      actorId,
      targetType: 'User',
      targetId: guardian.id,
      // **不寫明文密碼。** 稽核記錄會被匯出。
      after: { guardian: guardian.username, accountStatus: guardian.status } as never,
    },
  });

  return {
    guardianId: guardian.id,
    username: guardian.username,
    displayName: guardian.displayName,
    password,
  };
}

// ─────────────────────────────────────────────────────────────────
// 從名冊一次建起來
// ─────────────────────────────────────────────────────────────────

export type GuardianProvision = {
  className: string;
  /** 這一次新開的家長帳號數。 */
  created: number;
  /** 這一次新接上的連結數（含用既有帳號接的）。 */
  linked: number;
  /** 本來就已經接好的。按第二次時這個數字會等於全部。 */
  alreadyLinked: number;
  /** 名冊上沒有家長信箱的學生數。 */
  withoutEmail: number;
  /** 接不上的，逐一說出原因。**不可以靜靜地跳過。** */
  skipped: { student: string; email: string; why: string }[];
  /** 新帳號的初始密碼。**只在這一次回傳，不會再取得。** */
  credentials: { username: string; displayName: string; childName: string; password: string }[];
};

/**
 * 依名冊上的家長信箱，把整個班的家長帳號與連結建起來。
 *
 * # 為什麼它是名冊匯入之後的第二步，而不是同一個交易
 *
 * 因為家長帳號也要算 bcrypt，而 `applyRoster` 的交易裡已經只剩下
 * 寫入了（初始密碼在交易外面先算好，見 `mintPasswords`）。
 * 把家長那一批塞進去，等於把那個交易的時間乘上兩倍的人數，
 * 而 Prisma 互動式交易的預設上限是 5 秒。
 *
 * # 為什麼分開之後仍然安全
 *
 * 因為這一支是**冪等**的：已經接好的連結不重建、已經存在的帳號
 * 不重設密碼。跑第二次、第三次的結果與第一次相同，所以
 *
 *   · 匯入時它失敗了 → 名冊頁上按一次「建立家長帳號」就補回來
 *   · 事後改了某位學生的家長信箱 → 按一次就接上，不必重匯名冊
 *
 * 名冊匯入本身的「全有全無」在這裡不適用，也不需要：那條規則
 * 存在的理由是「部分匯入之後沒有人知道現在是什麼狀態」，
 * 而這一支跑完會逐項說出建了幾個、跳過哪幾個、為什麼。
 *
 * # 新帳號的密碼一樣只顯示一次
 *
 * 所以帳號建立本身要在**一個交易**裡：做到一半失敗的話，已經建好
 * 的那幾個帳號的密碼會跟著回應一起消失，而它們再也拿不回來
 * （下次跑會判定「已經存在」而不產生新密碼）。密碼在交易外面
 * 先算好，交易裡只剩下寫入。
 */
export async function provisionGuardiansForClass(
  classId: string,
  actorId: string,
): Promise<GuardianProvision> {
  const tenantId = requireTenant();
  const klass = await prisma.class.findFirst({
    where: { id: classId },
    select: { id: true, name: true },
  });
  if (!klass) throw new GuardianError('NOT_FOUND', '找不到這個班級', 404);

  const members = await prisma.classMembership.findMany({
    where: { classId, leftAt: null, role: 'STUDENT' },
    select: { userId: true },
    orderBy: { joinedAt: 'asc' },
  });
  const students = members.length
    ? await prisma.user.findMany({
        where: {
          id: { in: members.map((m) => m.userId) },
          systemRole: 'STUDENT',
          deletedAt: null,
        },
        select: { id: true, username: true, displayName: true, guardianEmail: true },
      })
    : [];

  const skipped: GuardianProvision['skipped'] = [];
  const withEmail: { id: string; username: string; displayName: string; email: string }[] = [];
  for (const s of students) {
    const raw = (s.guardianEmail ?? '').trim();
    if (!raw) continue;
    const email = guardianUsername(raw);
    if (!EMAIL.test(email)) {
      skipped.push({
        student: s.displayName,
        email: raw,
        why: '這一欄看起來不像一個信箱。到名冊上改好再按一次。',
      });
      continue;
    }
    withEmail.push({ id: s.id, username: s.username, displayName: s.displayName, email });
  }

  // 同一個信箱在同一個班出現兩次是正常的（兄弟姊妹同班），
  // 而那應該變成**一個帳號兩條連結**，不是兩個帳號。
  const byEmail = new Map<string, typeof withEmail>();
  for (const s of withEmail) {
    const bucket = byEmail.get(s.email);
    if (bucket) bucket.push(s);
    else byEmail.set(s.email, [s]);
  }

  const emails = [...byEmail.keys()];
  const existing = emails.length
    ? await prisma.user.findMany({
        where: { username: { in: emails } },
        select: { id: true, username: true, displayName: true, systemRole: true, deletedAt: true, status: true },
      })
    : [];
  const accountBy = new Map(existing.map((u) => [u.username, u]));

  const toCreate: { email: string; displayName: string; childName: string }[] = [];
  for (const [email, kids] of byEmail) {
    const hit = accountBy.get(email);
    if (hit && (hit.systemRole !== 'GUARDIAN' || hit.deletedAt)) {
      for (const kid of kids) {
        skipped.push({
          student: kid.displayName,
          email,
          why: '這個信箱已經被另一個帳號用作登入代號了。請換一個信箱。',
        });
      }
      continue;
    }
    if (!hit) {
      toCreate.push({
        email,
        displayName: guardianDisplayName(kids[0].displayName),
        childName: kids.map((k) => k.displayName).join('、'),
      });
    }
  }

  // 密碼**在交易外面先算好**。bcrypt 一次 0.31 秒，30 位家長就是
  // 十秒，而 Prisma 的互動式交易預設 5 秒就被切斷——寫在交易裡的話，
  // 小班正常、大班整批失敗，而錯誤訊息完全看不出與密碼有關。
  const minted = new Map<string, { password: string; hash: string }>();
  for (const c of toCreate) {
    const password = newPassword();
    minted.set(c.email, { password, hash: await hashPassword(password) });
  }

  const credentials: GuardianProvision['credentials'] = [];
  let created = 0;
  let linked = 0;
  let alreadyLinked = 0;
  const newLinks: { linkId: string; guardian: string; student: string }[] = [];

  await prisma.$transaction(async (tx) => {
    for (const c of toCreate) {
      const mint = minted.get(c.email);
      if (!mint) throw new Error('產生家長密碼時漏了一位，整批都沒有執行。請再試一次。');
      const guardian = await tx.user.create({
        data: {
          tenantId,
          username: c.email,
          email: c.email,
          displayName: c.displayName,
          systemRole: 'GUARDIAN',
          passwordHash: mint.hash,
          mustChangePassword: true,
          status: 'ACTIVE',
        },
        select: { id: true, username: true, displayName: true, systemRole: true, deletedAt: true, status: true },
      });
      accountBy.set(c.email, guardian);
      created += 1;
      credentials.push({
        username: c.email,
        displayName: c.displayName,
        childName: c.childName,
        password: mint.password,
      });
    }

    for (const [email, kids] of byEmail) {
      const account = accountBy.get(email);
      if (!account || account.systemRole !== 'GUARDIAN' || account.deletedAt) continue;
      // 上一輪把最後一個孩子退掉時帳號被停用了，現在又接回來。
      if (account.status === 'ARCHIVED') {
        await tx.user.updateMany({
          where: { id: account.id },
          data: { status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null },
        });
        account.status = 'ACTIVE';
      }
      for (const kid of kids) {
        const already = await tx.guardianLink.findFirst({
          where: { guardianId: account.id, studentId: kid.id },
          select: { id: true },
        });
        if (already) {
          alreadyLinked += 1;
          continue;
        }
        const link = await tx.guardianLink.create({
          data: { guardianId: account.id, studentId: kid.id },
          select: { id: true },
        });
        linked += 1;
        newLinks.push({ linkId: link.id, guardian: email, student: kid.username });
      }
    }
  });

  // 稽核**每一條連結各一列**，與整批登錄同意同一條規則：個資事件
  // 調查問的是「這位學生的資料是誰、什麼時候開放給哪個家長的」，
  // 而 `targetId` 指向那一條連結才查得到。記成一列「建了 30 條」
  // 的話，要查某一條就得把 metadata 撈出來自己找。
  if (newLinks.length > 0) {
    await prisma.auditLog.createMany({
      data: newLinks.map((l) => ({
        tenantId,
        category: 'USER' as const,
        action: 'guardian.link',
        actorId,
        targetType: 'guardian',
        targetId: l.linkId,
        after: { guardian: l.guardian, student: l.student, source: `名冊（${klass.name}）` } as never,
      })),
    });
  }

  return {
    className: klass.name,
    created,
    linked,
    alreadyLinked,
    withoutEmail: students.length - withEmail.length,
    skipped,
    credentials,
  };
}

// ─────────────────────────────────────────────────────────────────
// 職員那一側的讀取：名冊上每一位的家長
// ─────────────────────────────────────────────────────────────────

export type GuardianOfStudent = {
  linkId: string;
  guardianId: string;
  username: string;
  displayName: string;
  /** 帳號還登得進去嗎。停用的多半是「所有孩子的連結都被移除過」。 */
  active: boolean;
  /** 初始密碼還沒交出去。名冊上要標，那是「印了忘了發」的唯一線索。 */
  delivered: boolean;
  /** 這位家長還接著幾個孩子。移除前的確認視窗要說得出來。 */
  children: number;
  createdAt: string;
};

/** 這位學生現在有哪幾位家長。職員用。 */
export async function listGuardiansOfStudent(studentId: string): Promise<GuardianOfStudent[]> {
  requireTenant();
  const links = await prisma.guardianLink.findMany({
    where: { studentId },
    select: { id: true, guardianId: true, verifiedAt: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  if (links.length === 0) return [];

  const ids = links.map((l) => l.guardianId);
  const [accounts, allLinks] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, username: true, displayName: true, status: true },
    }),
    prisma.guardianLink.findMany({
      where: { guardianId: { in: ids } },
      select: { guardianId: true },
    }),
  ]);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const kids = new Map<string, number>();
  for (const l of allLinks) kids.set(l.guardianId, (kids.get(l.guardianId) ?? 0) + 1);

  return links.map((l) => {
    const a = byId.get(l.guardianId);
    return {
      linkId: l.id,
      guardianId: l.guardianId,
      username: a?.username ?? '（帳號已不存在）',
      displayName: a?.displayName ?? '（帳號已不存在）',
      active: a?.status === 'ACTIVE',
      delivered: l.verifiedAt != null,
      children: kids.get(l.guardianId) ?? 1,
      createdAt: l.createdAt.toISOString(),
    };
  });
}

/**
 * 這個班每一位學生各接了幾位家長。
 *
 * 名冊那一頁要靠它畫「家長」那一欄，而 200 位逐位去問是 200 次往返，
 * 每一次在租戶隔離底下是三句 SQL（見 `lib/prismaClient.mjs`）。
 */
export async function guardianCountsForClass(
  classId: string,
): Promise<Map<string, { linked: number; delivered: number }>> {
  requireTenant();
  const members = await prisma.classMembership.findMany({
    where: { classId, role: 'STUDENT' },
    select: { userId: true },
  });
  const out = new Map<string, { linked: number; delivered: number }>();
  if (members.length === 0) return out;

  const links = await prisma.guardianLink.findMany({
    where: { studentId: { in: members.map((m) => m.userId) } },
    select: { studentId: true, verifiedAt: true },
  });
  for (const l of links) {
    const b = out.get(l.studentId) ?? { linked: 0, delivered: 0 };
    b.linked += 1;
    if (l.verifiedAt) b.delivered += 1;
    out.set(l.studentId, b);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────
// 家長那一側的讀取
// ─────────────────────────────────────────────────────────────────

export type Child = {
  studentId: string;
  displayName: string;
  className: string | null;
  /** 這位家長的連結驗證過了沒。首頁上要說出來，見上面的長註解。 */
  delivered: boolean;
};

/**
 * 這位家長的孩子。**這是全系統唯一一處把 guardianId 換成 studentId
 * 的地方**，所以「家長看得到誰」這個問題只有一個答案。
 *
 * 已經被個資刪除的孩子不列出來（`eraseStudent` 本來就會把連結一起
 * 刪掉，這裡是第二道）。
 */
export async function childrenOf(guardianId: string): Promise<Child[]> {
  requireTenant();
  const links = await prisma.guardianLink.findMany({
    where: { guardianId },
    select: { studentId: true, verifiedAt: true },
    orderBy: { createdAt: 'asc' },
  });
  if (links.length === 0) return [];

  const students = await prisma.user.findMany({
    where: {
      id: { in: links.map((l) => l.studentId) },
      systemRole: 'STUDENT',
      deletedAt: null,
    },
    select: { id: true, displayName: true },
  });
  const byId = new Map(students.map((s) => [s.id, s]));

  const memberships = students.length
    ? await prisma.classMembership.findMany({
        where: { userId: { in: students.map((s) => s.id) }, leftAt: null, role: 'STUDENT' },
        select: { userId: true, classId: true },
      })
    : [];
  const classes = memberships.length
    ? await prisma.class.findMany({
        where: { id: { in: memberships.map((m) => m.classId) } },
        select: { id: true, name: true },
      })
    : [];
  const className = new Map(classes.map((c) => [c.id, c.name]));
  const classOf = new Map<string, string>();
  for (const m of memberships) {
    const name = className.get(m.classId);
    if (name && !classOf.has(m.userId)) classOf.set(m.userId, name);
  }

  const out: Child[] = [];
  for (const l of links) {
    const s = byId.get(l.studentId);
    if (!s) continue;
    out.push({
      studentId: s.id,
      displayName: s.displayName,
      className: classOf.get(s.id) ?? null,
      delivered: l.verifiedAt != null,
    });
  }
  return out;
}

/**
 * 這個 studentId 真的是這位家長的孩子嗎。
 *
 * **每一支家長端的讀取都要先過這一道。** RLS 擋得住別家補習班，
 * 擋不住同一間補習班的另一個孩子——他的資料與你孩子的在同一個租戶裡，
 * 政策全部通過。網址上的 `?child=` 換一個 id 就是那條路。
 */
export async function requireChild(guardianId: string, studentId: string): Promise<Child> {
  const kids = await childrenOf(guardianId);
  const hit = kids.find((c) => c.studentId === studentId);
  if (!hit) {
    // 「不是你的孩子」與「這個 id 不存在」回同一句。分開講等於把
    // 「這個 id 是一個學生」告訴問的人，而那是一次可以逐個試的探測。
    throw new GuardianError('FORBIDDEN', '這不是你的孩子。你只看得到自己孩子的狀況。', 403);
  }
  return hit;
}

export type ChildTask = GuardianTask & { compare: ClassComparison };

export type ChildView = {
  child: Child;
  summary: ChildSummary;
  tasks: ChildTask[];
  /** 為什麼現在沒有東西可以看。有東西時是 null。 */
  emptyReason: 'NO_CLASS' | 'NO_TASK' | 'NOT_SUBMITTED' | 'NOT_RELEASED' | null;
};

/**
 * 一個孩子的近況。家長端每一頁的唯一資料來源。
 *
 * 任務清單是**學生自己那一份的投影**（見檔頭）。班級平均另外算，
 * 而且只在這一份的成績已經對學生開放時才算——老師還沒放行的那幾份，
 * 連平均都不查。少了這個條件，家長會在孩子看到分數之前先看到
 * 「班上平均 72 分」，而那等於提前告訴他考完了、考得如何。
 */
export async function childView(guardianId: string, studentId: string): Promise<ChildView> {
  const child = await requireChild(guardianId, studentId);
  const raw = await listStudentTasks(studentId);

  // 只有「學生已經看得到分數」的那幾份才需要班級平均。
  const scored = raw.filter((t) => t.resultVisible && t.score != null);
  const means = await classMeans(scored.map((t) => t.assignmentId));

  const tasks: ChildTask[] = raw.map((t) => {
    const stat = means.get(t.assignmentId);
    return {
      ...projectTask(t as unknown as Record<string, unknown>),
      compare: compareToClass({
        score: t.resultVisible ? t.score : null,
        maxScore: t.maxScore,
        mean: stat?.mean ?? null,
        peers: stat?.peers ?? 0,
      }),
    };
  });

  const summary = summarizeChild(tasks);
  return {
    child,
    summary,
    tasks,
    emptyReason: noDataReason({
      inClass: child.className !== null,
      taskCount: tasks.length,
      submittedCount: tasks.filter((t) => t.lastSubmittedAt).length,
      scoredCount: summary.scored,
    }),
  };
}

/**
 * 這幾份任務的班級平均與交卷人數。
 *
 * **只算學生的作答**，與 `classStats` 及學生歷程頁同一條規則：
 * 老師自己試考的那一份會把平均拉高，而那個數字看起來完全正常。
 *
 * 兩句查詢而不是一句帶關聯條件的：`where: { user: { systemRole } }`
 * 在 Prisma 上是一次 join，讀起來比較短，但這一段在
 * `tools/e2e-guardian.mjs` 底下是用真的 SQL 跑的，而那支測試驗的
 * 正是「家長拿不到別人的資料」——用兩句簡單查詢換一份真的跑得起來
 * 的端到端驗證，划算。
 */
async function classMeans(
  assignmentIds: readonly string[],
): Promise<Map<string, { mean: number; peers: number }>> {
  const out = new Map<string, { mean: number; peers: number }>();
  if (assignmentIds.length === 0) return out;

  const attempts = await prisma.attempt.findMany({
    where: {
      assignmentId: { in: [...new Set(assignmentIds)] },
      status: { in: ['SUBMITTED', 'GRADED'] },
      totalScore: { not: null },
    },
    select: { assignmentId: true, userId: true, totalScore: true },
  });
  if (attempts.length === 0) return out;

  const students = await prisma.user.findMany({
    where: { id: { in: [...new Set(attempts.map((a) => a.userId))] }, systemRole: 'STUDENT' },
    select: { id: true },
  });
  const isStudent = new Set(students.map((s) => s.id));

  const bucket = new Map<string, { sum: number; n: number }>();
  for (const a of attempts) {
    if (!isStudent.has(a.userId)) continue;
    const b = bucket.get(a.assignmentId) ?? { sum: 0, n: 0 };
    b.sum += a.totalScore as number;
    b.n += 1;
    bucket.set(a.assignmentId, b);
  }
  for (const [id, b] of bucket) {
    if (b.n > 0) out.set(id, { mean: b.sum / b.n, peers: b.n });
  }
  return out;
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
