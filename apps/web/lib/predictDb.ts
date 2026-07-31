/**
 * 級分預測（N1）與個申落點（N2）的資料層。
 *
 * # 為什麼檔名不是 predict.ts
 *
 * 因為同一個資料夾裡已經有 `predict.mjs`，而 **tsc 與 webpack 對
 * `@/lib/predict` 的解析順序相反**：TypeScript 先找 `.ts`，Next 的
 * webpack 先找 `.mjs`。兩份實作的症狀非常難查：`npx tsc --noEmit` 全綠、
 * `next build` 只印一行「Attempted import error」然後**照樣 exit 0**，
 * 而頁面在瀏覽器上炸在「xxx is not a function」。完整說明見
 * `lib/abilityDb.ts` 的檔頭——這是第四次踩到，所以沿用同一個命名規則。
 *
 * # 兩個模組合在一個資料層裡，這是刻意的
 *
 * 因為落點模擬的輸入**就是**級分預測的輸出（規格書 §6.1 的最後一句：
 * 「下游的落點模擬直接使用這個分布而非點估計」）。拆成兩個檔案的話，
 * 中間那個「把預測折成邊際分布」的動作會有兩份實作，而它們遲早會
 * 分岐——分岐的症狀是畫面上的區間與落點的機率互相矛盾，而兩個數字
 * 各自看起來都正常。
 *
 * 會算錯的東西全部在兩個 `.mjs`（`predict.mjs`、`placement.mjs`，
 * 純函式、有測試）。這裡只做四件事：讀出來、丟給它算、寫回去、擋權限。
 * **新的規則要加在 .mjs 而不是這裡**——這裡沒有單元測試保護，因為它
 * 需要資料庫。
 *
 * # 三個寫入決定，每一個都會影響校準
 *
 * **一、`thin` 的預測不寫進 `GradePrediction`。** 資料不足時
 * `predictGrade()` 回的 `interval` 是 null，寫不進那張表（`intervalLow`
 * 是 NOT NULL）。要寫就得**編一個區間**，而那個區間會進入校準曲線，
 * 讓曲線看起來很健康而樣本門檻其實訂錯了——也就是說，補一個假區間
 * 進去會破壞掉唯一能檢查這件事的那個機制。所以不寫，並在回傳裡數出
 * 有幾科被跳過。
 *
 * **二、預測不在讀取時寫入。** 讀一頁不該產生寫入（預載、爬蟲、
 * 瀏覽器的預先連線都會打到頁面）。而且每次讀都寫的話，`GradePrediction`
 * 會塞滿同一個預測的幾百份複本，校準曲線的每一筆權重就變成「這位學生
 * 重整了幾次頁面」。所以顯示用的是**現算**，落地是一個明確的動作。
 *
 * **三、同一個預測不重複落地。** 上一筆的區間、信心與樣本數都沒變時
 * 就不再寫一列。這讓那張表變成「這位學生的預測**變化史**」而不是
 * 一份操作日誌，而那才是「上週看到的怎麼跟現在不一樣」需要的東西。
 *
 * # 實際成績的回填不是一支獨立的功能
 *
 * 學測成績公布後，學生（或老師）會把它當成一筆 `source = OFFICIAL_GSAT`
 * 的級分記錄輸入進來——那本來就是他會做的事。所以回填掛在
 * `addGradeRecord()` 上：輸入那一筆的同時，同一科同一學年度的每一份
 * 預測都補上 `actualGrade`。
 *
 * 做成一支「回填實際成績」的獨立按鈕的話，它永遠不會被按——而校準
 * 曲線會永遠是空的，然後沒有人知道這套預測準不準。
 */
import {
  DEFAULT_CONFIDENCE,
  calibrationCurve,
  gsatDateOf,
  gsatPassed,
  marginalsFor,
  predictAll,
  upcomingGsatYear,
} from '@/lib/predict.mjs';
import {
  DEFAULT_DRAWS,
  GSAT_SUBJECT_CODES,
  SUBJECT_LABELS,
  buildWishSpecs,
  estimateCorrelation,
  simulatePlacement,
} from '@/lib/placement.mjs';
import { admissionYearOf } from '@/lib/admission.mjs';
import { prisma } from '@/lib/prisma';
import { requireTenant } from '@/lib/tenant';
import type { SessionUser } from '@/lib/auth';

export { admissionYearOf };

/**
 * **級分預測與落點要用哪一個學年度，是兩個不同的問題。**
 *
 *   · 落點模擬吃的是**志願**，而志願屬於學年度（4 月填的個申志願是
 *     114 學年度的）。所以那一邊照樣用 `admissionYearOf()`。
 *   · 級分預測的目標是**下一場還沒考的學測**。1/20 到 7/31 之間這兩者
 *     差一年，而那半年裡拿學年度當目標的話，預測是對著一場已經考完的
 *     考試在算（見 `lib/predict.mjs` 的 `upcomingGsatYear`）。
 *
 * 這一支把兩個都算出來給頁面用，順便回答「那一場考完了沒有」。
 */
export function predictTargetOf(now = new Date()) {
  const target = upcomingGsatYear(now) as number;
  const school = admissionYearOf(now) as number;
  return {
    /** 預測的目標學年度：下一場還沒考的學測。 */
    targetYear: target,
    /** 現在的學年度。志願與參考資料用這一個。 */
    schoolYear: school,
    /** 學年度那一場已經考完了（每年 1/20 至 7/31 都是 true）。 */
    schoolYearExamPassed: gsatPassed(school, now) as boolean,
    examDate: (gsatDateOf(target) as Date | null)?.toISOString() ?? null,
    schoolYearExamDate: (gsatDateOf(school) as Date | null)?.toISOString() ?? null,
  };
}

/** 成績記錄的三種來源。與遷移裡的 CHECK 約束一字不差。 */
export const GRADE_SOURCES = [
  {
    value: 'EXTERNAL_MOCK',
    label: '外部模考（南模、全模…）',
    hint: '到考人數是全國幾萬人，級距算得出來也穩定。這一類的預測最可靠。',
  },
  {
    value: 'INTERNAL_MOCK',
    label: '校內模考',
    hint:
      '校內人數不足時**級距本身就不可靠**（級距是前 1% 考生的平均原始分除以 15，' +
      '幾十人的模考前 1% 只有一個人），所以這一類會讓區間變寬。',
  },
  {
    value: 'OFFICIAL_GSAT',
    label: '真正的學測',
    hint:
      '成績單上的正式級分。輸入這一筆的同時，系統會把同一科的歷次預測補上實際成績——' +
      '**校準曲線靠它**，而一個不追蹤自己準確度的預測系統只是在製造好看的數字。',
  },
] as const;

const SOURCE_VALUES = new Set(GRADE_SOURCES.map((s) => s.value as string));

export class PredictError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'PredictError';
    this.status = status;
  }
}

// ─────────────────────────────────────────────────────────────────
// 級分記錄
// ─────────────────────────────────────────────────────────────────

export type GradeRecordInput = {
  subjectCode: string;
  examName: string;
  examDate: string;
  grade: number;
  percentile?: number | null;
  source: string;
  note?: string | null;
};

/**
 * 這位學生的全部級分記錄。**不依學年度過濾。**
 *
 * 理由與 `admissionRefDb.myReferences()` 相同但更強：預測要看的是
 * **歷次**成績的趨勢，而那條趨勢跨學年度（高二下的模考也算）。用「今年」
 * 去濾的話，八月之後整條趨勢會少掉一半，而畫面上只是一個變寬的區間。
 */
export async function myGradeRecords(userId: string) {
  const rows = await prisma.subjectGradeRecord.findMany({
    where: { userId },
    orderBy: [{ examDate: 'asc' }, { subjectCode: 'asc' }],
  });
  return rows.map((r) => ({
    id: r.id,
    subjectCode: r.subjectCode,
    subjectLabel: (SUBJECT_LABELS as Record<string, string>)[r.subjectCode] ?? r.subjectCode,
    examName: r.examName,
    examDate: r.examDate.toISOString(),
    grade: r.grade,
    percentile: r.percentile,
    source: r.source,
    sourceLabel: GRADE_SOURCES.find((s) => s.value === r.source)?.label ?? r.source,
    enteredBy: r.enteredBy,
    note: r.note,
  }));
}

/**
 * 加一筆級分。
 *
 * 級分的範圍在資料庫有 CHECK（0 至 15），但這裡先擋一次——Prisma 對
 * CHECK 違反給的訊息是一段 SQL 錯誤，而使用者需要知道的是
 * 「你填的 78 看起來是百分制的分數，這一欄要填級分」。
 */
export async function addGradeRecord(
  userId: string,
  input: GradeRecordInput,
  actor: SessionUser,
): Promise<{ id: string; backfilled: number; afterExam: number }> {
  const tenantId = requireTenant();

  const subjectCode = String(input.subjectCode ?? '').trim();
  if (!subjectCode) throw new PredictError('請選一個科目。');
  if (!SOURCE_VALUES.has(input.source)) {
    throw new PredictError('請選這個級分是哪一種考試的（外部模考、校內模考、或真正的學測）。');
  }
  const examName = String(input.examName ?? '').trim();
  if (!examName) {
    throw new PredictError(
      '請填這次考試的名稱（例如「115 全模一」「校內第二次模考」）。' +
        '同一科同一個名稱只能有一筆，所以名稱也是它的身分。',
    );
  }
  const examDate = new Date(input.examDate);
  if (Number.isNaN(examDate.getTime())) throw new PredictError('請填考試日期。');
  if (examDate.getTime() > Date.now() + 86_400_000) {
    throw new PredictError('考試日期在未來。是不是年份打錯了？');
  }

  const grade = Number(input.grade);
  if (!Number.isInteger(grade) || grade < 0 || grade > 15) {
    throw new PredictError(
      `級分要是 0 到 15 的整數，「${input.grade}」不在範圍內。` +
        '這一欄填的是**級分**不是分數——填成百分制（例如 78）的話，' +
        '整條趨勢與所有下游的落點計算都會失去意義，而畫面上只是一個偏高的區間。',
    );
  }
  const percentile =
    input.percentile === null || input.percentile === undefined || input.percentile === ('' as never)
      ? null
      : Number(input.percentile);
  if (percentile !== null && (!Number.isFinite(percentile) || percentile < 0 || percentile > 100)) {
    throw new PredictError('百分位要在 0 到 100 之間（成績單上有給就填，沒有就空著）。');
  }

  const dup = await prisma.subjectGradeRecord.findFirst({
    where: { userId, subjectCode, examName },
    select: { id: true },
  });
  if (dup) {
    throw new PredictError(
      `「${examName}」這一科的級分已經輸入過了。要改的話先把舊的那一筆刪掉——` +
        '同一場考試同一科有兩個級分的話，趨勢與波動都會算錯。',
    );
  }

  const row = await prisma.subjectGradeRecord.create({
    data: {
      tenantId,
      userId,
      subjectCode,
      examName,
      examDate,
      grade,
      percentile,
      source: input.source,
      enteredBy: actor.id,
      note: input.note ?? null,
    },
  });

  const filled =
    input.source === 'OFFICIAL_GSAT'
      ? await backfillActual(userId, subjectCode, examDate, grade)
      : { backfilled: 0, afterExam: 0 };

  return { id: row.id, ...filled };
}

/**
 * 把實際的學測級分補進歷次預測。**校準曲線唯一的資料來源。**
 *
 * 學年度用 `admissionYearOf(examDate)` 推：學測在 1 月，而學年度自 8 月
 * 起算，所以民國 116 年 1 月的學測屬於 115 學年度——這正是
 * `admissionYearOf` 已經在做的事，不必再寫一份。差一年的後果是
 * 回填掛到隔一個學年度的預測上，於是校準曲線永遠是空的。
 *
 * # 只回填**考試之前**做的預測
 *
 * 這一條不是潔癖，它決定校準曲線是不是一份假報告。
 *
 * 學生 2 月輸入正式級分（回填當時已存在的那幾份預測，正確），之後他
 * 回到預測頁按「把現在的預測存一份」——**那一次的預測把正式成績當成
 * 輸入**（`OFFICIAL_GSAT` 的難度與級距誤差都是 0，而它是最近的一筆），
 * 區間會緊緊包住實際級分。接著他照系統自己的指示刪掉舊記錄再輸入一次
 * （`addGradeRecord` 的重複訊息就是這樣寫的），回填再跑一次，那份
 * **知道答案的預測**也被填上 `actualGrade`：穩穩命中、信心 0.99，
 * 進了校準曲線。
 *
 * 同一個檔案很小心地不讓 `thin` 的預測進表（怕曲線看起來太健康），
 * 卻讓一個知道答案的預測進得去——那比 thin 更糟，因為它必然命中。
 *
 * 界線用 `predictedAt < examDate`（考試那天的零時）而不是「今天」：
 * 我們要問的是「這份預測做的時候，這場考試考完了沒有」，而那個時點
 * 是考試日，不是回填日。
 */
async function backfillActual(
  userId: string,
  subjectCode: string,
  examDate: Date,
  grade: number,
): Promise<{ backfilled: number; afterExam: number }> {
  const targetYear = admissionYearOf(examDate) as number;
  const where = { userId, subjectCode, targetYear };

  const [res, total] = await Promise.all([
    prisma.gradePrediction.updateMany({
      where: { ...where, predictedAt: { lt: examDate } },
      data: { actualGrade: grade },
    }),
    prisma.gradePrediction.count({ where }),
  ]);
  // 事後才存下來的那幾份要數出來。靜靜跳過的話，學生會問「我明明存了
  // 五份，怎麼只有三份對到答案」，而那時沒有人答得出來。
  //
  // 用相減而不是再查一次 `predictedAt >= examDate`：兩個條件寫成兩份
  // 就多一次它們對不起來的機會（漏掉邊界那一份的話，那一份會在兩邊
  // 都不出現），而這裡的兩個集合本來就是互補的。
  return { backfilled: res.count, afterExam: Math.max(0, total - res.count) };
}

/** 刪一筆。回 false 代表不是他的（或不存在）——兩者的回應要一樣。 */
export async function deleteGradeRecord(userId: string, recordId: string) {
  const hit = await prisma.subjectGradeRecord.findFirst({
    where: { id: recordId, userId },
    select: { id: true },
  });
  if (!hit) return false;
  await prisma.subjectGradeRecord.delete({ where: { id: recordId } });
  return true;
}

// ─────────────────────────────────────────────────────────────────
// 預測
// ─────────────────────────────────────────────────────────────────

type Prediction = {
  subjectCode: string;
  available: boolean;
  thin: boolean;
  reason: string;
  interval: { low: number; high: number; confidence: number; widened: boolean } | null;
  distribution: { grade: number; p: number }[] | null;
  notes: string[];
  basis: Record<string, unknown>;
};

/**
 * 現算這位學生的六科預測。**不寫入。**
 *
 * @param confidence 目標信心水準。畫面上讓學生切 60/70/80——**這不是
 *   讓他把區間調到好看**，而是讓他看到「同一份資料在不同的信心下區間
 *   差多少」。那個對比比任何一句說明都能講清楚不確定性是什麼。
 */
export async function predictionsFor(
  userId: string,
  year: number,
  confidence = DEFAULT_CONFIDENCE,
) {
  const records = await myGradeRecords(userId);
  const codes = [...new Set(records.map((r) => r.subjectCode))].sort();

  const predictions = predictAll({
    records: records.map((r) => ({
      subjectCode: r.subjectCode,
      examName: r.examName,
      examDate: r.examDate,
      grade: r.grade,
      source: r.source,
    })),
    subjectCodes: codes,
    targetYear: year,
    confidence,
  }) as Prediction[];

  const examDate = gsatDateOf(year) as Date | null;

  return {
    year,
    confidence,
    examDate: examDate ? examDate.toISOString() : null,
    records,
    predictions: predictions.map(studentView),
    /** 六科裡完全沒有記錄的。畫面上要看得出來，而不是那一科靜靜不見。 */
    withoutRecords: (GSAT_SUBJECT_CODES as readonly string[]).filter((c) => !codes.includes(c)),
  };
}

/**
 * 學生看得到的投影。
 *
 * **`basis.center` 與 `basis.weightedMean` 一定要濾掉。** 它們是單一
 * 級分數字，而規格書 §6.3 的驗收準則寫的是「介面上不存在任何呈現單一
 * 級分數字的路徑」。留在 payload 裡的話，遲早有人為了畫面方便把它印
 * 出來——那時整條原則就沒了，而畫面上看起來只是多了一個很有用的數字。
 *
 * 濾在這一層而不是靠頁面記得不要印，是因為這一層有 e2e 測試釘著。
 */
function studentView(p: Prediction) {
  const b = p.basis as {
    records?: number;
    nEff?: number;
    monthsToExam?: number;
    monthsAhead?: number;
    examPassed?: boolean;
    sdDown?: number;
    sdUp?: number;
    variance?: Record<string, number>;
    sources?: { source: string; label: string; share: number; count: number }[];
    exams?: { examName: string; examDate: string; grade: number; source: string | null }[];
    rejected?: unknown[];
  };
  return {
    subjectCode: p.subjectCode,
    subjectLabel: (SUBJECT_LABELS as Record<string, string>)[p.subjectCode] ?? p.subjectCode,
    available: p.available,
    thin: p.thin,
    reason: p.reason,
    interval: p.interval,
    distribution: p.distribution,
    notes: p.notes,
    /** 資料基礎。**沒有任何單一級分的點估計。** */
    basis: {
      records: b.records ?? 0,
      nEff: b.nEff ?? 0,
      monthsToExam: b.monthsToExam ?? null,
      /**
       * 真正進到公式裡的剩餘時間（夾成非負）。**畫面要顯示這一個。**
       * 顯示帶號的那一個然後在頁面上 `Math.max(0, …)`，等於把「這場
       * 考試已經考完了」偽裝成「距學測約 0 個月」。
       */
      monthsAhead: b.monthsAhead ?? null,
      examPassed: b.examPassed === true,
      /** 四個不確定性來源各自的份量。畫面上畫成一條堆疊的線。 */
      variance: b.variance ?? null,
      spread: b.sdDown ?? null,
      spreadUp: b.sdUp ?? null,
      sources: b.sources ?? [],
      exams: b.exams ?? [],
      rejected: b.rejected ?? [],
    },
  };
}

/**
 * 把現在的預測落地一份，供日後校準。
 *
 * `thin` 的科目**不寫**（理由見檔頭決定一），而跳過的科目要回報——
 * 靜靜跳過的症狀是老師以為全班都有預測，而其中幾位一筆都沒有。
 */
export async function savePredictions(userId: string, year: number, confidence = DEFAULT_CONFIDENCE) {
  const tenantId = requireTenant();
  const { predictions } = await predictionsFor(userId, year, confidence);

  let saved = 0;
  let unchanged = 0;
  const skipped: { subjectCode: string; reason: string }[] = [];

  for (const p of predictions) {
    if (!p.interval || p.thin) {
      skipped.push({ subjectCode: p.subjectCode, reason: p.reason });
      continue;
    }

    // 同一個預測不重複落地（檔頭決定三）。比對的是**學生看得到的那三個
    // 數字加樣本數**：區間變了、信心變了、或多考了一次，才算一次新的預測。
    const last = await prisma.gradePrediction.findFirst({
      where: { userId, subjectCode: p.subjectCode, targetYear: year },
      orderBy: { predictedAt: 'desc' },
      select: {
        intervalLow: true,
        intervalHigh: true,
        confidence: true,
        basis: true,
      },
    });
    const lastRecords = (last?.basis as { records?: number } | null)?.records ?? -1;
    if (
      last &&
      last.intervalLow === p.interval.low &&
      last.intervalHigh === p.interval.high &&
      Math.abs(last.confidence - p.interval.confidence) < 1e-9 &&
      lastRecords === p.basis.records
    ) {
      unchanged += 1;
      continue;
    }

    await prisma.gradePrediction.create({
      data: {
        tenantId,
        userId,
        subjectCode: p.subjectCode,
        targetYear: year,
        intervalLow: p.interval.low,
        intervalHigh: p.interval.high,
        confidence: p.interval.confidence,
        distribution: p.distribution as never,
        basis: {
          records: p.basis.records,
          nEff: p.basis.nEff,
          monthsToExam: p.basis.monthsToExam,
          variance: p.basis.variance,
          spread: p.basis.spread,
          spreadUp: p.basis.spreadUp,
          sources: p.basis.sources,
          exams: p.basis.exams,
        } as never,
        thin: false,
      },
    });
    saved += 1;
  }

  return { saved, unchanged, skipped };
}

/**
 * 這位學生落地過的預測（最新在前）。畫面上是一條「預測怎麼變的」時間軸。
 *
 * `year` 收一個或一組學年度。**要收得下一組**，因為 1 月到 7 月之間
 * 學生看的是「下一場」的預測，而他上一場的那幾份還在等實際成績——
 * 只查一年的話，那幾份在畫面上消失，於是「去輸入正式級分」這個動作
 * 沒有任何地方提醒得了他。
 */
export async function myPredictionHistory(userId: string, year: number | number[]) {
  const years = (Array.isArray(year) ? year : [year]).filter((y) => Number.isFinite(y));
  const rows = await prisma.gradePrediction.findMany({
    where: { userId, targetYear: { in: years } },
    orderBy: { predictedAt: 'desc' },
    select: {
      id: true,
      subjectCode: true,
      targetYear: true,
      intervalLow: true,
      intervalHigh: true,
      confidence: true,
      actualGrade: true,
      predictedAt: true,
      basis: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    subjectCode: r.subjectCode,
    targetYear: r.targetYear,
    subjectLabel: (SUBJECT_LABELS as Record<string, string>)[r.subjectCode] ?? r.subjectCode,
    intervalLow: r.intervalLow,
    intervalHigh: r.intervalHigh,
    confidence: r.confidence,
    actualGrade: r.actualGrade,
    predictedAt: r.predictedAt.toISOString(),
    records: (r.basis as { records?: number } | null)?.records ?? null,
    /** 命中了嗎。實際成績還沒回填時是 null——**不是 false**。 */
    hit: r.actualGrade === null ? null : r.actualGrade >= r.intervalLow && r.actualGrade <= r.intervalHigh,
  }));
}

// ─────────────────────────────────────────────────────────────────
// 校準（規格書 §6.2）
// ─────────────────────────────────────────────────────────────────

/**
 * 誰看得到校準曲線。
 *
 * 這一份是**機構自己的品質報告**，不是學生的東西。學生看到「你們的
 * 70% 區間其實只準 45%」的正確反應是不再相信任何一個區間，而那個判斷
 * 需要的脈絡（樣本數、哪一屆、哪一科）他沒有。老師與管理員要看得到，
 * 因為他們是決定「這個功能還要不要開著」的人。
 *
 * 學科召集人也在裡面：偏離往往是某一科的問題（例如全部只有校內模考），
 * 而那是他們處理的事。
 */
const CALIBRATION_ROLES = new Set(['TEACHER', 'SUBJECT_LEAD', 'SCHOOL_ADMIN', 'SYS_ADMIN']);

export function canSeeCalibration(user: SessionUser): boolean {
  return CALIBRATION_ROLES.has(user.systemRole);
}

/**
 * 全機構的校準報告。
 *
 * @param year 民國學年度。`null` 代表全部年度一起看——**第一年一定要
 *   這樣看**，因為單一學年度的樣本量還不足以下結論。
 */
export async function calibrationReport(year: number | null = null) {
  const rows = await prisma.gradePrediction.findMany({
    where: year === null ? {} : { targetYear: year },
    select: {
      subjectCode: true,
      targetYear: true,
      intervalLow: true,
      intervalHigh: true,
      confidence: true,
      actualGrade: true,
    },
  });

  const overall = calibrationCurve(rows) as ReturnType<typeof calibrationCurve>;

  // 逐科也算一份。偏離往往集中在某一科（例如那一科全班只有校內模考），
  // 而整體的曲線會把它平掉——平掉之後沒有人知道該修哪裡。
  const codes = [...new Set(rows.map((r) => r.subjectCode))].sort();
  const bySubject = codes.map((code) => {
    const mine = rows.filter((r) => r.subjectCode === code);
    return {
      subjectCode: code,
      subjectLabel: (SUBJECT_LABELS as Record<string, string>)[code] ?? code,
      curve: calibrationCurve(mine) as ReturnType<typeof calibrationCurve>,
    };
  });

  const years = [...new Set(rows.map((r) => r.targetYear))].sort((a, b) => b - a);

  return { year, years, overall, bySubject, total: rows.length };
}

// ─────────────────────────────────────────────────────────────────
// 落點模擬（N2）
// ─────────────────────────────────────────────────────────────────

/**
 * 跑一次落點模擬並落地。
 *
 * # 為什麼每一次都存
 *
 * 因為學生會問「上週看到的是 60%，現在怎麼變 45%」。沒有輸入快照的話，
 * 沒有人回答得出是資料更新了、他的成績變了、還是程式改了。
 * 快照裡有種子，所以任何一次舊的模擬都可以被重跑出一模一樣的數字。
 *
 * # `dataAsOf` 取的是**最舊**的那一筆查詢日期
 *
 * schema 註解寫的就是這件事。取最新的話，一份「兩年前查的 112 門檻 ＋
 * 昨天查的 114 門檻」會顯示成「昨天更新」，而那個結論裡有一半是兩年前
 * 的東西。往舊的方向倒才是誠實的。
 */
export async function runPlacement(
  userId: string,
  year: number,
  { draws = DEFAULT_DRAWS, confidence = DEFAULT_CONFIDENCE }: { draws?: number; confidence?: number } = {},
) {
  const tenantId = requireTenant();

  const [records, wishes, references] = await Promise.all([
    myGradeRecords(userId),
    prisma.wish.findMany({
      where: { userId, year, channel: 'APPLY' },
      orderBy: { rank: 'asc' },
      select: { id: true, rank: true, channel: true, institutionName: true, programName: true },
    }),
    prisma.admissionReference.findMany({
      where: { userId, kind: { in: ['SIEVE_THRESHOLD', 'QUALIFY'] } },
      orderBy: { year: 'desc' },
      select: {
        id: true,
        kind: true,
        year: true,
        institutionName: true,
        programName: true,
        value: true,
        sourceKind: true,
        lookedUpAt: true,
        staleAfterYear: true,
      },
    }),
  ]);

  const now = new Date();
  const plain = records.map((r) => ({
    subjectCode: r.subjectCode,
    examName: r.examName,
    examDate: r.examDate,
    grade: r.grade,
    source: r.source,
  }));

  const predictions = predictAll({
    records: plain,
    subjectCodes: [...new Set(records.map((r) => r.subjectCode))].sort(),
    targetYear: year,
    confidence,
  }) as Prediction[];
  const marginals = marginalsFor(predictions) as Record<string, { grade: number; p: number }[]>;

  const correlation = estimateCorrelation({
    records: plain,
    subjectCodes: Object.keys(marginals),
  }) as {
    loadings: Record<string, number>;
    source: string;
    matrix: unknown;
    pairs: unknown;
    note: string;
  };

  const { specs, unmatched } = buildWishSpecs({
    wishes,
    references: references.map((r) => ({
      kind: r.kind,
      year: r.year,
      institutionName: r.institutionName,
      programName: r.programName,
      value: r.value as Record<string, unknown>,
      sourceKind: r.sourceKind as string,
      lookedUpAt: r.lookedUpAt,
      staleAfterYear: r.staleAfterYear,
    })),
    year,
    now,
    correlationSource: correlation.source,
  }) as { specs: Record<string, unknown>[]; unmatched: { institutionName: string; year: number }[] };

  // 用到的門檻資料裡**最舊**的那一筆查詢日期。見上面的註解。
  const usedRefs = references.filter((r) => r.kind === 'SIEVE_THRESHOLD');
  const dataAsOf =
    usedRefs.length > 0
      ? new Date(Math.min(...usedRefs.map((r) => r.lookedUpAt.getTime())))
      : now;

  const result = simulatePlacement({
    marginals,
    specs,
    correlation,
    draws,
    year,
    now,
    dataAsOf,
  }) as Record<string, unknown> & { seed: number; draws: number };

  /**
   * 輸入快照。**含級分分布、門檻資料的每一筆來源、志願清單與種子。**
   *
   * 存分布本身而不是「哪幾筆成績記錄」，是因為預測的公式會改（校準之後
   * 一定會調），而重現一次舊的模擬要的是**當時的分布**而不是當時的原始
   * 成績跑過新公式的結果。後者算出來的是另一個數字，而那個數字回答不了
   * 學生的問題。
   */
  const input = {
    seed: result.seed,
    draws: result.draws,
    confidence,
    marginals,
    correlation: {
      source: correlation.source,
      loadings: correlation.loadings,
      matrix: correlation.matrix,
      pairs: correlation.pairs,
    },
    wishes,
    thresholds: references.map((r) => ({
      id: r.id,
      kind: r.kind,
      year: r.year,
      institutionName: r.institutionName,
      programName: r.programName,
      value: r.value,
      sourceKind: r.sourceKind,
      lookedUpAt: r.lookedUpAt.toISOString(),
    })),
    unmatched: unmatched.map((u) => ({ institutionName: u.institutionName, year: u.year })),
  };

  const row = await prisma.simulationRun.create({
    data: {
      tenantId,
      userId,
      channel: 'APPLY',
      year,
      input: input as never,
      result: result as never,
      dataAsOf,
      draws: result.draws,
    },
    select: { id: true, runAt: true },
  });

  return {
    runId: row.id,
    runAt: row.runAt.toISOString(),
    result,
    unmatched,
    correlation,
    /** 還沒有級分分布的科目。畫面上要接到級分預測那一頁。 */
    subjectsWithoutDistribution: (GSAT_SUBJECT_CODES as readonly string[]).filter(
      (c) => !marginals[c],
    ),
  };
}

/** 最近幾次模擬。學生要看得出「這個數字是什麼時候算的、用的是哪一份資料」。 */
export async function placementRuns(userId: string, year: number, take = 10) {
  const rows = await prisma.simulationRun.findMany({
    where: { userId, year, channel: 'APPLY' },
    orderBy: { runAt: 'desc' },
    take,
    select: { id: true, runAt: true, dataAsOf: true, draws: true, input: true, result: true },
  });
  return rows.map((r) => {
    const input = r.input as {
      seed?: number;
      unmatched?: { institutionName: string; year: number }[];
    } | null;
    return {
      id: r.id,
      runAt: r.runAt.toISOString(),
      dataAsOf: r.dataAsOf.toISOString(),
      draws: r.draws,
      /** 快照裡的種子。**帶著它重跑就重現得出一模一樣的數字。** */
      seed: input?.seed ?? null,
      /**
       * 查到了但對不上任何志願的門檻。從快照讀而不是重算，因為那一頁
       * 要顯示的是「**那一次**用的是哪些資料」——重算會拿今天的志願去比，
       * 於是一份三週前的模擬旁邊出現今天才打錯的校名。
       */
      unmatched: input?.unmatched ?? [],
      result: r.result as Record<string, unknown>,
    };
  });
}

/**
 * 最近一次模擬。**只讀，不重跑。**
 *
 * 頁面打開時顯示的是上一次的結果加上它的計算時間，重跑是一個明確的
 * 動作。理由與預測相同（讀一頁不該產生寫入），但這裡還多一個：
 * 每次進頁面都重跑的話，`SimulationRun` 會塞滿一模一樣的列，而那張表
 * 存在的理由就是「哪一次算的、用的是哪一份資料」。
 */
export async function latestPlacement(userId: string, year: number) {
  const rows = await placementRuns(userId, year, 1);
  return rows[0] ?? null;
}
