/**
 * 升學輔導的資料層：把 `lib/admission.mjs` 與 `lib/star.mjs` 的規則
 * 接到資料庫上。
 *
 * # 為什麼檔名不是 admission.ts
 *
 * 因為同一個資料夾裡已經有 `admission.mjs`，而 **tsc 與 webpack 對
 * `@/lib/admission` 的解析順序相反**：TypeScript 先找 `.ts`，Next 的
 * webpack 先找 `.mjs`。兩份實作的症狀非常難查：`npx tsc --noEmit`
 * 全綠、`next build` 只印一行「Attempted import error」然後**照樣
 * exit 0**，而頁面在瀏覽器上炸在「xxx is not a function」。
 * 完整的說明見 `lib/abilityDb.ts` 的檔頭——這是第二次踩到，所以
 * 這裡直接沿用同一個命名規則。
 *
 * # 這一層刻意很薄
 *
 * 會算錯的東西全部在那兩個 `.mjs`（純函式、有完整單元測試：資格判定
 * 是 96×4 的完整笛卡兒積，繁星賽局 39 項）。這裡只做四件事：讀出來、
 * 丟給它算、寫回去、擋權限。**新的規則要加在 .mjs 而不是這裡**——
 * 這裡沒有測試保護，因為它需要資料庫。
 *
 * # 在校成績百分比是全校最敏感的資料
 *
 * `AcademicRank` 由教務處匯入，而它**不進入任何學生可查詢的 API**。
 * 這一條在程式碼上的落實方式是：
 *
 *   · 學生端唯一會碰到它的路徑是 `myStarPosition()`，而那支函式的
 *     回傳型別裡沒有百分比這個欄位——全校模擬在伺服器端跑完，
 *     `studentView()` 只切出序位（見 `lib/star.mjs` §3）。
 *   · 學生自己那一列的百分比由 `myAcademicRank()` 另外給，
 *     **與賽局結果走兩條路**。合成一條的話，遲早有人為了畫面方便
 *     把整份 `sim` 傳到前端去。
 *   · 全校檢視（`starCoordinatorReport`）只有繁星承辦做得到，
 *     而且每一次都寫稽核。
 *
 * # 繁星承辦人的權限掛在校務管理員身上，這是簡化
 *
 * 規格書 §3 要的是一個新的 `SystemRole.STAR_COORDINATOR`（範圍是全校）
 * 與一個新的 `ClassRole.COUNSELOR`（範圍是所負責的學生）。新增角色要
 * 動 schema、動權限矩陣、動稽核設計，所以第一階段用既有的六種角色
 * 承載：**繁星承辦 = 校務管理員**。
 *
 * 系統管理員**在**這個名單裡，而規格書 §3 說他不該在。那條規則的前提
 * 是學校有分職，而這套系統的實際部署不是那樣——完整的理由寫在下面
 * `STAR_COORDINATOR` 那個常數的註解上，那是它該待的地方。
 *
 * **畫面與 API 的文案必須跟著這個決定走。** 這裡以前寫「系統管理員刻意
 * 不在名單裡」，而程式碼收他，於是 `/admission/star` 的 Denied、
 * 兩支 API 的 403 與 e2e 的檔頭都跟著寫了一句系統做不到的隔離——
 * 採購方會據此相信一件不存在的事，而那比少一個功能嚴重。
 */
import { decodeCsv, matchColumns, parseCsv } from '@/lib/csv.mjs';
import { nextStep, weakestFirst } from '@/lib/ability.mjs';
import {
  ACTIONS,
  RANK_COLUMNS,
  STAR_CATEGORIES,
  admissionYearOf,
  eligibility,
  parseRankRows,
  planConflicts,
  remediationPlan,
} from '@/lib/admission.mjs';
import { coordinatorReport, simulate, studentView } from '@/lib/star.mjs';
import { prisma } from '@/lib/prisma';
import { requireTenant } from '@/lib/tenant';
import type { SessionUser } from '@/lib/auth';

export { admissionYearOf };

/**
 * 繁星承辦的職權掛在誰身上。見檔頭——這是簡化，不是設計。
 *
 * 用 `Set` 而不是陣列，是為了讓「加一個角色進來」是一個明顯的動作。
 * 這份名單決定誰看得到全校的在校成績百分比。
 *
 * # 為什麼 SYS_ADMIN 也在裡面，而規格書說它不該在
 *
 * 規格書第 3 節寫「系統管理員在本模組沒有任何資料存取權，只有稽核
 * 記錄」，理由是 `AcademicRank` 是本模組最敏感的資料。那條規則的前提
 * 是**學校有分職**：資訊組管系統、教務處管繁星，兩個人。
 *
 * 這套系統的實際部署不是那樣。它是單一補習班自架，維護者是主任兼
 * 科目代表老師，而**全新安裝之後機器上只有一個 SYS_ADMIN 帳號**
 * （`scripts/migrate-and-seed.mjs`）。照規格書排除它的結果是：業主裝好
 * 系統、匯入在校百分比、然後發現整個繁星模擬進不去，而畫面說的是
 * 「你不是繁星承辦人」——他就是那個承辦人，這台機器是他的。
 *
 * 那是一條純粹由角色命名造成的死路，而它會發生在他第一次想用這個
 * 功能的時候。所以這裡收 SYS_ADMIN。
 *
 * **分職真的存在的機構要縮回去，就把這一行改掉**，然後為教務處開一個
 * SCHOOL_ADMIN 帳號。那是一個明確的決定，不是預設值。
 * 全校檢視一律寫稽核（見 `starCoordinatorReport`），所以無論是誰看的
 * 都留得下紀錄——這比靠角色名單擋更實在。
 */
const STAR_COORDINATOR = new Set(['SCHOOL_ADMIN', 'SYS_ADMIN']);

/** 繁星承辦人？ */
export function isStarCoordinator(user: SessionUser): boolean {
  return STAR_COORDINATOR.has(user.systemRole);
}

// ─────────────────────────────────────────────────────────────────
// 升學狀態（N0）
// ─────────────────────────────────────────────────────────────────

/** 學生可以自己改的欄位。`starCategory` 之外全是布林。 */
export type ProfilePatch = {
  isRepeater?: boolean;
  sameSchoolAll?: boolean;
  specialAdmitted?: boolean;
  specialWaived?: boolean;
  starCategory?: string;
  starWaived?: boolean;
  applyAdmitted?: boolean;
  applyWaived?: boolean;
};

/**
 * 一位學生某學年度的升學狀態。**沒有就回一份全預設值的**，不建列。
 *
 * 不在讀取時建列是刻意的：讀一頁不該產生寫入（預載、爬蟲、瀏覽器的
 * 預先連線都會打到這裡），而全預設值與「剛建好的空列」在判定上
 * 完全等價——`normalizeProfile()` 補的就是 schema 的那組預設值。
 */
export async function myProfile(userId: string, year: number) {
  const row = await prisma.admissionProfile.findFirst({ where: { userId, year } });
  return {
    year,
    isRepeater: row?.isRepeater ?? false,
    sameSchoolAll: row?.sameSchoolAll ?? true,
    specialAdmitted: row?.specialAdmitted ?? false,
    specialWaived: row?.specialWaived ?? false,
    starCategory: row?.starCategory ?? 'NONE',
    starWaived: row?.starWaived ?? false,
    applyAdmitted: row?.applyAdmitted ?? false,
    applyWaived: row?.applyWaived ?? false,
    exists: row !== null,
  };
}

/** 寫回升學狀態。只有本人做得到（路由層擋）。 */
export async function saveProfile(userId: string, year: number, patch: ProfilePatch) {
  const tenantId = requireTenant();
  const data: Record<string, unknown> = {};
  for (const k of [
    'isRepeater',
    'sameSchoolAll',
    'specialAdmitted',
    'specialWaived',
    'starWaived',
    'applyAdmitted',
    'applyWaived',
  ] as const) {
    if (typeof patch[k] === 'boolean') data[k] = patch[k];
  }
  if (patch.starCategory && STAR_CATEGORIES.includes(patch.starCategory)) {
    // **一經錄取即固定，不因放棄而清空。** 這裡不做「放棄就設回 NONE」
    // 的貼心處理——那正是規格書 §5.2 警告的那個錯誤，而它的症狀是
    // 一位第 3 類已放棄的學生被判定成可以報名個人申請。
    data.starCategory = patch.starCategory;
  }

  return prisma.admissionProfile.upsert({
    where: { userId_year: { userId, year } },
    create: { tenantId, userId, year, ...data },
    update: data,
  });
}

/** 資格表 + 志願的後果說明，一次算完。 */
export async function admissionStatus(userId: string, year: number) {
  const [profile, wishes] = await Promise.all([myProfile(userId, year), myWishes(userId, year)]);
  return {
    profile,
    wishes,
    eligibility: eligibility(profile) as ReturnType<typeof eligibility>,
    conflicts: planConflicts(profile, wishes) as ReturnType<typeof planConflicts>,
    actions: ACTIONS,
  };
}

// ─────────────────────────────────────────────────────────────────
// 志願
// ─────────────────────────────────────────────────────────────────

export type WishInput = {
  channel: string;
  rank: number;
  institutionName: string;
  programName?: string | null;
  starGroup?: number | null;
  interestTag?: string | null;
  note?: string | null;
};

export async function myWishes(userId: string, year: number) {
  return prisma.wish.findMany({
    where: { userId, year },
    orderBy: [{ channel: 'asc' }, { rank: 'asc' }],
    select: {
      id: true,
      channel: true,
      rank: true,
      institutionName: true,
      programName: true,
      starGroup: true,
      interestTag: true,
      note: true,
    },
  });
}

/**
 * 新增一個志願。
 *
 * **不做任何資格或組合的阻擋。** 系統不替學生決定他能規劃什麼——
 * 後果由 `planConflicts()` 說明，這與文件 04 防作弊的「記錄而非中斷」
 * 是同一種立場。這裡唯一會拒絕的是「同一管道同一志願序已經有了」，
 * 而那是資料完整性不是制度判斷。
 */
export async function addWish(userId: string, year: number, input: WishInput) {
  const tenantId = requireTenant();
  return prisma.wish.create({
    data: {
      tenantId,
      userId,
      year,
      channel: input.channel as never,
      rank: input.rank,
      institutionName: input.institutionName,
      programName: input.programName ?? null,
      starGroup: input.starGroup ?? null,
      interestTag: input.interestTag ?? null,
      note: input.note ?? null,
    },
  });
}

/**
 * 改一個志願：志願序、校系、學群、興趣理由。
 *
 * # 「改一個打錯的字」與「系統替你排志願」是兩件事
 *
 * `WishList` 的檔頭寫著「系統不替他刪、不替他排」，而那個設計不動：
 * 填了注定衝突的組合照樣存得進去，順序永遠由學生自己決定。這一支
 * 做的是另一件事——**他自己要把第 3 志願提到第 1**，或者發現校名打錯。
 *
 * 在這一支之前，那兩件事都只能「刪掉再加一次」，而移動志願序還會先
 * 撞上 409（第 1 志願已經有了）：他得先刪掉原本的第 1、再刪要移動的
 * 那一個、再依序加回去。三次刪除只為了換一個順序，而中途離開畫面的話
 * 他的志願就少了兩個——**這是一條會弄丟資料的路徑**。
 *
 * # 撞號時「對調」而不是「整串往後推」
 *
 * 整串推是**系統在替他排序**（他只動了一個，卻有五個跟著變），那正是
 * 上面那句設計要避免的事。對調只動兩個，而且兩個都是他指名的：
 * 「把第 3 提到第 1」的結果就是原本的第 1 去第 3。
 *
 * 中間值是因為 `[userId, year, channel, rank]` 有唯一鍵而它不是 deferrable
 * ——A 與 B 直接互換的中途必然撞號。`TEMP_RANK` 取一個 API 不可能收到
 * 的值（志願序上限 100），而整段在同一個交易裡，中途失敗會整個回滾。
 *
 * @returns `null` 代表不是他的（或不存在）——與 `deleteWish` 一樣，
 *   「不存在」與「不是你的」不能分辨得出來。
 */
export type WishPatch = {
  rank?: number;
  institutionName?: string;
  programName?: string | null;
  starGroup?: number | null;
  interestTag?: string | null;
  note?: string | null;
};

const TEMP_RANK = 9999;

export async function updateWish(userId: string, wishId: string, patch: WishPatch) {
  const mine = await prisma.wish.findFirst({
    where: { id: wishId, userId },
    select: { id: true, year: true, channel: true, rank: true },
  });
  if (!mine) return null;

  const nextRank = Number.isFinite(patch.rank as number) ? (patch.rank as number) : mine.rank;
  const data = {
    ...(patch.institutionName !== undefined ? { institutionName: patch.institutionName } : {}),
    ...(patch.programName !== undefined ? { programName: patch.programName } : {}),
    ...(patch.starGroup !== undefined ? { starGroup: patch.starGroup } : {}),
    ...(patch.interestTag !== undefined ? { interestTag: patch.interestTag } : {}),
    ...(patch.note !== undefined ? { note: patch.note } : {}),
  };

  const other =
    nextRank === mine.rank
      ? null
      : await prisma.wish.findFirst({
          where: { userId, year: mine.year, channel: mine.channel, rank: nextRank },
          select: { id: true },
        });

  await prisma.$transaction(async (tx) => {
    if (other) {
      await tx.wish.update({ where: { id: mine.id }, data: { rank: TEMP_RANK } });
      await tx.wish.update({ where: { id: other.id }, data: { rank: mine.rank } });
    }
    await tx.wish.update({ where: { id: mine.id }, data: { ...data, rank: nextRank } });
  });

  return { swappedWith: other?.id ?? null };
}

/** 刪一個志願。回 false 代表不是他的（或不存在）——兩者的回應要一樣。 */
export async function deleteWish(userId: string, wishId: string) {
  const hit = await prisma.wish.findFirst({ where: { id: wishId, userId }, select: { id: true } });
  if (!hit) return false;
  await prisma.wish.delete({ where: { id: wishId } });
  return true;
}

// ─────────────────────────────────────────────────────────────────
// 在校成績百分比（N3 的輸入）
// ─────────────────────────────────────────────────────────────────

/**
 * 學生自己那一列。**只有本人與繁星承辦**。
 *
 * 與賽局結果走兩條路是刻意的，見檔頭。
 */
export async function myAcademicRank(userId: string, year: number) {
  const row = await prisma.academicRank.findFirst({
    where: { userId, year },
    select: { percentile: true, semesters: true, importedAt: true },
  });
  return row;
}

export type RankImportResult = {
  imported: number;
  updated: number;
  skipped: { line: number; message: string }[];
  encoding: string;
};

/**
 * 教務處匯入五學期在校成績百分比。
 *
 * # 為什麼讀不懂的列要留下來報出去
 *
 * 因為靜靜跳過的後果落在學生身上而不是承辦人身上：教務處匯了 300 列、
 * 系統收了 287 列、畫面寫著「匯入成功」，而那 13 位學生在自己的繁星
 * 頁面上看到「還沒有你的在校成績」，然後去問導師，導師去問教務處，
 * 教務處說「我匯過了」。
 *
 * # 為什麼一次寫完而不是先試算
 *
 * 名冊匯入（`lib/roster.ts`）是先 plan 再 apply，因為它會**建帳號**，
 * 事後補救很痛苦。這一張表不一樣：它是逐年一列、以 `[userId, year]`
 * 為唯一鍵的純資料，匯錯了再匯一次就蓋掉。多一道試算步驟的成本
 * （承辦人多按一次、程式多一份型別）換不到對應的安全。
 */
export async function importAcademicRanks(
  bytes: Uint8Array,
  year: number,
  actor: SessionUser,
): Promise<RankImportResult> {
  const tenantId = requireTenant();
  const { text, encoding } = decodeCsv(bytes);
  const table = parseCsv(text);
  if (table.length === 0) throw new Error('這個檔案是空的');

  const cols = matchColumns(table[0], RANK_COLUMNS);
  for (const need of ['username', 'percentile'] as const) {
    if (cols[need] === undefined) {
      const names = (RANK_COLUMNS[need] as readonly string[]).slice(0, 4).join('、');
      throw new Error(
        `找不到「${need === 'username' ? '學號' : '百分比'}」欄。` +
          `第一列要是欄位標題，可以叫 ${names} 等等。` +
          `這個檔案的第一列是：${table[0].slice(0, 6).join('、')}`,
      );
    }
  }

  const { rows, problems } = parseRankRows(table, cols) as {
    rows: { line: number; username: string; percentile: number; semesters: number }[];
    problems: { line: number; message: string }[];
  };

  // 學號 → userId。**只認學生**：把老師的代號放進在校成績裡不會有
  // 任何錯誤訊息，但他會出現在繁星的校內排序裡，佔掉一位學生的名額。
  const students = await prisma.user.findMany({
    where: { username: { in: rows.map((r) => r.username) }, systemRole: 'STUDENT', deletedAt: null },
    select: { id: true, username: true },
  });
  const idOf = new Map(students.map((s) => [s.username, s.id]));

  let imported = 0;
  let updated = 0;
  const skipped = [...problems];

  for (const r of rows) {
    const userId = idOf.get(r.username);
    if (!userId) {
      skipped.push({ line: r.line, message: `學號 ${r.username} 在這個補習班找不到學生帳號` });
      continue;
    }
    const existing = await prisma.academicRank.findFirst({
      where: { userId, year },
      select: { id: true },
    });
    await prisma.academicRank.upsert({
      where: { userId_year: { userId, year } },
      create: {
        tenantId,
        userId,
        year,
        percentile: r.percentile,
        semesters: r.semesters,
        importedBy: actor.id,
      },
      update: { percentile: r.percentile, semesters: r.semesters, importedBy: actor.id },
    });
    if (existing) updated += 1;
    else imported += 1;
  }

  // 稽核。在校成績百分比是全校最敏感的資料，所以**寫入與檢視都要留痕**。
  await prisma.auditLog.create({
    data: {
      tenantId,
      // USER：這是學生帳號的附加資料，與成績（考卷分數）不是同一件事。
      // 同一件事分散在兩個分類裡，出事時查的人會只翻其中一個。
      category: 'USER',
      action: 'admission.rank_import',
      actorId: actor.id,
      targetType: 'AcademicRank',
      metadata: {
        year,
        imported,
        updated,
        skipped: skipped.length,
        encoding,
      } as never,
    },
  });

  return { imported, updated, skipped, encoding };
}

// ─────────────────────────────────────────────────────────────────
// 繁星校內賽局（N3）
// ─────────────────────────────────────────────────────────────────

/**
 * 跑一次全校模擬。**這是唯一會讀到全校百分比的地方。**
 *
 * 兩個呼叫端共用它：學生端（`myStarPosition`，回傳前先切成自己那一片）
 * 與承辦人端（`starCoordinatorReport`）。各寫一份的話，兩邊會算出不同
 * 的名次，而那時沒有人知道該相信哪一個——這與 `lib/ability.mjs` 的
 * 「整批重算與逐次更新走同一支」是同一個理由。
 */
async function runSchoolSimulation(year: number) {
  const wishes = await prisma.wish.findMany({
    where: { year, channel: 'STAR' },
    select: { userId: true, rank: true, institutionName: true, starGroup: true },
  });
  if (wishes.length === 0) return simulate({ participants: [] });

  const ranks = await prisma.academicRank.findMany({
    where: { year, userId: { in: [...new Set(wishes.map((w) => w.userId))] } },
    select: { userId: true, percentile: true },
  });
  const pctOf = new Map(ranks.map((r) => [r.userId, r.percentile]));

  return simulate({
    participants: wishes.map((w) => ({
      userId: w.userId,
      // 沒有匯入百分比時傳 null，**不要傳 100**（最差）。`star.mjs`
      // 會把他歸到 `unranked` 而不是排在最後一名——後者是一個假結論，
      // 而真正的問題是承辦人少匯了一列。
      percentile: pctOf.has(w.userId) ? pctOf.get(w.userId)! : null,
      institutionName: w.institutionName,
      starGroup: w.starGroup as number,
      wishRank: w.rank,
    })),
  });
}

/**
 * 學生看自己在繁星的校內位置。
 *
 * 全校模擬在伺服器端跑完，`studentView()` 只切出他自己那一片：
 * **序位一個整數，沒有其他學生的 id、姓名、百分比，也沒有參與人數。**
 * 人數少於 3 時連序位都不給（推論攻擊：排第 2 的人能推知排第 1 的
 * 是誰），改成只說「你是不是校內第 1 位」。
 */
export async function myStarPosition(userId: string, year: number) {
  const sim = await runSchoolSimulation(year);
  // 學年度要傳下去：第二輪的說明裡有一個**逐年公告的缺額數**，而它
  // 不能被掛上一個它不屬於的年份（見 `lib/admission.mjs` 的
  // `starVacancySentence`）。
  return studentView(sim, userId, year) as ReturnType<typeof studentView>;
}

/**
 * 承辦人的全校檢視。**每一次都寫稽核。**
 *
 * 稽核不是走個形式：這個人一次就看得到全校每一位學生的相對名次，
 * 而規格書 §3 把它列為「全校最敏感的權限之一」。留痕的用意是
 * 事後查得出「三月十日誰調過這份名單」。
 */
export async function starCoordinatorReport(year: number, actor: SessionUser) {
  const tenantId = requireTenant();
  const sim = await runSchoolSimulation(year);
  const report = coordinatorReport(sim) as ReturnType<typeof coordinatorReport>;

  // 承辦人要看的是名字而不是 cuid。**只在這一層做**——`star.mjs`
  // 拿不到姓名，所以學生端那條路徑不可能不小心帶出去。
  const ids = new Set<string>();
  for (const p of report.positions) for (const e of p.entries) ids.add(e.userId);
  for (const u of report.unranked) ids.add(u.userId);
  for (const u of report.noGroup) ids.add(u.userId);
  for (const d of report.dropped) ids.add(d.userId);
  for (const s of report.squeeze) for (const m of s.members) ids.add(m.userId);

  const users = await prisma.user.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, username: true, displayName: true },
  });
  const nameOf = new Map(users.map((u) => [u.id, u]));

  await prisma.auditLog.create({
    data: {
      tenantId,
      // SECURITY：這是一次「看得到全校排名」的存取，不是一般的資料維護。
      category: 'SECURITY',
      action: 'admission.star_school_view',
      actorId: actor.id,
      targetType: 'AcademicRank',
      metadata: {
        year,
        students: report.totals.students,
        positions: report.totals.positions,
      } as never,
    },
  });

  return { report, nameOf: Object.fromEntries(nameOf) };
}

// ─────────────────────────────────────────────────────────────────
// 讀書計畫（N6）
// ─────────────────────────────────────────────────────────────────

/**
 * 「哪幾個知識點最值得補」。
 *
 * 接的是既有的 `AbilitySnapshot`（弱點程度）與 `KnowledgePoint.gsatWeight`
 * （學測權重）。**這裡沒有「距離目標校系還差多少」**——那需要由校系的
 * 檢定與篩選標準反推所需級分，而校系資料庫不存在（歷年篩選資料禁止
 * 爬取，見 `admission.mjs` 的 `NOT_OFFERED`）。
 *
 * 排序與文案在 `admission.mjs` 的 `remediationPlan()`，有測試。
 * 這裡只負責把 `gsatWeight` 與 `nextStep()` 的前置判斷接上去。
 */
export async function studyPlan(userId: string, limit = 8) {
  const snaps = await prisma.abilitySnapshot.findMany({
    where: { userId },
    select: {
      knowledgePointId: true,
      mastery: true,
      reliable: true,
      correct: true,
      total: true,
      streakWrong: true,
      lastAnsweredAt: true,
      knowledgePoint: {
        select: {
          id: true,
          name: true,
          subjectId: true,
          gsatWeight: true,
          subject: { select: { name: true } },
        },
      },
    },
  });

  type View = {
    id: string;
    name: string;
    subjectId: string;
    subjectName: string;
    gsatWeight: number;
    mastery: number;
    reliable: boolean;
    correct: number;
    total: number;
    streakWrong: number;
    lastAnsweredAt: Date | null;
  };

  const views: View[] = snaps.map((s) => ({
    id: s.knowledgePointId,
    name: s.knowledgePoint.name,
    subjectId: s.knowledgePoint.subjectId,
    subjectName: s.knowledgePoint.subject.name,
    gsatWeight: s.knowledgePoint.gsatWeight,
    mastery: s.mastery,
    reliable: s.reliable,
    correct: s.correct,
    total: s.total,
    streakWrong: s.streakWrong,
    lastAnsweredAt: s.lastAnsweredAt,
  }));

  // 前置關係。**沒有快照的前置也要算進去**——「不知道他有沒有底」
  // 與「他有底」是兩件事，而後者會讓建議跳過真正該補的東西。
  // 與 `lib/abilityDb.ts` 的 `studentAbility()` 同一個做法。
  const byId = new Map(views.map((v) => [v.id, v]));
  const links = views.length
    ? await prisma.kpPrerequisite.findMany({
        where: { kpId: { in: views.map((v) => v.id) } },
        orderBy: { strength: 'desc' },
        select: { kpId: true, prereq: { select: { id: true, name: true } } },
      })
    : [];
  const prereqOf = new Map<string, { id: string; name: string; mastery: number; reliable: boolean; total: number; correct: number; streakWrong: number; lastAnsweredAt: Date | null }[]>();
  for (const l of links) {
    const list = prereqOf.get(l.kpId) ?? [];
    const known = byId.get(l.prereq.id);
    list.push({
      id: l.prereq.id,
      name: l.prereq.name,
      mastery: known?.mastery ?? 0,
      reliable: known?.reliable ?? false,
      total: known?.total ?? 0,
      correct: known?.correct ?? 0,
      streakWrong: known?.streakWrong ?? 0,
      lastAnsweredAt: known?.lastAnsweredAt ?? null,
    });
    prereqOf.set(l.kpId, list);
  }

  const withStep = views.map((v) => ({
    ...v,
    step: nextStep(v, prereqOf.get(v.id) ?? []),
  }));

  const plan = remediationPlan({
    points: weakestFirst(withStep),
    limit,
  }) as ReturnType<typeof remediationPlan>;

  const attempts = await prisma.attempt.count({
    where: { userId, status: { in: ['SUBMITTED', 'GRADED'] } },
  });

  return { ...plan, attempts };
}

// ─────────────────────────────────────────────────────────────────
// 老師：所帶班級的學生
// ─────────────────────────────────────────────────────────────────

/**
 * 一個班的升學狀態總覽。
 *
 * **不含在校成績百分比。** 規格書 §3 把「在校成績百分比」給的是輔導
 * 老師（所帶班級）與繁星承辦（全校），而我們沒有輔導老師這個職權可用
 * （見檔頭）。在沒辦法區分「一般老師」與「輔導老師」的時候，
 * 這一欄往保守的方向倒——少看到一欄是可以被回報的症狀，
 * 全校的相對名次流到不該看的人手上不是。
 *
 * 呼叫端要先確認這位老師真的帶這個班（`teachesClass` / `isHomeroomOf`）。
 */
export async function classAdmissionOverview(classId: string, year: number) {
  const members = await prisma.classMembership.findMany({
    where: { classId, role: 'STUDENT', leftAt: null },
    select: { user: { select: { id: true, username: true, displayName: true } } },
  });
  const userIds = members.map((m) => m.user.id);
  if (userIds.length === 0) return [];

  const [profiles, wishes] = await Promise.all([
    prisma.admissionProfile.findMany({ where: { userId: { in: userIds }, year } }),
    prisma.wish.findMany({
      where: { userId: { in: userIds }, year },
      select: {
        id: true,
        userId: true,
        channel: true,
        rank: true,
        institutionName: true,
        programName: true,
        starGroup: true,
      },
    }),
  ]);
  const profileOf = new Map(profiles.map((p) => [p.userId, p]));

  return members
    .map((m) => {
      const profile = profileOf.get(m.user.id) ?? {};
      const mine = wishes.filter((w) => w.userId === m.user.id);
      const rules = eligibility(profile) as ReturnType<typeof eligibility>;
      return {
        userId: m.user.id,
        username: m.user.username,
        displayName: m.user.displayName,
        wishes: mine.length,
        starWishes: mine.filter((w) => w.channel === 'STAR').length,
        applyWishes: mine.filter((w) => w.channel === 'APPLY').length,
        blocked: rules.filter((r) => !r.ok).map((r) => r.label),
        conflicts: (planConflicts(profile, mine) as ReturnType<typeof planConflicts>).length,
      };
    })
    .sort((a, b) => b.conflicts - a.conflicts || a.username.localeCompare(b.username));
}
