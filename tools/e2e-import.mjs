/**
 * 匯入路徑的端到端驗證（由 tools/e2e-import.sh 起相依後呼叫）。
 *
 * 驗的是「跨越邊界之後還對不對」，而不是單元邏輯：
 *   · 資料庫的 CHECK 約束真的會擋下不合規的授權組合
 *   · Prisma 的欄位對應與手寫 SQL 遷移一致
 *   · 各階段的產出真的寫回資料庫，且失敗可以續跑
 *   · 上傳 API 的權利聲明與重複偵測按預期運作
 */
import assert from 'node:assert/strict';
import { createPgShim } from './pg-shim.mjs';
import { runImport, STAGES } from '../apps/web/scripts/import-pipeline.mjs';
import { commitJob } from './commit-shim.mjs';

// 用 pg-shim 而非 PrismaClient。理由見 tools/pg-shim.mjs 的檔頭：
// Prisma 的查詢引擎要從外部網域下載，封閉網段拿不到，而那正是
// 這套系統要部署的環境（補習班機房）。shim 從同一份 schema 取得
// 欄位對應，所以欄位名的正確性仍然被驗到。
const prisma = createPgShim({
  connectionString: process.env.DATABASE_URL,
  schemaPath: 'packages/db/schema.prisma',
});

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`   ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`   ✗ ${name}`);
    console.error(`     ${e.message.split('\n').slice(0, 4).join('\n     ')}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n\x1b[1m── ${name}\x1b[0m`);
}

// ── 造一份題本 PDF ───────────────────────────────────────────

async function makePaperPdf() {
  const { execFileSync } = await import('node:child_process');
  const script = `
import sys, fitz
doc = fitz.open()
page = doc.new_page(width=595, height=842)
f = "china-t"
def put(x, y, t, s=11): page.insert_text((x, y), t, fontsize=s, fontname=f)
y = 60
put(60, y, "第壹部分、選擇題（占 30 分）", 13); y += 26
put(60, y, "一、單選題（占 30 分）", 12); y += 24
put(60, y, "說明：第 1 題至第 6 題，每題有 5 個選項，各題答對者，得 5 分。", 10); y += 30
for q in range(1, 4):
    put(60, y, f"{q}. 設 f(x) 為第 {q} 題所定義的函數，試問下列敘述何者正確？", 11); y += 20
    for o in range(1, 6):
        put(80, y, f"({o}) 這是第 {q} 題的第 {o} 個選項敘述。", 10); y += 16
    y += 8
put(240, 800, "第 1 頁，共 1 頁", 9)
sys.stdout.buffer.write(doc.tobytes())
`;
  return execFileSync('python3', ['-c', script], {
    cwd: 'apps/ai',
    maxBuffer: 64 * 1024 * 1024,
  });
}

// ── 基礎資料 ─────────────────────────────────────────────────

async function seed() {
  const tenant = await prisma.tenant.create({ data: { name: '端到端測試補習班' } });
  const year = await prisma.academicYear.create({
    data: {
      tenantId: tenant.id,
      name: '115學年度',
      startDate: new Date('2026-08-01'),
      endDate: new Date('2027-07-31'),
      isCurrent: true,
    },
  });
  const teacher = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      username: 'T001',
      displayName: '王老師',
      systemRole: 'TEACHER',
      passwordHash: '$2a$12$notarealhashnotarealhashnotarealhashnotarealhashnotar',
    },
  });
  const subject = await prisma.subject.create({
    data: { tenantId: tenant.id, code: 'MATH_A', name: '數學A', gsatFullScore: 100 },
  });
  const klass = await prisma.class.create({
    data: { tenantId: tenant.id, academicYearId: year.id, name: '三年甲班' },
  });
  await prisma.classSubjectTeacher.create({
    data: { classId: klass.id, subjectId: subject.id, userId: teacher.id },
  });
  return { tenant, teacher, subject, klass };
}

async function main() {
  // 清乾淨。這支可以重複跑。
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE tenants, subjects, publishers, official_source_fetches
    RESTART IDENTITY CASCADE
  `);

  const { tenant, teacher, subject } = await seed();
  const pdf = await makePaperPdf();

  const storage = await import('@aws-sdk/client-s3');
  const s3 = new storage.S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION ?? 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
    },
  });

  // ── 資料庫層的授權約束 ─────────────────────────────────────

  section('資料庫層的授權約束');

  await test('出版社掃描不得設為可匯出', async () => {
    await assert.rejects(
      prisma.importJob.create({
        data: {
          tenantId: tenant.id,
          subjectId: subject.id,
          title: '違規測試',
          sourceType: 'PUBLISHER_SCAN',
          licenseScope: 'TENANT_EXPORTABLE',
          rightsBasis: 'LICENSED',
          rightsDeclaredBy: teacher.id,
        },
      }),
      /import_jobs_license_matches_source/,
    );
  });

  await test('只有歷屆試題可以設為公開', async () => {
    await assert.rejects(
      prisma.importJob.create({
        data: {
          tenantId: tenant.id,
          subjectId: subject.id,
          title: '違規測試 2',
          sourceType: 'TEACHER_ORIGINAL',
          licenseScope: 'PUBLIC',
          rightsBasis: 'OWNED',
          rightsDeclaredBy: teacher.id,
        },
      }),
      /import_jobs_license_matches_source/,
    );
  });

  await test('沒有權利聲明就不能建立匯入工作', async () => {
    await assert.rejects(
      prisma.importJob.create({
        data: {
          tenantId: tenant.id,
          subjectId: subject.id,
          title: '違規測試 3',
          sourceType: 'TEACHER_ORIGINAL',
          licenseScope: 'TENANT_EXPORTABLE',
        },
      }),
      /import_jobs_rights_declared/,
    );
  });

  await test('未確認權利的解析必須是 AI 改寫', async () => {
    const q = await prisma.question.create({
      data: {
        tenantId: tenant.id,
        subjectId: subject.id,
        familyId: 'fam-1',
        type: 'SINGLE_CHOICE',
        content: '測試題',
        sourceType: 'PUBLISHER_SCAN',
        licenseScope: 'TENANT_NO_EXPORT',
      },
    });
    await assert.rejects(
      prisma.explanation.create({
        data: {
          tenantId: tenant.id,
          questionId: q.id,
          origin: 'VERBATIM_IMPORT',
          rightsBasis: 'UNVERIFIED',
          licenseScope: 'TENANT_NO_EXPORT',
        },
      }),
      /explanations_unverified_must_rewrite/,
    );
    await prisma.question.delete({ where: { id: q.id } });
  });

  // ── 管線 ───────────────────────────────────────────────────

  section('管線各階段');

  const job = await prisma.importJob.create({
    data: {
      tenantId: tenant.id,
      subjectId: subject.id,
      title: '115 學測數學A（端到端測試）',
      sourceType: 'OFFICIAL_PAST',
      licenseScope: 'PUBLIC',
      rightsBasis: 'OFFICIAL_PUBLIC',
      rightsDeclaredBy: teacher.id,
      createdBy: teacher.id,
      stageDetail: { stages: {} },
    },
  });

  const file = await prisma.importFile.create({
    data: {
      jobId: job.id,
      role: 'QUESTION_BOOK',
      fileName: '115數學A試題.pdf',
      mimeType: 'application/pdf',
      sizeBytes: BigInt(pdf.length),
      storageKey: `t/${tenant.id}/import/${job.id}/src/paper.pdf`,
    },
  });

  await s3.send(
    new storage.PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: file.storageKey,
      Body: pdf,
      ContentType: 'application/pdf',
    }),
  );

  const seen = [];
  const result = await runImport(prisma, job.id, {
    onProgress: ({ stage }) => seen.push(stage),
  });

  await test('六個階段全部跑過', () => {
    assert.deepEqual(seen, STAGES);
  });

  await test('工作狀態變成待校對', async () => {
    const j = await prisma.importJob.findUnique({ where: { id: job.id } });
    assert.equal(j.status, 'READY_FOR_REVIEW');
    assert.equal(j.error, null);
    assert.equal(j.lastCompletedStage, 'DEDUPING');
  });

  await test('頁面影像寫進了物件儲存', async () => {
    const pages = await prisma.importPage.findMany({ where: { jobId: job.id } });
    assert.equal(pages.length, 1, `應有 1 頁，實得 ${pages.length}`);
    const head = await s3.send(
      new storage.HeadObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: pages[0].storageKey,
      }),
    );
    assert.ok(head.ContentLength > 1000, '頁面影像太小，可能沒真的寫進去');
  });

  await test('原生 PDF 走純程式切分，沒有用到視覺模型', async () => {
    const j = await prisma.importJob.findUnique({ where: { id: job.id } });
    assert.equal(j.stageDetail.stages.SEGMENTING.visionPages, 0);
  });

  await test('抽出了候選題', async () => {
    const n = await prisma.importCandidate.count({ where: { jobId: job.id } });
    assert.ok(n > 0, '沒有抽出任何候選題');
  });

  await test('mock provider 的候選題帶著「這是假資料」的警告', async () => {
    const c = await prisma.importCandidate.findFirst({ where: { jobId: job.id } });
    const codes = (c.confidenceReasons ?? []).map((r) => r.code);
    assert.ok(codes.includes('mock_provider'), `理由碼：${codes.join(', ')}`);
  });

  await test('自答結果寫回候選題', async () => {
    const c = await prisma.importCandidate.findFirst({ where: { jobId: job.id } });
    assert.equal(c.answerOrigin, 'AI_SOLVED');
    assert.ok(c.selfConsistency !== null);
    assert.ok(Array.isArray(c.solveTrace), '推導過程應保留給老師對照');
  });

  await test('沒有知識點時，標註階段略過而非失敗', async () => {
    const j = await prisma.importJob.findUnique({ where: { id: job.id } });
    assert.ok(j.stageDetail.stages.ANNOTATING.skipped?.includes('知識點'));
  });

  await test('每個階段都記了耗時', async () => {
    const j = await prisma.importJob.findUnique({ where: { id: job.id } });
    for (const s of STAGES) {
      assert.ok(
        typeof j.stageDetail.stages[s]?.elapsedMs === 'number',
        `${s} 沒有耗時記錄`,
      );
    }
  });

  await test('AI 用量寫進了稽核用的用量表', async () => {
    const n = await prisma.aiUsageLog.count({
      where: { refType: 'ImportJob', refId: job.id },
    });
    assert.ok(n > 0, '沒有任何用量記錄，成本就無從歸因');
  });

  // ── 續跑 ───────────────────────────────────────────────────

  section('失敗與續跑');

  await test('已完成的工作再跑一次會直接標成待校對，不重跑', async () => {
    const before = await prisma.aiUsageLog.count({
      where: { refType: 'ImportJob', refId: job.id },
    });
    const r = await runImport(prisma, job.id);
    const after = await prisma.aiUsageLog.count({
      where: { refType: 'ImportJob', refId: job.id },
    });
    assert.equal(r.alreadyDone, true);
    assert.equal(before, after, '不該產生新的 AI 呼叫');
  });

  await test('從中間階段續跑不會重跑前面的階段', async () => {
    await prisma.importJob.update({
      where: { id: job.id },
      data: { lastCompletedStage: 'EXTRACTING', status: 'FAILED' },
    });
    const seen2 = [];
    await runImport(prisma, job.id, { onProgress: ({ stage }) => seen2.push(stage) });
    assert.deepEqual(seen2, ['SOLVING', 'ANNOTATING', 'DEDUPING']);
  });

  await test('已校對的候選題不會被重跑的結構化階段清掉', async () => {
    const c = await prisma.importCandidate.findFirst({ where: { jobId: job.id } });
    await prisma.importCandidate.update({
      where: { id: c.id },
      data: { state: 'CONFIRMED', reviewedBy: teacher.id, reviewedAt: new Date() },
    });

    await prisma.importJob.update({
      where: { id: job.id },
      data: { lastCompletedStage: 'SEGMENTING', status: 'FAILED' },
    });
    await runImport(prisma, job.id);

    const still = await prisma.importCandidate.findUnique({ where: { id: c.id } });
    assert.ok(still, '老師已確認的候選題被重跑清掉了');
    assert.equal(still.state, 'CONFIRMED');
  });

  await test('檔案格式不支援時，錯誤是不可重試的', async () => {
    const bad = await prisma.importJob.create({
      data: {
        tenantId: tenant.id,
        subjectId: subject.id,
        title: '壞檔案',
        sourceType: 'TEACHER_ORIGINAL',
        licenseScope: 'TENANT_EXPORTABLE',
        rightsBasis: 'OWNED',
        rightsDeclaredBy: teacher.id,
        stageDetail: { stages: {} },
      },
    });
    const key = `t/${tenant.id}/import/${bad.id}/src/junk.bin`;
    await s3.send(
      new storage.PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: key,
        Body: Buffer.from('this is not a document'),
      }),
    );
    await prisma.importFile.create({
      data: {
        jobId: bad.id,
        role: 'QUESTION_BOOK',
        fileName: 'junk.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: BigInt(22),
        storageKey: key,
      },
    });

    await assert.rejects(runImport(prisma, bad.id), (e) => e.permanent === true);

    const j = await prisma.importJob.findUnique({ where: { id: bad.id } });
    assert.equal(j.status, 'FAILED');
    assert.ok(j.error.includes('檔案處理失敗'), j.error);
    assert.ok(
      j.error.includes('重試沒有幫助'),
      '不可重試的錯誤要明說重試沒用，否則老師會一直按',
    );
    assert.equal(j.stageDetail.permanent, true);
  });

  // ── 入庫 ───────────────────────────────────────────────────

  section('候選題入庫');

  await test('未確認的候選題不會入庫', async () => {
    const r = await commitJob(prisma, job.id, tenant.id, teacher.id);
    const confirmed = await prisma.importCandidate.count({
      where: { jobId: job.id, state: 'CONFIRMED' },
    });
    assert.equal(r.committed, confirmed, '只該寫入已確認的');
  });

  await test('入庫後題目帶著正確的來源與授權', async () => {
    const q = await prisma.question.findFirst({ where: { sourceImportJobId: job.id } });
    assert.ok(q, '沒有任何題目入庫');
    assert.equal(q.sourceType, 'OFFICIAL_PAST');
    assert.equal(q.licenseScope, 'PUBLIC');
    assert.equal(q.status, 'DRAFT', '入庫是草稿，發布是另一個決定');
    assert.ok(q.sourceRef?.includes('115'), `來源標註要能回頭找到原稿：${q.sourceRef}`);
    assert.ok(q.familyId, 'familyId 是跨版本的識別，不能是空的');
  });

  await test('選項一起寫進去，且序號從 1 連續', async () => {
    const q = await prisma.question.findFirst({ where: { sourceImportJobId: job.id } });
    const opts = await prisma.questionOption.findMany({ where: { questionId: q.id } });
    assert.ok(opts.length >= 2, `選擇題應該有選項，實得 ${opts.length}`);
    const orders = opts.map((o) => o.order).sort((a, b) => a - b);
    assert.deepEqual(orders, orders.map((_, i) => i + 1));
  });

  await test('候選題記住它變成了哪一題', async () => {
    const c = await prisma.importCandidate.findFirst({
      where: { jobId: job.id, state: 'CONFIRMED' },
    });
    assert.ok(c.questionId, '沒有回填 questionId，重跑入庫會產生重複題目');
  });

  await test('重跑入庫不會產生重複題目', async () => {
    const before = await prisma.question.count({ where: { sourceImportJobId: job.id } });
    const r = await commitJob(prisma, job.id, tenant.id, teacher.id);
    const after = await prisma.question.count({ where: { sourceImportJobId: job.id } });
    assert.equal(r.committed, 0);
    assert.equal(before, after);
  });

  await test('權利未確認時不原文收錄詳解', async () => {
    const j2 = await prisma.importJob.create({
      data: {
        tenantId: tenant.id,
        subjectId: subject.id,
        title: '未確認權利的講義',
        sourceType: 'PUBLISHER_SCAN',
        licenseScope: 'TENANT_NO_EXPORT',
        rightsBasis: 'UNVERIFIED',
        rightsDeclaredBy: teacher.id,
        stageDetail: { stages: {} },
      },
    });
    await prisma.importCandidate.create({
      data: {
        jobId: j2.id,
        order: 1,
        type: 'SINGLE_CHOICE',
        content: '測試題幹',
        options: [
          { order: 1, label: '1', content: '甲' },
          { order: 2, label: '2', content: '乙' },
        ],
        explanationRaw: '這是出版社的詳解原文，受著作權保護。',
        state: 'CONFIRMED',
        reviewedBy: teacher.id,
        reviewedAt: new Date(),
      },
    });

    const r = await commitJob(prisma, j2.id, tenant.id, teacher.id);
    assert.equal(r.committed, 1);
    assert.equal(r.explanations, 0, '權利未確認就不該建解析列');
    assert.equal(r.pendingRewrite, 1);

    const q = await prisma.question.findFirst({ where: { sourceImportJobId: j2.id } });
    const ex = await prisma.explanation.count({ where: { questionId: q.id } });
    assert.equal(ex, 0);
    assert.ok(q.qualityFlags?.explanationPendingRewrite, '要標記出來，否則沒有人知道還缺一份解析');

    // 原文不可以遺失——它還留在候選題上等改寫
    const c = await prisma.importCandidate.findFirst({ where: { jobId: j2.id } });
    assert.ok(c.explanationRaw?.includes('著作權'), '原文不該被丟掉');
  });

  await test('權利確認過就原文收錄詳解', async () => {
    const j3 = await prisma.importJob.create({
      data: {
        tenantId: tenant.id,
        subjectId: subject.id,
        title: '老師自編講義',
        sourceType: 'TEACHER_ORIGINAL',
        licenseScope: 'TENANT_EXPORTABLE',
        rightsBasis: 'OWNED',
        rightsDeclaredBy: teacher.id,
        stageDetail: { stages: {} },
      },
    });
    await prisma.importCandidate.create({
      data: {
        jobId: j3.id,
        order: 1,
        type: 'SHORT_ANSWER',
        content: '試證明之。',
        explanationRaw: '由三角不等式可得。',
        state: 'CONFIRMED',
        reviewedBy: teacher.id,
        reviewedAt: new Date(),
      },
    });

    const r = await commitJob(prisma, j3.id, tenant.id, teacher.id);
    assert.equal(r.explanations, 1);
    const q = await prisma.question.findFirst({ where: { sourceImportJobId: j3.id } });
    const ex = await prisma.explanation.findFirst({ where: { questionId: q.id } });
    assert.equal(ex.origin, 'VERBATIM_IMPORT');
    assert.equal(ex.isPrimary, true);
    assert.equal(ex.displayMode, 'FULL');
  });

  await test('入庫寫進稽核記錄', async () => {
    const n = await prisma.auditLog.count({
      where: { action: 'import.commit', targetId: job.id },
    });
    assert.ok(n >= 1, '入庫是題庫異動，一定要留下痕跡');
  });

  await test('全國答對率一路帶到題庫，並成為難度的先驗', async () => {
    const j4 = await prisma.importJob.create({
      data: {
        tenantId: tenant.id,
        createdBy: teacher.id,
        subjectId: subject.id,
        title: '社會考古題',
        sourceType: 'OFFICIAL_PAST',
        licenseScope: 'PUBLIC',
        rightsBasis: 'OFFICIAL_PUBLIC',
        rightsDeclaredBy: teacher.id,
        stageDetail: { stages: {} },
      },
    });
    await prisma.importCandidate.create({
      data: {
        jobId: j4.id,
        order: 1,
        type: 'SINGLE_CHOICE',
        content: '某公司違反勞動基準法第 49 條，下列敘述何者正確？',
        options: [
          { order: 1, label: '(A)', content: '司法院大法官' },
          { order: 2, label: '(B)', content: '最高行政法院' },
        ],
        sourceExam: '115學測',
        nationalCorrectRate: 0.39,
        state: 'CONFIRMED',
        reviewedBy: teacher.id,
        reviewedAt: new Date(),
      },
    });

    await commitJob(prisma, j4.id, tenant.id, teacher.id);
    const q = await prisma.question.findFirst({ where: { sourceImportJobId: j4.id } });
    assert.equal(q.nationalCorrectRate, 0.39);
    assert.equal(q.sourceExam, '115學測');
    // difficulty 的慣例是 1 = 最難，而答對率越高越簡單
    assert.ok(
      Math.abs(q.difficulty - 0.61) < 1e-9,
      `難度應由答對率推得，實得 ${q.difficulty}`,
    );
    // 本班的答對率是另一回事，不可以被外部數字污染
    assert.equal(q.correctRate, null, '全國答對率不該寫進本班的 correctRate');
  });

  await test('答對率超出 0–1 會被資料庫擋下來', async () => {
    // 應用層寫錯成百分數（43 而不是 0.43）的時候，能力分析會算出
    // 「比全國高 4200%」這種數字而完全不報錯。約束要在資料庫，
    // 因為應用層的檢查會被下一個直接寫 SQL 的人繞過。
    await assert.rejects(
      prisma.$executeRawUnsafe(
        `UPDATE questions SET "nationalCorrectRate" = 43 WHERE "sourceExam" = '115學測'`,
      ),
      /national_rate_range|violates check constraint/i,
    );
  });

  // ── 收尾 ───────────────────────────────────────────────────

  console.log(`\n${passed}/${passed + failed} 通過`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error('\n測試本身出錯：', e);
  await prisma.$disconnect();
  process.exit(1);
});
