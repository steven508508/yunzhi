/**
 * 題本上傳。
 *
 * 這是整個「題庫建置太慢」問題的入口（訪談時選定的第一版重點）。
 * 流程刻意做成三段而非一次做完：
 *
 *   上傳（這裡，同步、秒級）→ 佇列 → 管線（背景、分鐘級）→ 校對
 *
 * 上傳這一段只做能立刻做完、且做錯要立刻讓人知道的事：
 * 驗格式、驗權利聲明、存檔、建工作。所有耗時與花錢的動作
 * 都推到佇列後面 —— 老師按下上傳之後不該盯著轉圈圈。
 */
import { NextRequest, NextResponse } from 'next/server';
import { scopedRoute } from '@/lib/route';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireUser, canEditSubject } from '@/lib/auth';
import { sniff, mimeFor, extFor, rejectReason } from '@/lib/filetype';
import { putObject, importFileKey, deletePrefix, importPrefix, sha256 } from '@/lib/storage';
import { enqueueImport } from '@/lib/queue';
import {
  SOURCE_TYPES,
  LICENSE_SCOPES,
  RIGHTS_BASES,
  validateDeclaration,
  type RightsDeclaration,
} from '@/lib/rights';

export const dynamic = 'force-dynamic';
// 檔案處理會吃掉一些時間，但這裡不做 AI 呼叫，60 秒綽綽有餘。
export const maxDuration = 60;

/**
 * 單檔上限。
 *
 * 300 dpi 掃描的 200 頁題本大約 60–120 MB；用手機拍的單頁照片
 * 大約 2–5 MB。200 MB 容得下最壞情況，又不至於讓一次誤傳的
 * 影片檔把整個 request 記憶體吃光。
 */
const MAX_FILE_BYTES = 200 * 1024 * 1024;
/** 單次上傳的總量。一份題本＋答案卷＋詳解本，三份都給到上限也還在範圍內。 */
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const MAX_FILES = 10;

const FILE_ROLES = ['QUESTION_BOOK', 'ANSWER_KEY', 'EXPLANATION_BOOK', 'RUBRIC', 'UNKNOWN'] as const;

const Meta = z.object({
  subjectId: z.string().min(1, '請選擇科目'),
  title: z.string().trim().min(1, '請填寫這批題目的名稱').max(200),
  sourceType: z.enum(SOURCE_TYPES),
  licenseScope: z.enum(LICENSE_SCOPES),
  rightsBasis: z.enum(RIGHTS_BASES),
  rightsNote: z.string().max(2000).optional(),
  /** 與 files 等長，逐檔標記角色。順序必須對應。 */
  roles: z.array(z.enum(FILE_ROLES)).optional(),
  /** 老師勾選的確認框。沒有勾就不收 —— 責任歸屬要明確。 */
  rightsConfirmed: z.literal(true, {
    errorMap: () => ({ message: '請先確認你已取得這批題目的使用權利' }),
  }),
  /** 明知重複仍要匯入（例如同一份題本要拆成兩批給不同班）。 */
  allowDuplicate: z.boolean().optional(),
});

function bad(message: string, status = 400, detail?: unknown) {
  return NextResponse.json({ error: message, detail }, { status });
}

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  if (user.systemRole === 'STUDENT' || user.systemRole === 'GUARDIAN') {
    return bad('沒有匯入題目的權限', 403);
  }

  // Content-Length 先擋一次。等到 formData() 把 500 MB 讀進記憶體
  // 才發現超量，該吃的記憶體已經吃了。
  const declaredLength = Number(req.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_TOTAL_BYTES) {
    return bad(
      `這次上傳共 ${mb(declaredLength)}，超過單次上限 ${mb(MAX_TOTAL_BYTES)}。請分批上傳。`,
      413,
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad('上傳內容無法解析。若是在網路不穩時中斷，請重試一次。');
  }

  const metaRaw = form.get('meta');
  if (typeof metaRaw !== 'string') return bad('缺少 meta 欄位');

  let metaJson: unknown;
  try {
    metaJson = JSON.parse(metaRaw);
  } catch {
    return bad('meta 欄位不是合法的 JSON');
  }

  const parsed = Meta.safeParse(metaJson);
  if (!parsed.success) {
    return bad(
      '表單填寫不完整',
      400,
      parsed.error.issues.map((i) => `${i.path.join('.')}：${i.message}`),
    );
  }
  const meta = parsed.data;

  // ── 權利聲明。不合規就在這裡擋下，不要等到校對完才失敗。
  const declaration: RightsDeclaration = {
    sourceType: meta.sourceType,
    licenseScope: meta.licenseScope,
    rightsBasis: meta.rightsBasis,
    rightsNote: meta.rightsNote,
  };
  const rightsError = validateDeclaration(declaration);
  if (rightsError) return bad(rightsError, 422);

  // ── 科目與權限
  const subject = await prisma.subject.findFirst({
    where: { id: meta.subjectId, tenantId: user.tenantId, active: true },
    select: { id: true, name: true },
  });
  if (!subject) return bad('找不到這個科目，或它已停用');
  if (!(await canEditSubject(user, subject.id))) {
    return bad(`你不是「${subject.name}」的授課老師，無法匯入這一科的題目`, 403);
  }

  // ── 檔案
  const uploads = form.getAll('files').filter((f): f is File => f instanceof File);
  if (uploads.length === 0) return bad('請至少選擇一個檔案');
  if (uploads.length > MAX_FILES) return bad(`一次最多 ${MAX_FILES} 個檔案`);
  if (meta.roles && meta.roles.length !== uploads.length) {
    return bad('檔案角色的數量與檔案數量不符');
  }

  type Prepared = {
    fileName: string;
    role: (typeof FILE_ROLES)[number];
    mimeType: string;
    ext: string;
    bytes: Buffer;
    hash: string;
  };

  const prepared: Prepared[] = [];
  let total = 0;

  for (const [i, f] of uploads.entries()) {
    if (f.size > MAX_FILE_BYTES) {
      return bad(
        `「${f.name}」有 ${mb(f.size)}，超過單檔上限 ${mb(MAX_FILE_BYTES)}。` +
          '若是掃描件，請用較低的解析度（300 dpi 已足夠）重新輸出。',
        413,
      );
    }
    total += f.size;
    if (total > MAX_TOTAL_BYTES) {
      return bad(`這次上傳合計超過 ${mb(MAX_TOTAL_BYTES)}，請分批上傳。`, 413);
    }

    const bytes = Buffer.from(await f.arrayBuffer());
    if (bytes.length === 0) return bad(`「${f.name}」是空檔案`);

    // 副檔名不作數，看內容。
    const kind = sniff(bytes, f.name);
    if (kind === 'unknown') return bad(rejectReason(bytes, f.name), 415);

    prepared.push({
      fileName: f.name.slice(0, 255),
      role: meta.roles?.[i] ?? guessRole(f.name),
      mimeType: mimeFor(kind, bytes, f.name),
      ext: extFor(kind, bytes, f.name),
      bytes,
      hash: sha256(bytes),
    });
  }

  // 同一份檔案在同一次上傳裡出現兩次，多半是誤選。
  const seen = new Map<string, string>();
  for (const p of prepared) {
    const dup = seen.get(p.hash);
    if (dup) return bad(`「${p.fileName}」與「${dup}」內容相同，請移除其中一個。`);
    seen.set(p.hash, p.fileName);
  }

  // 這份檔案以前傳過嗎？
  //
  // 七個班、一科三位老師（訪談第 1 題），同一份講義被重複上傳
  // 是遲早的事。省下的不是儲存空間 —— 是第二次的 AI 費用，
  // 以及第二次的 20 分鐘校對。
  if (!meta.allowDuplicate) {
    const priors = await prisma.importFile.findMany({
      where: {
        sha256: { in: [...seen.keys()] },
        job: { tenantId: user.tenantId, status: { not: 'FAILED' } },
      },
      select: {
        sha256: true,
        fileName: true,
        job: {
          select: {
            id: true,
            title: true,
            status: true,
            createdAt: true,
            creator: { select: { displayName: true } },
          },
        },
      },
      take: 10,
    });

    if (priors.length > 0) {
      return NextResponse.json(
        {
          error: '這些檔案先前已經匯入過',
          duplicates: priors.map((p) => ({
            fileName: seen.get(p.sha256!) ?? p.fileName,
            priorJobId: p.job.id,
            priorTitle: p.job.title,
            priorStatus: p.job.status,
            priorBy: p.job.creator?.displayName ?? '已離職的帳號',
            priorAt: p.job.createdAt,
          })),
          hint: '若確定要再匯一次（例如同一份題本要拆給不同班），請勾選「仍要匯入」後重新送出。',
        },
        { status: 409 },
      );
    }
  }

  // ── 建立工作。先建 DB 再寫物件儲存：反過來的話，DB 寫入失敗
  //    會在 MinIO 留下沒有人指向的孤兒物件，而那些物件不會有人清。
  const job = await prisma.importJob.create({
    data: {
      tenantId: user.tenantId,
      subjectId: subject.id,
      title: meta.title,
      status: 'QUEUED',
      sourceType: meta.sourceType,
      licenseScope: meta.licenseScope,
      rightsBasis: meta.rightsBasis,
      rightsNote: meta.rightsNote,
      rightsDeclaredBy: user.id,
      // 姓名快照。帳號日後被刪時 rightsDeclaredBy 會變成 NULL，
      // 但「誰聲明這份題本可以用」是權利基礎的證據，不能跟著消失。
      rightsDeclaredName: user.displayName || user.username,
      createdBy: user.id,
      stageDetail: { stages: {} },
    },
    select: { id: true },
  });

  try {
    for (const p of prepared) {
      const file = await prisma.importFile.create({
        data: {
          jobId: job.id,
          role: p.role,
          fileName: p.fileName,
          mimeType: p.mimeType,
          sizeBytes: BigInt(p.bytes.length),
          sha256: p.hash,
          // 先填佔位，寫完物件再更新成真正的鍵。
          storageKey: '',
        },
        select: { id: true },
      });

      const key = importFileKey(user.tenantId, job.id, file.id, p.ext);
      await putObject(key, p.bytes, p.mimeType, {
        // metadata 只能放 ASCII，中文檔名要編碼過。
        'original-name': encodeURIComponent(p.fileName),
        sha256: p.hash,
      });
      await prisma.importFile.update({ where: { id: file.id }, data: { storageKey: key } });
    }
  } catch (e) {
    // 失敗就把這次留下的東西清乾淨。半成品的匯入工作對老師
    // 只是雜訊，而孤兒物件會一直佔著磁碟。
    await deletePrefix(importPrefix(user.tenantId, job.id)).catch(() => {});
    await prisma.importJob.delete({ where: { id: job.id } }).catch(() => {});
    return bad(
      `檔案儲存失敗：${e instanceof Error ? e.message : String(e)}。已取消這次匯入，請重試。`,
      502,
    );
  }

  await prisma.auditLog.create({
    data: {
      tenantId: user.tenantId,
      category: 'QUESTION',
      action: 'import.upload',
      actorId: user.id,
      actorIp: clientIp(req),
      targetType: 'ImportJob',
      targetId: job.id,
      after: {
        title: meta.title,
        subject: subject.name,
        sourceType: meta.sourceType,
        licenseScope: meta.licenseScope,
        rightsBasis: meta.rightsBasis,
        rightsNote: meta.rightsNote ?? null,
        files: prepared.map((p) => ({
          name: p.fileName,
          role: p.role,
          bytes: p.bytes.length,
          sha256: p.hash,
        })),
      },
    },
  });

  // ── 入列。入列失敗不該讓上傳失敗 —— 檔案已經安全存好了，
  //    工作停在 QUEUED，老師可以在進度頁按「重新開始」。
  let queued = true;
  let queueError: string | undefined;
  try {
    await enqueueImport({ jobId: job.id, tenantId: user.tenantId });
  } catch (e) {
    queued = false;
    queueError = e instanceof Error ? e.message : String(e);
    await prisma.importJob.update({
      where: { id: job.id },
      data: { error: `無法排入處理佇列：${queueError}` },
    });
  }

  return NextResponse.json(
    {
      jobId: job.id,
      fileCount: prepared.length,
      totalBytes: total,
      queued,
      queueError,
      next: `/import/${job.id}`,
    },
    { status: 201 },
  );
});

/**
 * 從檔名猜角色。猜錯不要緊 —— 上傳介面會把猜測結果顯示出來讓老師改，
 * 猜對的那幾次省下的是他點選的力氣。
 *
 * **題本的判斷排在最前面**，與 `Upload.tsx` 的 `guessRole` 一致。
 * 老師自己出的段考卷叫「115上第三次段考_數學A_含詳解.docx」，
 * 而題本裡夾詳解是常態、純詳解本很少單獨存在——兩種都命中時猜題本。
 * 猜成詳解本的後果是整份匯入在拆題階段永久失敗，而畫面上沒有任何
 * 地方能改角色。
 */
function guessRole(name: string): (typeof FILE_ROLES)[number] {
  const n = name.toLowerCase();
  if (/題本|試題|考卷|考題|段考|小考|週考|月考|模擬|講義|習題|練習|exam|paper|quiz/.test(n)) {
    return 'QUESTION_BOOK';
  }
  if (/答案|解答|answer|key|ans/.test(n)) return 'ANSWER_KEY';
  if (/詳解|解析|explanation|solution/.test(n)) return 'EXPLANATION_BOOK';
  if (/評分|原則|rubric|級分/.test(n)) return 'RUBRIC';
  return 'QUESTION_BOOK';
}

function mb(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function clientIp(req: NextRequest) {
  // 反向代理在前（訪談：server 已裝 nginx），所以真實 IP 在標頭裡。
  const fwd = req.headers.get('x-forwarded-for');
  return fwd?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip') ?? null;
}
