/**
 * 入庫時附圖寫進了哪一欄。
 *
 * # 為什麼有這一支，而端到端測試不夠
 *
 * `tools/e2e-import.mjs` 也驗這件事，但它要 Postgres、S3 與 AI 服務
 * 都在跑（`tools/e2e-import.sh` 起十幾秒）。而這裡驗的是**入庫那一段
 * 純粹的搬運邏輯**：哪一張圖寫進 `question_options.assets`、哪一張寫進
 * `question_groups.stimulus_assets`、哪一張留在 `contentAssets`。
 * 那一段錯掉的症狀沒有錯誤訊息——入庫回報成功、每一欄都有值，
 * 而學生在選項裡看到一行「這裡有一張附圖，但系統找不到它」。
 *
 * 驗的對象是 `tools/commit-shim.mjs`（`lib/commit.ts` 的 .mjs 對應版，
 * 兩邊逐行對應，見那個檔案的檔頭）。假的 prisma 只記下被寫了什麼，
 * 不模擬資料庫的行為——這裡要問的問題是「寫出去的那一包長什麼樣」。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { commitJob } from '../../../tools/commit-shim.mjs';

/** 記帳用的假 prisma。只實作 commit-shim 真的會呼叫的那幾支。 */
function fakePrisma(candidates) {
  const written = {
    questions: [],
    options: [],
    groups: [],
    candidateUpdates: [],
    explanations: [],
  };
  let seq = 0;
  const job = {
    id: 'job1',
    tenantId: 't1',
    subjectId: 's1',
    title: '測試題本',
    sourceType: 'TEACHER_ORIGINAL',
    licenseScope: 'TENANT_EXPORTABLE',
    rightsBasis: 'OWNED',
    rightsDeclaredBy: 'u1',
  };
  return {
    written,
    importJob: {
      findFirst: async () => job,
      updateMany: async () => ({ count: 1 }),
      update: async () => job,
    },
    importCandidate: {
      findMany: async () => candidates,
      update: async ({ where, data }) => {
        written.candidateUpdates.push({ id: where.id, ...data });
        return {};
      },
      count: async () => 0,
    },
    questionGroup: {
      create: async ({ data }) => {
        written.groups.push(data);
        return { id: `g${++seq}` };
      },
    },
    question: {
      create: async ({ data }) => {
        written.questions.push(data);
        return { id: `q${++seq}` };
      },
      update: async () => ({}),
    },
    questionOption: {
      createMany: async ({ data }) => {
        written.options.push(...data);
        return { count: data.length };
      },
    },
    explanation: {
      create: async ({ data }) => {
        written.explanations.push(data);
        return {};
      },
    },
    auditLog: { create: async () => ({}) },
  };
}

const asset = (id) => ({
  id,
  key: `k/${id}.png`,
  page: 1,
  bbox: null,
  alt: `${id} 的替代文字`,
  caption: '',
  labels: [],
  width: 120,
  height: 90,
  kind: 'FIGURE',
});

const candidate = (extra) => ({
  id: 'c1',
  order: 1,
  questionNo: '1',
  subLabel: null,
  groupKey: null,
  label: null,
  type: 'SINGLE_CHOICE',
  content: '下列何者正確？',
  stimulus: null,
  options: [
    { order: 1, label: '(1)', content: '甲' },
    { order: 2, label: '(2)', content: '乙' },
  ],
  answerKeys: [1],
  answerSlots: null,
  answerText: null,
  score: 2,
  explanationRaw: null,
  assets: null,
  kpSuggestions: null,
  sourcePage: 1,
  sourceExam: null,
  nationalCorrectRate: null,
  questionId: null,
  ...extra,
});

test('選項的力圖寫進 QuestionOption.assets，而不是堆在題幹上', async () => {
  const p = fakePrisma([
    candidate({
      content: '下列何者為 $\\vec{F_1}$ 與 $\\vec{F_2}$ 的合力？',
      options: [
        { order: 1, label: '(1)', content: '![[a:o1]]' },
        { order: 2, label: '(2)', content: '![[a:o2]]' },
      ],
      assets: [asset('o1'), asset('o2')],
    }),
  ]);

  const r = await commitJob(p, 'job1', 't1', 'u1');
  assert.equal(r.committed, 1, JSON.stringify(r.errors));

  assert.deepEqual(p.written.options.map((o) => o.assets?.map((a) => a.id)), [['o1'], ['o2']]);
  // 題幹一張都不留：留著的話 MathText 會把兩張沒有標號的圖排在題幹
  // 後面（`rest`），而選項仍然是空的——那正是這個缺陷的樣子。
  assert.equal(p.written.questions[0].contentAssets, null);
  // 寬高要跟著走，否則圖載入完成的那一刻會把整段題幹往下推。
  assert.equal(p.written.options[0].assets[0].width, 120);
  assert.equal(p.written.options[0].assets[0].alt, 'o1 的替代文字');
});

test('題組共用的圖寫進 QuestionGroup.stimulusAssets', async () => {
  const p = fakePrisma([
    candidate({
      groupKey: 'g1',
      stimulus: '下表為各都市死亡人數：![[a:tbl]]',
      content: '根據上表，下列何者正確？',
      assets: [asset('tbl')],
    }),
  ]);

  const r = await commitJob(p, 'job1', 't1', 'u1');
  assert.equal(r.committed, 1, JSON.stringify(r.errors));
  assert.deepEqual(p.written.groups[0].stimulusAssets.map((a) => a.id), ['tbl']);
  // 題組的圖不該同時掛在題幹上，那會在每一個子題後面重複印一次。
  assert.equal(p.written.questions[0].contentAssets, null);
});

test('題幹自己的圖仍然留在 contentAssets', async () => {
  const p = fakePrisma([
    candidate({ content: '如右圖 ![[a:f1]]，角 A 為何？', assets: [asset('f1')] }),
  ]);
  await commitJob(p, 'job1', 't1', 'u1');
  assert.deepEqual(p.written.questions[0].contentAssets.map((a) => a.id), ['f1']);
});

test('沒有 id 的圖（講義那條路）仍然跟著題幹', async () => {
  // 切分階段用垂直重疊分派的圖沒有 id，題幹裡也沒有標記。
  // MathText 會把它們排在題幹後面，那是主要路徑不是補漏。
  const p = fakePrisma([
    candidate({ assets: [{ key: 'k/loose.png', width: 100, height: 80 }] }),
  ]);
  await commitJob(p, 'job1', 't1', 'u1');
  assert.equal(p.written.questions[0].contentAssets.length, 1);
  assert.equal(p.written.questions[0].contentAssets[0].id, null);
});

test('標記指向一張不存在的圖時整題退回，並說得出是哪一個', async () => {
  const p = fakePrisma([
    candidate({ content: '根據 ![[a:t1]]，下列何者正確？', assets: null }),
  ]);

  const r = await commitJob(p, 'job1', 't1', 'u1');
  assert.equal(r.committed, 0, '引用了不存在的圖的題目不該入庫');
  assert.equal(r.skipped, 1);
  assert.equal(p.written.questions.length, 0);

  const flag = p.written.candidateUpdates.find((u) => u.state === 'FLAGGED');
  assert.ok(flag, '沒有把候選題標成存疑，老師不會知道發生了什麼');
  assert.ok(flag.reviewNote.includes('t1'), flag.reviewNote);
  assert.ok(flag.reviewNote.includes('題幹'), `要說出是哪一段：${flag.reviewNote}`);
  // 訊息要說得出老師可以怎麼辦，不能只說「壞了」。
  assert.ok(flag.reviewNote.includes('|'), `要給出表格的替代寫法：${flag.reviewNote}`);
});

test('選項裡的標記對不上時也擋得住，並指出是哪一個選項', async () => {
  const p = fakePrisma([
    candidate({
      options: [
        { order: 1, label: '(1)', content: '![[a:o1]]' },
        { order: 2, label: '(2)', content: '![[a:o2]]' },
      ],
      assets: [asset('o1')],
    }),
  ]);
  const r = await commitJob(p, 'job1', 't1', 'u1');
  assert.equal(r.committed, 0);
  const flag = p.written.candidateUpdates.find((u) => u.state === 'FLAGGED');
  assert.ok(flag.reviewNote.includes('選項 ((2))') || flag.reviewNote.includes('(2)'), flag.reviewNote);
  assert.ok(flag.reviewNote.includes('o2'), flag.reviewNote);
});
