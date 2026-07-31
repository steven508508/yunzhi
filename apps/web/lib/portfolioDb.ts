/**
 * 學習歷程輔助與面試準備的資料層。
 *
 * # 為什麼檔名不是 portfolio.ts
 *
 * 因為同一個資料夾裡已經有 `portfolio.mjs`，而 **tsc 與 webpack 對
 * `@/lib/portfolio` 的解析順序相反**：TypeScript 先找 `.ts`，Next 的
 * webpack 先找 `.mjs`。兩份實作的症狀非常難查：`npx tsc --noEmit`
 * 全綠、`next build` 只印一行「Attempted import error」然後**照樣
 * exit 0**，而頁面在瀏覽器上炸在「xxx is not a function」。
 * 完整說明見 `lib/abilityDb.ts` 的檔頭——這是第五次踩到，沿用同一個
 * 命名規則。
 *
 * # 隱私：這個模組與系統其他地方的規則相反，而且必須在程式裡真的擋住
 *
 * 這裡處理的是學生的**個人陳述與生涯敘事**，不是他的作答。規格書
 * §9.5 訂的四條線，每一條在這個檔案裡的落實方式：
 *
 * **一、內容預設只有學生本人看得到。**
 * `myEssays()` 收的是「誰在問」，而且它自己比對 `userId`——RLS 擋得住
 * 別家補習班，擋不住隔壁同學。沒有任何一支函式收「看哪一個學生」
 * 這種參數而不檢查關係。
 *
 * **二、學生可選擇性分享給特定老師，且可隨時撤回。**
 * `sharedWith` 是一個可寫的陣列而不是一張只增不減的表。老師端唯一的
 * 入口是 `essaysSharedWithMe()`，它查的條件是 `sharedWith has 我的 id`
 * ——**學生把自己從陣列裡拿掉的下一秒，那位老師就查不到了**。
 *
 * **三、家長在任何路徑下都讀不到。**
 * 這個檔案的每一支進入點都先問角色，`GUARDIAN` 一律 403，而且**它不是
 * 靠畫面上沒有連結**。做法與 `lib/guardian.ts` 相同但方向相反：那個
 * 檔案是「不查這幾張表」，這個檔案是「這幾張表的每一個進入點都擋家長」。
 * `tests/portfolioPrivacy.test.mjs` 會讀 `lib/guardian.ts` 的原始碼，
 * 確認家長那一側從來沒有長出對這幾張表的查詢。
 *
 * **四、AI 對話紀錄僅學生本人可見，老師連摘要都看不到。**
 * 這一條與智慧老師模組**相反**（那裡老師看得到班上的對話），所以它最
 * 容易在日後被「統一一下」而破掉。落實的方式是**型別**：
 * `SharedEssayView`（老師看得到的那一個）裡**沒有任何欄位裝得下**
 * 揭露記錄或聲明。不是「記得過濾」，是沒有地方放。這是
 * `lib/guardian.ts` 的 `projectTask` 用的同一招，而它是唯一在改版時
 * 撐得住的作法——多一個欄位會是編譯錯誤，不是一次靜默的外洩。
 *
 * 而且 `myDisclosureLogs()` 與 `myStatements()` 這兩支的第一個參數
 * **就是 `SessionUser` 而不是 userId**，所以呼叫端沒有辦法傳一個
 * 「別人的 id」進來——那個參數在型別上不存在。
 *
 * **五、不用於任何形式的統計分析。**
 * 這個檔案裡沒有任何 `groupBy`、`aggregate`、`count` 打在
 * `PortfolioEssay`、`AiDisclosureLog`、`InterviewPractice` 上。
 * 唯一的計數是學生自己那一份的件數（`countCentralUpload`），
 * 而它是規則檢查不是統計。
 *
 * # 這一層刻意很薄
 *
 * 會算錯的東西全部在三個 `.mjs`（`portfolio.mjs` 的件數與制度規則、
 * `portfolioGuard.mjs` 的防代寫閘門、`interview.mjs` 的結構回饋，
 * 都是純函式而且有測試）。這裡只做五件事：讀出來、丟給它算、寫回去、
 * 擋權限、記錄 AI 互動。**新的規則要加在 .mjs 而不是這裡**——
 * 這裡沒有單元測試保護，因為它需要資料庫。
 *
 * 唯一的例外是 `coachFeedback()` 那一段「生成 → 檢查 → 不過就重來」
 * 的迴圈，理由與 `lib/tutor.ts`、`lib/admissionRefDb.ts` 相同：
 * 重試策略需要知道被擋的是哪一種違規，而那要拿到閘門的輸出才知道。
 */
import {
  AI_FEATURE_DISCLOSURE_PHRASES,
  AI_FEATURE_LABELS,
  AI_LEVELS,
  aiDisabledReason,
  aiFeatureAllowed,
  charCountOf,
  checkFileSize,
  checkSelfStatement,
  checkSummaryEssay,
  countCentralUpload,
  countSelected,
  effectiveAiLevel,
  itemCodeInfo,
  limitsOf,
  mayAddItem,
  mayUpdateItem,
  submissionChecklist,
} from '@/lib/portfolio.mjs';
import {
  checkPortfolioOutput,
  describePortfolioViolations,
  disclosureFacts,
  ghostwriteFacts,
  safeFeedback,
  safeStatement,
  summarizePortfolioViolations,
} from '@/lib/portfolioGuard.mjs';
import {
  INTERVIEW_AI_FEATURE,
  QUESTION_TEMPLATES,
  consistencyCheck,
  structureFeedback,
} from '@/lib/interview.mjs';
import { admissionYearOf } from '@/lib/admission.mjs';
import { prisma } from '@/lib/prisma';
import { teachesClass } from '@/lib/teaching';
import { requireTenant } from '@/lib/tenant';
import type { SessionUser } from '@/lib/auth';

export { admissionYearOf, AI_LEVELS, AI_FEATURE_LABELS };

// ─────────────────────────────────────────────────────────────────
// 錯誤
// ─────────────────────────────────────────────────────────────────

export type PortfolioErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'INVALID'
  | 'OVER_LIMIT'
  | 'AI_DISABLED'
  | 'AI_DOWN'
  | 'BUDGET';

export class PortfolioError extends Error {
  readonly code: PortfolioErrorCode;
  readonly status: number;
  constructor(code: PortfolioErrorCode, message: string, status = 400) {
    super(message);
    this.name = 'PortfolioError';
    this.code = code;
    this.status = status;
  }
}

export function portfolioFailure(e: unknown): {
  status: number;
  body: { error: string; code?: PortfolioErrorCode };
} {
  if (e instanceof PortfolioError) {
    return { status: e.status, body: { error: e.message, code: e.code } };
  }
  console.error('[portfolio] 未預期的錯誤', e);
  return { status: 500, body: { error: '學習歷程這一區出了點問題。你剛才輸入的沒有存進去，再試一次。' } };
}

// ─────────────────────────────────────────────────────────────────
// 角色
// ─────────────────────────────────────────────────────────────────

/**
 * 這一整區只有學生自己能寫。
 *
 * **家長明確地被擋在這裡**，而不是靠畫面上沒有連結。學生可能寫下不
 * 希望家長看到的事，而那正是這種文件的本質——一個「家長看得到」的
 * 學習歷程輔助工具，學生會停止寫真話，然後這個功能就沒有用了。
 */
function assertStudent(user: SessionUser): void {
  if (user.systemRole === 'GUARDIAN') {
    throw new PortfolioError(
      'FORBIDDEN',
      '學習歷程的內容與 AI 對話不對家長開放。這不是設定問題——' +
        '學生可能在裡面寫下不希望家長看到的事，而那是這份文件的本質。' +
        '孩子的任務、成績與時程在「孩子的狀況」那一頁。',
      403,
    );
  }
  if (user.systemRole !== 'STUDENT') {
    throw new PortfolioError(
      'FORBIDDEN',
      '學習歷程是學生自己的東西。老師看得到的只有學生主動分享過來的自述。',
      403,
    );
  }
}

/** 老師端。管理員也算——他要設定當年度的上限。 */
function assertStaff(user: SessionUser): void {
  if (!['TEACHER', 'SUBJECT_LEAD', 'SCHOOL_ADMIN', 'SYS_ADMIN'].includes(user.systemRole)) {
    throw new PortfolioError('FORBIDDEN', '這一頁是給老師用的。', 403);
  }
}

/**
 * 面試題庫：學生要讀，老師日後要管，**家長一律不行**。
 *
 * 題庫本身不是誰的隱私（它是一份公開的問題清單），所以這一支比
 * `assertStudent` 寬。但它仍然要有一道判定：導覽列不畫、頁面擋下來，
 * 而 `GET /api/interview/questions` 只有登入判定的話，第三扇門是開的
 * ——家長拿得到整份題庫，而且在還沒匯入過的租戶上，**那次請求會用
 * 家長的 id 建立 39 筆 `InterviewQuestion`**。
 */
function assertNotGuardian(user: SessionUser): void {
  if (user.systemRole === 'GUARDIAN') {
    throw new PortfolioError(
      'FORBIDDEN',
      '面試準備不對家長開放。練習的回答裡會有他還沒想清楚的話與講砸的版本，' +
        '而那與學習歷程的內容是同一類的東西。孩子的任務、成績與時程在「孩子的狀況」那一頁。',
      403,
    );
  }
}

/**
 * 這個班的 AI 使用層級，是不是這個人可以動的。
 *
 * **帶班判定不可以省。** `assertStaff` 只問「他是不是職員」，於是數學班
 * 老師打一個 `{classId: 英文班, level: 4}` 就把英文老師事前明定的
 * 第 1 級蓋掉了——而 `AiUsagePolicy` 是 update-in-place，舊的 `level`
 * 直接消失，畫面上只會顯示新的日期。教育部函文要求的是**授課教師**
 * 事前明定，不是任何一位老師。
 *
 * 管理員例外：他要處理老師離職、或是全校統一調整的情形，而那件事
 * 本來就是他的職責（`saveLimits` 也是同一條線）。
 */
async function assertMayGovernClass(user: SessionUser, classId: string): Promise<void> {
  assertStaff(user);
  if (['SCHOOL_ADMIN', 'SYS_ADMIN'].includes(user.systemRole)) return;
  if (await teachesClass(user.id, classId)) return;
  throw new PortfolioError(
    'FORBIDDEN',
    'AI 使用層級只有這個班的授課老師改得動。教育部函文要求的是授課教師事前明定——' +
      '別班的老師改掉之後，原本那位老師不會知道自己的決定被換掉了。',
    403,
  );
}

function assertAdmin(user: SessionUser): void {
  if (!['SCHOOL_ADMIN', 'SYS_ADMIN'].includes(user.systemRole)) {
    throw new PortfolioError(
      'FORBIDDEN',
      '件數與容量上限影響全校學生，只有校務管理員能改。',
      403,
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// 制度上限
// ─────────────────────────────────────────────────────────────────

export type LimitView = ReturnType<typeof limitsOf> & { setBy: string | null; setAt: string | null };

/** 這一學年度的上限。沒有建檔就回預設值並標 `isDefault`。 */
export async function limitsFor(year: number): Promise<LimitView> {
  const tenantId = requireTenant();
  const row = await prisma.portfolioLimitSet.findFirst({ where: { tenantId, year } });
  return {
    ...limitsOf(row),
    setBy: row?.setBy ?? null,
    setAt: row?.setAt?.toISOString() ?? null,
  };
}

export async function saveLimits(
  user: SessionUser,
  year: number,
  patch: Record<string, number | string>,
): Promise<LimitView> {
  assertAdmin(user);
  const tenantId = requireTenant();
  const sourceRef = String(patch.sourceRef ?? '').trim();
  if (sourceRef.length < 4) {
    // **`sourceRef` 是必填而且要說得出頁碼。** 這幾個數字錯了會擋住
    // 學生，而擋錯的方向是「你超過上限了」而他其實沒有——他會相信
    // 系統然後刪掉一件該留的。要查得出是誰照哪一份簡章填的。
    throw new PortfolioError(
      'INVALID',
      '請填寫這些數字抄自哪一份簡章的哪一頁。這一欄不是形式——' +
        '上限填錯會讓系統擋住其實沒有超過的學生，而那時候要查得出來源。',
    );
  }
  const nums: Record<string, number> = {};
  for (const k of [
    'outcomePerYear',
    'diversePerYear',
    'outcomeSelected',
    'diverseSelected',
    'summaryChars',
    'summaryImages',
    'docBytes',
    'mediaBytes',
  ]) {
    const v = Number(patch[k]);
    if (Number.isFinite(v) && v > 0) nums[k] = Math.floor(v);
  }
  const existing = await prisma.portfolioLimitSet.findFirst({ where: { tenantId, year } });
  if (existing) {
    await prisma.portfolioLimitSet.update({
      where: { id: existing.id },
      data: { ...nums, sourceRef, setBy: user.id, setAt: new Date() },
    });
  } else {
    await prisma.portfolioLimitSet.create({
      data: { tenantId, year, ...nums, sourceRef, setBy: user.id },
    });
  }
  return limitsFor(year);
}

// ─────────────────────────────────────────────────────────────────
// 素材
// ─────────────────────────────────────────────────────────────────

export type ItemView = {
  id: string;
  category: string;
  itemCode: string;
  itemLabel: string | null;
  title: string;
  semester: string | null;
  fileName: string | null;
  fileBytes: number | null;
  fileKind: string | null;
  courseRef: string | null;
  abilityTags: string[];
  selectedFor: string[];
  note: string | null;
  /** 這一件在容量上有沒有問題。**上傳當下就要知道**，不能等到送出前。 */
  sizeIssue: string | null;
  createdAt: string;
};

type ItemRow = {
  id: string;
  category: string;
  itemCode: string;
  title: string;
  semester: string | null;
  fileName: string | null;
  fileBytes: number | null;
  fileKind: string | null;
  courseRef: string | null;
  abilityTags: string[];
  selectedFor: string[];
  note: string | null;
  createdAt: Date;
};

function toItemView(row: ItemRow, limits: ReturnType<typeof limitsOf>): ItemView {
  const size = checkFileSize(row, limits);
  return {
    id: row.id,
    category: row.category,
    itemCode: row.itemCode,
    itemLabel: itemCodeInfo(row.itemCode)?.label ?? null,
    title: row.title,
    semester: row.semester,
    fileName: row.fileName,
    fileBytes: row.fileBytes,
    fileKind: row.fileKind,
    courseRef: row.courseRef,
    abilityTags: row.abilityTags,
    selectedFor: row.selectedFor,
    note: row.note,
    sizeIssue: size.ok ? null : size.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * 學生自己的素材，以及件數。
 *
 * **收 `SessionUser` 而不是 userId。** 加一個 `?student=` 參數就多一個
 * 要自己比對關係的地方，而這一區的內容是他的生涯敘事——那個參數在
 * 型別上不存在是最安全的擋法。
 */
export async function myPortfolio(user: SessionUser, year = admissionYearOf()) {
  assertStudent(user);
  const [rows, limits] = await Promise.all([
    prisma.portfolioItem.findMany({
      where: { userId: user.id },
      orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }],
    }),
    limitsFor(year),
  ]);
  const items = rows.map((r) => toItemView(r as ItemRow, limits));
  const programRefs = [...new Set(rows.flatMap((r) => r.selectedFor))].sort();
  return {
    year,
    limits,
    items,
    central: countCentralUpload(rows, limits),
    selected: countSelected(rows, limits, programRefs),
    programRefs,
  };
}

export async function addItem(
  user: SessionUser,
  input: {
    category: string;
    itemCode: string;
    title: string;
    semester?: string | null;
    fileName?: string | null;
    fileBytes?: number | null;
    fileKind?: string | null;
    courseRef?: string | null;
    abilityTags?: string[];
    note?: string | null;
    year?: number;
  },
): Promise<ItemView> {
  assertStudent(user);
  const tenantId = requireTenant();
  const limits = await limitsFor(input.year ?? admissionYearOf());

  const title = String(input.title ?? '').trim();
  if (!title) throw new PortfolioError('INVALID', '這一件要有標題，不然三個月後你自己也認不出來。');

  const itemCode = String(input.itemCode ?? '').trim().toUpperCase();

  // **代碼與類別要互相驗證。** 兩者各自合法而湊在一起不合法的組合
  // （`{category: 'COURSE_OUTCOME', itemCode: 'N'}`）現在建得起來，
  // 而它的後果剛好是這個模組最在意的那一條失效：綜整心得被算進課程
  // 學習成果的額度，然後系統告訴一位其實沒有超過的學生他超過了。
  //
  // 認不得的代碼（'Z'）也建得起來，`itemLabel` 是 null——三個月後
  // 他自己看不出那是什麼，中央資料庫也收不了。
  const info = itemCodeInfo(itemCode);
  if (!info && input.category !== 'OTHER') {
    throw new PortfolioError(
      'INVALID',
      `「${itemCode}」不是官方代碼。課程學習成果是 B 到 E、多元表現是 F 到 N，` +
        '對不上的話請選「其他（校系自訂）」。',
    );
  }
  if (info && info.category !== input.category) {
    throw new PortfolioError(
      'INVALID',
      `代碼 ${info.code}（${info.label}）屬於${
        info.category === 'COURSE_OUTCOME' ? '課程學習成果' : '多元表現'
      }，與你選的類別對不起來。件數上限是逐類別算的，分錯類的後果是額度算錯。`,
    );
  }

  const candidate = {
    category: input.category,
    itemCode,
    semester: input.semester ?? null,
    fileBytes: input.fileBytes ?? null,
    fileKind: input.fileKind ?? null,
    title,
  };

  // **容量在上傳當下就擋。** 等到送出前的確認清單才說，他手上可能只剩
  // 那一份檔案而重做來不及。
  const size = checkFileSize(candidate, limits);
  if (!size.ok) throw new PortfolioError('OVER_LIMIT', size.reason ?? '檔案太大。');

  const existing = await prisma.portfolioItem.findMany({ where: { userId: user.id } });
  const may = mayAddItem(existing, candidate, limits);
  if (!may.ok) throw new PortfolioError('OVER_LIMIT', may.reason ?? '超過件數上限。');

  const row = await prisma.portfolioItem.create({
    data: {
      tenantId,
      userId: user.id,
      category: candidate.category as never,
      itemCode: candidate.itemCode,
      title,
      semester: input.semester ?? null,
      fileName: input.fileName ?? null,
      fileBytes: input.fileBytes ?? null,
      fileKind: input.fileKind ?? null,
      courseRef: input.courseRef ?? null,
      abilityTags: input.abilityTags ?? [],
      note: input.note ?? null,
    },
  });
  return toItemView(row as ItemRow, limits);
}

export async function updateItem(
  user: SessionUser,
  itemId: string,
  patch: {
    title?: string;
    semester?: string | null;
    abilityTags?: string[];
    selectedFor?: string[];
    note?: string | null;
    courseRef?: string | null;
  },
): Promise<ItemView> {
  assertStudent(user);
  // RLS 擋得住別家補習班，擋不住隔壁同學。所以自己比對 userId。
  const row = await prisma.portfolioItem.findFirst({ where: { id: itemId, userId: user.id } });
  if (!row) throw new PortfolioError('NOT_FOUND', '找不到這一件素材。', 404);

  const limits = await limitsFor(admissionYearOf());

  // **改一件的效果與新增一件一樣，所以這裡也要問一次。**
  //
  // 兩條路都繞得過 `addItem` 的判定：改學期把一件搬進已經滿的那一年，
  // 以及勾第四件課程學習成果給同一個校系——後者在畫面上只會染紅，
  // 而**個申的勾選上限沒有任何其他地方會擋**（送出前的清單在他沒填
  // 校系時看不到那幾件）。判定寫在 `portfolio.mjs` 的 `mayUpdateItem`，
  // 與 `mayAddItem` 同一條「只在這一動才超過時擋」的規則。
  if (patch.semester !== undefined || patch.selectedFor !== undefined) {
    const existing = await prisma.portfolioItem.findMany({ where: { userId: user.id } });
    const may = mayUpdateItem(
      existing,
      row.id,
      {
        ...(patch.semester !== undefined ? { semester: patch.semester } : {}),
        ...(patch.selectedFor !== undefined ? { selectedFor: patch.selectedFor } : {}),
      },
      limits,
    );
    if (!may.ok) throw new PortfolioError('OVER_LIMIT', may.reason ?? '超過件數上限。');
  }

  const updated = await prisma.portfolioItem.update({
    where: { id: row.id },
    data: {
      ...(patch.title !== undefined ? { title: String(patch.title).trim() } : {}),
      ...(patch.semester !== undefined ? { semester: patch.semester } : {}),
      ...(patch.abilityTags !== undefined ? { abilityTags: patch.abilityTags } : {}),
      ...(patch.selectedFor !== undefined ? { selectedFor: patch.selectedFor } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      ...(patch.courseRef !== undefined ? { courseRef: patch.courseRef } : {}),
    },
  });
  return toItemView(updated as ItemRow, limits);
}

export async function deleteItem(user: SessionUser, itemId: string): Promise<void> {
  assertStudent(user);
  const row = await prisma.portfolioItem.findFirst({ where: { id: itemId, userId: user.id } });
  if (!row) throw new PortfolioError('NOT_FOUND', '找不到這一件素材。', 404);
  await prisma.portfolioItem.delete({ where: { id: row.id } });
}

// ─────────────────────────────────────────────────────────────────
// 自述與綜整心得
// ─────────────────────────────────────────────────────────────────

export type EssayView = {
  id: string;
  kind: string;
  programRef: string | null;
  body: string;
  charCount: number;
  imageCount: number;
  version: number;
  isCurrent: boolean;
  /** 分享給哪幾位老師。**只有作者看得到這個欄位。** */
  sharedWith: { userId: string; displayName: string }[];
  updatedAt: string;
};

/**
 * 老師看得到的形狀。
 *
 * **這個型別裡沒有任何欄位裝得下 AI 對話紀錄、揭露聲明、或分享名單。**
 * 那不是省略，那是這一條隱私規則的實作方式：規格書 §9.5 要求「AI 對話
 * 紀錄僅學生本人可見，老師連摘要都看不到」，而「記得不要 select」
 * 在改版時撐不住——下一個人加一個欄位是為了讓畫面好看，
 * 而他不會想到那一欄違反了一條寫在規格書裡的線。
 *
 * 沒有地方放的話，加欄位是編譯錯誤。這是 `lib/guardian.ts` 的
 * `projectTask` 用的同一招。
 *
 * 分享名單也不在裡面：老師看得到自己被分享了，不需要知道學生還分享
 * 給了誰——那是學生找誰徵詢意見的資訊，而它本身就有點私密。
 */
export type SharedEssayView = {
  id: string;
  kind: string;
  authorName: string;
  body: string;
  charCount: number;
  updatedAt: string;
};

const ESSAY_KINDS = ['DIVERSE_SUMMARY', 'REFLECTION', 'MOTIVATION', 'PLAN'];

/** 學生自己的自述。**含 `sharedWith`，因為那是他自己的設定。** */
export async function myEssays(user: SessionUser, year = admissionYearOf()) {
  assertStudent(user);
  const rows = await prisma.portfolioEssay.findMany({
    where: { userId: user.id, isCurrent: true },
    orderBy: { updatedAt: 'desc' },
  });
  const teacherIds = [...new Set(rows.flatMap((r) => r.sharedWith))];
  const teachers = teacherIds.length
    ? await prisma.user.findMany({
        where: { id: { in: teacherIds } },
        select: { id: true, displayName: true },
      })
    : [];
  const nameOf = new Map(teachers.map((t) => [t.id, t.displayName]));

  const limits = await limitsFor(year);
  const essays: EssayView[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    programRef: r.programRef,
    body: r.body,
    charCount: r.charCount,
    imageCount: r.imageCount,
    version: r.version,
    isCurrent: r.isCurrent,
    sharedWith: r.sharedWith.map((id) => ({
      userId: id,
      displayName: nameOf.get(id) ?? '（已離職或找不到這位老師）',
    })),
    updatedAt: r.updatedAt.toISOString(),
  }));

  const summary = rows.find((r) => r.kind === 'DIVERSE_SUMMARY');
  return {
    year,
    limits,
    essays,
    ruleChecks: [
      ...checkSelfStatement(rows),
      ...(summary ? checkSummaryEssay(summary, limits) : []),
    ],
  };
}

/**
 * 存一個新版本。
 *
 * **舊版本留著**（`isCurrent = false`），因為寫學習歷程的價值有一半在
 * 回頭看自己三個月前怎麼想的。直接覆蓋的話那半就沒了，而且學生刪掉
 * 一段之後想找回來時只能重寫。
 */
export async function saveEssay(
  user: SessionUser,
  input: { kind: string; body: string; imageCount?: number; programRef?: string | null },
): Promise<EssayView> {
  assertStudent(user);
  const tenantId = requireTenant();
  if (!ESSAY_KINDS.includes(input.kind)) {
    throw new PortfolioError('INVALID', '不認得這一種自述。');
  }
  const body = String(input.body ?? '');
  const programRef = input.programRef ?? null;

  const prev = await prisma.portfolioEssay.findFirst({
    where: { userId: user.id, kind: input.kind as never, programRef, isCurrent: true },
    orderBy: { version: 'desc' },
  });

  // 分享名單跟著新版本走。**不繼承的話，學生每存一次就等於撤回了
  // 分享**，而他不會知道——老師那邊只是安靜地看不到最新的一版。
  const row = await prisma.$transaction(async (tx) => {
    if (prev) {
      await tx.portfolioEssay.update({ where: { id: prev.id }, data: { isCurrent: false } });
    }
    return tx.portfolioEssay.create({
      data: {
        tenantId,
        userId: user.id,
        kind: input.kind as never,
        programRef,
        body,
        charCount: charCountOf(body),
        imageCount: Math.max(0, Math.floor(Number(input.imageCount ?? prev?.imageCount ?? 0)) || 0),
        version: (prev?.version ?? 0) + 1,
        isCurrent: true,
        sharedWith: prev?.sharedWith ?? [],
      },
    });
  });

  return {
    id: row.id,
    kind: row.kind,
    programRef: row.programRef,
    body: row.body,
    charCount: row.charCount,
    imageCount: row.imageCount,
    version: row.version,
    isCurrent: row.isCurrent,
    sharedWith: row.sharedWith.map((id) => ({ userId: id, displayName: '' })),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 分享給一位老師，或撤回。
 *
 * **撤回是把 id 從陣列裡拿掉，而老師端的查詢條件就是這個陣列**——
 * 所以撤回是立即生效的，不需要另一張表記「已撤回」。做成只增不減的
 * 授權表加一個 `revokedAt` 的話，會有一個「查詢忘記過濾已撤回」的
 * 破口，而那個破口的症狀是沒有症狀。
 */
export async function shareEssay(
  user: SessionUser,
  essayId: string,
  teacherId: string,
  share: boolean,
): Promise<EssayView> {
  assertStudent(user);
  // **`isCurrent` 要在查詢裡，不是在回傳的時候才發現。**
  //
  // 少了它，一個舊版本的 essayId 會先被 `update()` 寫進 `sharedWith`，
  // 然後 `myEssays()`（只回現行版本）找不到它、丟 404——學生看到
  // 「找不到這一份自述」，而授權已經落地在一列他在畫面上永遠看不到、
  // 也撤不回的舊版本上。目前老師端因為也查 `isCurrent: true` 所以沒有
  // 外洩，但那條線是唯一擋著的東西，而它不該是唯一的。
  const row = await prisma.portfolioEssay.findFirst({
    where: { id: essayId, userId: user.id, isCurrent: true },
  });
  if (!row) {
    throw new PortfolioError(
      'NOT_FOUND',
      '找不到這一份自述的現行版本。分享與撤回都只作用在現行版本上——' +
        '舊版本是留給你自己回頭看的，不會被分享出去。',
      404,
    );
  }

  if (share) {
    const teacher = await prisma.user.findFirst({
      where: { id: teacherId, systemRole: { in: ['TEACHER', 'SUBJECT_LEAD', 'SCHOOL_ADMIN'] } },
      select: { id: true },
    });
    if (!teacher) throw new PortfolioError('NOT_FOUND', '找不到這位老師。', 404);
  }

  const next = share
    ? [...new Set([...row.sharedWith, teacherId])]
    : row.sharedWith.filter((id) => id !== teacherId);

  await prisma.portfolioEssay.update({ where: { id: row.id }, data: { sharedWith: next } });
  const fresh = await myEssays(user);
  const found = fresh.essays.find((e) => e.id === essayId);
  if (!found) throw new PortfolioError('NOT_FOUND', '找不到這一份自述。', 404);
  return found;
}

/**
 * 刪掉一份自述——**連同它的每一個舊版本。**
 *
 * # 為什麼有進沒有出是一個問題
 *
 * 素材有 DELETE，自述與練習紀錄沒有。這一區裝的是他的生涯敘事，
 * 而寫下來之後想拿掉的理由與素材完全不同：他可能寫了一段關於家裡的
 * 事、或是一段他現在覺得很蠢的話。「你刪不掉」在這種內容上不是不方便，
 * 它會讓他下一次不寫真話——而那時候這個功能就沒有用了。
 *
 * # 為什麼連舊版本一起刪
 *
 * 因為只刪現行版本的話，舊版本會留在資料庫裡而**畫面上永遠看不到**
 * （`myEssays()` 只回 `isCurrent`），連同它們的 `sharedWith`。
 * 那不是刪除，那是把它藏起來——症狀與這一支要解決的問題一模一樣。
 *
 * 保留舊版本的價值（回頭看自己三個月前怎麼想的）在這裡讓位：
 * 那個價值是**他的**，而他正在說他不要了。
 */
export async function deleteEssay(user: SessionUser, essayId: string): Promise<void> {
  assertStudent(user);
  const row = await prisma.portfolioEssay.findFirst({ where: { id: essayId, userId: user.id } });
  if (!row) throw new PortfolioError('NOT_FOUND', '找不到這一份自述。', 404);
  await prisma.portfolioEssay.deleteMany({
    where: { userId: user.id, kind: row.kind, programRef: row.programRef },
  });
}

/**
 * 老師端：學生主動分享過來的自述。
 *
 * **這是老師在這整個模組裡唯一看得到內容的入口。** 查詢條件是
 * 「`sharedWith` 含我的 id」，沒有「我帶的班」這個條件——帶班不等於
 * 被授權，而規格書 §3 的權限表在這一列寫的是「R（學生授權後）」。
 *
 * 回的是 `SharedEssayView`，那個型別裡沒有欄位裝得下 AI 對話紀錄。
 */
export async function essaysSharedWithMe(user: SessionUser): Promise<SharedEssayView[]> {
  assertStaff(user);
  const rows = await prisma.portfolioEssay.findMany({
    where: { isCurrent: true, sharedWith: { has: user.id } },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      kind: true,
      body: true,
      charCount: true,
      updatedAt: true,
      user: { select: { displayName: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    authorName: r.user.displayName,
    body: r.body,
    charCount: r.charCount,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

// ─────────────────────────────────────────────────────────────────
// AI 使用層級
// ─────────────────────────────────────────────────────────────────

/**
 * 這位學生現在適用哪一級。
 *
 * **多個班級取最嚴的一級**（見 `portfolio.mjs` 的 `effectiveAiLevel`）。
 * 沒有任何一班設定過就是 `null`，而 `null` 一律停用——「事前明定」的
 * 意思是老師要先做一個決定，沒做就是沒做。
 */
export async function aiLevelOf(userId: string): Promise<{
  level: number | null;
  classes: { classId: string; className: string; level: number | null }[];
  /** 還沒設定的班級名稱。**要點名**，否則學生不知道去找哪一位老師。 */
  unsetClasses: string[];
}> {
  const memberships = await prisma.classMembership.findMany({
    where: { userId, leftAt: null, role: 'STUDENT' },
    select: { classId: true, class: { select: { name: true, aiUsagePolicy: { select: { level: true } } } } },
  });
  const classes = memberships.map((m) => ({
    classId: m.classId,
    className: m.class.name,
    level: m.class.aiUsagePolicy?.level ?? null,
  }));
  return {
    level: effectiveAiLevel(classes.map((c) => c.level)),
    classes,
    unsetClasses: classes.filter((c) => c.level === null).map((c) => c.className),
  };
}

export async function setAiPolicy(
  user: SessionUser,
  classId: string,
  level: number,
  note?: string | null,
): Promise<{ classId: string; level: number }> {
  // 角色先問，班級存不存在後問：反過來的話，一個學生打這一支可以用
  // 錯誤訊息的差別（400 還是 404）問出「這個班級 id 存不存在」。
  assertStaff(user);
  if (!Number.isInteger(level) || level < 1 || level > 4) {
    throw new PortfolioError('INVALID', 'AI 使用層級是 1 到 4。');
  }
  const tenantId = requireTenant();
  const klass = await prisma.class.findFirst({ where: { id: classId }, select: { id: true } });
  if (!klass) throw new PortfolioError('NOT_FOUND', '找不到這個班級。', 404);
  // 帶班判定。理由見 `assertMayGovernClass`——`AiUsagePolicy` 是
  // update-in-place，被蓋掉的那一級沒有留下任何痕跡。
  await assertMayGovernClass(user, classId);

  const existing = await prisma.aiUsagePolicy.findFirst({ where: { classId } });
  if (existing) {
    await prisma.aiUsagePolicy.update({
      where: { id: existing.id },
      data: { level, note: note ?? null, setBy: user.id, setAt: new Date() },
    });
  } else {
    await prisma.aiUsagePolicy.create({
      data: { tenantId, classId, level, note: note ?? null, setBy: user.id },
    });
  }
  return { classId, level };
}

/**
 * 老師端的班級層級一覽。**只有他自己帶的班。**
 *
 * 全校每一班的設定不是他的事：這一頁的用途是「我帶的班我決定好了
 * 沒有」，而列出全校會讓那句話變成「還有 37 個班級沒有設定」——
 * 一個他做不了也不該做的待辦。管理員看得到全部，因為老師離職與
 * 全校統一調整是他的職責。
 */
export async function aiPolicies(user: SessionUser) {
  assertStaff(user);
  const isAdmin = ['SCHOOL_ADMIN', 'SYS_ADMIN'].includes(user.systemRole);
  const mine = isAdmin
    ? null
    : await prisma.classSubjectTeacher.findMany({
        where: { userId: user.id },
        select: { classId: true },
      });
  const rows = await prisma.class.findMany({
    where: {
      active: true,
      ...(mine ? { id: { in: [...new Set(mine.map((m) => m.classId))] } } : {}),
    },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, aiUsagePolicy: { select: { level: true, note: true, setAt: true } } },
  });
  return rows.map((c) => ({
    classId: c.id,
    className: c.name,
    level: c.aiUsagePolicy?.level ?? null,
    note: c.aiUsagePolicy?.note ?? null,
    setAt: c.aiUsagePolicy?.setAt?.toISOString() ?? null,
  }));
}

// ─────────────────────────────────────────────────────────────────
// AI 使用記錄與揭露聲明
// ─────────────────────────────────────────────────────────────────

/**
 * 記一次互動。**不可竄改**，所以只有 create，沒有 update 也沒有 delete。
 *
 * 記錄失敗不吞：這張表是揭露聲明的事實基礎，而一份對不回記錄的聲明
 * 就不是揭露而是宣稱。寧可讓學生看到錯誤重來一次。
 */
async function logAiUse(input: {
  userId: string;
  feature: string;
  essayId?: string | null;
  natureNote: string;
  aiLevel: number | null;
}): Promise<void> {
  const tenantId = requireTenant();
  await prisma.aiDisclosureLog.create({
    data: {
      tenantId,
      userId: input.userId,
      feature: input.feature as never,
      essayId: input.essayId ?? null,
      natureNote: input.natureNote,
      aiLevel: input.aiLevel,
    },
  });
}

/**
 * 學生自己的 AI 使用記錄。
 *
 * **第一個參數是 `SessionUser` 而不是 userId**，所以呼叫端沒有辦法傳
 * 一個「別人的 id」進來——那個參數在型別上不存在。這一條與智慧老師
 * 那一塊相反（那裡老師看得到班上的對話），因為這裡的內容涉及個人
 * 生涯與家庭。
 *
 * **這個檔案裡沒有第二支查 `AiDisclosureLog` 的函式。** 老師端要看的
 * 東西在 `essaysSharedWithMe()`，而那一支的回傳型別裡沒有欄位裝得下
 * 這些記錄。
 */
export async function myDisclosure(user: SessionUser, essayId?: string | null) {
  assertStudent(user);
  const [logs, statements, level] = await Promise.all([
    prisma.aiDisclosureLog.findMany({
      where: { userId: user.id },
      orderBy: { occurredAt: 'desc' },
      take: 500,
    }),
    prisma.aiDisclosureStatement.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    aiLevelOf(user.id),
  ]);
  const scoped = essayId ? logs.filter((l) => l.essayId === essayId) : logs;
  const facts = disclosureFacts(scoped);
  return {
    level: level.level,
    classes: level.classes,
    logs: scoped.map((l) => ({
      id: l.id,
      feature: l.feature,
      featureLabel: AI_FEATURE_LABELS[l.feature as keyof typeof AI_FEATURE_LABELS] ?? l.feature,
      natureNote: l.natureNote,
      aiLevel: l.aiLevel,
      occurredAt: l.occurredAt.toISOString(),
    })),
    counts: facts.counts,
    total: facts.total,
    statements: statements.map((s) => ({
      id: s.id,
      essayId: s.essayId,
      generated: s.generated,
      edited: s.edited,
      createdAt: s.createdAt.toISOString(),
    })),
  };
}

/**
 * 產生一份揭露聲明。
 *
 * # 這一支是規格書 §13 點名的陷阱
 *
 * 聲明本身就是一段五十幾字的連續第一人稱敘述（「本文之構思與撰寫由
 * 本人完成，過程中使用 AI 輔助工具進行……」），而且依 §9.6 它**必須
 * 隨互動性質變化、不能寫死成樣板**——也就是必須由模型生成。
 *
 * 若走防代寫閘門，這一支會被自己的後處理層無限重試，症狀是它永遠
 * 轉圈。所以它走**另一組規則**：`checkPortfolioOutput()` 看到
 * `DISCLOSURE_STATEMENT` 就改去比對聲明內容與 `AiDisclosureLog` 的
 * 實際記錄是否相符。**排除不等於不檢查。**
 *
 * 分流在閘門裡而不是在這裡，所以這一支與 `coachFeedback()` 共用
 * 同一個重試迴圈——兩份迴圈的話，其中一份遲早會忘記帶 feature。
 */
export async function makeStatement(
  user: SessionUser,
  essayId?: string | null,
): Promise<{
  id: string;
  generated: string;
  fellBack: boolean;
  blockedDrafts: number;
  blockedReasons: string[];
}> {
  assertStudent(user);
  const tenantId = requireTenant();

  const logs = await prisma.aiDisclosureLog.findMany({
    where: { userId: user.id, ...(essayId ? { essayId } : {}) },
    orderBy: { occurredAt: 'asc' },
    take: 500,
  });
  const facts = disclosureFacts(logs);
  const { level } = await aiLevelOf(user.id);

  const deterministic = () => safeStatement(facts, AI_FEATURE_DISCLOSURE_PHRASES);

  // 預算用完時走程式版本而不是報錯。**揭露是及格線不是加分項**——
  // 與 AI 連不上那一天同一個理由，而且這一天更難解釋：學生沒有辦法
  // 讓預算變多，他只能交不出揭露。
  const overBudget = await assertBudget(tenantId).then(
    () => false,
    (e) => {
      if (e instanceof PortfolioError && e.code === 'BUDGET') return true;
      throw e;
    },
  );

  // **第 1 級（不得使用 AI）不呼叫模型。**
  //
  // 這一級的學生依定義不可能有任何一次模型互動，所以他的聲明內容就是
  // 「未使用」——一句由程式組得出來的話。為了產生這句話而去呼叫模型，
  // 等於讓一位被明定不得使用 AI 的學生產生一次 AI 互動，而那次互動
  // 還會被記進他自己的揭露記錄裡。那不是矛盾的邊緣案例，那是直接
  // 違反老師的決定。
  const out =
    level === 1 || overBudget
      ? { text: deterministic(), fellBack: true, blockedDrafts: 0, blockedReasons: [], calledModel: false }
      : await generateWithGate({
          feature: 'DISCLOSURE_STATEMENT',
          userId: user.id,
          payload: {
            counts: facts.counts,
            // **要揭露的次數，不是記錄的總筆數。** 兩者的差是「產生
            // 聲明」自己那幾筆，而模型會照著這個數字寫「共 N 次」——
            // 用 total 的話，按幾次「重新產生」就多幾次（理由見
            // `disclosureFacts` 的說明）。
            total: facts.disclosedTotal,
            audit_total: facts.total,
            first_at: facts.firstAt,
            last_at: facts.lastAt,
            ai_level: level,
            notes: logs.slice(-12).map((l) => ({ feature: l.feature, nature: l.natureNote })),
          },
          facts: { disclosure: facts },
          fallback: deterministic,
          // 見 `generateWithGate` 的說明：揭露是及格線，AI 掛掉的那一天
          // 不可以變成他交不出揭露的那一天。預算用完也一樣。
          fallbackOnUpstreamFailure: true,
        });

  const row = await prisma.aiDisclosureStatement.create({
    data: { tenantId, userId: user.id, essayId: essayId ?? null, generated: out.text },
  });

  // **只有真的呼叫過模型才記一筆。**
  //
  // 第 1 級（不得使用 AI）與 AI 連不上時走的是 `deterministic()`，
  // 一行都沒有呼叫模型。無條件記錄的話，一位被老師明定不得使用 AI 的
  // 學生，記錄上會有 AI 互動——而那筆記錄還會灌進下一次的次數。
  //
  // 「呼叫了但三次都被閘門擋下」要記：那幾次模型確實看過他的文字，
  // 也確實花了錢，而揭露要算得進去。
  if (out.calledModel) {
    await logAiUse({
      userId: user.id,
      feature: 'DISCLOSURE_STATEMENT',
      essayId: essayId ?? null,
      natureNote: `依 ${facts.disclosedTotal} 次要揭露的互動產生揭露聲明草稿`,
      aiLevel: level,
    });
  }

  return {
    id: row.id,
    generated: row.generated,
    fellBack: out.fellBack,
    blockedDrafts: out.blockedDrafts,
    blockedReasons: out.blockedReasons,
  };
}

/**
 * 學生編輯過的版本。**原始的 `generated` 留著**，那是系統說了什麼。
 *
 * # 這一條路才是產出最終文件的那一條
 *
 * 閘門本來只掛在「模型生成」上，而學生按「產生一份」拿到正確的聲明
 * 之後，可以在 textarea 裡把它改成「……未使用 AI 輔助工具」再按存檔，
 * 然後畫面給他一顆「複製」按鈕——**而 `edited` 就是他要貼進檔案的
 * 那一份**。`CLAIMS_NO_AI`（「這不是揭露，這是否認」）在這條路上
 * 一次都不會執行。
 *
 * # 擋的是與記錄不符，不是擋編輯
 *
 * 學生**有權利用自己的話寫這份聲明**（§9.6 甚至要求它不能是樣板），
 * 所以這裡不能改成「只准用系統產的那一份」。分界線與模型那條路完全
 * 一樣：`GHOST` 是聲明不實（宣稱沒用過、漏掉發生過的、多說沒發生的、
 * 數字對不上）——擋下來並且說明白哪裡對不上；`STYLE` 是體例
 * （沒有寫「由本人完成」、太長）——存進去，回一句提醒。
 *
 * @returns 存進去了但值得提醒的幾句話
 */
export async function editStatement(
  user: SessionUser,
  statementId: string,
  edited: string,
): Promise<{ warnings: string[] }> {
  assertStudent(user);
  const row = await prisma.aiDisclosureStatement.findFirst({
    where: { id: statementId, userId: user.id },
  });
  if (!row) throw new PortfolioError('NOT_FOUND', '找不到這一份聲明。', 404);

  const text = String(edited ?? '');

  // 空的＝把編輯撤掉，回到系統產的那一份。擋一份空聲明沒有意義：
  // 他要的是「不要我改的版本」，而那是他的權利。
  if (!text.trim()) {
    await prisma.aiDisclosureStatement.update({ where: { id: row.id }, data: { edited: null } });
    return { warnings: [] };
  }

  // 比對的記錄範圍要與產生時同一份（同一個 essayId），否則一份針對
  // 某一份自述產生的聲明會被拿去對全部的記錄，然後被判成漏講。
  const logs = await prisma.aiDisclosureLog.findMany({
    where: { userId: user.id, ...(row.essayId ? { essayId: row.essayId } : {}) },
    orderBy: { occurredAt: 'asc' },
    take: 500,
  });
  const verdict = checkPortfolioOutput('DISCLOSURE_STATEMENT', text, {
    disclosure: disclosureFacts(logs),
  });

  if (verdict.ghostwritten) {
    throw new PortfolioError(
      'INVALID',
      '這一份改過的聲明與你的實際使用記錄對不起來，所以沒有存進去：' +
        summarizePortfolioViolations(verdict.violations.filter((v) => v.severity === 'GHOST')).join('；') +
        '。你可以用自己的話寫這份聲明——它本來就該像你講話的樣子——' +
        '但它會被貼進學習歷程給招生委員看，所以上面的每一件事與每一個數字都要對得回記錄。',
    );
  }

  await prisma.aiDisclosureStatement.update({ where: { id: row.id }, data: { edited: text } });
  return { warnings: summarizePortfolioViolations(verdict.violations) };
}

// ─────────────────────────────────────────────────────────────────
// 與 AI 服務的溝通
// ─────────────────────────────────────────────────────────────────

const AI_URL = (process.env.AI_SERVICE_URL ?? 'http://ai:8000').replace(/\/+$/, '');
const TURN_TIMEOUT_MS = 60_000;
/** 重試上限。用完就退回由程式組出來的版本。 */
const MAX_REGENERATE = 2;

type AiResponse = {
  text: string;
  model: string;
  prompt_version: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
};

async function callPortfolioAi(body: unknown): Promise<AiResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${AI_URL}/v1/portfolio/coach`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    throw new PortfolioError(
      'AI_DOWN',
      '現在連不上 AI 服務。制度檢查（字數、件數、必要子項）不受影響，那一部分是系統自己算的。',
      503,
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    console.error(`[portfolio] AI 服務回應 ${res.status}：${text.slice(0, 300)}`);
    throw new PortfolioError('AI_DOWN', 'AI 服務現在沒有辦法回應。這通常是設定或額度的問題，請告訴老師。', 503);
  }
  return JSON.parse(text) as AiResponse;
}

// ─────────────────────────────────────────────────────────────────
// 成本
//
// 這個模組原本一列 `AiUsageLog` 都沒有寫，而 `doctor.sh` 的「AI 用量」、
// `OPERATIONS.md` 的 SQL、匯入頁的成本**全部查那張表**——於是撰寫回饋、
// 素材提示、選件討論、揭露聲明產生器（每一次最多打三次模型）的花費
// 完全不在帳上。老師問「這個月花多少」時，答案少了一整個模組。
//
// 作法照 `lib/tutor.ts` 與 `lib/admissionRefDb.ts`：真相是 `AiUsageLog`
// 的 aggregate，`AiBudgetCounter` 只是寫給人看的鏡子。
// ─────────────────────────────────────────────────────────────────

async function monthlyTokens(tenantId: string): Promise<number> {
  const since = new Date();
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);
  const agg = await prisma.aiUsageLog.aggregate({
    where: { tenantId, createdAt: { gte: since } },
    _sum: { inputTokens: true, outputTokens: true },
  });
  return (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0);
}

/**
 * 預算用完就不再呼叫模型。
 *
 * **只擋會呼叫模型的那幾項。** 制度檢查、送出前的清單、面試的結構
 * 回饋都是純規則，不受影響——而揭露聲明的呼叫端會把這個錯誤接住、
 * 改用程式組出來的版本（見 `makeStatement`）：它是及格線不是加分項，
 * 預算用完的那一天不可以變成他交不出揭露的那一天。
 */
async function assertBudget(tenantId: string): Promise<void> {
  const budget = Number(process.env.AI_MONTHLY_TOKEN_BUDGET ?? 0);
  if (!(budget > 0)) return;
  const used = await monthlyTokens(tenantId);
  if (used >= budget) {
    throw new PortfolioError(
      'BUDGET',
      `這個月的 AI 用量已經到上限（${used.toLocaleString()} / ${budget.toLocaleString()}）。` +
        '學習歷程的 AI 回饋暫停，但制度檢查、送出前的確認清單與面試的結構回饋都不受影響——' +
        '那幾項是系統自己算的。想繼續的話，請告訴老師。',
      429,
    );
  }
}

/**
 * 一列用量記錄。**退回罐頭時也要寫**——那幾次仍然呼叫過模型、仍然
 * 花了錢，而少寫的那幾次會讓月底的帳與實際對不起來。
 */
async function recordPortfolioUsage(u: {
  tenantId: string;
  feature: string;
  userId: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
  promptVersion: string;
  latencyMs: number;
  succeeded: boolean;
  retryCount: number;
}): Promise<void> {
  if (u.tokensIn === 0 && u.tokensOut === 0) return;
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  try {
    await prisma.$transaction([
      prisma.aiUsageLog.create({
        data: {
          tenantId: u.tenantId,
          // OTHER 與 `AdmissionAdvice` 那一段同一個權宜之計：這個列舉
          // 是資料庫的 enum，加一個值要遷移。`refType` 分得出來是哪一塊。
          purpose: 'OTHER',
          // 回饋不是推導。用 MID：這一段要產出的是一段兩三百字的提問，
          // 而 HIGH 的價格是 MID 的五倍。
          tier: 'MID',
          provider: process.env.AI_PROVIDER ?? 'unknown',
          model: u.model || 'unknown',
          baseUrl: process.env.AI_BASE_URL ?? null,
          inputTokens: u.tokensIn,
          outputTokens: u.tokensOut,
          latencyMs: u.latencyMs || null,
          succeeded: u.succeeded,
          errorCode: u.succeeded ? null : 'PORTFOLIO_GUARD_FALLBACK',
          retryCount: u.retryCount,
          refType: `Portfolio:${u.feature}`,
          refId: u.userId,
          promptVersion: u.promptVersion,
        },
      }),
      prisma.aiBudgetCounter.upsert({
        where: { tenantId_yearMonth: { tenantId: u.tenantId, yearMonth: ym } },
        create: {
          tenantId: u.tenantId,
          yearMonth: ym,
          inputTokens: BigInt(u.tokensIn),
          outputTokens: BigInt(u.tokensOut),
          callCount: 1,
        },
        update: {
          inputTokens: { increment: BigInt(u.tokensIn) },
          outputTokens: { increment: BigInt(u.tokensOut) },
          callCount: { increment: 1 },
        },
      }),
    ]);
  } catch (e) {
    // 記帳失敗不該把已經產生的回饋吞掉。真相在 AiUsageLog，那一筆若也
    // 失敗了，下一次的 aggregate 會少算這一次——可以接受的誤差。
    console.error('[portfolio] 用量記錄失敗', e);
  }
}

/**
 * 生成 → 檢查 → 不過就重來 → 用完就退回程式組出來的版本。
 *
 * 這一段是三個 AI 功能（撰寫回饋、素材提示、選件討論）與揭露聲明
 * **共用的**迴圈。共用是刻意的：分開寫的話，其中一份遲早會忘記把
 * `feature` 傳給閘門，而忘記的那一份如果剛好是揭露聲明，症狀是
 * 它永遠轉圈——一個功能把自己擋掉。
 */
async function generateWithGate(input: {
  feature: string;
  userId: string;
  payload: Record<string, unknown>;
  facts: { ghostwrite?: ReturnType<typeof ghostwriteFacts>; disclosure?: ReturnType<typeof disclosureFacts> };
  fallback: () => string;
  /**
   * AI 服務連不上時，要拋錯還是用退路版本。
   *
   * **回饋要拋錯**：學生按了「看我寫的」而 AI 掛了，他要知道那件事。
   * 給他一段罐頭而不說，他會以為那就是 AI 的回饋，然後覺得這個功能
   * 很爛。而且他不會損失什麼——制度檢查本來就在畫面上。
   *
   * **揭露聲明要用退路版本**：它是**及格線不是加分項**（教育部函文
   * 要求在檔案中標註 AI 使用）。AI 服務掛掉的那一天剛好是他要送件的
   * 那一天的話，拋錯等於讓他交不出必要的揭露，而那是他要負責的。
   * 退路版本由程式依記錄組出來，內容一樣正確，只是讀起來像樣板。
   */
  fallbackOnUpstreamFailure?: boolean;
}): Promise<{
  text: string;
  fellBack: boolean;
  blockedDrafts: number;
  blockedReasons: string[];
  /**
   * 模型真的看過他的文字嗎。
   *
   * **`fellBack` 回答不了這個問題**：它在「呼叫了三次都被閘門擋下」與
   * 「一次都沒呼叫到」時都是 true，而這兩件事在揭露記錄上差很多——
   * 前者是一次要揭露的 AI 互動，後者不是（見 `makeStatement`）。
   */
  calledModel: boolean;
}> {
  const tenantId = requireTenant();
  let accepted: string | null = null;
  let blockedDrafts = 0;
  const blockedReasons: string[] = [];
  let calledModel = false;
  let tokensIn = 0;
  let tokensOut = 0;
  let latencyMs = 0;
  let model = '';
  let promptVersion = '';

  for (let attempt = 0; attempt <= MAX_REGENERATE; attempt += 1) {
    let out: AiResponse;
    try {
      out = await callPortfolioAi({ feature: input.feature, retry: attempt, ...input.payload });
    } catch (e) {
      // 第一次就連不上而且這個功能容許報錯：往上拋，讓學生看到
      // 「連不上 AI」而不是一段罐頭。已經重生成過才吞掉——那時候退回
      // 程式版本比報錯有用。
      if (attempt === 0 && !input.fallbackOnUpstreamFailure) throw e;
      break;
    }

    calledModel = true;
    tokensIn += out.input_tokens ?? 0;
    tokensOut += out.output_tokens ?? 0;
    latencyMs += out.latency_ms ?? 0;
    model = out.model || model;
    promptVersion = out.prompt_version || promptVersion;

    const verdict = checkPortfolioOutput(input.feature, out.text, input.facts);
    if (verdict.ok) {
      accepted = out.text;
      break;
    }

    // **細節只進伺服器日誌。** `describePortfolioViolations` 會把被擋掉
    // 的那一段代寫引用出來，而把它顯示在學生的畫面上，等於用「這段被
    // 擋了」這個包裝把代寫送到他眼前——他會記住那句話然後自己打一次。
    console.warn(
      `[portfolio] ${input.feature} 第 ${attempt + 1} 次生成被擋：` +
        describePortfolioViolations(verdict.violations),
    );
    blockedReasons.push(summarizePortfolioViolations(verdict.violations).join('；'));
    blockedDrafts += 1;

    // 只剩體例問題（沒有問句、太長）而且已經重來過一次，就收下。
    // **代寫與不實的聲明永遠不收。**
    if (!verdict.ghostwritten && attempt >= 1) {
      accepted = out.text;
      break;
    }
  }

  if (calledModel) {
    await recordPortfolioUsage({
      tenantId,
      feature: input.feature,
      userId: input.userId,
      tokensIn,
      tokensOut,
      model,
      promptVersion,
      latencyMs,
      succeeded: accepted !== null,
      retryCount: blockedDrafts,
    });
  }

  return {
    text: accepted ?? input.fallback(),
    fellBack: accepted === null,
    blockedDrafts,
    blockedReasons,
    calledModel,
  };
}

// ─────────────────────────────────────────────────────────────────
// 三個 AI 功能
// ─────────────────────────────────────────────────────────────────

export type CoachFeature = 'WRITING_FEEDBACK' | 'MATERIAL_HINT' | 'SELECTION_DISCUSS';

/**
 * 撰寫回饋、素材提示、選件討論。
 *
 * 三個功能共用一支，因為它們的差別只在餵什麼脈絡與用哪一段提示詞，
 * 而**它們的閘門與記錄必須完全一樣**。分成三支的話，日後有人在其中
 * 一支加了一個「不要重試了直接回」的捷徑，而那一支就沒有防代寫了。
 */
export async function coachFeedback(
  user: SessionUser,
  input: { feature: CoachFeature; essayId?: string | null; question?: string; programRef?: string | null },
): Promise<{
  feature: string;
  text: string;
  fellBack: boolean;
  blockedDrafts: number;
  blockedReasons: string[];
  ruleChecks: { code: string; ok: boolean; detail: string }[];
}> {
  assertStudent(user);
  const tenantId = requireTenant();
  const { level, unsetClasses } = await aiLevelOf(user.id);

  // **超出層級就停用，不是「可以用但要標註」。** 事前明定的意思就是
  // 有些事不准做（教育部 113/12/13 函文）。
  if (!aiFeatureAllowed(level, input.feature)) {
    throw new PortfolioError(
      'AI_DISABLED',
      aiDisabledReason(level, input.feature, unsetClasses),
      403,
    );
  }

  await assertBudget(tenantId);

  const year = admissionYearOf();
  const limits = await limitsFor(year);

  const [items, essays] = await Promise.all([
    prisma.portfolioItem.findMany({ where: { userId: user.id } }),
    prisma.portfolioEssay.findMany({ where: { userId: user.id, isCurrent: true } }),
  ]);

  const target = input.essayId
    ? essays.find((e) => e.id === input.essayId)
    : essays.find((e) => e.kind === 'MOTIVATION') ?? essays[0];

  const summary = essays.find((e) => e.kind === 'DIVERSE_SUMMARY');
  const ruleChecks = [
    ...checkSelfStatement(essays),
    ...(summary ? checkSummaryEssay(summary, limits) : []),
  ];

  // 學生自己寫的每一個字都算「他的原文」。閘門用它判斷一段第一人稱
  // 敘述是引用還是代寫——少了素材的標題與備註，引用他自己標的成果
  // 名稱會被當成代寫。
  const facts = ghostwriteFacts({
    studentText: target?.body ?? '',
    extraOwnText: [
      ...essays.map((e) => e.body),
      ...items.map((i) => `${i.title} ${i.note ?? ''}`),
    ],
  });

  // 素材提示要接核心系統的資料。**那不是代寫，是幫學生想起自己的
  // 經歷**，而且用的是他自己的真實學習軌跡。
  const trace =
    input.feature === 'MATERIAL_HINT' ? await learningTrace(user.id) : { grades: [], abilities: [] };

  const out = await generateWithGate({
    feature: input.feature,
    userId: user.id,
    payload: {
      question: String(input.question ?? '').slice(0, 500),
      essay: target ? { kind: target.kind, body: target.body.slice(0, 4000) } : null,
      items: items.map((i) => ({
        code: i.itemCode,
        title: i.title,
        semester: i.semester,
        ability_tags: i.abilityTags,
        selected_for: i.selectedFor,
      })),
      program_ref: input.programRef ?? null,
      rule_checks: ruleChecks,
      grade_trace: trace.grades,
      ability_trace: trace.abilities,
    },
    facts: { ghostwrite: facts },
    fallback: () => safeFeedback(ruleChecks),
  });

  // 模型看過他的文字就要記一筆，包含三次都被閘門擋下那幾次——那幾次
  // 仍然是 AI 互動。沒有呼叫到（連不上、被吞掉）就不記，理由與
  // `makeStatement` 相同：沒發生的事不進稽核記錄。
  if (out.calledModel) {
    await logAiUse({
      userId: user.id,
      feature: input.feature,
      essayId: target?.id ?? null,
      natureNote: natureNoteFor(input.feature, out.fellBack),
      aiLevel: level,
    });
  }

  return { feature: input.feature, ...out, ruleChecks };
}

/**
 * 揭露聲明要寫得像人話，所以互動性質的摘要也要。
 *
 * 這一段文字會被讀進聲明的生成脈絡裡，所以它不能是
 * 「feature=WRITING_FEEDBACK, ok=true」——那樣生出來的聲明會長得像
 * 一份系統日誌，而它是要貼進學習歷程檔案給招生委員看的。
 */
function natureNoteFor(feature: string, fellBack: boolean): string {
  const base: Record<string, string> = {
    WRITING_FEEDBACK: '請 AI 看過自述草稿，指出哪裡不夠具體、哪裡前後對不起來',
    MATERIAL_HINT: '請 AI 從個人的成績與作答軌跡提問，幫忙想起可以寫的經歷',
    SELECTION_DISCUSS: '與 AI 討論送出的成果組合能不能呈現目標校系想看的能力',
  };
  return (base[feature] ?? feature) + (fellBack ? '（AI 的回覆被防代寫閘門擋下，改用系統的制度檢查）' : '');
}

/**
 * 素材提示要用的學習軌跡。
 *
 * 只取**變化**而不是每一筆成績：「你在高二下的物理成績有明顯進步」
 * 是一個問題的開頭，「你的物理成績依序是 8、9、9、11」不是。
 * 這一支在這裡而不是在 `.mjs`，因為它要查資料庫；折成「哪幾科有明顯
 * 變化」這件事很簡單，複雜的判斷留給模型去問。
 */
async function learningTrace(userId: string) {
  const [grades, abilities] = await Promise.all([
    prisma.subjectGradeRecord.findMany({
      where: { userId },
      orderBy: { examDate: 'asc' },
      select: { subjectCode: true, examName: true, examDate: true, grade: true },
      take: 200,
    }),
    prisma.abilitySnapshot.findMany({
      where: { userId, reliable: true },
      orderBy: { mastery: 'desc' },
      select: { mastery: true, knowledgePoint: { select: { name: true } } },
      take: 60,
    }),
  ]);

  const bySubject = new Map<string, { grade: number; date: Date; examName: string }[]>();
  for (const g of grades) {
    if (!bySubject.has(g.subjectCode)) bySubject.set(g.subjectCode, []);
    bySubject.get(g.subjectCode)!.push({ grade: g.grade, date: g.examDate, examName: g.examName });
  }

  const moves: { subject: string; from: number; to: number; span: string }[] = [];
  for (const [subject, rows] of bySubject) {
    if (rows.length < 2) continue;
    const first = rows[0];
    const last = rows[rows.length - 1];
    // 兩級分以上才算「明顯」。一級分的差在模考之間是雜訊，而把雜訊
    // 講成轉折會讓學生去回想一件根本沒有發生的事。
    if (Math.abs(last.grade - first.grade) < 2) continue;
    moves.push({
      subject,
      from: first.grade,
      to: last.grade,
      span: `${first.examName} 到 ${last.examName}`,
    });
  }

  return {
    grades: moves,
    abilities: abilities.slice(0, 8).map((a) => ({
      name: a.knowledgePoint.name,
      mastery: Math.round(a.mastery * 100) / 100,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────
// 送出前的確認清單
// ─────────────────────────────────────────────────────────────────

export async function checklistFor(
  user: SessionUser,
  programs: { programRef: string; name?: string; mode?: string | null; deadline?: string | null }[],
  now = new Date(),
) {
  assertStudent(user);
  const year = admissionYearOf();
  const [items, essays, limits] = await Promise.all([
    prisma.portfolioItem.findMany({ where: { userId: user.id } }),
    prisma.portfolioEssay.findMany({ where: { userId: user.id, isCurrent: true } }),
    limitsFor(year),
  ]);
  return { year, limits, ...submissionChecklist({ items, essays, programs, limits, now }) };
}

// ─────────────────────────────────────────────────────────────────
// 面試
// ─────────────────────────────────────────────────────────────────

/**
 * 題庫。第一次進來時把內建範本匯入成 `InterviewQuestion`。
 *
 * 匯入而不是寫死，因為各校系的問法會變，而寫死的題庫改不動。
 * 匯入只做一次（用題目文字比對），所以老師刪掉的題目不會被還原——
 * 他刪掉是因為他不要那一題。
 */
export async function interviewQuestions(user: SessionUser, fieldTag?: string) {
  // 導覽列不畫、頁面擋非學生，而這裡是**第三扇門**。少了它，家長
  // 直接打 `GET /api/interview/questions` 拿得到整份題庫，而且在還沒
  // 匯入過的租戶上，那次請求會用他的 id 建立 39 筆 `InterviewQuestion`。
  assertNotGuardian(user);
  const tenantId = requireTenant();
  const existing = await prisma.interviewQuestion.count({ where: { tenantId } });
  if (existing === 0) {
    await prisma.interviewQuestion.createMany({
      data: QUESTION_TEMPLATES.map((t) => ({
        tenantId,
        fieldTag: t.fieldTag,
        question: t.question,
        focusPoints: t.focusPoints,
        createdBy: user.id,
      })),
    });
  }
  const tag = fieldTag && fieldTag !== 'ALL' ? fieldTag : null;
  const rows = await prisma.interviewQuestion.findMany({
    where: { tenantId, active: true, ...(tag ? { fieldTag: { in: [tag, 'GENERAL'] } } : {}) },
    orderBy: [{ fieldTag: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map((r) => ({
    id: r.id,
    fieldTag: r.fieldTag,
    question: r.question,
    focusPoints: r.focusPoints,
  }));
}

/**
 * 練習一題。
 *
 * **結構回饋是確定性的，不經過模型。** 三件事（有沒有回答到問題、
 * 有沒有具體例子、有沒有前後矛盾）用規則就判得出來，而規則的好處
 * 在這裡特別大：它不會偷偷開始評價內容——模型被要求「只評結構」時，
 * 第三輪就會寫出「你的例子很具體，展現了良好的團隊合作能力」，
 * 而後半句是內容評價。
 *
 * 一致性檢查同理：比對面試回答與學習歷程，是字串的事。
 */
export async function practiceInterview(
  user: SessionUser,
  questionId: string,
  answerText: string,
  programRef?: string | null,
): Promise<{
  id: string;
  feedback: ReturnType<typeof structureFeedback>;
  consistency: ReturnType<typeof consistencyCheck>;
}> {
  assertStudent(user);
  const tenantId = requireTenant();

  // **面試結構回饋在第 3 級才開，而這裡本來一道判定都沒有。**
  //
  // `AI_LEVELS[2].summary` 明寫「第 3 級……加開撰寫回饋與面試結構
  // 回饋」，`PolicyEditor` 把那句話整段印給老師看，`aiFeatureAllowed`
  // 也確實回 false——但沒有任何呼叫端用它，於是老師看到的說明與系統
  // 的行為是兩回事。**老師以為他關掉了。**
  //
  // 回饋本身不呼叫模型（那一段是對的，見下面），所以擋的不是「送進
  // 模型」而是「老師被告知這一項在他的層級之外」。兩者不一致的時候，
  // 要改的是行為不是那句說明——說明是他做決定時看到的東西。
  const { level, unsetClasses } = await aiLevelOf(user.id);
  if (!aiFeatureAllowed(level, INTERVIEW_AI_FEATURE)) {
    throw new PortfolioError(
      'AI_DISABLED',
      aiDisabledReason(level, INTERVIEW_AI_FEATURE, unsetClasses),
      403,
    );
  }

  const q = await prisma.interviewQuestion.findFirst({ where: { id: questionId, tenantId } });
  if (!q) throw new PortfolioError('NOT_FOUND', '找不到這一題。', 404);

  const answer = String(answerText ?? '').trim();
  if (!answer) throw new PortfolioError('INVALID', '還沒有輸入回答。');

  const [essays, items] = await Promise.all([
    prisma.portfolioEssay.findMany({
      where: { userId: user.id, isCurrent: true },
      select: { body: true },
    }),
    prisma.portfolioItem.findMany({ where: { userId: user.id }, select: { title: true, note: true } }),
  ]);

  const feedback = structureFeedback(answer, { question: q.question, focusPoints: q.focusPoints });
  const consistency = consistencyCheck(answer, essays, items);

  const row = await prisma.interviewPractice.create({
    data: {
      tenantId,
      userId: user.id,
      questionId: q.id,
      answerText: answer,
      programRef: programRef?.trim() || null,
      feedback: feedback as never,
      consistency: consistency as never,
    },
  });

  // **記一筆。** `INTERVIEW_FEEDBACK` 在 `MUST_DISCLOSE` 裡，而在此之前
  // 沒有任何一行寫過它——於是一位練了二十次的學生，揭露聲明上一個字
  // 都不會提到面試，而規則二（漏掉發生過的一類）永遠不會對它發動。
  //
  // 另一個選項是不記，理由是這一段確實一行都沒有呼叫模型（與
  // `RULE_CHECK` 同一種東西）。不選它，是因為老師的層級設定管得到
  // 這一項：一個「受 AI 使用層級管、但在揭露記錄上不存在」的功能，
  // 事後查不出他到底用了沒有。`natureNote` 說清楚它是規則判的。
  await logAiUse({
    userId: user.id,
    feature: INTERVIEW_AI_FEATURE,
    essayId: null,
    natureNote: '請系統依規則檢查面試回答的結構，以及它與學習歷程對不對得起來（不經過模型）',
    aiLevel: level,
  });

  return { id: row.id, feedback, consistency };
}

/**
 * 我的練習紀錄。
 *
 * **只有自己看得到。** 面試練習的回答裡會有他還沒想清楚的話、
 * 講砸的版本、以及他對自己志向的猶豫——那與學習歷程的內容是同一類
 * 的東西，所以走同一條線：沒有任何一支函式讓老師查別人的練習。
 */
export async function myPractices(user: SessionUser, limit = 50, programRef?: string | null) {
  assertStudent(user);
  const scope = programRef?.trim();
  const rows = await prisma.interviewPractice.findMany({
    where: { userId: user.id, ...(scope ? { programRef: scope } : {}) },
    // 先按校系再按時間。四月的學生手上有兩到三個系要面試，同一題他會
    // 為每一個系各練一次而三份答案應該長得完全不一樣——平鋪成一條
    // 時間軸的話，他回頭找不到「台大那一版」，而面試前一晚要看的
    // 正好就是那一版。
    orderBy: [{ programRef: 'asc' }, { createdAt: 'desc' }],
    take: limit,
    select: {
      id: true,
      answerText: true,
      programRef: true,
      feedback: true,
      consistency: true,
      createdAt: true,
      question: { select: { question: true, fieldTag: true, focusPoints: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    question: r.question.question,
    fieldTag: r.question.fieldTag,
    focusPoints: r.question.focusPoints,
    answerText: r.answerText,
    programRef: r.programRef,
    feedback: r.feedback,
    consistency: r.consistency,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * 刪掉一次練習。
 *
 * 這一區有進沒有出：素材有 DELETE，練習紀錄沒有。而練習框裡最可能
 * 出現的東西，是一段他還沒想清楚的話、一個講砸的版本、或是一句他
 * 對自己志向的猶豫——**沒有任何路徑刪得掉**在這種內容上不是不方便，
 * 它會讓他下一次不寫真的那一版，而假的那一版練了沒有用。
 */
export async function deletePractice(user: SessionUser, practiceId: string): Promise<void> {
  assertStudent(user);
  const row = await prisma.interviewPractice.findFirst({
    where: { id: practiceId, userId: user.id },
    select: { id: true },
  });
  if (!row) throw new PortfolioError('NOT_FOUND', '找不到這一次練習。', 404);
  await prisma.interviewPractice.delete({ where: { id: row.id } });
}
