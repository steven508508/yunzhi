/**
 * 學生自己查來的升學參考資料：資料層，以及 AI 老師那一段的編排。
 *
 * # 為什麼檔名不是 admissionRef.ts
 *
 * 因為同一個資料夾裡已經有 `admissionRef.mjs`，而 **tsc 與 webpack 對
 * `@/lib/admissionRef` 的解析順序相反**：TypeScript 先找 `.ts`，Next 的
 * webpack 先找 `.mjs`。兩份實作的症狀非常難查：`npx tsc --noEmit` 全綠、
 * `next build` 只印一行「Attempted import error」然後**照樣 exit 0**，
 * 而頁面在瀏覽器上炸在「xxx is not a function」。完整說明見
 * `lib/abilityDb.ts` 的檔頭——這是第三次踩到，所以沿用同一個命名規則。
 *
 * # 這一層刻意很薄，但它有一段編排邏輯
 *
 * 會算錯的東西全部在兩個 `.mjs`：信任度與過期判定在 `admissionRef.mjs`、
 * 假精確度的閘門在 `adviceGuard.mjs`，兩者都是純函式而且有測試。
 * 這裡做四件事：讀出來、丟給它算、寫回去、擋權限。
 *
 * 唯一例外是 `adviceFor()` 那一段「生成 → 檢查 → 不過就重來」的迴圈。
 * 它必須在這裡，因為它同時要碰 HTTP（AI 服務）與資料庫（用量記錄），
 * 而那兩件事在純函式裡做不到。**判斷本身仍然全部在 `checkAdvice()`。**
 *
 * # 學生自己輸入的資料為什麼不進入任何跨學生的計算
 *
 * `forSelfOnly` 預設 true，而繁星校內賽局模擬（`lib/star.mjs` 的
 * `simulate()`）的唯一百分比來源是教務處匯入的 `AcademicRank`。
 * 這一條在程式碼上的落實方式是：**這個檔案裡沒有任何一支函式把參考
 * 資料餵給 `simulate()`**，而該怎麼餵的那支函式（`starParticipants()`）
 * 在 `admissionRef.mjs` 裡明確地把自填百分比丟到 `ignoredSelfEntered`，
 * 並且有測試斷言其他學生的序位一個字都沒變。
 *
 * 理由不是隱私是正確性：甲同學把自己的百分比打錯成 5%，乙同學看到的
 * 序位就跟著錯，而乙完全不知道——他看到的是一個完全正常的數字。
 *
 * # AI 使用要可揭露，而且用既有的表
 *
 * 規格書 §2.3 與教育部 113 年 12 月 13 日函文要求學生在學習歷程中標註
 * AI 使用。這裡每一次建議都寫一列 `AiUsageLog`（`refType`
 * `AdmissionAdvice`、`refId` 是學生本人），揭露聲明由
 * `aiDisclosure()` 依那些記錄組出來。
 *
 * **`purpose` 用 `OTHER` 而不是一個新的 `ADMISSION_ADVICE`**，因為新增
 * enum 值要改 schema 加遷移，而這一階段不動 schema。代價是成本歸因的
 * 報表上這一項會混在 `OTHER` 裡；`refType` 分得出來，所以查得回來。
 * 真的要分開歸因時再加一個 enum 值，那是一行遷移。
 */
import {
  SOURCE_KINDS,
  adviceBasis,
  buildRefValue,
  describeRefValue,
  refKindOf,
  trustOf,
} from '@/lib/admissionRef.mjs';
import { admissionYearOf } from '@/lib/admission.mjs';
import { admissionStatus, myStarPosition } from '@/lib/admissionDb';
import {
  adviceFacts,
  checkAdvice,
  describeAdviceViolations,
  safeAdvice,
  summarizeAdviceViolations,
} from '@/lib/adviceGuard.mjs';
import { whereToLookFor } from '@/lib/admissionSources.mjs';
import { prisma } from '@/lib/prisma';
import { requireTenant } from '@/lib/tenant';

// ─────────────────────────────────────────────────────────────────
// 型別
// ─────────────────────────────────────────────────────────────────

export type ReferenceInput = {
  year: number;
  channel: string;
  kind: string;
  institutionName: string;
  programName?: string | null;
  starGroup?: number | null;
  /** 依 `kind` 的形狀填。驗證在 `buildRefValue()`。 */
  raw: Record<string, unknown>;
  sourceKind: string;
  sourceRef: string;
  /** 查到的日期。**必填**——理由見 schema 的 AdmissionReference 註解。 */
  lookedUpAt: string;
  staleAfterYear?: number | null;
  note?: string | null;
};

export class ReferenceError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ReferenceError';
    this.status = status;
  }
}

const SOURCE_VALUES = new Set(SOURCE_KINDS.map((s: { value: string }) => s.value));

// ─────────────────────────────────────────────────────────────────
// 讀
// ─────────────────────────────────────────────────────────────────

/**
 * 這位學生輸入的**全部**參考資料，附信任度。
 *
 * # 為什麼不依 `year` 過濾，而 `year` 又是一個必要的參數
 *
 * 因為 `AdmissionReference.year` 是**這一筆資料所屬的學年度**，而學生查
 * 的正是歷年門檻：114、113、112 各一筆。用「今年」去過濾的話，這個清單
 * 永遠是空的——他剛剛輸入了三筆，畫面上一筆都沒有，而系統這一側完全
 * 正常（那三列真的在資料庫裡）。這個錯誤在單元測試裡看不到，因為純函式
 * 那一層根本沒有 where 條件。
 *
 * 傳進來的 `currentYear` 用在另一件事上：**算過期。** 一筆 114 學年度的
 * 門檻在 115 學年度仍然有參考價值（歷年趨勢是繁星唯一可用的東西），
 * 但它必須被標成「這是 114 的，你現在看 115」。所以過期是一個標籤而
 * 不是一個過濾條件。
 *
 * **只回他自己的。** 沒有 `?student=` 這種參數：RLS 擋得住別家補習班，
 * 擋不住隔壁同學，而一筆「我的在校百分比」是同班同學最想看的東西。
 * 輔導老師要看某位學生的資料時走另一條路（還沒做）。
 */
export async function myReferences(userId: string, currentYear: number) {
  const rows = await prisma.admissionReference.findMany({
    where: { userId },
    orderBy: [{ year: 'desc' }, { institutionName: 'asc' }, { createdAt: 'desc' }],
  });

  const now = new Date();
  return rows.map((r) => {
    const meta = refKindOf(r.kind) as { label?: string; unit?: string } | null;
    return {
      id: r.id,
      year: r.year,
      channel: r.channel as string,
      kind: r.kind,
      kindLabel: meta?.label ?? r.kind,
      institutionName: r.institutionName,
      programName: r.programName,
      starGroup: r.starGroup,
      value: r.value as Record<string, unknown>,
      describe: describeRefValue(r.kind, r.value) as string,
      sourceKind: r.sourceKind as string,
      sourceRef: r.sourceRef,
      lookedUpAt: r.lookedUpAt.toISOString(),
      staleAfterYear: r.staleAfterYear,
      forSelfOnly: r.forSelfOnly,
      note: r.note,
      trust: trustOf(
        {
          sourceKind: r.sourceKind,
          year: r.year,
          staleAfterYear: r.staleAfterYear,
          lookedUpAt: r.lookedUpAt,
        },
        { currentYear, now },
      ) as ReturnType<typeof trustOf>,
    };
  });
}

/**
 * 建議要用的完整基礎：他查到的、他自己的百分比、他的志願、缺什麼。
 *
 * **兩個百分比走兩條路**（與 `lib/admissionDb.ts` 的同一個決定）：
 * 教務處匯入的 `AcademicRank` 是模擬用的那一份，學生自己輸入的只用於
 * 他自己的建議。合成一個欄位的話，遲早有人拿自填的那個去講校內序位。
 */
export async function referenceBasis(userId: string, year: number) {
  const [refs, rank, status] = await Promise.all([
    myReferences(userId, year),
    prisma.academicRank.findFirst({
      where: { userId, year },
      select: { percentile: true, semesters: true },
    }),
    admissionStatus(userId, year),
  ]);

  const basis = adviceBasis({
    references: refs,
    officialPercentile: rank?.percentile ?? null,
    wishes: status.wishes,
    year,
  }) as ReturnType<typeof adviceBasis>;

  // 每一個缺口都要帶著「去哪裡查」。只說缺什麼不說去哪裡查，等於把
  // 問題丟回給學生——而他打開這一頁的理由就是不知道去哪裡查。
  const gaps = basis.gaps.map((g: { code: string; text: string; lookFor?: string }) => {
    const guide = g.lookFor ? (whereToLookFor(g.lookFor, year) as { where?: { url?: string | null }[] } | null) : null;
    return { ...g, url: guide?.where?.find((w) => w.url)?.url ?? null };
  });

  return { ...basis, gaps, semesters: rank?.semesters ?? null };
}

// ─────────────────────────────────────────────────────────────────
// 寫
// ─────────────────────────────────────────────────────────────────

/**
 * 新增一筆。
 *
 * # 這一支唯一會拒絕的三件事
 *
 * 來源沒選、查詢日期沒填、以及 `value` 的形狀對不上 `kind`。前兩件是
 * schema 的 NOT NULL，但在這裡先擋一次，因為 Prisma 的錯誤訊息對使用者
 * 沒有意義（「Invalid value for argument sourceKind」）。
 *
 * **不驗證那個數字對不對。** 學生查錯了、抄錯了、或聽同學說的，系統
 * 都收——它沒有辦法驗（那份資料本來就只有官方網站有，而系統不去抓）。
 * 系統能做的是把來源與日期記下來，讓那筆資料自己說明它值多少信任。
 */
export async function addReference(userId: string, input: ReferenceInput) {
  const tenantId = requireTenant();

  const meta = refKindOf(input.kind);
  if (!meta) throw new ReferenceError(`不認得的資料種類「${input.kind}」`);

  if (!SOURCE_VALUES.has(input.sourceKind)) {
    throw new ReferenceError('請選一個來源。「聽同學說的」也是一個可以選的選項。');
  }
  const sourceRef = String(input.sourceRef ?? '').trim();
  if (!sourceRef) {
    throw new ReferenceError(
      '請填「從哪裡查到的」。官方文件填網址或文件名稱，教務處填是哪位老師——' +
        '一個沒有來源的數字，三個月後與一個有來源的長得一模一樣。',
    );
  }
  const lookedUpAt = new Date(input.lookedUpAt);
  if (Number.isNaN(lookedUpAt.getTime())) {
    throw new ReferenceError('請填查到這筆資料的日期。');
  }
  // 未來的日期擋掉。它不是筆誤而已：`stalenessOf()` 會算出負的天數，
  // 於是一筆手指打錯年份的資料永遠是「剛剛才查的」，永遠不會被提醒
  // 該重新確認。
  if (lookedUpAt.getTime() > Date.now() + 86_400_000) {
    throw new ReferenceError('查詢日期在未來。是不是年份打錯了？');
  }

  const built = buildRefValue(input.kind, input.raw) as {
    ok: boolean;
    value: unknown;
    error: string;
  };
  if (!built.ok) throw new ReferenceError(built.error);

  const staleAfterYear = Number.isFinite(input.staleAfterYear as number)
    ? Math.max(input.year, input.staleAfterYear as number)
    : input.year;

  return prisma.admissionReference.create({
    data: {
      tenantId,
      enteredBy: userId,
      userId,
      year: input.year,
      channel: input.channel as never,
      institutionName: input.institutionName,
      programName: input.programName ?? null,
      starGroup: input.starGroup ?? null,
      kind: input.kind,
      value: built.value as never,
      sourceKind: input.sourceKind as never,
      sourceRef,
      lookedUpAt,
      staleAfterYear,
      // **學生自己輸入的一律 true。** 這一行是隔離的落實點：
      // 見檔頭與 schema 的 AdmissionReference 註解決定二。
      forSelfOnly: true,
      note: input.note ?? null,
    },
  });
}

/**
 * 改一筆已經輸入的資料：**數字、來源、查詢日期、備註。**
 *
 * # 為什麼需要這一支
 *
 * 因為在它之前，一筆打錯的資料只能刪掉再輸入一次。而這裡最常見的
 * 打錯法是**小數點**：門檻 1.8% 打成 18%——那是一位頂標學生與一位
 * 前 20% 學生的差別，而它會被 AI 老師拿去跟他自己的百分比比較。
 * 「刪掉再加一次」要重打校名、學年度、來源與日期五個欄位，而其中
 * 四個原本是對的。
 *
 * # 為什麼不能改校名、學年度與資料種類
 *
 * 因為那三個是**這筆資料是關於什麼的**。改掉它們等於把這一列搬到另一
 * 個校系或另一個年度的趨勢裡去，而畫面上看起來只是改了一個欄位——
 * 「近三年」那條規則是逐校系數年份的（`adviceBasis` 的 `targets`），
 * 一次無聲的搬家會讓兩邊的年數同時算錯。
 *
 * 要改那三個就是刪掉重加，而那一次刪除是有意義的：它讓學生看見自己
 * 換掉的是**哪一筆資料**，而不是修正它。
 *
 * **不驗證那個數字對不對**，理由與 `addReference()` 相同。
 *
 * @returns `null` 代表不是他的（或不存在）。
 */
export type ReferencePatch = {
  raw?: Record<string, unknown>;
  sourceKind?: string;
  sourceRef?: string;
  lookedUpAt?: string;
  note?: string | null;
};

export async function updateReference(userId: string, refId: string, patch: ReferencePatch) {
  const mine = await prisma.admissionReference.findFirst({
    where: { id: refId, userId },
    select: { id: true, kind: true },
  });
  if (!mine) return null;

  const data: Record<string, unknown> = {};

  if (patch.raw !== undefined) {
    const built = buildRefValue(mine.kind, patch.raw) as {
      ok: boolean;
      value: unknown;
      error: string;
    };
    if (!built.ok) throw new ReferenceError(built.error);
    data.value = built.value;
  }
  if (patch.sourceKind !== undefined) {
    if (!SOURCE_VALUES.has(patch.sourceKind)) {
      throw new ReferenceError('請選一個來源。「聽同學說的」也是一個可以選的選項。');
    }
    data.sourceKind = patch.sourceKind;
  }
  if (patch.sourceRef !== undefined) {
    const sourceRef = String(patch.sourceRef).trim();
    if (!sourceRef) {
      throw new ReferenceError(
        '請填「從哪裡查到的」。一個沒有來源的數字，三個月後與一個有來源的長得一模一樣。',
      );
    }
    data.sourceRef = sourceRef;
  }
  if (patch.lookedUpAt !== undefined) {
    const lookedUpAt = new Date(patch.lookedUpAt);
    if (Number.isNaN(lookedUpAt.getTime())) throw new ReferenceError('請填查到這筆資料的日期。');
    // 與新增那一支同一條：未來的日期會讓這筆資料永遠是「剛剛才查的」，
    // 永遠不會被提醒該重新確認。
    if (lookedUpAt.getTime() > Date.now() + 86_400_000) {
      throw new ReferenceError('查詢日期在未來。是不是年份打錯了？');
    }
    data.lookedUpAt = lookedUpAt;
  }
  if (patch.note !== undefined) data.note = patch.note;

  if (Object.keys(data).length === 0) return { id: mine.id, changed: false };
  await prisma.admissionReference.update({ where: { id: mine.id }, data });
  return { id: mine.id, changed: true };
}

/** 刪一筆。回 false 代表不是他的（或不存在）——兩者的回應要一樣。 */
export async function deleteReference(userId: string, refId: string) {
  const hit = await prisma.admissionReference.findFirst({
    where: { id: refId, userId },
    select: { id: true },
  });
  if (!hit) return false;
  await prisma.admissionReference.delete({ where: { id: refId } });
  return true;
}

// ─────────────────────────────────────────────────────────────────
// AI 老師
// ─────────────────────────────────────────────────────────────────

const AI_URL = (process.env.AI_SERVICE_URL ?? 'http://ai:8000').replace(/\/+$/, '');

/** 一次建議的逾時。學生在等，所以給得比匯入短得多。 */
const ADVICE_TIMEOUT_MS = 60_000;

/**
 * 最多重新生成幾次。與智慧老師同一個數字。
 *
 * 三次之後退回 `safeAdvice()`——那一段由程式組出來，所以它不可能製造
 * 假的精確度。**退路不是「AI 暫時無法回應」**：對學生來說那等於功能
 * 壞了，而它沒壞，是模型剛剛三次都想給他一個機率。
 */
const MAX_REGENERATE = 3;

type AdviceApiResponse = {
  text: string;
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  prompt_version: string;
};

async function callAdvice(body: unknown): Promise<AdviceApiResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ADVICE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${AI_URL}/v1/admission/advice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    throw new ReferenceError(
      aborted
        ? 'AI 老師想太久了。再送一次試試看——你查到的資料都還在。'
        : '現在連不上 AI 老師。你輸入的資料與下面的整理都還看得到。',
      503,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 400);
    try {
      const j = JSON.parse(text) as { detail?: unknown };
      detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* 回應不是 JSON，用原文的前幾百字 */
    }
    console.error(`[advice] AI 服務回應 ${res.status}：${detail}`);
    throw new ReferenceError('AI 老師現在沒有辦法回答。這通常是設定或額度的問題，請告訴老師。', 503);
  }
  return JSON.parse(text) as AdviceApiResponse;
}

/**
 * 本月的 token 用量。與 `lib/tutor.ts` 同一個做法：真相是
 * `AiUsageLog` 的 aggregate，`AiBudgetCounter` 只是寫給人看的鏡子。
 */
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
 * 預算用完就不再生成。**只擋 AI 那一段**——他查到的資料、信任度標示、
 * 缺口清單與查資料指引全部照常，因為那些不需要模型。
 */
async function assertBudget(tenantId: string) {
  const budget = Number(process.env.AI_MONTHLY_TOKEN_BUDGET ?? 0);
  if (!(budget > 0)) return;
  const used = await monthlyTokens(tenantId);
  if (used >= budget) {
    throw new ReferenceError(
      `這個月的 AI 用量已經到上限（${used.toLocaleString()} / ${budget.toLocaleString()}）。` +
        'AI 老師暫停，但你查到的資料與下面的整理都不受影響。想繼續的話，請告訴老師。',
      429,
    );
  }
}

/**
 * AI 老師看一次他查到的資料。
 *
 * 流程：整理事實 → 生成 → **確定性閘門** → 不過就重來 → 三次都不過就
 * 退回只陳述事實的版本。每一次都寫一列 `AiUsageLog`（揭露用）。
 *
 * # 為什麼建議本身不落地保存
 *
 * 因為它會過期，而過期的建議比沒有建議危險：學生三個月後回來看到一段
 * 寫著「你的 12% 在門檻之上」的文字，而那時他又查到兩年的資料、教務處
 * 也匯入了正式的百分比。要保存就得同時保存輸入快照與重算機制
 * （規格書 §12 的 `SimulationRun` 是為這件事設計的，而這一階段沒有那
 * 張表）。所以現在的作法是：**每次現算**，而 `AiUsageLog` 保存「這次
 * 互動發生過」——那才是揭露需要的東西。
 */
export async function adviceFor(input: {
  userId: string;
  year: number;
  question?: string;
}): Promise<{
  text: string;
  fellBack: boolean;
  blockedDrafts: number;
  blockedReasons: string[];
  promptVersion: string;
  basis: Awaited<ReturnType<typeof referenceBasis>>;
}> {
  const tenantId = requireTenant();
  const { userId, year } = input;

  const basis = await referenceBasis(userId, year);
  const facts = adviceFacts(basis) as ReturnType<typeof adviceFacts>;

  // 校內序位與管道資格一起餵進去。**繁星有兩層競爭，而學生真正卡住的
  // 往往是第一層**（校內誰被推薦）——坊間工具只處理得了第二層。
  // 兩層放在同一段建議裡才是完整的圖。
  const [star, status] = await Promise.all([
    myStarPosition(userId, year),
    admissionStatus(userId, year),
  ]);

  await assertBudget(tenantId);

  const payload = {
    year,
    references: basis.references.map((r) => ({
      kind: r.kind,
      kind_label: r.kindLabel,
      institution_name: r.institutionName,
      program_name: r.programName,
      star_group: r.starGroup,
      year: r.year,
      value_text: r.describe,
      source_label: r.trust.sourceLabel,
      source_ref: r.sourceRef,
      looked_up_at: r.lookedUpAt.slice(0, 10),
      trust_label: r.trust.label,
      stale: r.trust.stale,
    })),
    wishes: status.wishes.map((w) => ({
      channel: w.channel,
      channel_label: w.channel,
      rank: w.rank,
      institution_name: w.institutionName,
      program_name: w.programName,
      star_group: w.starGroup,
      interest_tag: w.interestTag,
    })),
    // **只送序位。** `studentView()` 的輸出裡本來就沒有其他學生的
    // id、姓名、百分比或參與人數（見 lib/star.mjs §3），這裡再挑一次
    // 白名單，所以日後那個函式多回一個欄位也不會被送到模型那邊去。
    star_positions: star.positions.map((p) => ({
      institution_name: p.institutionName,
      star_group: p.starGroup,
      order: p.order,
      is_first: p.isFirst,
      nominated: p.nominated,
      first_round: p.firstRound,
    })),
    blockers: status.eligibility
      .filter((e) => !e.ok)
      .map((e) => `${e.label}：${e.blockers.map((b) => b.text).join(' ')}`),
    gaps: basis.gaps.map((g) => ({ text: g.text, url: g.url })),
    official_percentile: basis.officialPercentile,
    self_percentile: basis.selfPercentile,
    question: String(input.question ?? '').slice(0, 500),
  };

  let accepted: { text: string; model: string; promptVersion: string; latencyMs: number } | null =
    null;
  let blockedDrafts = 0;
  const blockedReasons: string[] = [];
  let tokensIn = 0;
  let tokensOut = 0;

  for (let attempt = 0; attempt <= MAX_REGENERATE; attempt += 1) {
    let out: AdviceApiResponse;
    try {
      out = await callAdvice({ ...payload, retry: attempt });
    } catch (e) {
      // 已經重生成過而上游掛了：退回只陳述事實的版本，不要把整個請求
      // 打成錯誤。第一次就掛掉才往上拋（那是「AI 服務沒起來」，
      // 學生要看到的是那句話而不是一段看起來像結論的整理）。
      if (attempt === 0) throw e;
      break;
    }
    tokensIn += out.input_tokens;
    tokensOut += out.output_tokens;

    const verdict = checkAdvice(out.text, facts) as ReturnType<typeof checkAdvice>;
    if (verdict.ok) {
      accepted = {
        text: out.text,
        model: out.model,
        promptVersion: out.prompt_version,
        latencyMs: out.latency_ms,
      };
      break;
    }

    // 兩套說法，兩個去處。**細節不送給學生**：`detail` 會把被擋掉的
    // 那個數字引用出來（「『68%』對不回任何一筆資料」），而那正是這一層
    // 在防的東西——用一句「這個數字被擋掉了」把那個數字說給他聽，
    // 他會記住 68%，而 68% 從來就不存在。
    console.warn(
      `[advice] 第 ${attempt + 1} 次生成被擋：${describeAdviceViolations(verdict.violations)}`,
    );
    // **一次生成折成一個字串**，不是一個違規一個字串。畫面上寫的是
    // 「被擋下來的理由（N 次）」，而 N 必須等於重新生成的次數——一段
    // 同時犯五條規則的輸出算一次，不是五次。
    blockedReasons.push((summarizeAdviceViolations(verdict.violations) as string[]).join('；'));

    // 只剩體例問題（太長、沒交代資料基礎）而且已經重來過一次，就收下。
    // **假精確度永遠不收。**
    if (!verdict.fabricated && attempt >= 1) {
      accepted = {
        text: out.text,
        model: out.model,
        promptVersion: out.prompt_version,
        latencyMs: out.latency_ms,
      };
      break;
    }
    blockedDrafts += 1;
  }

  const fellBack = accepted === null;
  const reply = accepted ?? {
    text: safeAdvice(basis) as string,
    model: '',
    promptVersion: 'fallback',
    latencyMs: 0,
  };

  await recordAdviceUsage({
    tenantId,
    userId,
    tokensIn,
    tokensOut,
    model: reply.model,
    promptVersion: reply.promptVersion,
    latencyMs: reply.latencyMs,
    succeeded: !fellBack,
    retryCount: blockedDrafts,
  });

  return {
    text: reply.text,
    fellBack,
    blockedDrafts,
    blockedReasons,
    promptVersion: reply.promptVersion,
    basis,
  };
}

/**
 * 一列用量記錄。**這一列同時是成本歸因與 AI 使用揭露的證據。**
 *
 * 退回罐頭（`fellBack`）時也要寫：那一次仍然呼叫過模型、仍然花了錢，
 * 而且**仍然是一次 AI 互動**——揭露聲明要算得進去。不寫的話，一位
 * 三次都被擋下來的學生會在聲明裡看到「未使用 AI」，那是不實陳述。
 */
async function recordAdviceUsage(u: {
  tenantId: string;
  userId: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
  promptVersion: string;
  latencyMs: number;
  succeeded: boolean;
  retryCount: number;
}) {
  const ym = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
  try {
    await prisma.$transaction([
      prisma.aiUsageLog.create({
        data: {
          tenantId: u.tenantId,
          // OTHER 是這一階段的權宜之計，理由見檔頭。`refType` 分得出來。
          purpose: 'OTHER',
          // 建議不是推導。用 MID：這一段要產出的是 300 字的說明，
          // 而 HIGH 的價格是 MID 的五倍。
          tier: 'MID',
          provider: process.env.AI_PROVIDER ?? 'unknown',
          model: u.model || 'unknown',
          baseUrl: process.env.AI_BASE_URL ?? null,
          inputTokens: u.tokensIn,
          outputTokens: u.tokensOut,
          latencyMs: u.latencyMs || null,
          succeeded: u.succeeded,
          errorCode: u.succeeded ? null : 'ADVICE_GUARD_FALLBACK',
          retryCount: u.retryCount,
          refType: 'AdmissionAdvice',
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
    // 記帳失敗不該把已經產生的建議吞掉。真相在 AiUsageLog，那一筆若也
    // 失敗了，下一次的 aggregate 會少算這一次——可以接受的誤差。
    console.error('[advice] 用量記錄失敗', e);
  }
}

// ─────────────────────────────────────────────────────────────────
// AI 使用揭露
// ─────────────────────────────────────────────────────────────────

/**
 * 這位學生用過幾次 AI 老師，以及一份可以貼進學習歷程的揭露聲明草稿。
 *
 * # 為什麼聲明是程式組的而不是模型生成的
 *
 * 規格書 §13 有一段很具體的警告：撰寫回饋的後處理規則會擋掉揭露聲明
 * 本身（聲明就是一段五十幾字的連續第一人稱敘述），所以那裡需要一組
 * 白名單。**這裡不需要那個複雜度**——這一段互動的性質是固定的
 * （「AI 看了我自己查來的升學資料並給了說明」），所以聲明由程式依實際
 * 記錄組出來就夠了，而且它因此不可能被模型寫成一句不實陳述。
 *
 * 內容仍然**依實際記錄變化而不是固定樣板**（§9.6 的驗收準則）：
 * 沒有用過就這樣寫，用過幾次就寫幾次，日期是真的。
 *
 * 學生可以自己改這段文字（那是他要負責的文件），而原始記錄留在
 * `AiUsageLog` 裡——這也是 §9.2 的「記錄與產出分開」。
 */
export async function aiDisclosure(userId: string) {
  const rows = await prisma.aiUsageLog.findMany({
    where: { refType: 'AdmissionAdvice', refId: userId },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true, model: true, succeeded: true, promptVersion: true },
  });

  const day = (d: Date) => d.toISOString().slice(0, 10);
  if (rows.length === 0) {
    return {
      count: 0,
      first: null as string | null,
      last: null as string | null,
      statement:
        '本人在升學資料的整理與判讀過程中未使用 AI 輔助工具。' +
        '所引用的招生資料均由本人自行至官方網站與學校查閱，來源與查閱日期已逐筆記錄。',
    };
  }

  return {
    count: rows.length,
    first: day(rows[0].createdAt),
    last: day(rows[rows.length - 1].createdAt),
    statement:
      '本人自行至官方網站與學校教務處查閱招生資料，' +
      `並逐筆記錄來源與查閱日期。其中 ${rows.length} 次由 AI 輔助工具就本人查得的資料` +
      `提供說明與資料缺口提醒（${day(rows[0].createdAt)} 至 ${day(rows[rows.length - 1].createdAt)}）。` +
      'AI 未提供任何錄取機率或落點預測，資料的判讀與志願的決定由本人完成。',
  };
}

/** 現在是民國幾學年度。轉出去，讓頁面不必再 import 一個模組。 */
export { admissionYearOf };
