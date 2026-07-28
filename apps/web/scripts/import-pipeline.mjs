/**
 * 匯入管線的編排。
 *
 * 這支的職責是「推進與記帳」，實際的解析都在 Python 服務裡。
 * 它做三件事，每一件都是為了同一個目標——**讓失敗不必從頭來過**：
 *
 *   1. 每完成一個階段就寫回資料庫（狀態、產出、成本）
 *   2. 續跑時從 lastCompletedStage 的下一階段開始
 *   3. 把 HTTP 狀態碼翻譯成「值得重試」或「不要重試」
 *
 * 第三點特別重要。一份 200 頁的題本跑到第四階段（自答）大概已經
 * 花了幾百塊，這時如果因為設定錯誤（模型名稱打錯）而失敗，
 * 盲目重試三次就是白燒三倍的前四階段。所以 502（設定錯）
 * 直接放棄並把原因寫給老師看，只有 503（限流、暫時故障）才重試。
 */
const AI_URL = (process.env.AI_SERVICE_URL ?? 'http://ai:8000').replace(/\/+$/, '');

/** 階段順序。與 ImportStatus 的列舉值同名，方便直接寫回。 */
export const STAGES = [
  'NORMALIZING',
  'SEGMENTING',
  'EXTRACTING',
  'SOLVING',
  'ANNOTATING',
  'DEDUPING',
];

/**
 * 不該重試的錯誤。
 *
 * 分成獨立的類別，是因為 BullMQ 只看「有沒有拋錯」——
 * 要讓它不重試，得明確地把工作標成失敗而非拋出去。
 */
export class PermanentError extends Error {
  constructor(message, stage) {
    super(message);
    this.name = 'PermanentError';
    this.stage = stage;
    this.permanent = true;
  }
}

export class RetryableStageError extends Error {
  constructor(message, stage) {
    super(message);
    this.name = 'RetryableStageError';
    this.stage = stage;
    this.permanent = false;
  }
}

// ─────────────────────────────────────────────────────────────
// 與 AI 服務的溝通
// ─────────────────────────────────────────────────────────────

/**
 * 逾時。正規化一份 200 頁的掃描件（含影像前處理）在慢的機器上
 * 要好幾分鐘，自答一批 50 題也是。給得寬，但不是無限——
 * 無限逾時遇到上游卡住就會變成一個永遠不會結束的工作。
 */
const STAGE_TIMEOUT_MS = {
  NORMALIZING: 15 * 60_000,
  SEGMENTING: 20 * 60_000,
  EXTRACTING: 15 * 60_000,
  SOLVING: 30 * 60_000,
  ANNOTATING: 10 * 60_000,
};

async function callAI(path, body, stage) {
  const timeout = STAGE_TIMEOUT_MS[stage] ?? 10 * 60_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let res;
  try {
    res = await fetch(`${AI_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      throw new RetryableStageError(
        `${stage} 階段超過 ${Math.round(timeout / 60000)} 分鐘未完成。` +
          `檔案可能過大，或 AI 服務卡住了。`,
        stage,
      );
    }
    // 連不上 AI 服務：多半是它還在啟動，或剛被重啟。值得重試。
    throw new RetryableStageError(`無法連線 AI 服務（${AI_URL}）：${e.message}`, stage);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 800);
    try {
      const j = JSON.parse(text);
      detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
    } catch {}

    // 415 / 422 / 400：檔案或內容的問題，重試一百次也一樣。
    if (res.status === 415 || res.status === 422 || res.status === 400) {
      throw new PermanentError(detail, stage);
    }
    // 502：設定錯（金鑰、模型名、base URL）。重試只是重複燒錢。
    if (res.status === 502) {
      throw new PermanentError(`AI 服務設定有誤：${detail}`, stage);
    }
    // 503 與 5xx：暫時性。
    throw new RetryableStageError(`AI 服務回應 ${res.status}：${detail}`, stage);
  }

  return JSON.parse(text);
}

// ─────────────────────────────────────────────────────────────
// 成本
// ─────────────────────────────────────────────────────────────

/**
 * 單價表。以新台幣計、每百萬 token。
 *
 * 從環境變數讀而不是寫死：模型會換、匯率會動、自架閘道的
 * 成本結構完全不同。寫死的數字幾個月後只會誤導人。
 *
 * 格式：AI_PRICING='{"claude-opus-4":{"in":480,"out":2400}}'
 */
function loadPricing() {
  const raw = process.env.AI_PRICING;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`[import] AI_PRICING 不是合法 JSON，成本一律記為 0：${e.message}`);
    return {};
  }
}

const PRICING = loadPricing();

function estimateCost(usage) {
  const p = PRICING[usage?.model];
  if (!p || !usage) return 0;
  const inTok = usage.input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  return ((inTok * (p.in ?? 0)) + (outTok * (p.out ?? 0))) / 1_000_000;
}

const PURPOSE_BY_STAGE = {
  SEGMENTING: 'IMPORT_EXTRACT',
  EXTRACTING: 'IMPORT_EXTRACT',
  SOLVING: 'IMPORT_SOLVE',
  ANNOTATING: 'IMPORT_ANNOTATE',
};

const TIER_BY_STAGE = {
  SEGMENTING: 'MID',
  EXTRACTING: 'MID',
  SOLVING: 'HIGH',
  ANNOTATING: 'LIGHT',
};

async function recordUsage(prisma, job, stage, usage, ok, errorCode) {
  if (!usage) return 0;
  const cost = estimateCost(usage);

  await prisma.aiUsageLog.create({
    data: {
      tenantId: job.tenantId,
      purpose: PURPOSE_BY_STAGE[stage] ?? 'OTHER',
      tier: TIER_BY_STAGE[stage] ?? 'MID',
      provider: usage.provider || 'unknown',
      model: usage.model || 'unknown',
      baseUrl: process.env.AI_BASE_URL ?? null,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      estimatedCost: cost || null,
      succeeded: ok,
      errorCode: errorCode ?? null,
      refType: 'ImportJob',
      refId: job.id,
      promptVersion: usage.prompt_version ?? null,
    },
  });
  return cost;
}

// ─────────────────────────────────────────────────────────────
// 各階段
// ─────────────────────────────────────────────────────────────

/** 第一階段：原稿 → 頁面影像（＋原生 PDF 的文字區塊）。 */
async function stageNormalize(ctx) {
  const { prisma, job } = ctx;
  const files = await prisma.importFile.findMany({
    where: { jobId: job.id },
    orderBy: { uploadedAt: 'asc' },
  });
  if (files.length === 0) throw new PermanentError('這個匯入工作沒有檔案', 'NORMALIZING');

  let totalPages = 0;
  const notes = [];

  for (const f of files) {
    const out = await callAI(
      '/v1/import/normalize',
      {
        source_key: f.storageKey,
        file_name: f.fileName,
        page_key_prefix: `t/${job.tenantId}/import/${job.id}/pages/${f.id}`,
      },
      'NORMALIZING',
    );

    // 先刪再寫。續跑時若不刪，unique(fileId,index) 會撞。
    await prisma.importPage.deleteMany({ where: { fileId: f.id } });
    await prisma.importPage.createMany({
      data: out.pages.map((p) => ({
        jobId: job.id,
        fileId: f.id,
        index: p.index,
        width: p.width,
        height: p.height,
        storageKey: p.storage_key,
        textLayer: p.text_layer ?? null,
        quality: p.quality,
        qualityNotes: p.quality_notes ?? [],
        // text_blocks 存進 blocks 欄位，第二階段直接用，
        // 不必回頭再讀一次 PDF。
        blocks: p.text_blocks?.length ? { textBlocks: p.text_blocks } : null,
        figures: p.figures?.length ? p.figures : null,
      })),
    });

    await prisma.importFile.update({
      where: { id: f.id },
      data: {
        pageCount: out.page_count,
        qualityScore: out.quality,
        qualityNote: out.quality_note,
      },
    });

    totalPages += out.page_count;
    notes.push(`${f.fileName}：${out.quality_note}`);
  }

  await prisma.importJob.update({ where: { id: job.id }, data: { totalPages } });
  return { totalPages, notes, usage: null };
}

/** 第二階段：版面切分。原生 PDF 走純程式，掃描件走視覺模型。 */
async function stageSegment(ctx) {
  const { prisma, job } = ctx;

  // 只切題本。答案卷另走對齊流程，詳解本另走解析匯入，
  // 評分原則另走 rubric —— 它們的著作權地位與處理方式都不同。
  //
  // 先查檔案再查頁面，而不是用關聯過濾一次查完：兩段式查詢
  // 直接吃 import_pages(jobId) 索引，而關聯過濾會產生一個
  // 跨表的 join，在 200 頁的工作上差別明顯。
  const fileIds = (
    await prisma.importFile.findMany({
      where: { jobId: job.id, role: { in: ['QUESTION_BOOK', 'UNKNOWN'] } },
      select: { id: true },
    })
  ).map((f) => f.id);

  const pages = fileIds.length
    ? await prisma.importPage.findMany({
        where: { jobId: job.id, fileId: { in: fileIds } },
        orderBy: [{ fileId: 'asc' }, { index: 'asc' }],
        select: { id: true, index: true, storageKey: true, blocks: true, figures: true },
      })
    : [];
  if (pages.length === 0) {
    throw new PermanentError('沒有可切分的頁面。請確認上傳的檔案標記為題本。', 'SEGMENTING');
  }

  const out = await callAI(
    '/v1/import/segment',
    {
      pages: pages.map((p) => ({
        index: p.index,
        storage_key: p.storageKey,
        text_blocks: p.blocks?.textBlocks ?? [],
        figures: p.figures ?? [],
      })),
    },
    'SEGMENTING',
  );

  // 每頁的切分結果寫回，讓校對介面能做左右連動。
  const byPage = new Map();
  for (const b of out.blocks) {
    const arr = byPage.get(b.bbox.page) ?? [];
    arr.push(b);
    byPage.set(b.bbox.page, arr);
  }
  for (const p of pages) {
    const blocks = byPage.get(p.index);
    if (!blocks) continue;
    await prisma.importPage.update({
      where: { id: p.id },
      data: {
        blocks: { ...(p.blocks ?? {}), layout: blocks, method: out.method[String(p.index)] },
      },
    });
  }

  const failed = Object.entries(out.method).filter(([, m]) => m.startsWith('failed'));
  return {
    sections: out.sections,
    exercises: out.exercises ?? [],
    genre: out.genre ?? 'unknown',
    answerInk: out.answer_ink ?? null,
    groupRanges: out.group_ranges,
    visionPages: out.vision_pages,
    failedPages: failed.map(([page, m]) => `第 ${page} 頁（${m}）`),
    usage: out.usage,
  };
}

/** 第三階段：切分結果 → 候選題。 */
async function stageExtract(ctx) {
  const { prisma, job, state } = ctx;
  const seg = state.SEGMENTING ?? {};

  // 重跑此階段時先清掉舊候選。**只清尚未校對的**——老師已經
  // 確認過的候選不該因為重跑而消失，那是他花在 20 分鐘目標裡的時間。
  await prisma.importCandidate.deleteMany({
    where: { jobId: job.id, state: 'PENDING', reviewedAt: null },
  });

  // 新的 order 要從**現有最大值**往後接，不是從「剩幾列」往後接。
  //
  // 老師確認了第 3 題然後續跑：刪掉未校對的之後只剩 1 列，於是新
  // 候選從 order=2 開始編——而 order=3 已經被那一題佔著。
  // `UNIQUE(jobId, order)` 讓整個 createMany 拋錯，EXTRACTING 階段
  // 標成 FAILED。續跑正是這條管線的賣點，而它撞的是自己的唯一鍵。
  const [kept, top] = await Promise.all([
    prisma.importCandidate.count({ where: { jobId: job.id } }),
    prisma.importCandidate.findFirst({
      where: { jobId: job.id },
      orderBy: { order: 'desc' },
      select: { order: true },
    }),
  ]);
  const existing = top?.order ?? 0;

  const out =
    seg.genre === 'worksheet'
      ? await extractWorksheet(ctx, seg, existing)
      : await extractExam(ctx, seg, existing);

  await prisma.importJob.update({
    where: { id: job.id },
    data: { totalCandidates: kept + out.rows.length },
  });

  if (out.rows.length) await prisma.importCandidate.createMany({ data: out.rows });

  return {
    extracted: out.rows.length,
    genre: seg.genre ?? 'unknown',
    withExplanation: out.rows.filter((r) => r.explanationRaw).length,
    withFigure: out.rows.filter((r) => r.assets).length,
    sectionWarnings: out.warnings,
    usage: out.usage,
  };
}

/**
 * 講義：題目單位已經在切分階段就分好了（範例／類題／習題），
 * 而且**詳解與答案已經跟題幹分開**——那是切分階段用顏色做到的，
 * 比讓模型從一整段文字裡猜哪裡是解答可靠得多。
 *
 * 所以這裡的模型呼叫只做一件事：把題幹整理成結構化的題目
 * （題型、選項、配分）。詳解原樣帶過去。
 */
async function extractWorksheet(ctx, seg, existing) {
  const { job } = ctx;
  const exercises = seg.exercises ?? [];
  if (exercises.length === 0) {
    throw new PermanentError('切分階段沒有切出任何題目單位', 'EXTRACTING');
  }

  const rows = [];
  const usageTotal = { input_tokens: 0, output_tokens: 0, calls: 0, estimated: false };
  const BATCH = 12;

  for (let i = 0; i < exercises.length; i += BATCH) {
    const batch = exercises.slice(i, i + BATCH);
    const out = await callAI(
      '/v1/import/structure',
      {
        sections: batch.map((e) => ({
          title: e.label,
          note: '',
          text: e.stem,
        })),
      },
      'EXTRACTING',
    );

    for (const [k, q] of (out.questions ?? []).entries()) {
      const src = batch[out.section_of?.[k] ?? 0] ?? batch[0];
      rows.push({
        jobId: job.id,
        order: existing + rows.length + 1,
        questionNo: q.question_no ?? null,
        label: src.label ?? null,
        subLabel: q.sub_label ?? null,
        groupKey: q.group_key ?? null,
        type: q.type,
        content: q.content,
        options: q.options ?? [],
        answerSlots: q.answer_slots?.length ? q.answer_slots : null,
        answerText: src.answer || null,
        sourceAnswerRaw: src.answer || (src.inline_answers ?? []).join('；') || null,
        explanationRaw: src.explanation || null,
        assets: src.assets?.length ? src.assets : null,
        score: q.score ?? null,
        confidence: q.confidence ?? 0,
        confidenceReasons: q.confidence_reasons ?? [],
        sourceBbox: q.source_bbox ?? null,
        sourcePage: q.source_bbox?.page ?? src.page ?? null,
        // 出處與全國答對率優先採**切分階段用規則抓到的**，
        // 模型的回覆只當補漏。規則是逐字比對，模型會「幫忙」
        // 把沒印的數字補一個看起來合理的——而這一欄一旦混進
        // 估計值，就再也分不出哪些是大考中心的實測值。
        sourceExam: src.source_exam ?? q.source_exam ?? null,
        nationalCorrectRate:
          src.national_correct_rate ?? q.national_correct_rate ?? null,
      });
    }

    usageTotal.calls += out.usage?.calls ?? 0;
    usageTotal.input_tokens += out.usage?.input_tokens ?? 0;
    usageTotal.output_tokens += out.usage?.output_tokens ?? 0;
    usageTotal.model = out.usage?.model ?? usageTotal.model;
    usageTotal.provider = out.usage?.provider ?? usageTotal.provider;
    usageTotal.prompt_version = out.usage?.prompt_version ?? usageTotal.prompt_version;
  }

  return { rows, warnings: [], usage: usageTotal };
}

/** 學測試卷：靠「節」切，配分與題型由節說明推定。 */
async function extractExam(ctx, seg, existing) {
  const { job } = ctx;
  const sections = seg.sections ?? [];
  if (sections.length === 0) {
    throw new PermanentError('切分階段沒有產出任何內容，無法結構化', 'EXTRACTING');
  }

  const out = await callAI(
    '/v1/import/structure',
    {
      sections: sections.map((s) => ({ title: s.title, note: s.note, text: s.text })),
    },
    'EXTRACTING',
  );

  const rows = (out.questions ?? []).map((q, i) => ({
    jobId: job.id,
    order: existing + i + 1,
    questionNo: q.question_no ?? null,
    subLabel: q.sub_label ?? null,
    groupKey: q.group_key ?? null,
    type: q.type,
    content: q.content,
    options: q.options ?? [],
    answerSlots: q.answer_slots?.length ? q.answer_slots : null,
    score: q.score ?? null,
    confidence: q.confidence ?? 0,
    confidenceReasons: q.confidence_reasons ?? [],
    sourceBbox: q.source_bbox ?? null,
    sourcePage: q.source_bbox?.page ?? null,
  }));

  return { rows, warnings: out.section_warnings ?? [], usage: out.usage };
}

/** 第四階段：AI 自答（self-consistency 投票）。 */
async function stageSolve(ctx) {
  const { prisma, job } = ctx;

  const candidates = await prisma.importCandidate.findMany({
    where: { jobId: job.id, state: 'PENDING', answerOrigin: null },
    orderBy: { order: 'asc' },
  });
  if (candidates.length === 0) return { solved: 0, usage: null };

  // 分批。一次送太多會讓單一 HTTP 請求跑很久，而中途失敗就
  // 整批白做——分批之後，失敗只損失一批。
  const BATCH = 20;
  let solved = 0;
  let failed = 0;
  const usageTotal = { input_tokens: 0, output_tokens: 0, calls: 0, estimated: true };

  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const out = await callAI(
      '/v1/import/solve',
      {
        items: batch.map((c) => ({
          ref: c.id,
          question: toStructured(c),
          provided_keys: c.answerKeys ?? [],
        })),
      },
      'SOLVING',
    );

    for (const r of out.results) {
      const c = batch.find((x) => x.id === r.ref);
      if (!c) continue;
      if (r.error) {
        failed++;
        await prisma.importCandidate.update({
          where: { id: c.id },
          data: {
            confidenceReasons: [
              ...(c.confidenceReasons ?? []),
              {
                code: 'solve_failed',
                detail: `AI 自答失敗（${r.error}）。這題沒有答案，請手動填入。`,
                severity: 'error',
              },
            ],
          },
        });
        continue;
      }

      solved++;
      await prisma.importCandidate.update({
        where: { id: c.id },
        data: {
          ...pickPatch(r.patch),
          confidenceReasons: [...(c.confidenceReasons ?? []), ...(r.reasons ?? [])],
          // 自答結果會影響信心：一致率低的題目要排到校對的前面。
          confidence: adjustConfidence(c.confidence, r.patch),
        },
      });
    }

    usageTotal.calls += out.usage?.calls ?? 0;
    usageTotal.input_tokens += out.usage?.input_tokens ?? 0;
    usageTotal.output_tokens += out.usage?.output_tokens ?? 0;
    usageTotal.model = out.usage?.model ?? usageTotal.model;
    usageTotal.provider = out.usage?.provider ?? usageTotal.provider;
  }

  return { solved, failed, usage: usageTotal };
}

/** 第六階段：知識點標註。 */
async function stageAnnotate(ctx) {
  const { prisma, job } = ctx;

  const subject = await prisma.subject.findUnique({
    where: { id: job.subjectId },
    select: { id: true, name: true },
  });

  const candidates = await prisma.importCandidate.findMany({
    where: { jobId: job.id, state: 'PENDING' },
    orderBy: { order: 'asc' },
  });
  if (candidates.length === 0) return { annotated: 0, usage: null };

  const kpCount = await prisma.knowledgePoint.count({ where: { subjectId: subject.id } });
  if (kpCount === 0) {
    // 不算失敗。知識點是另一條建置路線，還沒建完不該擋住題目匯入。
    return {
      annotated: 0,
      skipped: `科目「${subject.name}」尚未建立知識點，已略過標註。` +
        `題目仍可正常使用，日後補建知識點後可重新標註。`,
      usage: null,
    };
  }

  const BATCH = 25;
  let annotated = 0;
  const usageTotal = { input_tokens: 0, output_tokens: 0, calls: 0, estimated: true };

  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const items = [];
    for (const c of batch) {
      items.push({
        ref: c.id,
        question: toStructured(c),
        candidates: await retrieveKpCandidates(prisma, subject.id, c.content ?? ''),
      });
    }

    const out = await callAI(
      '/v1/import/annotate',
      { subject_name: subject.name, items },
      'ANNOTATING',
    );

    for (const r of out.results) {
      if (!r.result) continue;
      const c = batch.find((x) => x.id === r.ref);
      if (!c) continue;
      annotated++;
      await prisma.importCandidate.update({
        where: { id: c.id },
        data: {
          kpSuggestions: r.result.picks.map((p) => ({
            id: p.kp_id,
            weight: p.weight,
            evidence: p.evidence,
          })),
        },
      });
    }

    usageTotal.calls += out.usage?.calls ?? 0;
    usageTotal.model = out.usage?.model ?? usageTotal.model;
    usageTotal.provider = out.usage?.provider ?? usageTotal.provider;
  }

  return { annotated, usage: usageTotal };
}

/** 第七階段：去重。純程式，不花錢。 */
async function stageDedupe(ctx) {
  const { prisma, job } = ctx;

  const candidates = await prisma.importCandidate.findMany({
    where: { jobId: job.id, state: 'PENDING' },
    select: { id: true, content: true, options: true, confidenceReasons: true },
  });
  if (candidates.length === 0) return { duplicates: 0, usage: null };

  // 雜湊由 AI 服務算，確保與 Python 端的正規化規則是同一份。
  // 兩份實作遲早會分岐，而分岐的症狀是去重靜默失效。
  const { hashes } = await callAI(
    '/v1/import/content-hash',
    {
      items: candidates.map((c) => ({
        stem: c.content ?? '',
        options: (c.options ?? []).map((o) => o.content ?? ''),
      })),
    },
    'DEDUPING',
  );

  let dupes = 0;

  // 批內重複
  const seen = new Map();
  for (const [i, c] of candidates.entries()) {
    const h = hashes[i];
    const first = seen.get(h);
    if (first) {
      dupes++;
      await prisma.importCandidate.update({
        where: { id: c.id },
        data: {
          confidenceReasons: [
            ...(c.confidenceReasons ?? []),
            {
              code: 'duplicate_in_batch',
              detail: `與本次匯入的第 ${first} 題內容相同。確認後請刪除其中一份。`,
              severity: 'warn',
            },
          ],
        },
      });
      continue;
    }
    seen.set(h, i + 1);
  }

  return { duplicates: dupes, usage: null };
}

const STAGE_FN = {
  NORMALIZING: stageNormalize,
  SEGMENTING: stageSegment,
  EXTRACTING: stageExtract,
  SOLVING: stageSolve,
  ANNOTATING: stageAnnotate,
  DEDUPING: stageDedupe,
};

// ─────────────────────────────────────────────────────────────
// 輔助
// ─────────────────────────────────────────────────────────────

/** 候選題 → AI 服務認得的 StructuredQuestion 形狀。 */
function toStructured(c) {
  return {
    question_no: c.questionNo ?? '',
    sub_label: c.subLabel,
    group_key: c.groupKey,
    type: c.type ?? 'SINGLE_CHOICE',
    content: c.content ?? '',
    options: c.options ?? [],
    answer_slots: c.answerSlots ?? [],
    score: c.score,
    confidence: c.confidence ?? 0.5,
    confidence_reasons: [],
  };
}

/** 只取白名單欄位。避免 AI 服務回傳的額外鍵直接寫進資料庫。 */
const PATCHABLE = new Set([
  'answerKeys',
  'answerSlots',
  'answerText',
  'answerOrigin',
  'selfConsistency',
  'solveTrace',
]);

function pickPatch(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (PATCHABLE.has(k) && v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * 自答之後的信心調整。
 *
 * 校對介面依 confidence 排序，讓老師先看最可疑的。一致率低的題目
 * 必須排到前面——那是最可能出錯、也最需要人判斷的。
 */
function adjustConfidence(base, patch) {
  const c = patch?.selfConsistency;
  if (c === undefined || c === null) return base;
  if (c >= 1.0) return Math.min(1, base + 0.1);
  if (c >= 0.6) return Math.max(0, base - 0.1);
  return Math.max(0, Math.min(base, 0.3)); // 沒有共識 → 一定要人看
}

/**
 * 取回候選知識點。
 *
 * 完整做法是向量檢索（KnowledgePoint.embedding），但嵌入子系統
 * 是另一條路線。在它就緒之前，用兩段式的退路：
 *   科目的知識點不多 → 全部給（模型自己挑得動）
 *   多到給不完       → 用 pg_trgm 的相似度取前 20
 *
 * 這樣「還沒建嵌入」不會擋住題目匯入，而有嵌入之後只要換掉
 * 這一個函式。無論哪條路徑，**模型都只能從候選中挑**——
 * 這一點不能退讓，否則同一個概念會出現五種寫法。
 */
const KP_CANDIDATE_LIMIT = 20;

async function retrieveKpCandidates(prisma, subjectId, stem) {
  const total = await prisma.knowledgePoint.count({ where: { subjectId } });

  if (total <= 40) {
    const all = await prisma.knowledgePoint.findMany({
      where: { subjectId },
      select: { id: true, name: true, description: true },
      orderBy: { name: 'asc' },
    });
    return all.map((k) => ({ id: k.id, name: k.name, description: k.description ?? '' }));
  }

  const rows = await prisma.$queryRaw`
    SELECT id, name, COALESCE(description, '') AS description,
           similarity(name, ${stem}) AS score
      FROM knowledge_points
     WHERE "subjectId" = ${subjectId}
     ORDER BY score DESC
     LIMIT ${KP_CANDIDATE_LIMIT}
  `;
  return rows.map((r) => ({ id: r.id, name: r.name, description: r.description }));
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────

/**
 * 跑一個匯入工作。
 *
 * @param prisma  PrismaClient
 * @param jobId   ImportJob.id
 * @param opts.fromStage  從哪一階段開始（省略則依 lastCompletedStage 續跑）
 * @param opts.onProgress 進度回呼，用於 BullMQ 的 updateProgress
 */
/**
 * 本月已用的 token 數。
 *
 * AI_MONTHLY_TOKEN_BUDGET 原本在整個 repo 沒有任何一行程式讀取——
 * 也就是說老師設了一個上限，帳單來的時候才發現它從來沒有生效過。
 * 那比沒有這個設定更糟：它給了一個假的安全感。
 *
 * 上限只擋**匯入**這條路。考試、客觀題評分、已生成的解析全部
 * 照常運作（規格書文件 01 §16 的降級原則）——預算用完不該讓
 * 考試停擺。
 */
async function monthlyTokensUsed(prisma, tenantId) {
  const since = new Date();
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);
  const rows = await prisma.aiUsageLog.findMany({
    where: { tenantId, createdAt: { gte: since } },
    select: { inputTokens: true, outputTokens: true },
  });
  return rows.reduce((n, r) => n + (r.inputTokens ?? 0) + (r.outputTokens ?? 0), 0);
}

export async function runImport(prisma, jobId, opts = {}) {
  const job = await prisma.importJob.findUnique({ where: { id: jobId } });
  if (!job) throw new PermanentError(`找不到匯入工作 ${jobId}`, null);
  if (job.status === 'COMMITTED') {
    return { skipped: '這個工作已經入庫，不再重跑' };
  }

  const budget = Number(process.env.AI_MONTHLY_TOKEN_BUDGET ?? 0);
  if (budget > 0) {
    const used = await monthlyTokensUsed(prisma, job.tenantId);
    if (used >= budget) {
      // 不重試——重試也還是超支。訊息要讓老師知道下一步做什麼。
      throw new PermanentError(
        `本月 AI 用量已達上限（${used.toLocaleString()} / ${budget.toLocaleString()} token）。` +
          `題本匯入暫停，但考試、客觀題評分、既有解析都不受影響。` +
          `要調整請改 .env 的 AI_MONTHLY_TOKEN_BUDGET 後重啟。`,
        null,
      );
    }
  }

  // 從哪裡開始。明確指定優先；否則接續上次完成的階段。
  const done = job.lastCompletedStage;
  const startIndex = opts.fromStage
    ? Math.max(0, STAGES.indexOf(opts.fromStage))
    : done
      ? STAGES.indexOf(done) + 1
      : 0;

  if (startIndex >= STAGES.length) {
    await prisma.importJob.update({
      where: { id: jobId },
      data: { status: 'READY_FOR_REVIEW', error: null },
    });
    return { alreadyDone: true };
  }

  await prisma.importJob.update({
    where: { id: jobId },
    data: { attemptCount: { increment: 1 }, error: null },
  });

  // 之前各階段的產出。續跑時要讀回來——第三階段吃第二階段的 sections。
  const state = { ...(job.stageDetail?.stages ?? {}) };
  let cost = Number(job.aiCostTwd ?? 0);

  for (let i = startIndex; i < STAGES.length; i++) {
    const stage = STAGES[i];
    const startedAt = new Date();

    await prisma.importJob.update({
      where: { id: jobId },
      data: { status: stage, stageStartedAt: startedAt },
    });
    opts.onProgress?.({ stage, index: i, total: STAGES.length });

    let result;
    try {
      result = await STAGE_FN[stage]({ prisma, job, state });
    } catch (e) {
      const permanent = e.permanent === true;
      await recordUsage(prisma, job, stage, { model: '', provider: '' }, false, e.name);
      await prisma.importJob.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          error:
            `${stageLabel(stage)}失敗：${e.message}` +
            (permanent
              ? '　這類問題重試沒有幫助，請依訊息處理後重新開始。'
              : '　系統會自動重試；若持續失敗請聯絡維護老師。'),
          stageDetail: { stages: state, failedAt: stage, permanent },
        },
      });
      throw e;
    }

    const { usage, ...detail } = result ?? {};
    cost += await recordUsage(prisma, job, stage, usage, true, null);

    state[stage] = { ...detail, elapsedMs: Date.now() - startedAt.getTime() };

    await prisma.importJob.update({
      where: { id: jobId },
      data: {
        lastCompletedStage: stage,
        stageDetail: { stages: state },
        aiCostTwd: cost,
      },
    });
  }

  await prisma.importJob.update({
    where: { id: jobId },
    data: { status: 'READY_FOR_REVIEW', stageStartedAt: null, error: null },
  });

  return { state, cost };
}

const STAGE_LABELS = {
  NORMALIZING: '檔案處理',
  SEGMENTING: '版面切分',
  EXTRACTING: '題目結構化',
  SOLVING: 'AI 自答',
  ANNOTATING: '知識點標註',
  DEDUPING: '重複比對',
};

export function stageLabel(stage) {
  return STAGE_LABELS[stage] ?? stage;
}
