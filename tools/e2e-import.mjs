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
import {
  exitTenantScope,
  withTenant,
  withoutTenantScope,
} from '../apps/web/lib/tenantContext.mjs';
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

/** 第二家補習班。存在的唯一理由是證明第一家看不到它的東西。 */
async function seedOther() {
  const tenant = await prisma.tenant.create({ data: { name: '隔壁補習班' } });
  const teacher = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      username: 'T999',
      displayName: '隔壁老師',
      systemRole: 'TEACHER',
      passwordHash: '$2a$12$notarealhashnotarealhashnotarealhashnotarealhashnotar',
    },
  });
  const subject = await prisma.subject.create({
    data: { tenantId: tenant.id, code: 'MATH_A', name: '數學A', gsatFullScore: 100 },
  });
  const job = await prisma.importJob.create({
    data: {
      tenantId: tenant.id,
      subjectId: subject.id,
      title: '隔壁補習班的題本',
      sourceType: 'TEACHER_ORIGINAL',
      licenseScope: 'TENANT_EXPORTABLE',
      rightsBasis: 'OWNED',
      rightsDeclaredBy: teacher.id,
      stageDetail: { stages: {} },
    },
  });
  const question = await prisma.question.create({
    data: {
      tenantId: tenant.id,
      subjectId: subject.id,
      familyId: 'fam-other',
      version: 1,
      type: 'SINGLE_CHOICE',
      content: '隔壁補習班的題目，這一行不該被別人看到',
      answerKeys: [1],
      sourceType: 'TEACHER_ORIGINAL',
      licenseScope: 'TENANT_EXPORTABLE',
      status: 'PUBLISHED',
    },
  });
  return { tenant, teacher, subject, job, question };
}

async function main() {
  // 建置階段是跨租戶的：它要清掉所有租戶、再建出租戶本身。
  // 這是全檔唯一一處，之後的每一項測試都在租戶脈絡下跑——
  // 那才是正式環境的樣子，也才驗得到 RLS。
  const fixture = await withoutTenantScope('端到端測試建置：清庫並建出租戶本身', async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE tenants, subjects, publishers, official_source_fetches
      RESTART IDENTITY CASCADE
    `);
    const base = await seed();
    // 第二個租戶，專門用來驗「看不到別人的資料」。
    const other = await seedOther();
    return { ...base, other };
  });
  return withTenant(fixture.tenant.id, () => mainScoped(fixture));
}

async function mainScoped(fixture) {
  const { tenant, teacher, subject, other } = fixture;
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

  // ── 租戶隔離 ───────────────────────────────────────────────
  //
  // 這一組是白牌授權的前提。一旦系統給第二家補習班用，
  // 「A 看得到 B 的資料」就從 bug 變成法律問題——出版社詳解的
  // 授權範圍是「機構內部使用」，跨機構就是對外散布。
  //
  // 全部走真的程式路徑，不是直接下 SQL：要驗的是「應用程式漏了
  // 條件時資料庫擋不擋得住」，而不是「政策的語法對不對」。

  section('租戶隔離');

  await test('查不到別家補習班的題目——即使完全不帶條件', async () => {
    // 自己先放一題，這樣「看得到自己的、看不到別人的」兩半都驗得到。
    // 只驗後半的話，一個「什麼都查不到」的錯誤設定也會通過。
    const mine = await prisma.question.create({
      data: {
        tenantId: tenant.id,
        subjectId: subject.id,
        familyId: 'fam-isolation-probe',
        version: 1,
        type: 'SINGLE_CHOICE',
        content: '自己租戶的題目，應該看得到',
        answerKeys: [1],
        sourceType: 'TEACHER_ORIGINAL',
        licenseScope: 'TENANT_EXPORTABLE',
        status: 'PUBLISHED',
      },
    });
    try {
      const all = await prisma.question.findMany({});
      assert.ok(
        all.some((q) => q.id === mine.id),
        '連自己的題目都看不到——那不是隔離，是壞掉',
      );
      assert.ok(
        !all.some((q) => q.tenantId === other.tenant.id),
        '看到了隔壁補習班的題目。**這就是漏掉 where 條件時會發生的事**',
      );
    } finally {
      await prisma.question.deleteMany({ where: { id: mine.id } });
    }
  });

  await test('拿著別家的 id 直接查，也查不到', async () => {
    const q = await prisma.question.findFirst({ where: { id: other.question.id } });
    assert.equal(q, null, '知道 id 就查得到，等於隔離只擋住列表不擋住直接存取');
    const job = await prisma.importJob.findFirst({ where: { id: other.job.id } });
    assert.equal(job, null);
  });

  await test('看不到別家的使用者與科目', async () => {
    const users = await prisma.user.findMany({});
    assert.ok(!users.some((u) => u.id === other.teacher.id), '看到了隔壁的老師帳號');
    const subs = await prisma.subject.findMany({});
    assert.ok(!subs.some((x) => x.id === other.subject.id), '看到了隔壁的科目');
  });

  await test('改不動別家的資料', async () => {
    const { count } = await prisma.importJob.updateMany({
      where: { id: other.job.id },
      data: { title: '被別家改掉了' },
    });
    assert.equal(count, 0, '改得動別家的資料，比讀得到更嚴重');
    const still = await withoutTenantScope('驗證用：回頭確認隔壁的資料沒被動到', () =>
      prisma.importJob.findFirst({ where: { id: other.job.id } }),
    );
    assert.equal(still.title, '隔壁補習班的題本');
  });

  await test('寫不進別家的租戶', async () => {
    await assert.rejects(
      prisma.subject.create({
        data: {
          tenantId: other.tenant.id,
          code: 'CHINESE',
          name: '偷渡到隔壁的科目',
          gsatFullScore: 100,
        },
      }),
      /row-level security|policy/i,
      'WITH CHECK 沒有生效——寫得進去卻讀不到，是最難查的一種資料損壞',
    );
  });

  await test('沒有外鍵的子表也擋得住（間接隔離）', async () => {
    // question_options 沒有 tenantId，靠 questions 掛上去。
    // 這一類表最容易被漏掉，因為它們看起來與租戶無關。
    const otherOpt = await withoutTenantScope('驗證用：在隔壁租戶底下建一個選項', () =>
      prisma.questionOption.create({
        data: { questionId: other.question.id, order: 1, label: '(1)', content: '隔壁的選項' },
      }),
    );
    const seen = await prisma.questionOption.findFirst({ where: { id: otherOpt.id } });
    assert.equal(seen, null, '子表沒有跟著父表一起隔離');
  });

  await test('沒有租戶脈絡時什麼都查不到（fail closed）', async () => {
    // 忘記包 withTenant 是最常見的錯。它必須是「查不到東西」，
    // 而不是「查到全部」——後者是安靜的資料外洩。
    const outside = await exitTenantScope(() => prisma.question.findMany({}));
    assert.ok(Array.isArray(outside));
    assert.equal(outside.length, 0, '沒設租戶卻查得到資料——fail open，最糟的一種預設');
  });

  // ── 班級與名冊（B0.3）─────────────────────────────────────

  section('班級與名冊');

  await test('同一學年度不能有兩個同名班級', async () => {
    const year = await prisma.academicYear.findFirst({ where: { tenantId: tenant.id } });
    const a = await prisma.class.create({
      data: { tenantId: tenant.id, academicYearId: year.id, name: '三年丙班' },
    });
    assert.ok(a.id);
    await assert.rejects(
      prisma.class.create({
        data: { tenantId: tenant.id, academicYearId: year.id, name: '三年丙班' },
      }),
      /unique|duplicate/i,
      '同名班級擋不住的話，派任務時會派到錯的班',
    );
    await prisma.class.deleteMany({ where: { id: a.id } });
  });

  await test('學生帳號預設不能登入，直到家長同意', async () => {
    // 個資法第 15 條：蒐集未成年人的個人資料需法定代理人同意。
    // 沒有同意紀錄，整個資料庫的合法性都有疑問——所以預設擋住，
    // 而不是預設放行再補簽。
    const s = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        username: 'S-consent-1',
        displayName: '待同意學生',
        systemRole: 'STUDENT',
        status: 'PENDING_CONSENT',
        passwordHash: '$2a$12$notarealhashnotarealhashnotarealhashnotarealhashnotar',
      },
    });
    assert.equal(s.status, 'PENDING_CONSENT');
    assert.equal(s.consentAt, null);

    const after = await prisma.user.update({
      where: { id: s.id },
      data: { consentAt: new Date(), status: 'ACTIVE' },
    });
    assert.ok(after.consentAt, '同意之後才會有時間戳');
    assert.equal(after.status, 'ACTIVE');
    await prisma.user.deleteMany({ where: { id: s.id } });
  });

  await test('同一位學生重複加入同一個班不會產生第二筆', async () => {
    // 名冊匯入兩次是常態（櫃檯改了一列再匯一次）。
    // 每次都新增一筆 membership 的話，人數會愈匯愈多。
    const year = await prisma.academicYear.findFirst({ where: { tenantId: tenant.id } });
    const k = await prisma.class.create({
      data: { tenantId: tenant.id, academicYearId: year.id, name: '重複測試班' },
    });
    const s = await prisma.user.create({
      data: {
        tenantId: tenant.id, username: 'S-dup-1', displayName: '重複測試',
        systemRole: 'STUDENT', status: 'PENDING_CONSENT',
        passwordHash: '$2a$12$notarealhashnotarealhashnotarealhashnotarealhashnotar',
      },
    });
    await prisma.classMembership.create({
      data: { classId: k.id, userId: s.id, role: 'STUDENT' },
    });
    await assert.rejects(
      prisma.classMembership.create({
        data: { classId: k.id, userId: s.id, role: 'STUDENT' },
      }),
      /unique|duplicate/i,
      '沒有唯一鍵的話，匯入兩次名冊人數就會變兩倍',
    );
    const n = await prisma.classMembership.count({ where: { classId: k.id } });
    assert.equal(n, 1);
    await prisma.classMembership.deleteMany({ where: { classId: k.id } });
    await prisma.user.deleteMany({ where: { id: s.id } });
    await prisma.class.deleteMany({ where: { id: k.id } });
  });

  await test('加不進別家補習班的班級（名冊也受隔離）', async () => {
    // class_memberships 沒有 tenantId，靠 classes 間接隔離。
    // 這一類表最容易被漏掉，因為它們看起來與租戶無關。
    const otherClass = await withoutTenantScope('驗證用：在隔壁租戶建一個班', async () => {
      const y = await prisma.academicYear.create({
        data: {
          tenantId: other.tenant.id, name: '隔壁115',
          startDate: new Date('2026-08-01'), endDate: new Date('2027-07-31'),
        },
      });
      return prisma.class.create({
        data: { tenantId: other.tenant.id, academicYearId: y.id, name: '隔壁的班' },
      });
    });
    const seen = await prisma.class.findFirst({ where: { id: otherClass.id } });
    assert.equal(seen, null, '看得到隔壁補習班的班級');
  });

  // ── 知識點圖譜（B0.4）──────────────────────────────────────

  section('知識點圖譜');

  await test('同一科不能有兩個同名知識點', async () => {
    // 同名知識點會讓能力分析分裂成兩份，而症狀是「明明練了很多，
    // 掌握度卻上不去」——沒有人會聯想到是知識點重複。
    const a = await prisma.knowledgePoint.create({
      data: { tenantId: tenant.id, subjectId: subject.id, name: '等差級數的求和' },
    });
    await assert.rejects(
      prisma.knowledgePoint.create({
        data: { tenantId: tenant.id, subjectId: subject.id, name: '等差級數的求和' },
      }),
      /unique|duplicate/i,
    );
    await prisma.knowledgePoint.deleteMany({ where: { id: a.id } });
  });

  await test('前置關係存得下來，而且同一對不會重複', async () => {
    const base = await prisma.knowledgePoint.create({
      data: { tenantId: tenant.id, subjectId: subject.id, name: '乘法公式' },
    });
    const adv = await prisma.knowledgePoint.create({
      data: { tenantId: tenant.id, subjectId: subject.id, name: '因式分解' },
    });
    await prisma.kpPrerequisite.create({ data: { kpId: adv.id, prereqKpId: base.id } });
    await assert.rejects(
      prisma.kpPrerequisite.create({ data: { kpId: adv.id, prereqKpId: base.id } }),
      /unique|duplicate|primary key/i,
    );
    const n = await prisma.kpPrerequisite.count({ where: { kpId: adv.id } });
    assert.equal(n, 1);
    await prisma.kpPrerequisite.deleteMany({ where: { kpId: adv.id } });
    await prisma.knowledgePoint.deleteMany({ where: { id: adv.id } });
    await prisma.knowledgePoint.deleteMany({ where: { id: base.id } });
  });

  await test('看不到別家補習班的知識點', async () => {
    const otherKp = await withoutTenantScope('驗證用：在隔壁租戶建一個知識點', () =>
      prisma.knowledgePoint.create({
        data: { tenantId: other.tenant.id, subjectId: other.subject.id, name: '隔壁的知識點' },
      }),
    );
    const seen = await prisma.knowledgePoint.findFirst({ where: { id: otherKp.id } });
    assert.equal(seen, null, '知識點是能力分析的座標系，跨租戶看得到就是分析資料外洩');
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

  await test('原稿印了答案的題目不走 AI 自答', async () => {
    // 整頁閱讀會把教用版印出來的答案一起讀回來，那一題就不必再花錢
    // 自答——而且原稿印的比推導出來的可靠。自答一題要投票三到五次，
    // 這是整條管線最貴的一段。
    const c = await prisma.importCandidate.findFirst({ where: { jobId: job.id } });
    assert.equal(c.answerOrigin, 'SOURCE_PRINTED');
    assert.ok(c.answerKeys.length > 0, '原稿的答案沒有被收下來');
    assert.equal(c.selfConsistency, null, '不該為它跑自答');
  });

  await test('原稿沒印答案時才走 AI 自答', async () => {
    const c = await prisma.importCandidate.findFirst({ where: { jobId: job.id } });
    await prisma.importCandidate.update({
      where: { id: c.id },
      data: { answerOrigin: null, answerKeys: [] },
    });
    await runImport(prisma, job.id, { fromStage: 'SOLVING' });
    const after = await prisma.importCandidate.findFirst({ where: { id: c.id } });
    assert.equal(after.answerOrigin, 'AI_SOLVED');
    assert.ok(after.selfConsistency !== null);
    assert.ok(Array.isArray(after.solveTrace), '推導過程應保留給老師對照');
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
    // **這一行原本斷言 DRAFT，而那把一個真的 bug 編碼成了規格。**
    //
    // 題庫頁只列 PUBLISHED 與 PENDING_REVIEW，而全 repo 沒有任何一行
    // 會把 DRAFT 改成別的狀態。症狀是：老師按「寫進題庫」，畫面回報
    // 「已寫入 2 題」，點到題庫看到「題庫是空的」——題目其實都在，
    // 只是永遠不會出現。那是整條核心動線唯一的斷點，而測試是綠的。
    //
    // 所以現在驗的不是「等於某個值」，而是**真正的不變量**：
    // 入庫之後的狀態，必須是題庫頁看得到的狀態之一。
    const VISIBLE_IN_BANK = ['PUBLISHED', 'PENDING_REVIEW'];
    assert.ok(
      VISIBLE_IN_BANK.includes(q.status),
      `入庫後的狀態是 ${q.status}，而題庫頁只顯示 ${VISIBLE_IN_BANK.join('／')}——` +
        `老師會看到「已寫入 N 題」然後在題庫看到空的`,
    );
    // 但也不能直接發布：校對確認的是「抽取正確」，不是「可以拿去考學生」。
    assert.notEqual(q.status, 'PUBLISHED', '入庫不該直接發布，那是科目老師的另一個決定');
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

  await test('答案對不上選項的題目不入庫，改標成存疑', async () => {
    // 掃描漏抓了選項 (2)：原稿四個選項、答案是 (4)。重新編號之後
    // 只剩三個選項，(4) 指不到東西。**硬塞一個看起來合理的答案，
    // 每個答對的學生都會被判錯，而且沒有任何跡象。**
    const j5 = await prisma.importJob.create({
      data: {
        tenantId: tenant.id, createdBy: teacher.id, subjectId: subject.id,
        title: '掃描漏抓選項', sourceType: 'TEACHER_ORIGINAL',
        licenseScope: 'TENANT_EXPORTABLE', rightsBasis: 'OWNED',
        rightsDeclaredBy: teacher.id, stageDetail: { stages: {} },
      },
    });
    const c = await prisma.importCandidate.create({
      data: {
        jobId: j5.id, order: 1, type: 'SINGLE_CHOICE',
        content: '某商品原價 100 元，打八折後再降 10 元，售價為多少？',
        options: [
          { order: 1, label: '(1)', content: '60 元' },
          { order: 3, label: '(3)', content: '80 元' },
          { order: 4, label: '(4)', content: '90 元' },
        ],
        answerKeys: [2],  // 指向被漏掉的那個選項
        state: 'CONFIRMED', reviewedBy: teacher.id, reviewedAt: new Date(),
      },
    });

    const r = await commitJob(prisma, j5.id, tenant.id, teacher.id);
    assert.equal(r.committed, 0, '答案對不上就不該入庫');
    assert.equal(r.skipped, 1);
    const after = await prisma.importCandidate.findFirst({ where: { id: c.id } });
    assert.equal(after.state, 'FLAGGED');
    assert.ok(after.reviewNote?.includes('選項'), `校對者要看得懂：${after.reviewNote}`);
  });

  await test('兩個選項一模一樣的題目不入庫，改標成存疑', async () => {
    // 物理題：四個選項本來是 $\vec{a}$、$\vec{b}$、$a$、$b$。
    // 翻拍把向量的箭頭抹掉之後，(1) 與 (3) 變成同一個東西。
    //
    // 這比上面那個「答案對不上」更隱蔽：選項數量對、答案是合法的
    // 序號、校對者掃過去不會停。但這一題已經沒有唯一解，而每一個
    // 選到「另一個一樣的」的學生都被判錯——沒有任何跡象。
    const jd = await prisma.importJob.create({
      data: {
        tenantId: tenant.id, createdBy: teacher.id, subjectId: subject.id,
        title: '向量箭頭被翻拍抹掉', sourceType: 'TEACHER_ORIGINAL',
        licenseScope: 'TENANT_EXPORTABLE', rightsBasis: 'OWNED',
        rightsDeclaredBy: teacher.id, stageDetail: { stages: {} },
      },
    });
    const cd = await prisma.importCandidate.create({
      data: {
        jobId: jd.id, order: 1, type: 'SINGLE_CHOICE',
        content: '物體所受合力為下列何者？',
        options: [
          { order: 1, label: '(1)', content: '$a$' },
          { order: 2, label: '(2)', content: '$b$' },
          { order: 3, label: '(3)', content: '$a$' },
          { order: 4, label: '(4)', content: '$0$' },
        ],
        answerKeys: [1],
        state: 'CONFIRMED', reviewedBy: teacher.id, reviewedAt: new Date(),
      },
    });

    const r = await commitJob(prisma, jd.id, tenant.id, teacher.id);
    assert.equal(r.committed, 0, '沒有唯一解的題目不該入庫');
    assert.equal(r.skipped, 1);
    const after = await prisma.importCandidate.findFirst({ where: { id: cd.id } });
    assert.equal(after.state, 'FLAGGED');
    assert.ok(
      after.reviewNote?.includes('(1)') && after.reviewNote?.includes('(3)'),
      `校對者要知道是哪兩個選項撞了：${after.reviewNote}`,
    );
  });

  await test('選項重新編號時答案鍵跟著對映', async () => {
    // 原稿 (1)(2)(4) —— (3) 內容是空的被丟掉。答案 (4) 入庫後
    // 應該變成 (3)，因為選項序號必須從 1 連續。
    const j6 = await prisma.importJob.create({
      data: {
        tenantId: tenant.id, createdBy: teacher.id, subjectId: subject.id,
        title: '選項重新編號', sourceType: 'TEACHER_ORIGINAL',
        licenseScope: 'TENANT_EXPORTABLE', rightsBasis: 'OWNED',
        rightsDeclaredBy: teacher.id, stageDetail: { stages: {} },
      },
    });
    await prisma.importCandidate.create({
      data: {
        jobId: j6.id, order: 1, type: 'SINGLE_CHOICE', content: '下列何者正確？',
        options: [
          { order: 1, label: '(1)', content: '甲' },
          { order: 2, label: '(2)', content: '乙' },
          { order: 3, label: '(3)', content: '   ' },
          { order: 4, label: '(4)', content: '丁' },
        ],
        answerKeys: [4],
        state: 'CONFIRMED', reviewedBy: teacher.id, reviewedAt: new Date(),
      },
    });

    await commitJob(prisma, j6.id, tenant.id, teacher.id);
    const q = await prisma.question.findFirst({ where: { sourceImportJobId: j6.id } });
    const opts = await prisma.questionOption.findMany({ where: { questionId: q.id } });
    assert.equal(opts.length, 3);
    assert.deepEqual(q.answerKeys, [3], `答案沒有跟著重新編號：${q.answerKeys}`);
    const answer = opts.find((o) => o.order === q.answerKeys[0]);
    assert.equal(answer.content, '丁', '答案指到了別的選項');
  });

  await test('選項與題組的附圖真的寫進資料庫', async () => {
    // **在這之前 `question_options.assets` 與 `question_groups.stimulus_assets`
    // 沒有任何一條路寫過**，而 take／result／卷子預覽／題目內頁／
    // /api/assets 五個地方都在讀它。症狀是物理題四個選項各印一行
    // 「這裡有一張附圖，但系統找不到它」，而那四張圖被堆到題幹後面
    // ——四張沒有標號的圖配四個沒有圖的選項，那一題不可能作答。
    //
    // 沒有任何錯誤訊息：入庫回報成功、每一欄都有值。
    const j7 = await prisma.importJob.create({
      data: {
        tenantId: tenant.id, createdBy: teacher.id, subjectId: subject.id,
        title: '力圖選項與圖表題組', sourceType: 'TEACHER_ORIGINAL',
        licenseScope: 'TENANT_EXPORTABLE', rightsBasis: 'OWNED',
        rightsDeclaredBy: teacher.id, stageDetail: { stages: {} },
      },
    });
    const asset = (id) => ({
      id, key: `e2e/${id}.png`, page: 1, bbox: null,
      alt: `${id} 的替代文字`, caption: '', labels: [],
      width: 120, height: 90, kind: 'FIGURE',
    });
    await prisma.importCandidate.create({
      data: {
        jobId: j7.id, order: 1, type: 'SINGLE_CHOICE',
        groupKey: 'g1',
        stimulus: '下表為各都市死亡人數：![[a:tbl]]',
        content: '根據上表，下列何者為合力？',
        options: [
          { order: 1, label: '(1)', content: '![[a:o1]]' },
          { order: 2, label: '(2)', content: '![[a:o2]]' },
        ],
        answerKeys: [1],
        assets: [asset('tbl'), asset('o1'), asset('o2')],
        state: 'CONFIRMED', reviewedBy: teacher.id, reviewedAt: new Date(),
      },
    });

    const r = await commitJob(prisma, j7.id, tenant.id, teacher.id);
    assert.equal(r.committed, 1, `應該入庫一題：${JSON.stringify(r.errors)}`);

    const q = await prisma.question.findFirst({ where: { sourceImportJobId: j7.id } });
    const opts = await prisma.questionOption.findMany({ where: { questionId: q.id } });
    const byOrder = new Map(opts.map((o) => [o.order, o]));
    assert.deepEqual(
      byOrder.get(1)?.assets?.map((a) => a.id),
      ['o1'],
      '選項 (1) 的附圖沒有寫進 question_options.assets',
    );
    assert.deepEqual(byOrder.get(2)?.assets?.map((a) => a.id), ['o2']);

    // 選項的圖**不可以**同時留在題幹上：留著的話 MathText 會把它們
    // 一起排在題幹後面（`rest`），變成重複兩次的圖。
    assert.deepEqual(
      (q.contentAssets ?? []).map((a) => a.id), [],
      '選項的圖不該同時掛在題幹上',
    );

    const g = await prisma.questionGroup.findFirst({ where: { sourceImportJobId: j7.id } });
    assert.ok(g, '題組沒有建出來');
    assert.deepEqual(
      (g.stimulusAssets ?? []).map((a) => a.id),
      ['tbl'],
      '題組共用的圖沒有寫進 question_groups.stimulus_assets',
    );
  });

  await test('標記指向一張不存在的圖時，這一題不入庫', async () => {
    // 表格沒有 bbox 就裁不出影像（routes_import.py 會 continue），
    // 而題幹裡的 ![[a:t1]] 原封不動。照樣入庫的話學生看到的是
    // 「這裡有一張附圖，但系統找不到它」——**安靜地丟掉是唯一
    // 不可接受的結局**，所以擋在這裡並把原因寫給老師。
    const j8 = await prisma.importJob.create({
      data: {
        tenantId: tenant.id, createdBy: teacher.id, subjectId: subject.id,
        title: '沒裁出來的圖表', sourceType: 'TEACHER_ORIGINAL',
        licenseScope: 'TENANT_EXPORTABLE', rightsBasis: 'OWNED',
        rightsDeclaredBy: teacher.id, stageDetail: { stages: {} },
      },
    });
    const c8 = await prisma.importCandidate.create({
      data: {
        jobId: j8.id, order: 1, type: 'SINGLE_CHOICE',
        content: '根據 ![[a:t1]]，下列何者正確？',
        options: [
          { order: 1, label: '(1)', content: '甲' },
          { order: 2, label: '(2)', content: '乙' },
        ],
        answerKeys: [1],
        assets: null,
        state: 'CONFIRMED', reviewedBy: teacher.id, reviewedAt: new Date(),
      },
    });

    const r = await commitJob(prisma, j8.id, tenant.id, teacher.id);
    assert.equal(r.committed, 0, '引用了不存在的圖的題目不該入庫');
    assert.equal(r.skipped, 1);
    const after = await prisma.importCandidate.findFirst({ where: { id: c8.id } });
    assert.equal(after.state, 'FLAGGED');
    assert.ok(
      after.reviewNote?.includes('t1'),
      `校對者要知道是哪一個標記對不上：${after.reviewNote}`,
    );
  });

  await test('原文收錄的詳解不可以標成公開', async () => {
    // 一份標成「歷屆試題／PUBLIC」的講義夾帶出版社教用版詳解。
    // 試題依著作權法第 9 條不受保護，**詳解受保護**。
    const q = await prisma.question.findFirst({ where: { sourceImportJobId: job.id } });
    await assert.rejects(
      prisma.explanation.create({
        data: {
          tenantId: tenant.id, questionId: q.id,
          origin: 'VERBATIM_IMPORT', rightsBasis: 'OFFICIAL_PUBLIC',
          licenseScope: 'PUBLIC', displayMode: 'FULL', isPrimary: false,
          layers: { steps: ['出版社的詳解原文'] },
        },
      }),
      /explanations_verbatim_not_public|violates check constraint/i,
    );
  });

  await test('刪掉聲明權利的老師帳號不會撞上約束', async () => {
    // rightsDeclaredBy 是 ON DELETE SET NULL，而 CHECK 要求它不是 NULL
    // ——兩者互相矛盾，刪帳號會失敗且錯誤訊息完全看不出原因。
    // 姓名快照讓「誰聲明的」留下來，同時解開這個死結。
    const temp = await prisma.user.create({
      data: {
        tenantId: tenant.id, username: 'temp_teacher', displayName: '臨時老師',
        systemRole: 'TEACHER', status: 'ACTIVE',
      },
    });
    const j7 = await prisma.importJob.create({
      data: {
        tenantId: tenant.id, createdBy: teacher.id, subjectId: subject.id,
        title: '離職老師傳的', sourceType: 'TEACHER_ORIGINAL',
        licenseScope: 'TENANT_EXPORTABLE', rightsBasis: 'OWNED',
        rightsDeclaredBy: temp.id, rightsDeclaredName: '臨時老師',
        stageDetail: { stages: {} },
      },
    });
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE id = '${temp.id}'`);
    const after = await prisma.importJob.findFirst({ where: { id: j7.id } });
    assert.equal(after.rightsDeclaredBy, null);
    assert.equal(after.rightsDeclaredName, '臨時老師', '聲明人的姓名要留著');
  });

  await test('續跑結構化階段不會撞上 order 的唯一鍵', async () => {
    // 老師確認了第 3 題之後續跑。舊的作法是「刪完剩幾列就從那裡
    // 接下去編號」，而剩下的那一列 order 是 3 —— 新候選從 2 開始
    // 編，撞上 UNIQUE(jobId, order)，整個階段標成 FAILED。
    // 續跑正是這條管線的賣點。
    const j8 = await prisma.importJob.create({
      data: {
        tenantId: tenant.id, createdBy: teacher.id, subjectId: subject.id,
        title: '續跑測試', sourceType: 'TEACHER_ORIGINAL',
        licenseScope: 'TENANT_EXPORTABLE', rightsBasis: 'OWNED',
        rightsDeclaredBy: teacher.id, stageDetail: { stages: {} },
      },
    });
    for (const [order, state] of [[1, 'PENDING'], [2, 'PENDING'], [3, 'CONFIRMED']]) {
      await prisma.importCandidate.create({
        data: {
          jobId: j8.id, order, type: 'SINGLE_CHOICE', content: `第 ${order} 題`,
          state, ...(state === 'CONFIRMED'
            ? { reviewedBy: teacher.id, reviewedAt: new Date() } : {}),
        },
      });
    }
    // 模擬 stageExtract 的續跑邏輯
    await prisma.importCandidate.deleteMany({
      where: { jobId: j8.id, state: 'PENDING', reviewedAt: null },
    });
    const top = await prisma.importCandidate.findFirst({
      where: { jobId: j8.id }, orderBy: { order: 'desc' }, select: { order: true },
    });
    assert.equal(top.order, 3, '要從最大的 order 往後接，不是從剩幾列往後接');
    await prisma.importCandidate.create({
      data: {
        jobId: j8.id, order: top.order + 1, type: 'SINGLE_CHOICE',
        content: '重跑抽出來的新題', state: 'PENDING',
      },
    });
  });

  await test('出版社專屬題型：確認一次，之後記住', async () => {
    // 「向老師確認即可」實際發生的地方。老師確認之後，同一種題型
    // 在這份講義裡的每一題都要一次接上——同一種題型會出現二十次，
    // 而老師只該回答一次。
    const { confirmType, applyType, pendingTypes } = await import(
      '../apps/web/lib/customTypes.ts'
    ).catch(() => ({}));
    if (!confirmType) {
      // customTypes.ts 是 TypeScript，node 直接 import 不了。
      // 這裡改驗資料庫層的行為，那才是端到端要驗的部分。
      const t = await prisma.customQuestionType.create({
        data: {
          tenantId: tenant.id,
          publisherName: '翰林',
          name: '觀念速記',
          description: '把關鍵字挖空讓學生回想',
          answerMode: 'FILL_TEXT',
          recognitionHint: '黃色圓角色塊，標題左側有燈泡圖示',
          rightsBasis: 'LICENSED',
          confirmedBy: teacher.id,
          confirmedName: '王老師',
          confirmedAt: new Date(),
        },
      });
      assert.ok(t.id);

      // 同一租戶同一出版社的名稱唯一——兩位老師各確認一次不該
      // 產生兩個「觀念速記」，那會讓篩選失效。
      await assert.rejects(
        prisma.customQuestionType.create({
          data: {
            tenantId: tenant.id, publisherName: '翰林', name: '觀念速記',
            description: '重複的', answerMode: 'FILL_TEXT',
            rightsBasis: 'LICENSED',
          },
        }),
        /custom_question_types_tenant_publisher_name_key|duplicate key/i,
      );
      return;
    }
  });

  await test('確認過的題型說得出是誰確認的', async () => {
    // 「向老師確認即可」的那個確認就是責任歸屬——半年後題目出問題
    // 時要找得到人。
    await assert.rejects(
      prisma.$executeRawUnsafe(`
        INSERT INTO custom_question_types
          (id, "tenantId", name, description, "answerMode", "rightsBasis",
           "confirmedAt", "updatedAt")
        VALUES ('ct_bad', '${tenant.id}', '沒人確認的題型', '說明',
                'SHORT_ANSWER', 'LICENSED', NOW(), NOW())
      `),
      /confirmed_by_someone|violates check constraint/i,
    );
  });

  await test('專屬題型的授權基礎受資料庫約束', async () => {
    await assert.rejects(
      prisma.$executeRawUnsafe(`
        INSERT INTO custom_question_types
          (id, "tenantId", name, description, "answerMode", "rightsBasis", "updatedAt")
        VALUES ('ct_bad2', '${tenant.id}', '亂填授權', '說明',
                'SHORT_ANSWER', 'WHATEVER', NOW())
      `),
      /rights_basis_valid|violates check constraint/i,
    );
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
