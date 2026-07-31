/**
 * 學習歷程的閘門：擋的是**代寫**，而且它必須放過自己。
 *
 * # 這一支測的錯誤與前三支都不同
 *
 * `tutorGuard.test.mjs` 測洩漏答案——學生看完就知道答案，傷害看得見。
 * `adviceGuard.test.mjs` 測假的精確度——讀起來專業、完全沒有症狀。
 * 這裡測的是第三種：**一段學生可以直接貼進去的文字。**
 *
 * 它的失效方式最安靜。學生貼上去、送出去、上榜或沒上榜，整個過程沒有
 * 任何一個時點會有人發現。唯一的症狀是他失去了那個回顧與反思的過程，
 * 而那正是學習歷程檔案存在的全部理由。
 *
 * # 三十一種代寫，各一項
 *
 * 因為模型被擋掉之後會換寫法，而換出來的每一種在字串上都完全不同：
 *
 *     我從小就…  →  你可以這樣寫：我從小就…  →  參考範例：…
 *     →  本人自高中一年級起…  →  筆者於高二時…  →  （拿掉主詞）高二那年…
 *
 * 少寫一條，模型就會找到那一條——它確實會，這與 tutorGuard 的排除法、
 * adviceGuard 的中文成數是同一種現象。所以下面每一種都是一個獨立的案例，
 * 而且**每一條都要說得出它是哪一種手法**。
 *
 * # 反例比正例重要
 *
 * 誤擋的代價是把這個功能最該給的那一種回饋丟掉。所以後半段有一整組
 * 必須通過的輸出，包含規格書 §9.3 的四個範例、**一段引用學生原文的
 * 長回饋**（引用不是代寫），以及**模型拒絕代寫的那一句**——那一句
 * 是五十幾字的連續第一人稱，而且字串裡就含著「幫你寫」。
 *
 * # 揭露聲明那一組是規格書點名的陷阱
 *
 * §13 明文警告：揭露聲明本身就是一段五十幾字的連續第一人稱敘述，
 * 若不排除，產生器會被自己的後處理層無限重試。所以這裡有兩件事要釘住：
 *
 *   一、**那段聲明確實會被防代寫規則擋掉**（陷阱是真的存在的）
 *   二、**它走 `checkPortfolioOutput('DISCLOSURE_STATEMENT', …)` 會過**
 *
 * 只測第二件的話，日後有人把第一人稱規則改鬆而測試照樣綠燈，
 * 於是白名單看起來還在、實際上已經沒有作用。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FIRST_PERSON_MAX_CHARS,
  checkDisclosureStatement,
  checkGhostwriting,
  checkPortfolioOutput,
  describePortfolioViolations,
  disclosureFacts,
  firstPersonRuns,
  ghostwriteFacts,
  safeFeedback,
  safeStatement,
  sentencesOf,
  summarizePortfolioViolations,
} from '../lib/portfolioGuard.mjs';
import { AI_FEATURE_DISCLOSURE_PHRASES } from '../lib/portfolio.mjs';

// ─────────────────────────────────────────────────────────────────
// 事實：一位學生寫了三句話
// ─────────────────────────────────────────────────────────────────

const OWN_TEXT =
  '我從社團中學到很多。高二的時候我參加了機器人社，做了一個自走車。我覺得那次很有趣。';

const facts = () => ghostwriteFacts({ studentText: OWN_TEXT });

/** 規格書 §9.2 的揭露聲明範例，一字不改。 */
const SPEC_STATEMENT =
  '本文之構思與撰寫由本人完成，過程中使用 AI 輔助工具進行文字具體性與邏輯一致性的回饋，未使用 AI 生成內容。';

// ═════════════════════════════════════════════════════════════════
// 一、三十一種代寫，全部要擋下來
// ═════════════════════════════════════════════════════════════════

/**
 * 每一項是 `[這是哪一種手法, 輸出]`。
 *
 * 分成六群：直接寫、把代寫包起來、換人稱、換格式、換語言、拿掉主詞。
 * 分群不是為了好看——**它是這份清單的完整性檢查**：新增一種手法時要
 * 問「它屬於哪一群」，屬於哪一群都不是的那一種就是這份清單漏掉的。
 */
const GHOSTWRITTEN = [
  // ── 直接寫 ────────────────────────────────────────────────
  ['第一人稱長段', '我從小就對資訊科技充滿興趣，國中時第一次接觸程式設計，那種把想法變成畫面的成就感讓我決定往這條路走。'],
  ['短但完整的自傳句', '我在高二下開始接觸機器學習，從看不懂公式到能自己實作一個分類器，花了整整一個學期。'],
  ['條列而每條是完整句', '1. 我在高一參加了辯論社，學會了如何組織論點。2. 我在高二擔任社長，開始理解帶人比做事難。'],
  ['引號整段包起來', '「我對資料科學的興趣始於高二的一次統計課，那次我第一次發現數字背後可以說出故事。」'],
  ['markdown 粗體包起來', '**我在高二那年參加了全國科展，第一次知道一份報告要改十幾遍才能見人。**'],

  // ── 把代寫包起來 ──────────────────────────────────────────
  ['你可以這樣寫', '你可以這樣寫：我從高一開始就對材料科學產生興趣，經過三年的探索，我更確定了自己的方向。'],
  ['你可以說', '你可以說：我在那段時間每天留校到七點，只為了把那個電路調到穩定。'],
  ['參考範例', '參考範例：在機器人社的三年裡，我從一個完全不懂電路的人，變成能獨立完成自走車控制程式的人。'],
  ['範文', '範文：從國中的科展開始，我就對生物產生了濃厚的興趣，高中三年更讓這份興趣變成了志向。'],
  ['模板', '這是一個常用的模板。我從小就喜歡觀察自然，高中的探究課讓我把這份好奇變成有方法的研究。'],
  ['以下是為你撰寫', '以下是為你撰寫的就讀動機，供你參考。在高中三年的探索中，我逐漸確立了對資訊工程的興趣。'],
  ['提供一個版本', '以下提供一個版本供你參考。在三年的高中生活中，我逐漸從一個被動的學習者變成主動的探索者。'],
  ['建議改成', '建議改成：「那次比賽讓我第一次體會到，團隊合作不是把工作分完就結束。」'],
  ['修改後的版本', '修改後的版本如下。三年的社團經驗讓我學到的遠比想像中多，尤其是在溝通這件事情上。'],
  ['潤飾後的內容', '潤飾後的內容：我的高中三年可以用一個詞概括，那就是嘗試。每一次嘗試都讓我更了解自己。'],
  ['重寫後的段落', '重寫後的段落：對我而言，那場比賽的意義不在名次，而在我第一次獨立完成了一整套流程。'],
  ['幫你潤飾', '我幫你潤飾了一下。在自主學習的過程中，我學會了如何規劃時間，也在高二那年學會面對失敗。'],
  ['幫你把這句改寫成', '幫你把這句改寫成：那次社團經驗讓我明白，領導不是下指令，而是讓每個人知道自己為什麼在這裡。'],
  ['試著這樣寫', '試著這樣寫：那次失敗讓我意識到，準備不足不是能力問題，而是我對時間的估計太樂觀了。'],
  ['第一段可以這樣開頭', '第一段可以這樣開頭：高中三年，我最深刻的一次改變發生在高二下學期的一堂物理課上。'],
  ['草稿如下', '草稿如下。我在高二加入了資訊研究社，第一次寫出可以跑的程式時，那種感覺我到現在還記得。'],
  ['直接複製貼上', '這段可以直接複製貼上。我對貴系的課程規劃相當嚮往，希望能在這裡深化我的專業。'],
  ['一鍵採用', '採用此版本：三年來我持續投入自主學習，累積了跨領域的視野，也培養了獨立解決問題的能力。'],
  ['關於某項可以寫', '關於就讀動機，可以寫：我對這個領域的興趣來自高二的一次專題。那次專題讓我發現自己喜歡動手做。'],

  // ── 換人稱 ────────────────────────────────────────────────
  ['本人', '本人自高中一年級起即積極參與科學研究社團，累積了扎實的實驗設計能力與資料分析經驗。'],
  ['筆者', '筆者於高二時參與全國科展，並以自製感測器獲得佳作，該經驗奠定了往後研究的基礎。'],
  ['敝人', '敝人於高中期間擔任班級幹部三學期，並主導兩次班際競賽的籌辦工作。'],

  // ── 申請文件的語域 ────────────────────────────────────────
  ['貴系', '未來我希望能在貴系的實驗室中，延續高中時期對材料表面處理的探索，並進一步學習理論基礎。'],
  ['綜上所述', '綜上所述，三年的努力讓我具備了進入這個領域所需要的基礎與熱情，也讓我更確定自己的方向。'],

  // ── 換語言 ────────────────────────────────────────────────
  [
    '英文第一人稱',
    'I have always been fascinated by the way materials behave under stress, and this curiosity grew stronger during my second year in high school.',
  ],
  [
    '英文的框',
    'Here is a draft for your statement: My interest in computer science began in junior high school when I wrote my first program.',
  ],

  // ── 拿掉主詞 ──────────────────────────────────────────────
  //
  // 這一群是「把主詞拿掉就過得去」那條捷徑。`PASTEABLE` 與第一人稱
  // 規則用同一個 40 字門檻，就是為了不讓它成立。
  ['無主詞的成段敘述', '高二那年的專題研究是一個轉折。從那之後，對材料科學的興趣就不再只是好奇，而是變成明確的方向。'],
];

test('三十一種代寫的寫法，每一種都要被擋下來', () => {
  assert.ok(GHOSTWRITTEN.length >= 30, `紅隊樣本只有 ${GHOSTWRITTEN.length} 種，規格要求至少 30 種`);
  const missed = [];
  for (const [how, text] of GHOSTWRITTEN) {
    const v = checkGhostwriting(text, facts());
    if (!v.ghostwritten) missed.push(`${how}：${text.slice(0, 24)}…`);
  }
  assert.deepEqual(missed, [], `這幾種代寫沒有被擋下來：\n${missed.join('\n')}`);
});

test('被擋下來的一律是 GHOST 等級，不是「重來一次還這樣就收下」的 STYLE', () => {
  // 這一條在防的是一種很隱蔽的退化：把某一條代寫規則的嚴重度改成
  // STYLE，測試上「有違規」照樣成立，而實際行為變成第二次生成就收下。
  for (const [how, text] of GHOSTWRITTEN) {
    const v = checkGhostwriting(text, facts());
    const ghost = v.violations.filter((x) => x.severity === 'GHOST');
    assert.ok(ghost.length > 0, `${how} 只被判成 STYLE，重試一次之後就會被收下`);
  }
});

// ═════════════════════════════════════════════════════════════════
// 二、反例：好的回饋不可以被誤擋
// ═════════════════════════════════════════════════════════════════

const GOOD = [
  [
    '具體性檢查（規格書 §9.3 的範例）',
    '你寫「我從社團中學到很多」，但沒有說是什麼事情讓你學到什麼，可以舉一個具體的例子嗎？',
  ],
  [
    '一致性檢查（規格書 §9.3 的範例）',
    '你的就讀動機提到對資料科學有興趣，但三件課程學習成果都與這個方向沒有明顯關聯，要不要說明一下連結？',
  ],
  [
    '素材提示（規格書 §9.3 的範例）',
    '你在高二下的物理成績有明顯進步，那段時間發生了什麼？這可能是一個值得寫的轉折。',
  ],
  [
    '選件討論（規格書 §9.3 的範例）',
    '你選的三件都是實驗報告，這個系的建議方向提到重視文字表達與團隊合作，你有沒有其他類型的成果可以考慮？',
  ],
  [
    '拒絕代寫——這一段是五十幾字的第一人稱，而且含著「幫你寫」三個字',
    '我沒有辦法幫你寫這一段，因為學習歷程的意義在於你自己回顧的過程。我可以做的是問你幾個問題，讓你想起當時發生了什麼。你還記得那次做自走車時，卡最久的是哪一步嗎？',
  ],
  [
    '引用學生的原文（引用不是代寫）',
    '你這段寫「高二的時候我參加了機器人社，做了一個自走車。我覺得那次很有趣。」——「很有趣」是你的感受，但招生委員看不到過程。那台自走車最後跑起來了嗎？',
  ],
  ['制度檢查', '綜整心得目前 850 字，超過上限 50 字；圖片 2 張在 3 張之內。要不要看看哪一段可以縮？'],
  ['連續提問', '你提到擔任幹部，但沒有說做了什麼決定。當時最難的一次協調是什麼？你怎麼處理的？結果呢？'],
  ['觀察加提問', '這一段有三個地方講了同一件事，字數大概可以省下六十字。哪一個版本最接近你當時的想法？'],
];

test('好的回饋一項都不可以被擋', () => {
  const wrong = [];
  for (const [what, text] of GOOD) {
    const v = checkGhostwriting(text, facts());
    if (!v.ok) wrong.push(`${what} → ${v.violations.map((x) => x.code).join('、')}`);
  }
  assert.deepEqual(wrong, [], `這幾段好的回饋被誤擋了：\n${wrong.join('\n')}`);
});

test('引用學生原文的長段落不算代寫——少了這個豁免，最有用的回饋會被自己擋掉', () => {
  // 一整段原文原樣引用，長度遠超過 40 字。
  const quoted = `你這一段是這樣寫的：${OWN_TEXT}後面呢？`;
  assert.equal(checkGhostwriting(quoted, facts()).ok, true);
  // 同樣長度、但**改寫過**（潤飾就是代寫的一種）就要被擋。
  const polished =
    '三年的社團經驗讓我學到的遠比想像中多。高二那年，我加入了機器人社並完成了一台自走車，那次的過程至今難忘。';
  assert.equal(checkGhostwriting(polished, facts()).ghostwritten, true);
});

test('沒有學生原文時，引用豁免不會變成一個放行的破口', () => {
  // `ghostwriteFacts()` 是空的（例如學生還沒寫任何東西就按了回饋）。
  // 這時候重疊率恆為 0，所以每一段第一人稱敘述都會被擋——**方向是對的**：
  // 他還沒寫，模型寫出來的一定不是他的。
  const empty = ghostwriteFacts({});
  assert.equal(checkGhostwriting(GHOSTWRITTEN[0][1], empty).ghostwritten, true);
  assert.equal(checkGhostwriting(GOOD[0][1], empty).ok, true);
});

// ═════════════════════════════════════════════════════════════════
// 三、切段：規則的內部行為
// ═════════════════════════════════════════════════════════════════

test('用括號把「你」塞進句子中間，躲不掉', () => {
  // 這是被 40 字規則擋掉之後最自然的一種改寫，而且模型會自己想到：
  // 插入語讓整句話含著「你」，於是它被當成回饋的聲音整句放過去，
  // 而括號外面那一整段仍然是一段可以貼走的自傳。
  const dodge = '我在高二時參加了機器人社（你可以換成你自己的社團），那次經驗讓我學會了合作。';
  const runs = firstPersonRuns(dodge);
  assert.equal(runs.length, 1, '含「你」的括號沒有被拿掉，整句被當成回饋放過去了');
  assert.ok(!runs[0].text.includes('你'));
  assert.equal(checkGhostwriting(dodge, facts()).ghostwritten, true);
});

test('不含「你」的括號是敘述的一部分，不可以被拿掉', () => {
  // 拿掉一般的補述會讓字數少算，於是一段剛好 41 字的代寫變成 38 字
  // 而過關。這一條把那個副作用釘住。
  const runs = firstPersonRuns(`我${'寫'.repeat(38)}（大約兩個月）。`);
  assert.equal(runs.length, 1);
  assert.ok(runs[0].chars > FIRST_PERSON_MAX_CHARS);
});

test('問句不會被算進第一人稱敘述', () => {
  assert.deepEqual(firstPersonRuns('我想問你，那件事後來怎麼樣了？'), []);
});

test('冒號是句子邊界——框與被框的東西必須分開看', () => {
  const runs = firstPersonRuns('你可以這樣寫：我從小就對這個領域很有興趣。');
  assert.equal(runs.length, 1);
  assert.ok(!runs[0].text.includes('你'));
});

test('剛好 40 字不擋，41 字要擋（規格書 §13 的門檻）', () => {
  const at40 = `我${'寫'.repeat(39)}。`;
  const at41 = `我${'寫'.repeat(40)}。`;
  const has = (t) => checkGhostwriting(t, facts()).violations.some((v) => v.code === 'FIRST_PERSON_RUN');
  assert.equal(has(at40), false);
  assert.equal(has(at41), true);
});

// ═════════════════════════════════════════════════════════════════
// 四、揭露聲明：規格書 §13 點名的陷阱
// ═════════════════════════════════════════════════════════════════

const TEN_FEEDBACKS = disclosureFacts(
  Array.from({ length: 10 }, () => ({ feature: 'WRITING_FEEDBACK', occurredAt: new Date() })),
);

test('陷阱是真的：§9.2 的揭露聲明範例確實會被防代寫規則擋掉', () => {
  // **這一條最重要。** 只測「聲明走白名單會過」的話，日後有人把第一
  // 人稱規則改鬆而測試照樣綠燈——白名單看起來還在、實際上已經沒有
  // 作用，而下一次規則改回來時沒有人知道為什麼壞了。
  const v = checkGhostwriting(SPEC_STATEMENT, facts());
  assert.equal(v.ghostwritten, true, '§13 說這段聲明會被擋，如果它沒被擋，白名單就失去了理由');
  assert.ok(v.violations.some((x) => x.code === 'FIRST_PERSON_RUN'));
});

test('而它走 DISCLOSURE_STATEMENT 這條路要通過', () => {
  const v = checkPortfolioOutput('DISCLOSURE_STATEMENT', SPEC_STATEMENT, {
    disclosure: TEN_FEEDBACKS,
  });
  assert.equal(v.ok, true, `聲明被自己那一組規則擋了：${describePortfolioViolations(v.violations)}`);
});

test('揭露聲明產生器不會被自己的閘門無限重試', () => {
  // 模擬三次重試：每一次都用同一組規則檢查。若走錯路，三次都會被擋，
  // 而症狀是這個功能永遠轉圈。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const v = checkPortfolioOutput('DISCLOSURE_STATEMENT', SPEC_STATEMENT, {
      disclosure: TEN_FEEDBACKS,
    });
    assert.equal(v.ok, true, `第 ${attempt + 1} 次仍被擋——這正是 §13 警告的無限重試`);
  }
});

test('沒有帶 feature 時走嚴的那一組（往擋的方向倒）', () => {
  assert.equal(checkPortfolioOutput(undefined, SPEC_STATEMENT, {}).ghostwritten, true);
  assert.equal(checkPortfolioOutput('WRITING_FEEDBACK', SPEC_STATEMENT, {}).ghostwritten, true);
  // 認不得的 feature 也一樣。日後新增功能而忘了登錄時，症狀是
  // 「它的輸出常常被擋」，有人會來講；反過來的症狀是沒有人會來講。
  assert.equal(checkPortfolioOutput('SOMETHING_NEW', SPEC_STATEMENT, {}).ghostwritten, true);
});

// ── 排除不等於不檢查 ─────────────────────────────────────────

test('宣稱「未使用 AI 生成內容」但記錄裡有十次撰寫回饋，要被擋下來', () => {
  // 「未使用 AI 生成內容」這句話本身是真的（系統從不生成內容），
  // 但如果整份聲明只有這一句、而記錄裡有十次撰寫回饋，它就是用一句
  // 真話遮住一件該說的事——招生委員讀到的是「這位學生沒有用 AI」。
  const v = checkDisclosureStatement(
    '本文之構思與撰寫由本人完成，未使用 AI 生成內容。',
    TEN_FEEDBACKS,
  );
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.code === 'OMITS_FEATURE'));
  assert.equal(v.ghostwritten, true, '聲明不實一定要重新生成，不可以是 STYLE');
});

test('宣稱完全沒用過 AI，但記錄裡有——這是否認不是揭露', () => {
  const v = checkDisclosureStatement(
    '本文之構思與撰寫由本人完成，全程未使用 AI 輔助工具。',
    TEN_FEEDBACKS,
  );
  assert.ok(v.violations.some((x) => x.code === 'CLAIMS_NO_AI'));
});

test('提到了記錄裡沒有的互動，同樣是不符', () => {
  const v = checkDisclosureStatement(
    '本文之構思與撰寫由本人完成，過程中使用 AI 輔助工具進行文字具體性的回饋與面試回答結構的檢視，未使用 AI 生成內容。',
    TEN_FEEDBACKS,
  );
  assert.ok(v.violations.some((x) => x.code === 'CLAIMS_UNUSED_FEATURE'));
});

test('說內容由 AI 生成——系統不代寫，所以這句話是錯的', () => {
  const v = checkDisclosureStatement(
    '本文由本人完成，部分段落由 AI 生成後修改，過程中使用 AI 進行文字具體性與一致性的回饋。',
    TEN_FEEDBACKS,
  );
  assert.ok(v.violations.some((x) => x.code === 'CLAIMS_GENERATION'));
});

test('一次都沒用過而聲明含糊其詞，也要擋', () => {
  const none = disclosureFacts([]);
  const v = checkDisclosureStatement('本文之構思與撰寫由本人完成。', none);
  assert.ok(v.violations.some((x) => x.code === 'SILENT_WHEN_UNUSED'));
});

test('多種互動時，漏掉其中任何一種都要被抓到', () => {
  const mixed = disclosureFacts([
    { feature: 'WRITING_FEEDBACK' },
    { feature: 'MATERIAL_HINT' },
    { feature: 'SELECTION_DISCUSS' },
    { feature: 'RULE_CHECK' },
  ]);
  // 只講了撰寫回饋，漏掉素材提示與選件討論。
  const v = checkDisclosureStatement(
    '本文之構思與撰寫由本人完成，過程中使用 AI 輔助工具進行文字具體性與一致性的回饋，未使用 AI 生成內容。',
    mixed,
  );
  assert.ok(v.violations.some((x) => x.code === 'OMITS_FEATURE'));

  // 三種都講到就過。
  const full = checkDisclosureStatement(
    '本文之構思與撰寫由本人完成，過程中使用 AI 輔助工具進行文字具體性與一致性的回饋、' +
      '從個人學習紀錄回想素材的提問，以及成果選件的討論，未使用 AI 生成內容。',
    mixed,
  );
  assert.equal(full.ok, true, describePortfolioViolations(full.violations));
});

test('制度檢查與聲明自己不必寫進聲明——否則真正該注意的幾項會被稀釋', () => {
  const onlyRules = disclosureFacts([
    { feature: 'RULE_CHECK' },
    { feature: 'RULE_CHECK' },
    { feature: 'DISCLOSURE_STATEMENT' },
  ]);
  const v = checkDisclosureStatement(
    '本文之構思與撰寫均由本人完成，過程中未使用 AI 輔助工具，亦未使用 AI 生成內容。',
    onlyRules,
  );
  assert.equal(v.ok, true, describePortfolioViolations(v.violations));
});

// ═════════════════════════════════════════════════════════════════
// 五、退路
// ═════════════════════════════════════════════════════════════════

test('程式組出來的聲明，自己通得過自己那一組規則', () => {
  // 退路若通不過檢查，重試用完之後會落到一個永遠不合格的狀態，
  // 而學生交不出揭露——那是及格線不是加分項。
  for (const f of [
    disclosureFacts([]),
    TEN_FEEDBACKS,
    disclosureFacts([
      { feature: 'WRITING_FEEDBACK' },
      { feature: 'MATERIAL_HINT' },
      { feature: 'SELECTION_DISCUSS' },
      { feature: 'INTERVIEW_FEEDBACK' },
    ]),
  ]) {
    const s = safeStatement(f, AI_FEATURE_DISCLOSURE_PHRASES);
    const v = checkDisclosureStatement(s, f);
    assert.equal(v.ok, true, `退路版本自己不合格：「${s}」→ ${describePortfolioViolations(v.violations)}`);
  }
});

test('程式組出來的回饋通得過防代寫閘門', () => {
  const s = safeFeedback([
    { code: 'SUMMARY_CHARS', ok: false, detail: '850 字，超過上限 800 字 50 字。' },
    { code: 'SELF_O', ok: true, detail: 'O 高中學習歷程反思：1200 字。' },
  ]);
  const v = checkGhostwriting(s, facts());
  assert.equal(v.ok, true, describePortfolioViolations(v.violations));
});

// ═════════════════════════════════════════════════════════════════
// 六、給學生看的說法不含被擋掉的原文
// ═════════════════════════════════════════════════════════════════

test('給學生的違規說明不會把代寫的原文引用出來', () => {
  // 把被擋的原文顯示給學生，等於用「這段被擋了」這個包裝把代寫送到
  // 他眼前——他會記住那句話然後自己打一次。
  const bad = GHOSTWRITTEN[0][1];
  const v = checkGhostwriting(bad, facts());
  const forStudent = summarizePortfolioViolations(v.violations).join(' ');
  assert.ok(forStudent.length > 0);
  assert.ok(!forStudent.includes('我從小就'), '學生看得到的說法引用了被擋掉的代寫');
  // 伺服器日誌那一份反而要具體，老師才判斷得出模型差一點寫了什麼。
  assert.ok(describePortfolioViolations(v.violations).includes('我從小就'));
});

test('每一種違規代號都有給學生看的說法', () => {
  const seen = new Set();
  for (const [, text] of [...GHOSTWRITTEN, ...DODGES, ...GOOD]) {
    for (const v of checkGhostwriting(text, facts()).violations) seen.add(v.code);
  }
  for (const f of [TEN_FEEDBACKS, disclosureFacts([])]) {
    for (const s of ['本文由 AI 生成。', '本文之構思與撰寫由本人完成。', '']) {
      for (const v of checkDisclosureStatement(s, f).violations) seen.add(v.code);
    }
  }
  for (const code of seen) {
    const label = summarizePortfolioViolations([{ code, severity: 'GHOST', detail: '' }])[0];
    assert.ok(
      !label.endsWith('不符合這一層的規則'),
      `${code} 沒有給學生看的說法，畫面上只會顯示一句沒有資訊的話`,
    );
  }
});

// ═════════════════════════════════════════════════════════════════
// 七、情境模擬找出來的四種繞法
//
// 這四種在 v0.26.0 的閘門上**零違規**，而它們都是模型被前面幾條規則
// 擋掉之後最省力的下一步。分成兩軸：
//
//   換人稱  「我」→「該生」→ 拿掉主詞  （三條規則同時只認第一人稱）
//   換句法  一句逗號串到底 / 每寫一句就插一個問句  （湊不滿兩句）
//
// 加上一個**整篇層級**的漏：`sentences()` 的邊界裡沒有半形句點，
// 於是整篇英文散文是「一個句子」，最後那句 `Does this match…you…?`
// 讓整篇被當成「對學生說話」而豁免。檔頭第 97 行接受的是**子句層級**
// 的那個交換，不是這個。
// ═════════════════════════════════════════════════════════════════

const DODGES = [
  [
    '第三人稱＋每寫一句就插一個問句（chain 每次被歸零）',
    '該生自高二起投入機器人社，從完全不懂電路到能獨立完成自走車的控制程式。這樣的說法貼近你的記憶嗎？那段過程讓他確認了對電機領域的興趣，也讓他明白分工不是把事情切開就好。你會怎麼改？',
  ],
  [
    '第三人稱＋一句逗號串到底（永遠湊不滿兩句）',
    '該生自高中二年級加入機器人社以來，歷經三次比賽的失敗與重做，逐步從一個連麵包板都不會插的人，成長為能獨立完成自走車控制程式並帶領三人小組完成專題的學習者。這樣講你接得起來嗎？',
  ],
  [
    '拿掉主詞＋一句逗號串到底',
    '高二那年的專題研究成為一個明確的轉折點，從那之後對材料科學的興趣不再只是好奇，而是逐漸長成一個可以說得出理由、也找得到方法去追的方向。這樣講你接得起來嗎？',
  ],
  [
    '整篇英文，最後補一句含 you 的問句',
    'I first encountered robotics in the tenth grade. I spent two months building a self-driving car, and that experience turned a vague curiosity into a clear direction. Does this match what you remember?',
  ],
  [
    '中文整段只用逗號、句尾補一個問句',
    '該生在高二上第一次接觸機構設計，接著在高二下把那份興趣帶進自主學習，最後在高三上完成了一台可以循跡的自走車，也讓他確定了要往電機這條路走。這一段你認得出是自己的經歷嗎？',
  ],
  [
    '推薦函的口吻（第三人稱、沒有時間落點）',
    '該生具備良好的溝通能力與團隊合作精神，並能在壓力下維持穩定的表現，是一位值得推薦給貴系的學生。',
  ],
];

test('換人稱與換句法的繞法，每一種都要被擋下來', () => {
  const missed = [];
  for (const [how, text] of DODGES) {
    const v = checkGhostwriting(text, facts());
    if (!v.ghostwritten) missed.push(`${how}：${text.slice(0, 24)}…`);
  }
  assert.deepEqual(missed, [], `這幾種繞法沒有被擋下來：\n${missed.join('\n')}`);
});

test('半形句點是句子邊界，所以整篇英文不會被當成一句話', () => {
  // 少了這一條，任何一個 `you` 就讓整篇英文自述豁免：`ADDRESSES_READER`
  // 的意思從「這一句是對學生說話」變成「這一篇是對學生說話」。
  const english =
    'I first encountered robotics in the tenth grade. I spent two months building a self-driving car.';
  assert.equal(firstPersonRuns(english).length, 1);
  assert.equal(sentencesOf(english).length, 2);
});

test('條列的編號不是句號——`1.` 不可以被切成一句', () => {
  // 切開的話，`1. 我在高一…。2. 我在高二…。` 會變成四段短的，
  // 而那一條 41 字的第一人稱敘述就掉到門檻底下。
  assert.equal(sentencesOf('1. 我在高一參加了辯論社。').length, 1);
  assert.equal(sentencesOf('這一份是 3.5MB。').length, 1);
});

// ── 反例：擋更多的同時，不該擋的東西還是不能擋 ──────────────

const GOOD_DODGE_NEGATIVES = [
  [
    '整篇英文的回饋（英文不等於代寫）',
    'You wrote that you learned a lot from the club, but you never say what actually happened. Which week do you remember best? What did you do that the others did not?',
  ],
  [
    '一句超過 40 字的制度說明（沒有時間落點，不是自傳）',
    '多元表現綜整心得有八百字與三張圖的明文限制，但它不計入十件多元表現的額度，所以不需要為了它刪掉別的東西。要不要看看你現在這一份有幾張圖？',
  ],
  [
    '提到招生委員（有第三人稱，但講的不是學生的經歷）',
    '委員手上只有那份檔案，他讀到「很有幫助」的時候接不上前因後果。你要不要在那一句後面補一件具體發生過的事？',
  ],
  [
    '敢問到底的追問——一個連這句都不敢說的 AI 沒有用',
    '你要不要講講那次比賽你負責的是哪一部分？當時最卡的一步是什麼？後來是誰把它解掉的？',
  ],
  [
    '引用學生原文之後再問（引用不是代寫）',
    '你這一段寫「高二的時候我參加了機器人社，做了一個自走車。我覺得那次很有趣。」——那台自走車最後跑起來了嗎？',
  ],
];

test('擋更多之後，好的回饋一項都不可以被誤擋', () => {
  const wrong = [];
  for (const [what, text] of GOOD_DODGE_NEGATIVES) {
    const v = checkGhostwriting(text, facts());
    if (!v.ok) wrong.push(`${what} → ${describePortfolioViolations(v.violations)}`);
  }
  assert.deepEqual(wrong, [], `這幾段好的回饋被誤擋了：\n${wrong.join('\n')}`);
});

// ═════════════════════════════════════════════════════════════════
// 八、揭露聲明的數字與否定
//
// 這份文件會被貼進學習歷程給招生委員看，所以它上面的**每一個字與
// 每一個數字**都要跟記錄對得起來。三件事：
//
//   · 「共 N 次」不可以把「產生聲明」自己那幾筆算進去
//   · 誠實的否定句（「未使用 AI 協助挑選素材」）不可以被當成不實
//   · 把該說的事寫成「由本人進行」不可以算成揭露過了
// ═════════════════════════════════════════════════════════════════

test('「共 N 次」不算「產生聲明」自己那幾筆——按幾次重新產生都一樣', () => {
  // 學生只用過 3 次撰寫回饋，按了 4 次「重新產生」。列舉的類別只有
  // 一種，數字卻會變成七——而這份文件是要給招生委員看的。
  const f = disclosureFacts([
    ...Array.from({ length: 3 }, () => ({ feature: 'WRITING_FEEDBACK' })),
    ...Array.from({ length: 4 }, () => ({ feature: 'DISCLOSURE_STATEMENT' })),
  ]);
  assert.equal(f.total, 7, 'total 是稽核用的全部筆數，不該變');
  assert.equal(f.disclosedTotal, 3, '要揭露的次數只算 MUST_DISCLOSE 那幾類');

  const s = safeStatement(f, AI_FEATURE_DISCLOSURE_PHRASES);
  assert.ok(s.includes('共 3 次'), `聲明上的數字是錯的：「${s}」`);
  assert.ok(!s.includes('共 7 次'));
  assert.equal(checkDisclosureStatement(s, f).ok, true);
});

test('聲明上的次數與記錄對不起來時要被擋', () => {
  const v = checkDisclosureStatement(
    '本文之構思與撰寫由本人完成，過程中使用 AI 輔助工具進行文字具體性與邏輯一致性的回饋，共 7 次，未使用 AI 生成內容。',
    TEN_FEEDBACKS,
  );
  assert.ok(v.violations.some((x) => x.code === 'MISCOUNTS'));
  assert.equal(v.ghostwritten, true);

  // 對得上的就不擋。
  const ok = checkDisclosureStatement(
    '本文之構思與撰寫由本人完成，過程中使用 AI 輔助工具進行文字具體性與邏輯一致性的回饋，共 10 次，未使用 AI 生成內容。',
    TEN_FEEDBACKS,
  );
  assert.equal(ok.ok, true, describePortfolioViolations(ok.violations));
});

test('誠實的否定句不可以被當成「宣稱未使用 AI」或「宣稱用了沒用過的功能」', () => {
  // 記錄裡只有撰寫回饋。這一份把「沒有用 AI 挑素材」講出來是誠實，
  // 而學生看到「模型三次都寫出與記錄不符的聲明」是一句冤枉話——
  // 冤枉三次之後他會轉去用別的工具，那才是最壞的結果。
  const v = checkDisclosureStatement(
    '本文之構思與撰寫由本人完成，過程中使用 AI 輔助工具進行文字具體性與邏輯一致性的回饋，' +
      '未使用 AI 協助挑選素材，亦未使用 AI 生成內容。',
    TEN_FEEDBACKS,
  );
  assert.equal(v.ok, true, describePortfolioViolations(v.violations));
});

test('把該說的事寫成「由本人進行」，遮不掉記錄裡的十次撰寫回饋', () => {
  // 這正是檔頭說要擋的「用一句真話遮住一件該說的事」：句子裡確實有
  // 「具體性」三個字，而那句話講的正好相反。
  const v = checkDisclosureStatement(
    '本文之構思與撰寫由本人完成，文字具體性與邏輯一致性的檢視亦由本人反覆進行，' +
      '未透過 AI 工具生成任何內容。',
    TEN_FEEDBACKS,
  );
  assert.equal(v.ok, false, '一句真話遮住了十次撰寫回饋，而閘門放它過去了');
  assert.ok(v.violations.some((x) => x.code === 'OMITS_FEATURE'));
});

test('全篇否認仍然要擋——放寬否定的判定不可以把這一條一起放掉', () => {
  const v = checkDisclosureStatement(
    '本文之構思與撰寫由本人完成，全程未使用 AI 輔助工具。',
    TEN_FEEDBACKS,
  );
  assert.ok(v.violations.some((x) => x.code === 'CLAIMS_NO_AI'));
});
