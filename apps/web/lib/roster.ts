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
// session 的作廢在下面是**跟著密碼寫入同一個交易**做的，所以這裡
// 不用 `revokeAllSessions`：分成兩次寫入的話，中間那一瞬間新密碼
// 已經生效而舊 session 還活著，而那正是「密碼被同學看到了」要斷掉的
// 那條連線。
import { hashPassword } from '@/lib/password';
import { requireTenant } from '@/lib/tenant';
import { decodeCsv, matchColumns, parseCsv } from '@/lib/csv.mjs';
import { OTP_LENGTH, oneTimePassword } from '@/lib/passwordRules.mjs';
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

  // 密碼**在交易外面先算好**。理由見 `mintPasswords`——一句話：
  // bcrypt 一次要 0.3 秒，而 Prisma 的互動式交易預設 5 秒就會被切斷。
  const minted = await mintPasswords(plan.creating);

  // 一個交易。全有全無不是靠事後補救，是靠資料庫。
  await prisma.$transaction(async (tx) => {
    for (const row of plan.rows) {
      let user = await tx.user.findFirst({
        where: { username: row.username },
        select: { id: true, displayName: true },
      });

      if (!user) {
        const mint = minted.get(row.username);
        if (!mint) {
          // 試算的時候這個帳號還在，現在不見了——有人在這兩步之間
          // 把它刪掉了。整份停下來（全有全無），而訊息要說得出下一步。
          throw new Error(
            `「${row.username}」的狀態在試算之後被改動了。請重新試算一次再匯入。`,
          );
        }
        user = await tx.user.create({
          data: {
            tenantId,
            username: row.username,
            displayName: row.displayName,
            email: row.email,
            guardianEmail: row.guardianEmail,
            birthDate: row.birthDate,
            systemRole: 'STUDENT',
            passwordHash: mint.hash,
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
          password: mint.password,
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
 * 初始密碼與重設密碼**共用的唯一產生器**。
 *
 * 字母表與抽樣邏輯在 `lib/passwordRules.mjs`（純函式、有測試）。
 * 分成兩份實作的話，兩邊的字母表遲早會分岐，而分岐的那一天老師會
 * 發現「匯入的密碼打得進去、重設的打不進去」，然後懷疑是重設壞了。
 *
 * 亂數在這裡供給而不是寫在那個檔案裡，理由有兩個：
 *
 *   · 那個檔案要能被瀏覽器端引用（更換密碼的表單共用強度檢查），
 *     而 `import 'node:crypto'` 會讓 `next build` 直接失敗。
 *   · 「用哪一種亂數」是一個要被看見的決定。**這裡一定是 CSPRNG**：
 *     `Math.random()` 可預測，而這串字是兩百個帳號當天唯一的憑證。
 *
 * 一次抓兩倍的量，是因為抽樣會丟掉落在 31 的倍數之外的位元組
 * （見那邊的註解），一次抓足就不必回頭再要。
 *
 * 教職員帳號（`lib/staff.ts`）也用這一支。**不要在那邊再寫一個**：
 * 兩份實作遲早會分岐，而分岐的那一天，管理員會發現老師的初始密碼
 * 與學生的長得不一樣，然後開始懷疑其中一邊是壞的。
 */
export function newPassword(): string {
  return oneTimePassword(() => randomBytes(OTP_LENGTH * 2));
}

/**
 * 先把一批臨時密碼與它們的雜湊全部算好，**在資料庫交易外面**。
 *
 * # 這一支存在的唯一理由是 bcrypt 很慢，而那是刻意的
 *
 * `hashPassword` 跑 12 輪 bcrypt，實測一次 0.31 秒。慢是它的功能
 * （慢才擋得住離線暴力破解），但那 0.31 秒乘上一整班就變成別的東西：
 *
 *   · 一份 16 人的名冊 → 約 5 秒
 *   · 一份 32 人的名冊 → 約 10 秒
 *
 * 而 **Prisma 互動式交易的預設上限是 5 秒**。把雜湊寫在
 * `$transaction(async (tx) => …)` 的迴圈裡，一班十幾個人以下都正常，
 * 超過就整份失敗，錯誤訊息是 `Transaction already closed`——完全看
 * 不出與密碼有關。而它會在開學前一天、櫃檯匯入第一份完整名冊的
 * 那一刻第一次出現。
 *
 * 算好之後交易裡只剩下寫入，一班的交易時間回到毫秒等級。
 *
 * # 為什麼不平行算
 *
 * bcryptjs 是純 JavaScript，CPU 綁死在同一條執行緒上。`Promise.all`
 * 只會讓它們交錯執行，總時間一樣，但記憶體與尾延遲更難預測。
 *
 * @param keys 要產密碼的鍵（名冊用學號、重設用 userId）
 */
async function mintPasswords(
  keys: readonly string[],
): Promise<Map<string, { password: string; hash: string }>> {
  const out = new Map<string, { password: string; hash: string }>();
  for (const key of keys) {
    const password = newPassword();
    out.set(key, { password, hash: await hashPassword(password) });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────
// 重設密碼
// ─────────────────────────────────────────────────────────────────

/**
 * 一組交到人手上的臨時憑證。**只在回傳的那一次拿得到。**
 *
 * 不存明文、不寫進稽核、不寫進 log——雜湊之後那串字就沒有第二個
 * 副本了。這不是潔癖：稽核記錄會被匯出、log 會被複製到維運機器上，
 * 而一份含兩百組可用密碼的檔案流出去，等於整個系統的帳號都失守。
 */
export type ResetCredential = {
  userId: string;
  username: string;
  displayName: string;
  password: string;
};

/**
 * 只有學生帳號重設得了。
 *
 * # 這一行擋掉的是提權
 *
 * 重設密碼的權限給到老師（櫃檯現場就要能處理），而如果不限定對象，
 * 一位老師就能對著系統管理員的 userId 打一次這支 API、拿到一組
 * 可用的密碼，然後用管理員的身分登入。整套角色權限在那一刻歸零。
 *
 * 老師與管理員自己忘記密碼是另一件事，走的是另一條路（找系統管理員
 * 從主控台處理），**不該與「學生在櫃檯說我登不進去」共用同一個入口**。
 */
async function loadResettableStudent(studentId: string) {
  const student = await prisma.user.findFirst({
    where: { id: studentId, systemRole: 'STUDENT', deletedAt: null },
    select: { id: true, username: true, displayName: true, status: true },
  });
  if (!student) {
    // 找不到有兩種可能：不存在，或者對象不是學生帳號。兩種都回同一句——
    // 分開講等於告訴對方「這個 id 是一個老師的帳號」。
    throw new Error('找不到這位學生。只有學生帳號可以從名冊重設密碼。');
  }
  return student;
}

/**
 * 這位學生現在有沒有一份正在進行的作答。
 *
 * 重設密碼會把他所有的 session 作廢（見下面），所以考試進行中按下去
 * 等於**把人從考場裡踢出來**：他的畫面還在，但下一次自動存檔會 401，
 * 而那一題就沒有存進去。這件事必須在按下之前講出來。
 */
async function writingNow(studentId: string): Promise<string | null> {
  const open = await prisma.attempt.findFirst({
    where: { userId: studentId, status: 'IN_PROGRESS' },
    select: { assignment: { select: { title: true } } },
  });
  return open?.assignment.title ?? null;
}

/**
 * 重設一位學生的密碼，回傳一組新的臨時密碼。
 *
 * # 為什麼系統裡非有這一支不可
 *
 * 在此之前，初始密碼只在名冊匯入的那一次回傳，之後**沒有任何介面
 * 可以重設**。兩百位學生第一次登入，忘記密碼的一定不只一個，而
 * 當時唯一的解法是「把整份名冊再匯一次」——那會動到不該被動到的人。
 *
 * # 為什麼不做寄信的忘記密碼流程
 *
 * 因為這些學生多半沒有登記 email，而系統跑在補習班的封閉網段裡，
 * 對外的 SMTP 是 ERR_TUNNEL_CONNECTION_FAILED。做一個寄不出去的
 * 重設信，比沒有更糟：學生會等一封永遠不會到的信。
 *
 * 補習班的實際流程就是「學生跟老師講、老師當場給一串新密碼」，
 * 所以這一支就是那個流程：產生、顯示一次、要求他下次登入時換掉。
 *
 * # 三件跟著一起做的事
 *
 * **一、清掉鎖定與失敗計數。** 會來要重設密碼的學生，多半已經試錯
 * 五次被鎖了 15 分鐘（見 lib/password.ts）。不清的話，老師把新密碼
 * 抄給他、他照著打，仍然登不進去——而畫面上只會說「請稍後再試」，
 * 兩邊都會以為是重設功能壞了。
 *
 * **二、作廢所有既有 session。** 會需要重設，常見的原因之一是密碼
 * 被同學看到了。留著舊 session 等於那個人還在裡面。
 *
 * **三、標記 mustChangePassword。** 這串字經過老師的手、可能被抄在
 * 便條紙上，不該長期作為有效憑證。
 *
 * **不動 `status`。** 還沒取得家長同意的帳號重設完仍然登不進去，
 * 那是對的——個資法的要件不會因為換了一組密碼就消失。名冊頁上
 * 「帳號狀態」那一欄看得到，所以老師不會白忙。
 */
export async function resetStudentPassword(
  studentId: string,
  actorId: string,
): Promise<ResetCredential & { warning: string | null }> {
  const tenantId = requireTenant();
  const student = await loadResettableStudent(studentId);
  const busyWith = await writingNow(student.id);

  const password = newPassword();
  await prisma.$transaction([
    prisma.user.update({
      where: { id: student.id },
      data: {
        passwordHash: await hashPassword(password),
        mustChangePassword: true,
        passwordChangedAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
      },
    }),
    prisma.session.deleteMany({ where: { userId: student.id } }),
  ]);

  await auditAuth(tenantId, actorId, 'auth.password_reset', student.id, {
    student: student.username,
    // **不寫明文密碼。** 稽核記錄會被匯出，而一份含可用密碼的匯出檔
    // 等於把帳號一起交出去。要記的是「誰在什麼時候重設了誰的」。
    accountStatus: student.status,
    hadOpenAttempt: busyWith !== null,
  });

  return {
    userId: student.id,
    username: student.username,
    displayName: student.displayName,
    password,
    warning: busyWith
      ? `${student.displayName}目前有一份「${busyWith}」正在作答中，` +
        '這次重設已經把他登出了。請他用新密碼重新登入並回到那份考卷——' +
        '已經存到伺服器的答案都還在，但登出前最後幾秒還沒送出的可能會漏掉。'
      : null,
  };
}

/**
 * 整班重設。
 *
 * # 為什麼它比單一個危險得多
 *
 * 因為它讓**全班現有的密碼同時失效**。學生已經改過的、自己記得的
 * 那一組，按下去就沒了——而其中大部分人根本沒有忘記密碼。所以
 * 介面上要比單一個難按（要打出班級名稱才確認得了），而這裡再擋一道。
 *
 * # 考試進行中一律拒絕，整班
 *
 * 單一個重設容許考試中執行（那是急件：學生登不進去，不做他就不能
 * 考），但整班重設不是急件——它是開學或期初的行政作業。而在考試中
 * 按下去，是把整個考場的人同時登出。所以只要有任何一位正在作答，
 * 整批就停下來，並且說出是誰。
 *
 * 全有全無與名冊匯入同一個理由：**做一半之後沒有人知道現在是什麼
 * 狀態**——哪幾位換了、哪幾位沒換，而印出來的那張紙上看不出來。
 */
export async function resetClassPasswords(
  classId: string,
  actorId: string,
): Promise<{ className: string; credentials: ResetCredential[] }> {
  const tenantId = requireTenant();
  const klass = await prisma.class.findFirst({
    where: { id: classId },
    select: { id: true, name: true },
  });
  if (!klass) throw new Error('找不到這個班級');

  const members = await prisma.classMembership.findMany({
    where: { classId, leftAt: null, role: 'STUDENT' },
    select: {
      user: {
        select: { id: true, username: true, displayName: true, systemRole: true, deletedAt: true },
      },
    },
    orderBy: { joinedAt: 'asc' },
  });
  // 名冊裡也可能有助教或掛在班上的老師（role 不是 STUDENT 的那些已經
  // 被上面濾掉了，但帳號本身的 systemRole 要再確認一次）。少了這一道，
  // 整班重設會順手改掉一位老師的密碼。
  const students = members
    .map((m) => m.user)
    .filter((u) => u.systemRole === 'STUDENT' && u.deletedAt === null);

  if (students.length === 0) {
    throw new Error(`「${klass.name}」沒有可以重設密碼的學生。`);
  }

  const busy = await prisma.attempt.findMany({
    where: { userId: { in: students.map((s) => s.id) }, status: 'IN_PROGRESS' },
    select: { user: { select: { displayName: true } } },
    take: 5,
  });
  if (busy.length > 0) {
    const names = [...new Set(busy.map((b) => b.user.displayName))].join('、');
    throw new Error(
      `${names} 現在有作答進行中，整班重設會把他們從考場裡登出，所以整批都沒有執行。` +
        '等這場考完再重設；如果是單獨一位登不進去，請用那一列的「重設密碼」。',
    );
  }

  // 密碼**在交易外面先算好**。bcrypt 一次 0.3 秒，一整班就是十秒，
  // 而 Prisma 的互動式交易預設 5 秒就被切斷——寫在交易裡的話，
  // 小班正常、大班整批失敗，而錯誤訊息完全看不出與密碼有關。
  // 詳見 `mintPasswords`。
  const minted = await mintPasswords(students.map((s) => s.id));

  const credentials: ResetCredential[] = [];
  const now = new Date();
  // 一個交易。全有全無不是靠事後補救，是靠資料庫——印出來的那張紙上
  // 看不出哪幾位其實沒有換成功。
  await prisma.$transaction(async (tx) => {
    for (const s of students) {
      const mint = minted.get(s.id);
      if (!mint) throw new Error('產生密碼時漏了一位，整批都沒有執行。請再試一次。');
      await tx.user.update({
        where: { id: s.id },
        data: {
          passwordHash: mint.hash,
          mustChangePassword: true,
          passwordChangedAt: now,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      await tx.session.deleteMany({ where: { userId: s.id } });
      credentials.push({
        userId: s.id,
        username: s.username,
        displayName: s.displayName,
        password: mint.password,
      });
    }
  });

  await auditAuth(tenantId, actorId, 'auth.password_reset_class', classId, {
    class: klass.name,
    students: credentials.length,
    // 學號留著（哪些帳號被動到是稽核的重點），密碼一個都不留。
    usernames: credentials.map((c) => c.username),
  });

  return { className: klass.name, credentials };
}

// ─────────────────────────────────────────────────────────────────
// 進出班級
// ─────────────────────────────────────────────────────────────────

/**
 * 把一位學生移出班級。**寫 `leftAt`，不刪那一列。**
 *
 * # 為什麼這件事非做不可
 *
 * `ClassMembership.leftAt` 從第一天就存在，而且到處都在讀它：
 * `resolveRecipients` 用它決定誰收得到任務、`countRecipients` 用它算
 * 應交人數、`listStudentTasks` 用它決定學生看得到哪幾份。
 * **但全 repo 沒有任何一行寫過它。**
 *
 * 結果是轉班或退補的學生仍然收得到考卷、仍然算進應交人數、仍然出現
 * 在催繳名單上，而老師只能看著一個已經不在的人永遠不交。
 *
 * # 為什麼不刪那一列
 *
 * 因為 membership 是「這位學生當時屬於哪個班」的唯一記錄。刪掉之後，
 * 他過去的成績、能力分析的班級比較、家長週報全部對不回班級——
 * 一份三個月前的模考成績會變成沒有主人的資料。
 *
 * # 為什麼考試進行中要擋
 *
 * 因為 `listStudentTasks` 也照 `leftAt` 過濾：移出的那一秒，他清單上
 * 那份任務就消失了，而作答頁一重新整理就是「這份任務沒有派給你」。
 * 他寫的東西還在資料庫裡（`saveAnswer` 只認 attempt 的擁有者，不查
 * 名冊），但他自己走不回去。**考試中把人移出班級是一場災難，
 * 而且畫面上完全看不出發生了什麼。**
 */
export async function leaveClass(classId: string, studentId: string, actorId: string) {
  const tenantId = requireTenant();
  const membership = await prisma.classMembership.findFirst({
    where: { classId, userId: studentId, role: 'STUDENT' },
    select: {
      id: true,
      leftAt: true,
      class: { select: { name: true } },
      user: { select: { username: true, displayName: true } },
    },
  });
  if (!membership) throw new Error('這位學生不在這個班的名冊上');
  if (membership.leftAt) {
    // 靜靜地成功是不行的：兩位老師同時看著同一頁時，後按的那一位
    // 會以為是自己移出的，而移出時間會被改成他按的那一刻。
    throw new Error(
      `${membership.user.displayName}已經在 ` +
        `${membership.leftAt.toLocaleDateString('zh-TW')} 移出「${membership.class.name}」了。` +
        '重新整理看看是不是別人剛做的。',
    );
  }

  const open = await prisma.attempt.findFirst({
    where: {
      userId: studentId,
      status: 'IN_PROGRESS',
      assignment: { targets: { some: { classId } } },
    },
    select: { assignment: { select: { title: true } } },
  });
  if (open) {
    throw new Error(
      `${membership.user.displayName}正在作答「${open.assignment.title}」。` +
        '現在移出的話，那份考卷會從他的清單上消失，他重新整理之後就回不去了——' +
        '等他交卷再移出。若是要中止這一份，請到成績頁把它作廢。',
    );
  }

  const leftAt = new Date();
  await prisma.classMembership.update({ where: { id: membership.id }, data: { leftAt } });
  await audit(tenantId, actorId, 'class.member_leave', classId, {
    class: membership.class.name,
    student: membership.user.username,
    studentName: membership.user.displayName,
    leftAt: leftAt.toISOString(),
  });
  return { ...membership, leftAt };
}

/**
 * 復原：把移出的人放回名冊。
 *
 * 誤按、或學生又回來了。`leftAt` 設回 null 就是原本那一列，
 * `joinedAt` 不動——他當初就是那天入班的，改掉等於竄改記錄。
 *
 * 名冊重新匯入時的 upsert 也做同一件事（`update: { leftAt: null }`），
 * 兩邊語意一致：**同一個人在同一個班只會有一列**，進出是那一列的
 * 狀態，不是兩列。
 */
export async function rejoinClass(classId: string, studentId: string, actorId: string) {
  const tenantId = requireTenant();
  const membership = await prisma.classMembership.findFirst({
    where: { classId, userId: studentId, role: 'STUDENT' },
    select: {
      id: true,
      leftAt: true,
      class: { select: { name: true } },
      user: { select: { username: true, displayName: true } },
    },
  });
  if (!membership) throw new Error('這位學生不在這個班的名冊上');
  if (!membership.leftAt) {
    throw new Error(`${membership.user.displayName}本來就在名冊上，沒有需要復原的。`);
  }

  await prisma.classMembership.update({ where: { id: membership.id }, data: { leftAt: null } });
  await audit(tenantId, actorId, 'class.member_rejoin', classId, {
    class: membership.class.name,
    student: membership.user.username,
    studentName: membership.user.displayName,
    // 原本的移出時間留在稽核裡。那一列上的 leftAt 被清成 null 之後，
    // 「他曾經被移出過、什麼時候」就只剩這裡說得出來。
    wasLeftAt: membership.leftAt.toISOString(),
  });
  return membership;
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

/**
 * 密碼相關的稽核，分類是 AUTH 而不是 USER。
 *
 * 為什麼要分兩支：`AuditCategory.AUTH` 的定義就是「登入、登出、
 * 密碼變更、帳號鎖定」，而學生自己改密碼（lib/password.ts 的
 * `auth.password_changed`）也記在那裡。**同一件事分散在兩個分類裡，
 * 出事時查的人會只翻其中一個然後說「沒有記錄」**——而個資事件調查
 * 要的正是「這個帳號的密碼被誰動過幾次」這一條時間線。
 *
 * `targetType` 從 action 推不出來（`auth.password_reset` 的對象是
 * User，`auth.password_reset_class` 的對象是 Class），所以明著傳。
 */
async function auditAuth(
  tenantId: string,
  actorId: string,
  action: 'auth.password_reset' | 'auth.password_reset_class',
  targetId: string,
  after: Record<string, unknown>,
) {
  await prisma.auditLog.create({
    data: {
      tenantId,
      category: 'AUTH',
      action,
      actorId,
      targetType: action === 'auth.password_reset_class' ? 'Class' : 'User',
      targetId,
      after: after as never,
    },
  });
}
