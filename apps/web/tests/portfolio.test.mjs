/**
 * 學習歷程的制度規則：件數、容量、字數、送出前的清單、AI 使用層級。
 *
 * # 這一支釘住的是「擋錯學生」這一類的錯
 *
 * 這些規則的失敗方式與別處不同：它們**擋的是學生**，而擋錯的方向特別
 * 惡劣——系統說「你超過 10 件了」而他其實只有 9 件，他會相信系統然後
 * 刪掉一件該留的。刪掉之後那件素材通常就沒了，他不會為了系統的一句話
 * 去重新做一份實驗報告。
 *
 * # 最多人搞錯的那一條有一整節
 *
 * **「多元表現綜整心得」（代碼 N）有 800 字加 3 張圖的明文限制，但它
 * 不計入 10 件多元表現的額度。**
 *
 * 寫錯的症狀是：一位已經上傳 10 件多元表現的學生，寫完綜整心得之後
 * 被系統告知「多元表現已達上限」——而綜整心得本來就是必要的一項，
 * 它不是第 11 件。他會刪掉一件真的多元表現去換位置，而那是一個純粹
 * 由 bug 造成的損失。
 *
 * 所以下面有五條測試專門測它：不計入額度、但仍檢查字數與圖片數、
 * 在邊界上（正好 10 件加一份心得）不會被擋、在「還能不能再加」那一支
 * 上也不算、以及在確認清單上顯示為「另有 N 件，不計入額度」。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AI_LEVELS,
  AI_LEVEL_UNSET,
  DEFAULT_LIMITS,
  DIVERSE_SUMMARY_CODE,
  aiDisabledReason,
  aiFeatureAllowed,
  charCountOf,
  checkFileSize,
  checkSelfStatement,
  checkSummaryEssay,
  countCentralUpload,
  countSelected,
  countsTowardDiverseQuota,
  effectiveAiLevel,
  gradeYearOf,
  itemCodeInfo,
  limitsOf,
  mayAddItem,
  mayUpdateItem,
  submissionChecklist,
} from '../lib/portfolio.mjs';

const LIMITS = limitsOf(null);

const item = (over = {}) => ({
  category: 'DIVERSE_PERFORMANCE',
  itemCode: 'G',
  title: '素材',
  semester: '高二上',
  selectedFor: [],
  ...over,
});

/** n 件真的多元表現。 */
const diverse = (n, semester = '高二上') =>
  Array.from({ length: n }, (_, i) => item({ itemCode: 'G', title: `社團 ${i}`, semester }));

// ═════════════════════════════════════════════════════════════════
// 一、綜整心得不計入 10 件額度——最多人搞錯的那一條
// ═════════════════════════════════════════════════════════════════

test('綜整心得（N）不計入多元表現的額度', () => {
  assert.equal(countsTowardDiverseQuota(item({ itemCode: 'G' })), true);
  assert.equal(countsTowardDiverseQuota(item({ itemCode: DIVERSE_SUMMARY_CODE })), false);
  // 小寫與前後空白也要認得——匯入或手打進來的代碼不保證乾淨，而
  // 認不出來的後果剛好是它被算進額度，也就是這條規則失效。
  assert.equal(countsTowardDiverseQuota(item({ itemCode: ' n ' })), false);
});

test('十件多元表現加一份綜整心得，額度上是十件不是十一件', () => {
  const items = [...diverse(10), item({ itemCode: 'N', title: '多元表現綜整心得' })];
  const { byYear, over } = countCentralUpload(items, LIMITS);
  const y = byYear.find((x) => x.year === 'G2');
  assert.equal(y.diverse.used, 10);
  assert.equal(y.diverse.max, 10);
  assert.equal(y.diverse.over, false, '綜整心得被算進額度了——學生會刪掉一件該留的');
  assert.equal(over, false);
});

test('綜整心得的件數要另外報出來，不能只是消失', () => {
  // 不印的話，學生數自己的檔案是 11 件而系統說 10 件，他會以為系統
  // 壞了然後去刪東西。能被驗證的數字比正確的數字重要。
  const items = [...diverse(10), item({ itemCode: 'N' })];
  const y = countCentralUpload(items, LIMITS).byYear.find((x) => x.year === 'G2');
  assert.equal(y.diverse.summaryExcluded, 1);
});

test('已經滿十件時，再加一份綜整心得加得下去', () => {
  const items = diverse(10);
  assert.equal(mayAddItem(items, item({ itemCode: 'N' }), LIMITS).ok, true);
  // 而再加一件真的多元表現就加不下去。
  const no = mayAddItem(items, item({ itemCode: 'G' }), LIMITS);
  assert.equal(no.ok, false);
  assert.ok(no.reason.includes('10'));
});

test('個人申請階段的勾選，綜整心得同樣不計入', () => {
  const items = [
    ...diverse(10).map((i) => ({ ...i, selectedFor: ['001'] })),
    item({ itemCode: 'N', selectedFor: ['001'] }),
  ];
  const p = countSelected(items, LIMITS, ['001']).byProgram[0];
  assert.equal(p.diverse.used, 10);
  assert.equal(p.diverse.over, false);
  assert.equal(p.diverse.summaryExcluded, 1);
});

test('綜整心得雖然不計入件數，字數與圖片仍然要檢查', () => {
  // 不計入額度**不等於**沒有限制。它有 800 字加 3 圖的明文限制，
  // 而漏掉這一項的症狀是上傳被退件。
  const ok = checkSummaryEssay({ body: '字'.repeat(800), imageCount: 3 }, LIMITS);
  assert.ok(ok.every((c) => c.ok));

  const over = checkSummaryEssay({ body: '字'.repeat(801), imageCount: 4 }, LIMITS);
  assert.equal(over.find((c) => c.code === 'SUMMARY_CHARS').ok, false);
  assert.equal(over.find((c) => c.code === 'SUMMARY_IMAGES').ok, false);
});

test('確認清單上，綜整心得那一項要說出「不計入額度」', () => {
  const out = submissionChecklist({
    items: diverse(10),
    essays: [],
    programs: [],
    limits: LIMITS,
    now: new Date('2026-05-10T10:00:00'),
  });
  const miss = out.items.find((c) => c.code === 'SUMMARY_MISSING');
  assert.ok(miss);
  assert.ok(miss.detail.includes('不計入'), '清單上沒有講出這一條，而它是最多人搞錯的');
});

// ═════════════════════════════════════════════════════════════════
// 二、件數與學年
// ═════════════════════════════════════════════════════════════════

test('件數是逐學年算的，不是三年加總', () => {
  const items = [...diverse(6, '高一上'), ...diverse(6, '高二上')];
  const { byYear, over } = countCentralUpload(items, LIMITS);
  assert.equal(byYear.length, 2);
  assert.equal(over, false);
  for (const y of byYear) assert.equal(y.diverse.used, 6);
});

test('課程學習成果每學年 6 件、多元表現每學年 10 件，各算各的', () => {
  const items = [
    ...Array.from({ length: 7 }, () => item({ category: 'COURSE_OUTCOME', itemCode: 'B' })),
    ...diverse(3),
  ];
  const y = countCentralUpload(items, LIMITS).byYear[0];
  assert.equal(y.outcome.over, true);
  assert.equal(y.diverse.over, false);
});

test('認不出學期的素材單獨成一組，不併進任何一年', () => {
  // 併進去的話那一年會虛胖，然後在他真的要加第 6 件時擋住他。
  assert.equal(gradeYearOf('高二上'), 'G2');
  assert.equal(gradeYearOf('高2下'), 'G2');
  assert.equal(gradeYearOf('11年級上'), 'G2');
  assert.equal(gradeYearOf(''), 'UNKNOWN');
  assert.equal(gradeYearOf('一上'), 'UNKNOWN', '沒有「高」字時猜不得——那可能是國中');

  const items = [...diverse(6, '高二上'), item({ semester: null })];
  const { byYear, over } = countCentralUpload(items, LIMITS);
  assert.equal(over, false);
  assert.equal(byYear.find((y) => y.year === 'UNKNOWN').diverse.used, 1);
});

test('本來就超過上限時，不會把學生鎖死在動不了的狀態', () => {
  // 上限被調小的情況。連加都不能加的話，他沒有辦法修正——而他要做的
  // 第一件事可能正是把一件換成另一件。
  const tight = limitsOf({ diversePerYear: 3, sourceRef: 'x' });
  const items = diverse(5);
  assert.equal(countCentralUpload(items, tight).over, true);
  assert.equal(mayAddItem(items, item(), tight).ok, true);
});

test('個人申請的勾選是逐校系算的', () => {
  const items = [
    ...Array.from({ length: 3 }, () =>
      item({ category: 'COURSE_OUTCOME', itemCode: 'B', selectedFor: ['001', '002'] }),
    ),
    item({ category: 'COURSE_OUTCOME', itemCode: 'B', selectedFor: ['001'] }),
  ];
  const { byProgram } = countSelected(items, LIMITS, ['001', '002']);
  assert.equal(byProgram.find((p) => p.programRef === '001').outcome.over, true);
  assert.equal(byProgram.find((p) => p.programRef === '002').outcome.over, false);
});

test('代碼認得出中文名稱，認不得的回 null 而不是猜一個', () => {
  assert.equal(itemCodeInfo('n').code, 'N');
  assert.equal(itemCodeInfo('B').category, 'COURSE_OUTCOME');
  assert.equal(itemCodeInfo('Z'), null);
});

// ═════════════════════════════════════════════════════════════════
// 三、容量
// ═════════════════════════════════════════════════════════════════

test('文件 4MB、影音 10MB，兩種上限不同', () => {
  const MB = 1024 * 1024;
  assert.equal(checkFileSize({ fileBytes: 4 * MB, fileKind: 'DOC' }, LIMITS).ok, true);
  assert.equal(checkFileSize({ fileBytes: 4 * MB + 1, fileKind: 'DOC' }, LIMITS).ok, false);
  assert.equal(checkFileSize({ fileBytes: 10 * MB, fileKind: 'MEDIA' }, LIMITS).ok, true);
  assert.equal(checkFileSize({ fileBytes: 10 * MB + 1, fileKind: 'MEDIA' }, LIMITS).ok, false);
  // 沒有標類別的當成文件（嚴的那一邊）。
  assert.equal(checkFileSize({ fileBytes: 5 * MB }, LIMITS).ok, false);
  // 沒有檔案的不檢查。
  assert.equal(checkFileSize({ fileBytes: null }, LIMITS).ok, true);
});

// ═════════════════════════════════════════════════════════════════
// 四、字數與必要子項
// ═════════════════════════════════════════════════════════════════

test('字數不計空白與換行，而且數的是字不是 UTF-16 單元', () => {
  assert.equal(charCountOf('一 二\n三'), 3);
  assert.equal(charCountOf('𠮟'), 1, 'String.length 會把它算成 2');
});

test('三個子項缺一項就是整份不完整，空白的算缺', () => {
  const all = checkSelfStatement([
    { kind: 'REFLECTION', body: '反思' },
    { kind: 'MOTIVATION', body: '動機' },
    { kind: 'PLAN', body: '計畫' },
  ]);
  assert.ok(all.every((c) => c.ok));

  const blank = checkSelfStatement([
    { kind: 'REFLECTION', body: '反思' },
    { kind: 'MOTIVATION', body: '   ' },
    { kind: 'PLAN', body: '' },
  ]);
  assert.equal(blank.filter((c) => !c.ok).length, 2, '開了草稿但沒寫，在資料庫裡看起來與寫完了一樣');
  assert.deepEqual(
    blank.filter((c) => !c.ok).map((c) => c.code),
    ['SELF_P', 'SELF_Q'],
  );
});

// ═════════════════════════════════════════════════════════════════
// 五、送出前的確認清單（§9.4 的不可逆窄口）
// ═════════════════════════════════════════════════════════════════

const fullEssays = [
  { kind: 'REFLECTION', body: '反思' },
  { kind: 'MOTIVATION', body: '動機' },
  { kind: 'PLAN', body: '計畫' },
  { kind: 'DIVERSE_SUMMARY', body: '心得', imageCount: 1 },
];

const run = (over = {}) =>
  submissionChecklist({
    items: [],
    essays: fullEssays,
    programs: [{ programRef: '001', name: '某系', mode: 'CENTRAL', deadline: '2026-05-10' }],
    limits: LIMITS,
    now: new Date('2026-05-01T10:00:00'),
    ...over,
  });

const code = (out, c) => out.items.find((x) => x.code === c);

test('擇一不得混搭是阻斷項', () => {
  const out = run({
    programs: [{ programRef: '001', mode: 'MIXED', deadline: '2026-05-10' }],
  });
  const c = code(out, 'MODE_NOT_MIXED');
  assert.equal(c.ok, false);
  assert.equal(c.severity, 'BLOCK');
  assert.equal(out.blocking >= 1, true);
});

test('沒有選擇上傳方式也是阻斷項', () => {
  const out = run({ programs: [{ programRef: '001', mode: null, deadline: '2026-05-10' }] });
  assert.equal(code(out, 'MODE_CHOSEN').ok, false);
});

test('每日 09:00 至 21:00：邊界各一個案例', () => {
  // 這一條最常害到人的地方是截止日當天——21:00 一到就關，不是 23:59。
  assert.equal(code(run({ now: new Date('2026-05-01T08:59:00') }), 'WINDOW_DAILY').ok, false);
  assert.equal(code(run({ now: new Date('2026-05-01T09:00:00') }), 'WINDOW_DAILY').ok, true);
  assert.equal(code(run({ now: new Date('2026-05-01T20:59:00') }), 'WINDOW_DAILY').ok, true);
  assert.equal(code(run({ now: new Date('2026-05-01T21:00:00') }), 'WINDOW_DAILY').ok, false);
});

test('起始日 4/30 全國統一', () => {
  assert.equal(code(run({ now: new Date('2026-04-29T10:00:00') }), 'WINDOW_START').ok, false);
  assert.equal(code(run({ now: new Date('2026-04-30T10:00:00') }), 'WINDOW_START').ok, true);
});

test('截止日各校自訂，沒查到的要提醒但不阻斷', () => {
  const c = code(run({ programs: [{ programRef: '001', mode: 'PDF', deadline: null }] }), 'DEADLINE_KNOWN');
  assert.equal(c.ok, false);
  assert.equal(c.severity, 'WARN', '沒查到截止日不該阻斷——系統本來就沒有這份資料');
  assert.ok(c.detail.includes('各大學各自規定'));
});

test('件數超過是阻斷項', () => {
  const out = run({ items: diverse(11) });
  assert.equal(code(out, 'COUNT_CENTRAL').ok, false);
  assert.equal(code(out, 'COUNT_CENTRAL').severity, 'BLOCK');
});

test('缺子項是阻斷項', () => {
  const out = run({ essays: [{ kind: 'REFLECTION', body: '反思' }] });
  assert.equal(code(out, 'SELF_P').ok, false);
  assert.equal(code(out, 'SELF_Q').ok, false);
});

test('「送出確認後不得修改」一定要在清單上，而且它不是阻斷項', () => {
  // 它是 INFO：它不是一個要修正的錯，而是一件他按下去之前必須知道
  // 的事。做成阻斷項的話，學生會學會忽略整份清單。
  const c = code(run(), 'IRREVERSIBLE');
  assert.ok(c);
  assert.equal(c.severity, 'INFO');
  assert.equal(c.ok, true);
});

test('全部都對的時候沒有阻斷項', () => {
  const out = run({ items: diverse(3) });
  assert.equal(out.blocking, 0, out.items.filter((c) => !c.ok).map((c) => c.code).join('、'));
});

// ═════════════════════════════════════════════════════════════════
// 六、上限是資料不是常數
// ═════════════════════════════════════════════════════════════════

test('沒有建檔時回預設值，而且標得出來它是預設值', () => {
  const d = limitsOf(null);
  assert.equal(d.isDefault, true);
  assert.equal(d.sourceRef, null);
  assert.equal(d.diversePerYear, DEFAULT_LIMITS.diversePerYear);
});

test('建檔之後 isDefault 是 false，而且帶著來源', () => {
  const l = limitsOf({ year: 116, diversePerYear: 8, sourceRef: '116 簡章總則第 42 頁' });
  assert.equal(l.isDefault, false);
  assert.equal(l.diversePerYear, 8);
  assert.equal(l.sourceRef, '116 簡章總則第 42 頁');
  // 沒填的欄位退回預設值，不是 0——0 會擋住每一位學生。
  assert.equal(l.outcomePerYear, DEFAULT_LIMITS.outcomePerYear);
});

// ═════════════════════════════════════════════════════════════════
// 七、AI 使用層級（§9.2）
// ═════════════════════════════════════════════════════════════════

test('四個層級是遞增的：上一級允許的，下一級一定也允許', () => {
  for (let i = 1; i < AI_LEVELS.length; i += 1) {
    for (const f of AI_LEVELS[i - 1].allows) {
      assert.ok(
        AI_LEVELS[i].allows.includes(f),
        `第 ${AI_LEVELS[i].level} 級少了第 ${AI_LEVELS[i - 1].level} 級有的 ${f}`,
      );
    }
  }
});

test('第 1 級只開制度檢查與揭露聲明，兩者都不呼叫模型', () => {
  assert.deepEqual(AI_LEVELS[0].allows, ['RULE_CHECK', 'DISCLOSURE_STATEMENT']);
  assert.equal(aiFeatureAllowed(1, 'WRITING_FEEDBACK'), false);
  assert.equal(aiFeatureAllowed(1, 'MATERIAL_HINT'), false);
  assert.equal(aiFeatureAllowed(1, 'SELECTION_DISCUSS'), false);
  assert.equal(aiFeatureAllowed(1, 'INTERVIEW_FEEDBACK'), false);
  // 揭露聲明在每一級都開：關掉它會讓這一級的學生交不出必要的揭露，
  // 而那是及格線不是加分項。
  assert.equal(aiFeatureAllowed(1, 'DISCLOSURE_STATEMENT'), true);
  assert.equal(aiFeatureAllowed(1, 'RULE_CHECK'), true);
});

test('第 2 級開素材提示，第 3 級開撰寫與面試回饋，第 4 級開選件討論', () => {
  assert.equal(aiFeatureAllowed(2, 'MATERIAL_HINT'), true);
  assert.equal(aiFeatureAllowed(2, 'WRITING_FEEDBACK'), false);

  assert.equal(aiFeatureAllowed(3, 'WRITING_FEEDBACK'), true);
  assert.equal(aiFeatureAllowed(3, 'INTERVIEW_FEEDBACK'), true);
  assert.equal(aiFeatureAllowed(3, 'SELECTION_DISCUSS'), false);

  assert.equal(aiFeatureAllowed(4, 'SELECTION_DISCUSS'), true);
});

test('沒有設定（null）一律停用，除了那兩個永遠開的例外', () => {
  // 「事前明定」的意思是老師要先做一個決定，沒做就是沒做。
  assert.equal(aiFeatureAllowed(AI_LEVEL_UNSET, 'WRITING_FEEDBACK'), false);
  assert.equal(aiFeatureAllowed(AI_LEVEL_UNSET, 'MATERIAL_HINT'), false);
  assert.equal(aiFeatureAllowed(AI_LEVEL_UNSET, 'DISCLOSURE_STATEMENT'), true);
  assert.equal(aiFeatureAllowed(AI_LEVEL_UNSET, 'RULE_CHECK'), true);
  // 認不得的層級也一樣往停用的方向倒。
  assert.equal(aiFeatureAllowed(99, 'WRITING_FEEDBACK'), false);
});

test('被停用時的訊息說得出是誰決定的、去問誰', () => {
  // 學生看到「這個功能停用」的第一個反應是以為系統壞了，然後他會去找
  // 一個沒有這層限制的工具。
  const unset = aiDisabledReason(AI_LEVEL_UNSET, 'WRITING_FEEDBACK');
  assert.ok(unset.includes('老師'));
  assert.ok(unset.includes('還沒有設定'));

  const lv1 = aiDisabledReason(1, 'WRITING_FEEDBACK');
  assert.ok(lv1.includes('老師'));
  assert.ok(lv1.includes('撰寫回饋'), '訊息裡沒有功能的中文名，學生看不懂被擋的是什麼');
});

test('每一級都說得出「為什麼是這個順序」', () => {
  // 排序的軸線是「AI 介入的時點離產出有多近」，而它不直觀——不寫的話，
  // 老師會以為第 4 級的選件討論排錯了。
  for (const l of AI_LEVELS) {
    assert.ok(l.why && l.why.length > 30, `第 ${l.level} 級沒有寫理由`);
    assert.ok(l.summary && l.summary.length > 5);
  }
});

// ═════════════════════════════════════════════════════════════════
// 八、沒有設定的班級不可以被當成「沒有意見」
//
// `aiFeatureAllowed(null, …)` 一律拒絕（「往放行的方向倒的話，這條
// 規定就等於沒有」），但只要**另一班設過**，`null` 就從「未明定」被
// 降級成「沒有意見」——英文老師的「還沒明定」在這位學生身上等於
// 「全部開放」，而畫面同時告訴他「這一班的 AI 功能停用中」。
// ═════════════════════════════════════════════════════════════════

test('只要有一個班沒設定，整個人就是未設定——不可以被別班的設定蓋過去', () => {
  assert.equal(effectiveAiLevel([4, null]), AI_LEVEL_UNSET, '沒設定的班被當成「沒有意見」了');
  assert.equal(effectiveAiLevel([3, null]), AI_LEVEL_UNSET);
  assert.equal(effectiveAiLevel([1, null]), AI_LEVEL_UNSET);
  assert.equal(effectiveAiLevel([null, null]), AI_LEVEL_UNSET);
  assert.equal(effectiveAiLevel([]), AI_LEVEL_UNSET);
});

test('每一班都設過的時候，取最嚴的一級', () => {
  assert.equal(effectiveAiLevel([4, 1]), 1);
  assert.equal(effectiveAiLevel([3, 4]), 3);
  assert.equal(effectiveAiLevel([2]), 2);
});

test('範圍外的值算「沒設定」而不是「不存在」——往停用的方向倒', () => {
  // 0 與 5 進得了資料庫（欄位是 Int），而把它們當成「不算數」等於
  // 讓一列壞資料變成「沒有意見」，於是另一班的第 4 級生效。
  assert.equal(effectiveAiLevel([0, 5, 2]), AI_LEVEL_UNSET);
  assert.equal(effectiveAiLevel([2, 3]), 2);
});

test('被停用時說得出是哪幾班還沒設定', () => {
  const msg = aiDisabledReason(AI_LEVEL_UNSET, 'WRITING_FEEDBACK', ['高三英文', '高三數學']);
  assert.ok(msg.includes('高三英文'), '學生不知道要去找哪一位老師');
  assert.ok(msg.includes('高三數學'));
});

// ═════════════════════════════════════════════════════════════════
// 九、改一件素材繞不過件數上限
//
// `addItem` 擋得住，`updateItem` 擋不住：高二上已經 10 件時，把高三的
// 一件改成「高二上」就變成 11 件，而它只會在送出前的清單上被退。
// `mayAddItem` 的註解說錯的方向是「讓他傳到第 7 件才在中央資料庫端
// 被退」，PATCH 這條路正是那個方向。
// ═════════════════════════════════════════════════════════════════

const withId = (n, over = {}) =>
  Array.from({ length: n }, (_, i) => item({ id: `x${i}`, title: `社團 ${i}`, ...over }));

test('改學期繞不過每學年的件數上限', () => {
  const items = [...withId(10), item({ id: 'g3', semester: '高三上' })];
  const no = mayUpdateItem(items, 'g3', { semester: '高二上' }, LIMITS);
  assert.equal(no.ok, false);
  assert.ok(no.reason.includes('高二'));

  // 反過來（從滿的那一年搬出去）要放行——他要做的第一件事可能正是這個。
  const yes = mayUpdateItem(items, 'x0', { semester: '高三上' }, LIMITS);
  assert.equal(yes.ok, true, yes.reason ?? '');
});

test('勾選給某一校系時，逐校系的上限擋得住', () => {
  // 上限是 3 件課程學習成果。畫面上超過只會染紅，而確認清單在沒填
  // 校系時是全綠的——這條上限從頭到尾沒有一個地方會擋住人。
  const items = [
    ...Array.from({ length: 3 }, (_, i) =>
      item({ id: `o${i}`, category: 'COURSE_OUTCOME', itemCode: 'B', selectedFor: ['001'] }),
    ),
    item({ id: 'o3', category: 'COURSE_OUTCOME', itemCode: 'B', selectedFor: [] }),
  ];
  const no = mayUpdateItem(items, 'o3', { selectedFor: ['001'] }, LIMITS);
  assert.equal(no.ok, false);
  assert.ok(no.reason.includes('001'));

  // 換一個校系就加得下。
  const yes = mayUpdateItem(items, 'o3', { selectedFor: ['002'] }, LIMITS);
  assert.equal(yes.ok, true, yes.reason ?? '');
});

test('綜整心得在 PATCH 這條路上一樣不計入額度', () => {
  const items = [...withId(10), item({ id: 'n', itemCode: 'N', semester: '高三上' })];
  assert.equal(mayUpdateItem(items, 'n', { semester: '高二上' }, LIMITS).ok, true);
});

test('本來就超過的時候不會被鎖死', () => {
  const tight = limitsOf({ diversePerYear: 3, sourceRef: 'x' });
  const items = [...withId(5), item({ id: 'g3', semester: '高三上' })];
  // 高二上本來就超過（5 > 3），再搬一件進去不擋——與 mayAddItem 同一條
  // 規則：只在「這一動才超過」時擋，否則他沒有辦法修正。
  assert.equal(mayUpdateItem(items, 'g3', { semester: '高二上' }, tight).ok, true);
});

// ═════════════════════════════════════════════════════════════════
// 十、清單不可以把「沒有核對到」印成「都對了」
//
// 一份漏掉重點的清單比沒有清單糟，因為學生會以為自己核對過了。
// ═════════════════════════════════════════════════════════════════

test('沒填校系時，逐校系的那幾項不可以是綠的', () => {
  const out = submissionChecklist({
    items: [],
    essays: fullEssays,
    programs: [],
    limits: LIMITS,
    now: new Date('2026-05-01T10:00:00'),
  });
  assert.equal(code(out, 'PROGRAMS_LISTED').ok, false, '一個校系都沒填，這件事本身要說出來');
  for (const c of ['MODE_CHOSEN', 'MODE_NOT_MIXED', 'DEADLINE_KNOWN']) {
    assert.equal(code(out, c).ok, false, `${c} 在沒填校系時仍然是綠的`);
    assert.ok(code(out, c).detail.includes('沒有核對'), `${c} 沒有說出它其實沒核對到`);
  }
});

test('沒填校系，但素材上已經標了校系時，勾選件數照樣要算', () => {
  // 學生把 5 件都勾給台大電機（上限 3），確認清單的校系欄是空白的，
  // 他直接按「跑一次清單」——實測 blocking = 0，逐項寫著「都在之內」。
  const items = Array.from({ length: 5 }, (_, i) =>
    item({ id: `o${i}`, category: 'COURSE_OUTCOME', itemCode: 'B', selectedFor: ['台大電機'] }),
  );
  const out = submissionChecklist({
    items,
    essays: fullEssays,
    programs: [],
    limits: LIMITS,
    now: new Date('2026-05-01T10:00:00'),
  });
  const c = code(out, 'COUNT_SELECTED');
  assert.equal(c.ok, false, '五件勾給同一個校系（上限 3），清單卻說「都在之內」');
  assert.ok(c.detail.includes('台大電機'));
});

test('一件都沒標校系時，勾選那一項要說「沒有核對到」而不是「都在之內」', () => {
  const out = submissionChecklist({
    items: diverse(3),
    essays: fullEssays,
    programs: [],
    limits: LIMITS,
    now: new Date('2026-05-01T10:00:00'),
  });
  const c = code(out, 'COUNT_SELECTED');
  assert.ok(c.detail.includes('沒有核對'), `講得像核對過了：「${c.detail}」`);
});

test('沒有任何一件填了檔案大小時，不可以宣告「都在範圍內」', () => {
  // 檔案大小是選填、要學生自己打，而且根本沒有真的上傳。一個從來
  // 沒看過檔案的檢查，講得像看過了。
  const out = submissionChecklist({
    items: diverse(16),
    essays: fullEssays,
    programs: [{ programRef: '001', mode: 'CENTRAL', deadline: '2026-05-10' }],
    limits: LIMITS,
    now: new Date('2026-05-01T10:00:00'),
  });
  const c = code(out, 'FILE_SIZE');
  assert.equal(c.ok, false);
  assert.equal(c.severity, 'WARN', '沒有資料不該阻斷——系統本來就沒有這份資料');
  assert.ok(c.detail.includes('沒有'), `講得像看過檔案了：「${c.detail}」`);

  // 有量到的時候照舊說「都在範圍內」，而且說得出量到幾件。
  const measured = submissionChecklist({
    items: [...diverse(3), item({ fileBytes: 1024 * 1024, fileKind: 'DOC' })],
    essays: fullEssays,
    programs: [{ programRef: '001', mode: 'CENTRAL', deadline: '2026-05-10' }],
    limits: LIMITS,
    now: new Date('2026-05-01T10:00:00'),
  });
  assert.equal(code(measured, 'FILE_SIZE').ok, true);
  assert.ok(code(measured, 'FILE_SIZE').detail.includes('1'));
});

test('checkFileSize 說得出它到底有沒有量到', () => {
  const MB = 1024 * 1024;
  assert.equal(checkFileSize({ fileBytes: 2 * MB, fileKind: 'DOC' }, LIMITS).measured, true);
  assert.equal(checkFileSize({ fileBytes: null }, LIMITS).measured, false);
  assert.equal(checkFileSize({ fileBytes: null }, LIMITS).ok, true, '量不到不能當成超過');
});
