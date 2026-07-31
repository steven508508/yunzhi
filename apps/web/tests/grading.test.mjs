/**
 * 客觀題評分與級分換算。
 *
 * **這是全系統最不能出錯的一段**（文件 05 階段 3、藍圖 B4），
 * 所以這一支測的不是「功能會動」，而是**每一種會安靜算錯的情況**。
 *
 * 評分出錯的共同特徵是它不會報錯：學生看到一個分數，老師看到一個
 * 平均，兩者都是合理的數字，沒有任何跡象顯示它算錯了。發現的方式
 * 只有一種——某個學生自己手算對不起來，然後來申訴。所以每一個
 * 測試的註解都寫「錯了會怎樣」，那是這些測試存在的理由。
 *
 * 官方規則出處是文件 A.2（大考中心的計分制度）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  gradeAttempt,
  gradeFillSlot,
  gradeFillText,
  gradeMultiChoice,
  gradeShortAnswerByRule,
  gradeSingleChoice,
  mapDisplayKeys,
  mathEquivalent,
  normalizeAnswerText,
  parseRational,
  slotList,
} from '../lib/grading.mjs';
import {
  GSAT_FULL_SCORE,
  MIN_COHORT,
  fiveStandards,
  fullScoreFor,
  gsatLevels,
  levelInterval,
  levelTable,
  percentileOf,
  toLevel,
  topOnePercentMean,
} from '../lib/gsat.mjs';

// ═══════════════════════════════════════════════════════════════
// 單選題
// ═══════════════════════════════════════════════════════════════

test('單選題答對給滿分、答錯給 0', () => {
  assert.equal(gradeSingleChoice([3], [3], 2).earnedScore, 2);
  assert.equal(gradeSingleChoice([3], [3], 2).isCorrect, true);
  assert.equal(gradeSingleChoice([2], [3], 2).earnedScore, 0);
  assert.equal(gradeSingleChoice([2], [3], 2).isCorrect, false);
});

test('單選題未作答是 0 分，而且說得出是「未作答」', () => {
  // 未作答與答錯都是 0 分，但學生看到的說明必須不同——
  // 「答錯」會讓他去翻解析找自己哪裡想錯了，而他根本沒作答。
  const r = gradeSingleChoice([], [3], 2);
  assert.equal(r.earnedScore, 0);
  assert.match(r.scoreNote, /未作答/);
});

test('單選題多劃記一律 0 分', () => {
  // 官方規則：答錯、未作答、多劃記皆得 0 分。
  // 線上作答按不出兩個，但**答案卡辨識匯入會**——而那時若把
  // 「劃了 2、3」當成「選了 2」，等於幫學生決定他要選哪一個。
  const r = gradeSingleChoice([2, 3], [3], 2);
  assert.equal(r.earnedScore, 0);
  assert.equal(r.isCorrect, false);
  assert.match(r.scoreNote, /多劃記/);
});

test('沒有標準答案的題目判需人工確認，不是判學生錯', () => {
  // 匯入時答案沒抓到就會是空的。判 0 分的話：這一題全班都是 0 分，
  // 而且看起來完全正常——沒有人會發現是題目沒有答案。
  const r = gradeSingleChoice([3], [], 2);
  assert.equal(r.needsReview, true);
  assert.equal(r.earnedScore, null, '不確定的題目不該寫一個分數下去');
  assert.equal(r.isCorrect, null);
});

test('單選題卻有兩個標準答案 → 需人工確認', () => {
  // 送分題或匯入錯誤。硬取第一個的話，選了第二個答案的學生被判錯。
  assert.equal(gradeSingleChoice([3], [2, 3], 2).needsReview, true);
});

test('是非題比照單選', () => {
  const r = gradeAttempt(
    [{ questionId: 'q', type: 'TRUE_FALSE', score: 1, correctKeys: [1] }],
    [{ questionId: 'q', answerKeys: [1] }],
  );
  assert.equal(r.autoScore, 1);
});

// ═══════════════════════════════════════════════════════════════
// 多選題的部分給分 (n − 2k)/n
//
// 文件 05 階段 3 點名必測的四個邊界全部在這一段，另外加上幾個
// 實作時真的會踩到的。
// ═══════════════════════════════════════════════════════════════

test('多選全對給滿分', () => {
  const r = gradeMultiChoice([1, 2, 3], [1, 2, 3], 5, 5);
  assert.equal(r.earnedScore, 5);
  assert.equal(r.isCorrect, true);
});

test('多選答錯一個：(5−2×1)/5 = 3/5', () => {
  // 「該選沒選」與「不該選卻選了」都算一個錯，兩者的分數必須一樣。
  // 只算其中一種是很常見的實作錯誤（通常只算「選錯的」），
  // 症狀是漏選的學生分數偏高。
  const 漏選 = gradeMultiChoice([1, 2], [1, 2, 3], 5, 5);
  const 多選 = gradeMultiChoice([1, 2, 3, 4], [1, 2, 3], 5, 5);
  assert.equal(漏選.earnedScore, 3);
  assert.equal(多選.earnedScore, 3);
  assert.match(漏選.scoreNote, /答錯 1 個/, `說明要說得出錯幾個：${漏選.scoreNote}`);
  assert.match(漏選.scoreNote, /3\/5/, `說明要說得出比例：${漏選.scoreNote}`);
});

test('多選答錯到負分要歸零，不是負分', () => {
  // n=5 答錯 3 個：(5−6)/5 = −0.2。不歸零的話這一題會把別題的分數
  // 扣掉，總分低於它應有的值，而學生自己手算對不起來。
  const r = gradeMultiChoice([1, 4], [1, 2, 3], 5, 5); // 漏 2、3，多 4 → k=3
  assert.equal(r.earnedScore, 0, `負分沒歸零：${r.earnedScore}`);
  assert.ok(r.earnedScore >= 0);
  // 剛好 0 的那一格（k = n/2）也要是 0，不是別的東西
  assert.equal(gradeMultiChoice([1, 2, 3, 4], [1, 2], 4, 4).earnedScore, 0);
});

test('多選全部未作答是 0 分，不套公式', () => {
  // **這一條不做的話，空白卷會拿到分數。** n=5、正確答案 2 個時，
  // 未作答的 k = 2，公式算出 (5−4)/5 = 0.2，一題送 1 分；
  // 一份 6 題多選的卷子，什麼都不寫可以拿 6 分。
  // 官方規則明寫「全部未作答者以 0 分計」就是為了擋這個。
  const r = gradeMultiChoice([], [1, 2], 5, 5);
  assert.equal(r.earnedScore, 0, `空白卷拿到了 ${r.earnedScore} 分`);
  assert.match(r.scoreNote, /未作答/);
});

test('多選選了全部選項也是 0 分', () => {
  // 「全選穩賺」是學生一定會試的策略。n=5、正確 2 個時全選 k=3，
  // 公式算出負的 → 歸零。若公式寫錯（例如只算漏選），全選會變成滿分。
  assert.equal(gradeMultiChoice([1, 2, 3, 4, 5], [1, 2], 5, 5).earnedScore, 0);
  assert.equal(gradeMultiChoice([1, 2, 3, 4], [2], 4, 4).earnedScore, 0);
});

test('n 是選項總數，不是正確答案的個數', () => {
  // 最容易寫錯的一處。同樣答錯 1 個，n=4 與 n=5 的得分不同：
  // (4−2)/4 = 1/2、(5−2)/5 = 3/5。用「正確答案個數」當 n 的話，
  // 分數會偏低而且每一題偏得不一樣多。
  assert.equal(gradeMultiChoice([1, 2], [1, 2, 3], 4, 4).earnedScore, 2); // (4−2)/4 × 4
  assert.equal(gradeMultiChoice([1, 2], [1, 2, 3], 5, 5).earnedScore, 3); // (5−2)/5 × 5
});

test('部分給分不是整數時也要對得起來', () => {
  // 英文的多選常是 4 分 4 選項。(4−2)/4 × 4 = 2；
  // 數學 5 分 5 選項答錯 2 個是 (5−4)/5 × 5 = 1。
  assert.equal(gradeMultiChoice([1], [1, 2], 4, 4).earnedScore, 2);
  assert.equal(gradeMultiChoice([1, 4], [1, 2], 5, 5).earnedScore, 1);
  // 4 分 5 選項答錯 1 個 → 2.4，不是 2.4000000000000004
  assert.equal(gradeMultiChoice([1, 2], [1, 2, 3], 5, 4).earnedScore, 2.4);
});

test('重複劃記同一個選項不算兩個錯', () => {
  // answerKeys 是 Int[]，資料庫層沒有唯一性約束，[2,2] 塞得進去。
  // 不去重的話 k 會被算成 2，這個學生莫名其妙少一半的分。
  const r = gradeMultiChoice([1, 2, 2, 3], [1, 2, 3], 5, 5);
  assert.equal(r.earnedScore, 5, `重複值讓 k 算多了：${r.scoreNote}`);
});

test('答案鍵指到不存在的選項 → 需人工確認，不硬算', () => {
  // 選項被重新編號而答案沒跟著改（見 lib/questionShape.mjs）。
  // 硬算的話：正確答案「4」對不到任何選項，於是選對的人全被判錯，
  // 而且完全沒有跡象。
  assert.equal(gradeMultiChoice([1, 2], [1, 2, 4], 3, 5).needsReview, true);
  // 學生的作答超出範圍同理——那代表選項順序快照與題目對不上。
  assert.equal(gradeMultiChoice([1, 5], [1, 2], 4, 5).needsReview, true);
});

test('選項總數不明時不硬算（否則會除以 0）', () => {
  // 題目的選項沒入庫時 optionCount 是 0。(0−2k)/0 是 −Infinity 或 NaN，
  // 寫進資料庫之後整份卷子的總分變成 NaN。
  const r = gradeMultiChoice([1], [1, 2], 0, 5);
  assert.equal(r.needsReview, true);
  assert.equal(r.earnedScore, null);
  assert.equal(gradeMultiChoice([1], [1, 2], undefined, 5).needsReview, true);
});

test('scoringRule 可以切換成全對才給分', () => {
  // schema 上 scoringRule 存規則而非寫死，因為各科不同——
  // 有些老師的小考就是不採部分給分。
  const rule = { mode: 'ALL_OR_NOTHING' };
  assert.equal(gradeMultiChoice([1, 2, 3], [1, 2, 3], 5, 5, rule).earnedScore, 5);
  assert.equal(gradeMultiChoice([1, 2], [1, 2, 3], 5, 5, rule).earnedScore, 0);
});

// ═══════════════════════════════════════════════════════════════
// 選填題
// ═══════════════════════════════════════════════════════════════

test('選填題整題全對才給分，答錯不倒扣', () => {
  assert.equal(gradeFillSlot(['1', '2'], ['1', '2'], 5).earnedScore, 5);
  const wrong = gradeFillSlot(['1', '3'], ['1', '2'], 5);
  assert.equal(wrong.earnedScore, 0, '選填沒有部分給分');
  assert.ok(wrong.earnedScore >= 0, '不倒扣');
  assert.match(wrong.scoreNote, /第 2 格/, `要說得出哪一格錯：${wrong.scoreNote}`);
});

test('選填題的每一格也要吃數學等價', () => {
  // 答案卡上是一格一個字元，但線上作答與匯入不保證。
  // 「−3」（真正的減號）與「-3」是同一個答案。
  assert.equal(gradeFillSlot(['−3', '０'], ['-3', '0'], 5).earnedScore, 5);
});

test('選填題未作答是 0 分', () => {
  assert.equal(gradeFillSlot([], ['1', '2'], 5).earnedScore, 0);
  assert.equal(gradeFillSlot(['', ''], ['1', '2'], 5).earnedScore, 0);
  assert.match(gradeFillSlot(['', ''], ['1', '2'], 5).scoreNote, /未作答/);
});

test('少填幾格是答錯，不是需人工確認', () => {
  // 只填了第一格就交卷。這是明確的答錯（整題全對才給分），
  // 不該丟給老師看——那會讓複核佇列被沒有爭議的東西塞滿。
  const r = gradeFillSlot(['1'], ['1', '2'], 5);
  assert.equal(r.needsReview, false);
  assert.equal(r.earnedScore, 0);
});

test('作答格數多於標準答案 → 需人工確認', () => {
  // 代表這一題在學生作答之後被改過，或作答介面與題目對不上。
  // 硬比會比錯位置，而且比錯之後看起來很正常。
  assert.equal(gradeFillSlot(['1', '2', '3'], ['1', '2'], 5).needsReview, true);
});

test('答案格用物件存時，格位鍵要用數值排序', () => {
  // `{'2':'b','10':'a'}` 用字串排序會變成 10、2，兩格的答案對調，
  // 於是全對的學生被判錯。
  assert.deepEqual(slotList({ 10: 'a', 2: 'b' }), ['b', 'a']);
  assert.equal(gradeFillSlot({ 14: '2', 13: '1' }, ['1', '2'], 5).earnedScore, 5);
});

test('選填題已經有一格確定錯了，就不必再問人', () => {
  // 整題全對才給分，所以第 1 格錯了結果就定了；第 2 格判不判得出來
  // 不影響任何事。送進人工佇列只會讓老師看一份他只能按「維持原判」
  // 的卷子——複核佇列的可信度就是這樣被稀釋掉的。
  const r = gradeFillSlot(['9', '50%'], ['1', '0.5'], 5);
  assert.equal(r.earnedScore, 0);
  assert.equal(r.needsReview, false);
  // 但只有判不出來的那一格時，仍然要問
  assert.equal(gradeFillSlot(['1', '50%'], ['1', '0.5'], 5).needsReview, true);
});

test('選填題沒有標準答案 → 需人工確認', () => {
  assert.equal(gradeFillSlot(['1'], [], 5).needsReview, true);
  assert.equal(gradeFillSlot(['1'], ['', ''], 5).needsReview, true);
});

// ═══════════════════════════════════════════════════════════════
// 數學等價判定
//
// 文件 01 第 10.5 節的驗收準則：`1/2`、`0.5`、`2/4`、`0.50` 均判定
// 為相同。這一段是那一條的實作。
// ═══════════════════════════════════════════════════════════════

test('1/2、0.5、2/4、0.50、．5 是同一個答案', () => {
  for (const written of ['1/2', '0.5', '2/4', '0.50', '．5', '.5', '4/8', '0.500']) {
    assert.equal(
      mathEquivalent(written, '1/2'),
      'SAME',
      `學生寫「${written}」被判成不等於 1/2——他答對了卻是 0 分`,
    );
  }
});

test('全形數字與全形符號要吸收', () => {
  // 中文輸入法沒切回英數就會打出這些，而畫面上幾乎看不出差別。
  assert.equal(mathEquivalent('１／２', '1/2'), 'SAME');
  assert.equal(mathEquivalent('０．５', '0.5'), 'SAME');
  assert.equal(mathEquivalent('１２３', '123'), 'SAME');
});

test('空白與正負號的寫法差異要吸收', () => {
  assert.equal(mathEquivalent(' 1 / 2 ', '1/2'), 'SAME');
  assert.equal(mathEquivalent('1　/　2', '1/2'), 'SAME'); // 全形空白
  assert.equal(mathEquivalent('+3', '3'), 'SAME');
  assert.equal(mathEquivalent('−3', '-3'), 'SAME'); // U+2212 真正的減號
  assert.equal(mathEquivalent('－3', '-3'), 'SAME'); // 全形
  assert.equal(mathEquivalent('–3', '-3'), 'SAME'); // en dash，PDF 複製常見
  assert.equal(mathEquivalent('-0', '0'), 'SAME');
  assert.equal(mathEquivalent('-1/2', '-0.5'), 'SAME');
  assert.equal(mathEquivalent('1/-2', '-0.5'), 'SAME');
});

test('數值不同就是不同，不要過度寬鬆', () => {
  // 等價判定寫得太寬鬆的後果比太嚴格糟：太嚴格會進人工佇列被發現，
  // 太寬鬆是把錯的答案判對，沒有人會來申訴。
  assert.equal(mathEquivalent('0.333', '1/3'), 'DIFFERENT');
  assert.equal(mathEquivalent('0.5', '0.05'), 'DIFFERENT');
  assert.equal(mathEquivalent('-3', '3'), 'DIFFERENT');
  assert.equal(mathEquivalent('水', '空氣'), 'DIFFERENT');
});

test('不用浮點數比較，所以 0.1+0.2 那類陷阱不存在', () => {
  // 0.1 + 0.2 !== 0.3 在計分上的後果是：兩個數學上相等的答案被判不同，
  // 而且只在特定數值上發生——測不到的那種。這裡用分數比較，不除。
  assert.equal(mathEquivalent('0.3', '3/10'), 'SAME');
  assert.equal(mathEquivalent('0.1', '1/10'), 'SAME');
  assert.equal(mathEquivalent('0.7', '7/10'), 'SAME');
  const r = parseRational('0.30');
  assert.equal(r.num, 3n);
  assert.equal(r.den, 10n);
});

test('判不出來的一律「需人工確認」，不猜', () => {
  // 這幾種每一種都有兩個都說得通的判法，而任一個判錯都不會被發現。
  assert.equal(mathEquivalent('50%', '0.5'), 'UNSURE', '百分號與小數的關係要老師決定');
  assert.equal(mathEquivalent('√2', '1.414'), 'UNSURE', '近似值算不算對是老師的事');
  assert.equal(mathEquivalent('一半', '0.5'), 'UNSURE', '中文數字不猜');
  assert.equal(mathEquivalent('二分之一', '1/2'), 'UNSURE');
  assert.equal(mathEquivalent('3公分', '0.03公尺'), 'UNSURE', '不做單位換算');
  assert.equal(mathEquivalent('3', '3公分'), 'UNSURE', '要不要求單位是老師的規定');
  assert.equal(mathEquivalent('Na', 'na'), 'UNSURE', 'Co 是鈷、CO 是一氧化碳，大小寫不敢自己決定');
  assert.equal(mathEquivalent('1,2', '12'), 'UNSURE', '逗號可能是兩個答案也可能是千分位');
});

test('同單位的數值可以直接比', () => {
  assert.equal(mathEquivalent('3公分', '3.0公分'), 'SAME');
  assert.equal(mathEquivalent('50%', '50.0%'), 'SAME');
  assert.equal(mathEquivalent('3公分', '4公分'), 'DIFFERENT');
  assert.equal(mathEquivalent('1,234', '1234'), 'SAME'); // 千分位
});

test('最單純的 LaTeX 分數讀得懂，複雜的交給人', () => {
  // 題庫裡的數學式是 LaTeX，答案欄也可能是。
  assert.equal(mathEquivalent('\\frac{1}{2}', '0.5'), 'SAME');
  assert.equal(mathEquivalent('$\\dfrac{2}{4}$', '1/2'), 'SAME');
  assert.equal(mathEquivalent('\\frac{\\sqrt{2}}{2}', '0.707'), 'UNSURE');
});

test('normalizeAnswerText 不會把不同的答案洗成一樣', () => {
  assert.equal(normalizeAnswerText('　1 / 2　'), '1/2');
  assert.equal(normalizeAnswerText('水。'), '水');
  assert.notEqual(normalizeAnswerText('12'), normalizeAnswerText('21'));
});

// ═══════════════════════════════════════════════════════════════
// 填充題
// ═══════════════════════════════════════════════════════════════

test('填充題答對給分、答錯給 0、未作答說得出來', () => {
  assert.equal(gradeFillText('0.5', '1/2', 5).earnedScore, 5);
  assert.equal(gradeFillText('0.6', '1/2', 5).earnedScore, 0);
  assert.match(gradeFillText('', '1/2', 5).scoreNote, /未作答/);
  assert.match(gradeFillText('   ', '1/2', 5).scoreNote, /未作答/);
});

test('填充題判不出來時不給 0，交給人並且 earnedScore 留空', () => {
  // 給 0 的話這個學生的申訴理由是「我答對了」，而系統裡沒有任何
  // 記錄顯示這一題曾經有疑義。
  const r = gradeFillText('50%', '0.5', 5);
  assert.equal(r.needsReview, true);
  assert.equal(r.earnedScore, null);
  assert.equal(r.isCorrect, null);
});

test('標準答案可以用 | 列出多種都算對的寫法', () => {
  // 老師實際會需要的：同一個答案的合理寫法不只一種。
  assert.equal(gradeFillText('二分之一', '1/2|二分之一', 5).earnedScore, 5);
  assert.equal(gradeFillText('0.5', '1/2|二分之一', 5).earnedScore, 5);
});

test('多寫一個讀不懂的寫法，不會把全班答錯的人送進人工佇列', () => {
  // `0.6` 讀得出是一個數，`1/2` 也是，兩者確定不等 → 就是答錯。
  // 不做這一條的話，老師只要在答案欄多寫一個「二分之一」，
  // 這一題所有答錯的人都要他自己一份一份看——於是他學到的是
  // 「不要用這個功能」。
  const r = gradeFillText('0.6', '1/2|二分之一', 5);
  assert.equal(r.earnedScore, 0);
  assert.equal(r.needsReview, false);

  // 但學生自己寫了讀不懂的東西時，仍然要交給人。
  assert.equal(gradeFillText('三分之二', '1/2|二分之一', 5).needsReview, true);
  // 判不出來的是單位而不是寫法時也一樣（0.03公尺 vs 3公分 要人看）。
  assert.equal(gradeFillText('0.03公尺', '3公分|三公分', 5).needsReview, true);
});

test('絕對值裡的直線不會被當成「或」的分隔符', () => {
  // `|x|=3` 切開之後是兩個誰也不等於的碎片，那一題全班都會被判錯。
  const r = gradeFillText('|x|=3', '|x|=3', 5);
  assert.equal(r.earnedScore, 5, `絕對值的答案被切壞了：${r.scoreNote}`);
  // LaTeX 寫法同理
  assert.equal(gradeFillText('\\left|x\\right|', '\\left|x\\right|', 5).earnedScore, 5);
  // 真的要列兩種寫法時仍然有效
  assert.equal(gradeFillText('0.5', '1/2|0.5', 5).earnedScore, 5);
});

test('單選題的標準答案指到不存在的選項也擋得住', () => {
  // 選項只有 4 個而答案是 5。判 0 分的話全班都是 0 分，
  // 而每一題看起來都被正常計分了。
  assert.equal(gradeSingleChoice([3], [5], 2, 4).needsReview, true);
  assert.equal(gradeSingleChoice([3], [3], 2, 4).earnedScore, 2);
  // 不知道選項數時不做這個檢查（維持原本的行為）
  assert.equal(gradeSingleChoice([5], [5], 2).earnedScore, 2);
});

test('簡答題的規則比對：完全相符與關鍵詞', () => {
  // 只做純程式判定得了的兩種。「AI 語意判定」不在這個檔案裡——
  // 這裡的價值就在於 100% 確定性。
  assert.equal(gradeShortAnswerByRule('光合作用', { mode: 'EXACT', answer: '光合作用' }, 4).earnedScore, 4);
  const kw = { mode: 'CONTAINS', keywords: ['葉綠體', '二氧化碳'] };
  assert.equal(gradeShortAnswerByRule('在葉綠體中吸收二氧化碳', kw, 4).earnedScore, 4);
  assert.equal(gradeShortAnswerByRule('在葉綠體中', kw, 4).earnedScore, 0);
  // 沒有設定規則的簡答題不歸這裡管，回 null 讓上層排進人工佇列
  assert.equal(gradeShortAnswerByRule('隨便寫', {}, 4), null);
});

// ═══════════════════════════════════════════════════════════════
// 整份卷子
// ═══════════════════════════════════════════════════════════════

/** 數學 A 的縮小版：單選 5 分、多選 5 分、選填 5 分。 */
const PAPER = [
  { questionId: 'q1', order: 1, type: 'SINGLE_CHOICE', score: 5, correctKeys: [3], optionCount: 5 },
  { questionId: 'q2', order: 2, type: 'MULTI_CHOICE', score: 5, correctKeys: [1, 2, 3], optionCount: 5 },
  { questionId: 'q3', order: 3, type: 'FILL_SLOT', score: 5, correctSlots: ['1', '2'] },
  { questionId: 'q4', order: 4, type: 'FILL_TEXT', score: 5, correctText: '1/2' },
];

test('整份卷子加總', () => {
  const r = gradeAttempt(PAPER, [
    { questionId: 'q1', answerKeys: [3] }, // 5
    { questionId: 'q2', answerKeys: [1, 2] }, // 3
    { questionId: 'q3', answerSlots: ['1', '2'] }, // 5
    { questionId: 'q4', answerText: '0.50' }, // 5
  ]);
  assert.equal(r.autoScore, 18);
  assert.equal(r.maxScore, 20);
  assert.equal(r.correctCount, 3);
  assert.equal(r.results.length, 4);
});

test('沒有作答記錄的題目算未作答，不是跳過', () => {
  // 學生沒碰過的題目在 attempt_answers 裡沒有列。若計分時直接跳過，
  // 那一題就不存在——總分看起來合理，但滿分也跟著變小，
  // 於是「得分率」永遠很好看。
  const r = gradeAttempt(PAPER, [{ questionId: 'q1', answerKeys: [3] }]);
  assert.equal(r.autoScore, 5);
  assert.equal(r.maxScore, 20, '滿分不該因為沒作答而縮水');
  assert.equal(r.results.length, 4);
  assert.equal(r.results[1].earnedScore, 0);
});

test('需人工確認的題目不當成 0 分加總', () => {
  // 當成 0 的話，畫面上會出現一個看起來已經確定、但其實還沒改完的
  // 分數，而老師沒有理由去點開它。
  const paper = [...PAPER, { questionId: 'q5', order: 5, type: 'FILL_TEXT', score: 5, correctText: '0.5' }];
  const r = gradeAttempt(paper, [
    { questionId: 'q1', answerKeys: [3] },
    { questionId: 'q5', answerText: '50%' },
  ]);
  assert.equal(r.needsReview, 1);
  assert.equal(r.autoScore, 5, '需人工確認的那一題被當成 0 分加進去了');
  assert.equal(r.results[4].earnedScore, null);
});

test('非選題不自動評分，但也不算「需人工確認」', () => {
  // 兩者要分開數：非選題本來就要人改（正常流程），
  // 需人工確認是「客觀題但資料有問題」（不正常，要處理）。
  // 混在一起的話，老師的待辦清單會被 40 份作文淹沒。
  const paper = [
    { questionId: 'q1', order: 1, type: 'SINGLE_CHOICE', score: 5, correctKeys: [3], optionCount: 5 },
    { questionId: 'e1', order: 2, type: 'ESSAY', score: 25, correctText: null },
  ];
  const r = gradeAttempt(paper, [
    { questionId: 'q1', answerKeys: [3] },
    { questionId: 'e1', answerText: '一大段作文' },
  ]);
  assert.equal(r.pendingManual, 1);
  assert.equal(r.needsReview, 0);
  assert.equal(r.autoScore, 5);
  assert.equal(r.maxScore, 30);
  assert.equal(r.autoMaxScore, 5, '非選題的配分不該算進「可自動計分」的滿分');
  assert.equal(r.results[1].earnedScore, null);
});

test('總分不會出現浮點數的尾巴', () => {
  // 0.1 × 3 = 0.30000000000000004。一份 60 題的卷子加起來，
  // 老師會看到「總分 79.99999999999999」。
  const paper = Array.from({ length: 3 }, (_, i) => ({
    questionId: `q${i}`,
    type: 'SINGLE_CHOICE',
    score: 0.1,
    correctKeys: [1],
    optionCount: 4,
  }));
  const answers = paper.map((p) => ({ questionId: p.questionId, answerKeys: [1] }));
  assert.equal(gradeAttempt(paper, answers).autoScore, 0.3);
});

test('答案可以用 Map 或物件傳進來', () => {
  const m = new Map([['q1', { answerKeys: [3] }]]);
  assert.equal(gradeAttempt([PAPER[0]], m).autoScore, 5);
  assert.equal(gradeAttempt([PAPER[0]], { q1: { answerKeys: [3] } }).autoScore, 5);
});

test('不認得的題型不會被靜靜跳過', () => {
  const r = gradeAttempt([{ questionId: 'x', type: 'MYSTERY', score: 5 }], []);
  assert.equal(r.needsReview, 1);
  assert.equal(r.autoScore, 0);
});

test('選項洗牌時，作答存的是畫面順序就要換回原始編號', () => {
  // 隨機出選項是防作弊的第一層。若作答存的是「畫面上的第幾個」而
  // 計分時直接拿去比原始答案，**全班的分數都是錯的**，
  // 而每一題看起來都被正常計分了——這是這一段最貴的失敗模式。
  assert.deepEqual(mapDisplayKeys([1], [3, 1, 2]), [3]);
  assert.deepEqual(mapDisplayKeys([1, 3], [3, 1, 2]), [2, 3]);
  assert.equal(mapDisplayKeys([4], [3, 1, 2]), null, '對不上要回 null，不是 undefined 混進答案裡');

  const item = {
    questionId: 'q1',
    type: 'SINGLE_CHOICE',
    score: 5,
    correctKeys: [3],
    optionCount: 3,
    optionOrder: [3, 1, 2],
    keysAreDisplayOrder: true,
  };
  // 學生點了畫面上的第 1 個，那是原始的第 3 個 → 答對
  assert.equal(gradeAttempt([item], [{ questionId: 'q1', answerKeys: [1] }]).autoScore, 5);
  // 沒有這個標記時預設是原始編號，不做轉換
  const plain = { ...item, keysAreDisplayOrder: false };
  assert.equal(gradeAttempt([plain], [{ questionId: 'q1', answerKeys: [1] }]).autoScore, 0);
});

test('選項順序快照壞掉時判需人工確認', () => {
  const item = {
    questionId: 'q1',
    type: 'SINGLE_CHOICE',
    score: 5,
    correctKeys: [3],
    optionCount: 3,
    optionOrder: [],
    keysAreDisplayOrder: true,
  };
  assert.equal(gradeAttempt([item], [{ questionId: 'q1', answerKeys: [1] }]).needsReview, 1);
});

// ═══════════════════════════════════════════════════════════════
// 級分換算
// ═══════════════════════════════════════════════════════════════

test('級分的上限截斷 min(15, …)', () => {
  // **照抄定義敘述就會踩到的溢位。** L 是前 1% 的平均分除以 15，
  // 而前 1% 的平均分必然低於滿分，所以 15L < 滿分恆成立，
  // 高分群的 X 超過 15L 是常態。沒有 min(15, …) 的話，
  // 考 96 分的學生會拿到「16 級分」——而滿級分是 15。
  const L = 6; // 前 1% 平均 90 分
  assert.equal(toLevel(90, L), 15);
  assert.equal(toLevel(96, L), 15, '96/6 = 16，沒截斷就會給出 16 級分');
  assert.equal(toLevel(100, L), 15);
  assert.equal(toLevel(144, L), 15, '社會科滿分 144，溢位更明顯');
});

test('級分的分界點屬於下面那一級（而且不會被浮點數推上去）', () => {
  // 定義是 `(k−1)L < X ≦ kL` 為 k 級分，右閉。
  // X = 3L 恰好在分界上，必須是 3 級分。
  // 而 9.00012 / 3.00004 在浮點數下是 3.0000000000000004，
  // ceil 之後變成 4——**多給一級，不會有人來申訴。**
  assert.equal(toLevel(9.00012, 3.00004), 3, '浮點數把分界點推上去了');
  assert.equal(toLevel(21.00035, 3.00005), 7);
  assert.equal(toLevel(12, 4), 3);
  assert.equal(toLevel(12.0001, 4), 4, '超過一點點就是下一級');
});

test('0 分是 0 級分', () => {
  // 「原始分 0 分即 0 級分」。ceil(0/L) 剛好也是 0，但負分與 0 分
  // 要一起處理，否則缺考被記成 0 分時可能算出 −0 或 1。
  assert.equal(toLevel(0, 6), 0);
  assert.equal(toLevel(-1, 6), 0);
  assert.equal(toLevel(0.1, 6), 1, '只要有分數就至少 1 級分');
});

test('級距無效時回 null，不是回 0 級分', () => {
  // 回 0 的話，整批學生的級分都是 0，看起來像「大家都考很差」
  // 而不是「級距算不出來」。
  assert.equal(toLevel(50, 0), null);
  assert.equal(toLevel(50, -1), null);
  assert.equal(toLevel(50, NaN), null);
  assert.equal(toLevel(NaN, 6), null);
});

test('級距是前 1% 的平均分除以 15，四捨五入到小數第五位', () => {
  const scores = Array.from({ length: 300 }, (_, i) => i * 0.3); // 0 … 89.7
  const top = topOnePercentMean(scores);
  assert.equal(top.nominal, 3, '300 人的前 1% 是 3 個人');
  assert.equal(top.count, 3);
  assert.equal(Math.round(top.mean * 100) / 100, 89.4); // (89.7+89.4+89.1)/3
  const L = levelInterval(scores);
  assert.equal(L, Math.round((89.4 / 15) * 1e5) / 1e5);
  assert.ok(String(L).split('.')[1].length <= 5, `級距的小數位數超過 5：${L}`);
});

test('前 1% 的分界上同分的人一起算', () => {
  // 不這樣做的話，兩個一模一樣的分數會有一個被算進去、一個沒有，
  // 而誰被算到取決於排序的穩定性——那是不能對學生解釋的東西。
  const scores = [...Array(97).fill(10), 90, 90, 90]; // 100 人，前 1 % 名義上 1 人
  const top = topOnePercentMean(scores);
  assert.equal(top.nominal, 1);
  assert.equal(top.count, 3, '同分的另外兩位被排除了');
  assert.equal(top.mean, 90);
});

test('級分對照表與官方一樣是左開右閉', () => {
  const rows = levelTable(6, 100);
  assert.equal(rows.length, 16); // 0 到 15
  assert.deepEqual(rows[1], { level: 1, from: 0, to: 6 });
  assert.deepEqual(rows[15], { level: 15, from: 84, to: 100 });
});

// ── 小樣本的三種策略 ─────────────────────────────────────────────

test('到考人數足夠時用本次分布', () => {
  const scores = Array.from({ length: MIN_COHORT }, (_, i) => (i % 100) + 1);
  const r = gsatLevels(scores);
  assert.equal(r.method, 'COHORT');
  assert.equal(r.estimated, false);
  assert.ok(r.interval > 0);
  assert.equal(r.levels.length, MIN_COHORT);
});

test('人數不足但有歷史錨定級距 → 估算，而且明確標示是估計值', () => {
  // 給出一個不可靠的級分而不說它不可靠，學生會據以填志願。
  const scores = Array.from({ length: 40 }, (_, i) => i + 40);
  const r = gsatLevels(scores, { anchorInterval: 6, difficultyFactor: 1.1 });
  assert.equal(r.method, 'HISTORICAL_ANCHOR');
  assert.equal(r.estimated, true, '沒有標示成估計值');
  assert.equal(r.interval, 6.6);
  assert.match(r.note, /估計值/);
  assert.match(r.note, /40 人/, '要說清楚是幾個人');
});

test('人數不足又沒有錨定資料 → 不給級分，改給百分位', () => {
  // 「不呈現級分」是刻意的選擇：30 個人算出來的級分不是比較不準，
  // 而是沒有意義——前 1% 是 1 個人，級距等於那個人的分數除以 15。
  const scores = Array.from({ length: 30 }, (_, i) => i * 2);
  const r = gsatLevels(scores);
  assert.equal(r.method, 'UNAVAILABLE');
  assert.equal(r.interval, null);
  assert.ok(r.levels.every((x) => x.level === null), '不該給出級分');
  assert.ok(r.levels.every((x) => typeof x.percentile === 'number'), '要改給百分位數');
  assert.match(r.note, /不足/);
});

test('缺考不計入級距與人數', () => {
  // 官方定義用的是「到考考生」。把缺考當 0 分算進去，級距會被拉低，
  // 於是全班的級分集體虛高。
  const scores = [...Array.from({ length: 300 }, () => 60), null, null, undefined, NaN];
  const r = gsatLevels(scores);
  assert.equal(r.cohortSize, 300);
  assert.equal(r.absent, 4);
  assert.equal(r.method, 'COHORT');
});

test('沒有任何成績時不會炸掉', () => {
  const r = gsatLevels([]);
  assert.equal(r.method, 'UNAVAILABLE');
  assert.equal(r.cohortSize, 0);
  assert.equal(topOnePercentMean([]), null);
  assert.equal(levelInterval([]), null);
});

test('分科測驗的 60 級分制用同一套公式', () => {
  // 文件 A.3：級距為前 1% 平均除以 60，上限 60。
  // 上限寫死 15 的話，分科的級分全部被壓在 15。
  assert.equal(toLevel(100, 1.5, 60), 60);
  assert.equal(toLevel(30, 1.5, 60), 20);
});

// ── 各科滿分 ─────────────────────────────────────────────────────

test('社會 144、自然 128，不是每科都 100', () => {
  assert.equal(GSAT_FULL_SCORE.SOCIAL, 144);
  assert.equal(GSAT_FULL_SCORE.SCIENCE, 128);
  assert.equal(fullScoreFor({ code: 'SOCIAL' }), 144);
  assert.equal(fullScoreFor({ code: 'SCIENCE' }), 128);
  assert.equal(fullScoreFor('MATH_A'), 100);
});

test('滿分以資料庫的設定為準', () => {
  // 制度會改（111 學年度數學才拆成 A、B）。表是後備，不是權威。
  assert.equal(fullScoreFor({ code: 'SOCIAL', gsatFullScore: 100 }), 100);
});

test('查不到滿分時回 null，絕不預設 100', () => {
  // 預設 100 的話，社會科全班的得分率會變成 144/100 = 144%，
  // 而級分換算全部偏高——畫面上不會有任何地方看起來不對。
  assert.equal(fullScoreFor({ code: 'UNKNOWN_SUBJECT' }), null);
  assert.equal(fullScoreFor({ code: 'CHEMISTRY' }), null);
  // 分科（化學、物理）看它屬於哪一張合科考卷
  assert.equal(fullScoreFor({ code: 'CHEMISTRY', parentCode: 'SCIENCE' }), 128);
});

// ── 五標與百分位 ─────────────────────────────────────────────────

test('五標依官方百分位定義，人數不足時不給', () => {
  const levels = Array.from({ length: 400 }, (_, i) => Math.min(15, Math.floor(i / 25)));
  const s = fiveStandards(levels);
  assert.equal(s.available, true);
  assert.ok(s.top >= s.front && s.front >= s.average, `五標順序不對：${JSON.stringify(s)}`);
  assert.ok(s.average >= s.back && s.back >= s.bottom);

  const small = fiveStandards([12, 11, 10, 9, 8]);
  assert.equal(small.available, false, '5 個人的「頂標」只是第 5 名那位同學');
  assert.match(small.why, /不足/);
});

test('百分位數是累計人數百分比', () => {
  const scores = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentileOf(scores, 100), 100);
  assert.equal(percentileOf(scores, 50), 50);
  assert.equal(percentileOf([], 50), null);
});

// ═══════════════════════════════════════════════════════════════
// 閱卷畫面上的三條路：給分的入口、看得到題目、走得回題庫
//
// # 為什麼這一段是靜態檢查
//
// 這三條的共同點是**它們壞掉的時候沒有任何東西會壞**：頁面回 200、
// 資料查得到、型別也對。只是老師手上少了一個他非有不可的東西——
// 一個輸入框、一張圖、一個連結。行為測試看不出這種缺席（沒有東西可以
// 斷言「不存在」），而畫面測試要一整個瀏覽器。所以這裡照
// `gradingWriteBarrier.test.mjs` 的做法讀原始碼，用規則判斷。
//
// 三條都是 v0.26.0 的情境模擬走出來的：
//
//   · AI 掛掉時批次閱卷頁上三十列全部只剩一顆「請 AI 評這一份」，
//     而錯誤訊息寫著「可以直接用旁邊的輸入框給分」——那個輸入框
//     在那一頁不存在
//   · 老師在判一份看不到圖的作答（資料就在手上，畫面沒接）
//   · 「第 12 題答對率 3%」的下一步是去看那一題，而沒有路過去
// ═══════════════════════════════════════════════════════════════

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => readFileSync(path.join(WEB, rel), 'utf8');

const PROPOSAL_CARD = 'app/(app)/grades/[assignmentId]/ProposalCard.tsx';
const BATCH_PAGE = 'app/(app)/grades/[assignmentId]/grading/page.tsx';
const SHEET_PAGE = 'app/(app)/grades/[assignmentId]/[attemptId]/page.tsx';
const CLASS_PAGE = 'app/(app)/grades/[assignmentId]/page.tsx';

test('沒有 AI 建議時，批次閱卷頁上照樣有給分的輸入框', () => {
  const card = src(PROPOSAL_CARD);
  // 輸入框那一整塊不可以掛在「有建議」底下。批次頁的一列只畫這一個
  // 元件（`StudentRow`），所以掛上去等於那一列沒有任何給分的方法，
  // 而老師只能逐份開「看整份」——三十份就是三十個分頁。
  assert.ok(
    !/\{proposal !== null && \(\s*<div className="yz-prop__acts"/.test(card),
    '給分的輸入框又被關在「有 AI 建議」底下了。AI 掛掉、預算用完、' +
      '或老師根本不想花九十次模型呼叫時，這一頁就沒有任何給分的入口。',
  );
  assert.match(card, /<div className="yz-prop__acts">/, '找不到輸入框那一塊');
});

test('沒有建議時的給分走人工給分那一支，不生一筆假的「決定」', () => {
  const card = src(PROPOSAL_CARD);
  assert.match(
    card,
    /submitJson\(`\/api\/attempts\/\$\{attemptId\}\/score`/,
    '沒有建議時應該走 setManualScore 那條路（與答案卷頁的 ScoreOne 同一支）',
  );
  // 反過來也要擋：沒有建議卻去 /api/proposals/decide 的話，
  // 「這個功能到底準不準」那一塊的採用率會被一批空建議汙染。
  assert.match(
    card,
    /proposal === null \? scoreDirect\(Number\(score\)\) : decide\(/,
    '有建議走 decide、沒有建議走人工給分，這個分岔要看得出來',
  );
});

test('老師的兩個閱卷畫面都把附圖交給 MathText', () => {
  // 資料一直都在（`lib/result.ts` 與 `loadQuestionBatch` 都查了），
  // 只是畫面沒接——症狀是老師在判一份只看得到〔附圖〕的作答。
  const sheet = src(SHEET_PAGE);
  for (const [what, pattern] of [
    ['題組素材', /<MathText assets=\{q\.stimulusAssets\}/],
    ['題幹', /<MathText assets=\{q\.contentAssets\}/],
    ['選項', /<MathText assets=\{o\.assets\}/],
  ]) {
    assert.match(sheet, pattern, `答案卷頁的${what}沒有帶附圖`);
  }

  const batch = src(BATCH_PAGE);
  assert.match(batch, /<MathText assets=\{view\.stemAssets\}/, '批次閱卷頁的題幹沒有帶附圖');
  assert.match(batch, /<MathText assets=\{view\.stimulusAssets\}/, '批次閱卷頁的引文沒有帶附圖');
});

test('批次閱卷頁給老師的題目與餵給 AI 的是同一份（含題組引文）', () => {
  // `proposeGrade` 刻意把 `group.stimulus` 併進題幹（少了引文等於評一段
  // 沒有題目的作答）。老師要判斷那個建議合不合理，手上就得有同一份東西
  // ——否則他否決時記下的「AI 評不準」其實是「老師少看了引文」。
  const db = src('lib/gradingProposalDb.ts');
  const batchFn = db.slice(
    db.indexOf('export async function loadQuestionBatch'),
    db.indexOf('// 產生建議'),
  );
  assert.ok(batchFn.length > 500, '找不到 loadQuestionBatch 的內容');
  assert.match(batchFn, /group: \{ select: \{ stimulus: true/, '沒有查題組的引文');
  assert.match(batchFn, /stimulus: item\.question\.group\?\.stimulus/, '查了卻沒有帶出去');
  assert.match(src(BATCH_PAGE), /\{view\.stimulus\}/, '帶出去了卻沒有畫');
});

test('成績頁與答案卷頁都走得回題庫的那一題', () => {
  // 老師在「各題答對率」看到第 12 題只有 3% 會，第一個動作是去看那一題
  // 出了什麼事。反向的連結（題庫 → 這份任務）早就有了，正向的沒有，
  // 於是那一步只能自己到 /bank 用題幹文字搜。
  assert.match(
    src(CLASS_PAGE),
    /href=\{`\/bank\/\$\{q\.questionId\}`\}/,
    '各題答對率那張表沒有通往題庫的連結',
  );
  assert.match(
    src(SHEET_PAGE),
    /href=\{`\/bank\/\$\{q\.questionId\}`\}/,
    '答案卷頁的每一題也要走得回題庫',
  );
});
