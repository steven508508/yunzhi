/**
 * 學習歷程的確定性閘門：擋的是**代寫**。
 *
 * # 這是第四道閘門，而它擋的東西與前三道都不同
 *
 * `lib/tutorGuard.mjs` 擋洩漏答案——傷害立刻發生而且看得見。
 * `lib/adviceGuard.mjs` 擋假的精確度——讀起來專業、完全沒有症狀。
 * 這一層擋的是第三種：**一段學生可以直接貼進去的文字。**
 *
 * 它的失效方式最安靜。洩漏答案至少學生知道自己看了答案；假精確度至少
 * 事後對得出來。代寫不一樣——學生貼上去、送出去、上榜或沒上榜，
 * 整個過程沒有任何一個時點會有人發現。**唯一的症狀是他失去了那個
 * 回顧與反思的過程**，而那正是學習歷程檔案存在的全部理由。
 *
 * 而且這一層的對手最積極。學生問智慧老師「直接告訴我答案」是偷懶，
 * 問這一層「幫我寫」是他真的寫不出來、離截止日剩三天、而且他覺得
 * 別人一定也在用 AI 寫。那個處境下他會一直換說法，所以規則要密。
 *
 * # 三層設限，這裡是第二層
 *
 * **提示層**（`apps/ai/pipeline/portfolio_prompts.py`）禁止產出可直接
 * 使用的完整段落。擋得住正常情況，擋不住第三次要求。
 * **後處理層**（這個檔案）看完整段輸出、用規則判斷、命中就整段丟掉
 * 重新生成。
 * **介面層**（`app/(app)/portfolio/**`）回饋以問題與觀察呈現，
 * **沒有「一鍵套用」這類動作**——那個按鈕本身就是代寫。
 *
 * # 規格書 §13 的兩條確定性規則，以及為什麼要再加幾條
 *
 * 規格書寫的是兩條：**連續的第一人稱敘述超過 40 字**即判定為代寫；
 * **輸出可以被直接複製使用**（成段的完整句子且與學生原文高度不同）
 * 同樣重新生成。這兩條是驗收準則，一定要在。
 *
 * 但只有這兩條會漏掉一整類寫法：模型被擋掉之後不會停止代寫，
 * 它會把代寫**包起來**——「你可以這樣寫：……」「參考範例：……」
 * 「修改後的版本：……」。包起來之後那段第一人稱仍然在，只是前面多了
 * 一句框，而那句框本身是最好認的證據。所以另外有一條抓框
 * （`GHOSTWRITE_LEAD`），而且它比長度規則更早命中。
 *
 * # 「與學生原文高度不同」這一句要反過來讀
 *
 * 它的意思是：**引用學生自己寫的東西不算代寫。** 而具體性檢查
 * 最有用的形式恰恰是引用——「你寫『我從社團中學到很多』，但沒有說是
 * 什麼事情讓你學到什麼」。少了這個豁免，這個功能最該給的那一種回饋
 * 會被自己擋掉。
 *
 * 所以 `ghostwriteFacts()` 收學生的原文，而每一段第一人稱敘述在被判違規
 * 之前，先問「這段話在他自己的文字裡找得到嗎」。找得到就是引用。
 * 門檻訂得高（四字組的重疊率 0.82），因為「高度不同」的反面不是
 * 「有點像」——潤飾過的句子與原句有一半重疊，而潤飾就是代寫的一種。
 *
 * # 代寫的敘述怎麼認：靠「你」這個字，而**不是**靠人稱
 *
 * 最麻煩的誤擋是這一種：
 *
 *   「我沒有辦法幫你寫這一段，因為學習歷程的意義在於你自己回顧的過程，
 *     我可以做的是問你幾個問題，讓你想起當時發生了什麼。」
 *
 * 這是一段五十幾字的連續第一人稱，而它正是這個功能最該說的話。
 *
 * 分辨的方式不是語意理解，是一個機械的事實：**回饋的聲音永遠在對學生
 * 說話（句子裡有「你」），代寫出來的敘述永遠沒有**——那是學生自己的
 * 故事，故事裡不會有「你」。
 *
 * 這一招有一個明顯的繞法，而模型會自己想到：把「你」用插入語塞進句子
 * 中間（「我在高二時參加了機器人社（你可以換成你自己的社團），那次
 * 經驗讓我學會了合作。」），整句話就變成「回饋的聲音」被放過去。所以
 * `normalizeForPortfolio()` 會先把**含「你」的括號整段拿掉**——那句
 * 插入語不是敘述的一部分，拿掉之後它就回到原本的樣子。
 *
 * ## 人稱是最容易換掉的東西，所以切段的時候不看它
 *
 * 第一版把「連續的敘述」與「第一人稱」綁在一起，結果三條規則同時只認
 * 我／本人／筆者，而**這三步都讀得通、每一步在字串上完全不同**：
 *
 *     我在高二加入機器人社…  →  該生自高二起投入機器人社…
 *     →（拿掉主詞）高二那年的專題研究成為一個明確的轉折點…
 *
 * 換完之後那一段對學生一樣貼得進去——他只要把「該生」換回「我」。
 * 所以 `narrativeRuns()` **只問「這一句有沒有在對學生說話」**，人稱
 * 留給呼叫端當條件：§13 那條 40 字的規則問第一人稱，它的鏡像問
 * 「該生」，自傳口吻那條問「有沒有指到學生」，可整段貼走那條完全不問。
 *
 * ## 句子的邊界也是這一層的防線，而且它漏掉的是**整篇**
 *
 * `sentences()` 原本的邊界裡沒有半形句點，於是一整篇英文散文是「一個
 * 句子」——最後補上一句「Does this match what you remember?」就讓
 * 「這一句是對學生說話」變成「這一篇是對學生說話」，整篇自述豁免。
 * 中文只用逗號、句尾補一個問句也複製得出來。這與下面第二點那個
 * 「子句層級」的取捨是兩回事：那一種漏掉一個子句，這一種漏掉一整篇。
 *
 * # 揭露聲明必須走另一條路，否則這個功能會把自己擋掉
 *
 * 規格書 §13 點名的陷阱。§9.2 的揭露聲明範例——
 *
 *   「本文之構思與撰寫由本人完成，過程中使用 AI 輔助工具進行文字
 *     具體性與邏輯一致性的回饋，未使用 AI 生成內容」
 *
 * ——本身就是一段五十幾字的連續第一人稱敘述，句子裡沒有「你」，
 * 而且依 §9.6 的驗收準則它**必須隨互動性質變化、不能寫死成樣板**，
 * 也就是必須由模型生成。若不排除，揭露聲明產生器會被自己的後處理層
 * 無限重試，而症狀是它永遠轉圈——一個功能把自己擋掉。
 *
 * **排除的方式是功能別的白名單，而排除不等於不檢查。**
 * `feature = DISCLOSURE_STATEMENT` 走 `checkDisclosureStatement()`，
 * 那一組規則問的是完全不同的問題：**這份聲明說的話與 `AiDisclosureLog`
 * 的實際記錄相符嗎。** 一份宣稱「未使用 AI 生成內容」而完全沒有提到
 * 十次撰寫回饋的聲明要被擋下來——那不是揭露，那是遺漏。
 *
 * 兩組規則的入口是同一支 `checkPortfolioOutput(feature, ...)`，
 * 所以呼叫端不可能忘記分流；忘了傳 feature 的話走的是**嚴的那一組**。
 *
 * ## 這一組要看的是「那句話說了什麼」，不是「那幾個字在不在」
 *
 * 這份文件會被貼進學習歷程給招生委員看，所以它的每一個字與每一個數字
 * 都要對得回記錄，而兩個方向都會出事：
 *
 *   · 只比對關鍵詞在不在，於是「文字具體性的檢視**亦由本人反覆進行**」
 *     被算成揭露過了——那句話講的正好相反，它遮住的正是那十次。
 *   · 同一個毛病反過來：「**未**使用 AI 協助挑選素材」被判成「宣稱用了
 *     沒用過的功能」，而那是一句誠實話。冤枉三次之後學生會轉去用別的
 *     工具，那才是最壞的結果——他用了、系統沒記錄、聲明上寫著沒用過。
 *
 * 所以規則二、三走 `aiClauses()`：逐子句判肯否，沒有線索的子句沿用
 * 前一句（一份把三類都列出來的正確聲明，中間那兩個子句裡一個 AI 都
 * 沒有）。次數則由 `disclosedTotal` 管——見 `disclosureFacts()`。
 *
 * # 這一層擋不住的三件事
 *
 * 一、**擋不住「用問句代寫」。** 「你是不是想說，那次失敗讓你第一次
 *     意識到自己其實沒有真的理解那個原理？」——這句話把一整個句子
 *     送給了學生，而它是一個問句。這一層擋的是可機械辨識的代寫。
 * 二、**擋不住把「你」灑進每一個子句。** 括號的那一種擋得住（見上面），
 *     但「我在高二加入了社團，你可以換成自己的，那次經驗讓我學會合作」
 *     這種沒有括號的插入語會讓整句話被當成回饋的聲音。這裡沒有為它
 *     再加一條規則，因為要擋它就得改成子句層級判定，而那會把
 *     「你寫『我從社團中學到很多』」這種引用切碎、開始誤擋最有用的
 *     那一種回饋。**在這個交換上寧可漏這一種。** 它也不是模型自然會
 *     寫出來的東西——那樣的句子讀起來是壞的，而模型傾向寫得通順。
 *
 *     這個交換的範圍是**一個子句**。同樣的招數放大到一整句、一整段、
 *     一整篇就不在交換裡了，那是句子邊界要擋的（見上面）。
 * 三、**它不判斷回饋寫得好不好。** 它只驗證那段話沒有辦法被直接貼進
 *     檔案，不驗證它有沒有幫助。
 * 四、**它不能保證重新生成之後就變好。** 所以重試有上限，用完就退回
 *     `safeFeedback()`——一份由程式組出來的制度檢查結果，不經過模型。
 */

// ─────────────────────────────────────────────────────────────────
// 正規化
//
// **不折中文數字**（與 adviceGuard 同一個理由：這裡不比數字），
// 也**不折標點**——句子邊界是這一層的主要工具，折掉句號等於把
// 「三個短句」與「一段長敘述」變成同一個東西。
// ─────────────────────────────────────────────────────────────────

/** 比對用的形式。匯出是給測試用的。 */
export function normalizeForPortfolio(text) {
  if (!text) return '';
  return String(text)
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    // Markdown 的粗體與標題符號。模型會用 `**我從小就……**` 把一段
    // 代寫加粗當成「範例」，而那些星號躲得過每一條句子規則。
    .replace(/\*+/g, '')
    .replace(/^#+\s*/gm, '')
    // **括號裡對讀者說的話不是敘述的一部分，要拿掉再看。**
    //
    // 這是被 40 字規則擋掉之後最自然的一種改寫，而且模型會自己想到：
    // 「我在高二時參加了機器人社（你可以換成你自己的社團），那次經驗
    // 讓我學會了合作。」——那個插入語讓整句話含著「你」，於是它被當成
    // 回饋的聲音整句放過去，而括號外面那一整段仍然是一段可以貼走的
    // 自傳。拿掉插入語之後，它就回到原本的樣子。
    //
    // 只拿掉**含「你」的**括號：一般的補述（「（大約兩個月）」）是敘述
    // 的一部分，拿掉會讓字數少算。
    .replace(/[（(【][^）)】]{0,60}[你妳您][^）)】]{0,60}[）)】]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** 只留下字，用來算重疊率與字數。標點與空白都不算。 */
function bare(text) {
  return String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 中文的字數（不是 UTF-16 單元數）。 */
function charLen(text) {
  return Array.from(bare(text)).length;
}

// ─────────────────────────────────────────────────────────────────
// 事實：這一次回饋是針對誰的哪一段文字
// ─────────────────────────────────────────────────────────────────

/**
 * 把學生的原文折成閘門要的形狀。
 *
 * @param {object} input
 * @param {string} [input.studentText] 學生自己寫的（自述、綜整心得、面試回答）
 * @param {string[]} [input.extraOwnText] 其他也算他自己寫的（素材標題、備註）
 * @returns {{grams: Set<string>, hasText: boolean}}
 *
 * 存成四字組的集合而不是原文，因為要問的問題是「這段話有多少比例
 * 在他的文字裡出現過」，而那是集合的包含關係。四字而不是三字：
 * 三字組在中文裡的碰撞率高到「隨便一段話都有一半在他的文章裡」，
 * 於是豁免變成放行。
 */
export function ghostwriteFacts(input = {}) {
  const own = [input.studentText ?? '', ...(input.extraOwnText ?? [])]
    .map((t) => bare(t))
    .join(' ');
  const grams = new Set();
  const chars = Array.from(own);
  for (let i = 0; i + 4 <= chars.length; i += 1) {
    const g = chars.slice(i, i + 4).join('');
    if (!g.includes(' ')) grams.add(g);
  }
  return { grams, hasText: charLen(input.studentText ?? '') > 0 };
}

/**
 * 這一段話有多少比例在學生自己的文字裡出現過。
 *
 * 太短的片段一律回 0（`grams` 湊不滿四個字），因為短句本來就容易碰撞，
 * 而短句本來也不會觸發長度規則。
 */
function overlapWithOwn(segment, facts) {
  const chars = Array.from(bare(segment));
  if (chars.length < 8) return 0;
  const grams = facts?.grams;
  if (!grams || grams.size === 0) return 0;
  let hit = 0;
  let total = 0;
  for (let i = 0; i + 4 <= chars.length; i += 1) {
    total += 1;
    if (grams.has(chars.slice(i, i + 4).join(''))) hit += 1;
  }
  return total === 0 ? 0 : hit / total;
}

/**
 * 判定為「引用學生原文」的門檻。
 *
 * 0.82 而不是 0.5：**潤飾過的句子與原句大約有一半重疊**，而潤飾就是
 * 代寫的一種——「我從社團中學到很多」改成「三年的社團經驗讓我學到
 * 的遠比想像中多」，那不是回饋，那是替他寫。門檻要高到只有真正的
 * 引用（原樣或只改了標點）過得去。
 */
export const QUOTE_THRESHOLD = 0.82;

// ─────────────────────────────────────────────────────────────────
// 句子切分
// ─────────────────────────────────────────────────────────────────

/**
 * 切成句子。**冒號、破折號、引號的開頭都算邊界。**
 *
 * 這一點與一般的斷句需求不同：「你可以這樣寫：我從小就……」如果不在
 * 冒號斷開，整句話會因為含「你」而被當成回饋的聲音放過去，
 * 而冒號後面那一整段正是代寫。**框與被框的東西必須分開看。**
 *
 * # 半形句點也是邊界，而它漏掉的後果是**整篇層級**的
 *
 * 少了它，一整篇英文散文是「一個句子」——於是最後補上的一句
 * 「Does this match what you remember?」把 `ADDRESSES_READER` 的意思
 * 從「這一句是對學生說話」變成「這一篇是對學生說話」，整篇自述豁免。
 * 檔頭第 97 行接受的是**子句層級**的那個交換（把「你」灑進每一個
 * 子句），不是這一種。中文只用逗號、句尾補一個問句也複製得出來。
 *
 * **前面是數字的句點不算。** 「1. 我在高一參加了辯論社」的那個點是
 * 條列的編號、「3.5MB」的那個點是小數點，切開它們會把一段連續的敘述
 * 拆成幾段短的，然後那段代寫就掉到字數門檻底下——與漏掉句點方向相反、
 * 後果一樣。
 */
export function sentencesOf(text) {
  return String(text ?? '')
    .split(/(?<=[。！？!?；;：:\n])|(?<=[A-Za-z一-鿿)\]”’"'][.])(?=\s|$)|(?=[「『"“])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

const sentences = sentencesOf;

/** 第一人稱的標記。「本人」「筆者」是申請文件裡最常見的兩種變體。 */
const FIRST_PERSON = /[我吾]|本人|筆者|敝人|\bI\b|\bmy\b|\bme\b/i;

/**
 * 第三人稱指名學生的說法。**「該生」是這一組的主角。**
 *
 * 把「我」換成「該生」是被第一人稱規則擋掉之後最省力的一步，而且
 * 換完之後那一段對學生來說**一樣貼得進去**——他只要再把「該生」
 * 換回「我」。三條規則同時只認第一人稱的話，這一步等於整組閘門失效。
 *
 * 這一組刻意只收**指名學生**的說法，不含裸的「他」：見 `THIRD_PERSON`。
 */
const EXPLICIT_STUDENT = /該(?:生|童)|該名?(?:學生|同學)|這[位名](?:學生|同學)|學生本人/;

/**
 * 泛指的第三人稱。**比 `EXPLICIT_STUDENT` 寬，所以用在比較嚴的條件下。**
 *
 * 裸的「他」在回饋裡有正當用途（「委員手上只有那份檔案，他讀到這裡
 * 接不上前因後果」），所以它只在「這一段同時帶著時間與事件的落點」
 * 這個條件下才算數（`NARRATIVE_VOICE`），不單獨構成長度違規。
 *
 * 「其他」要排除掉——它每一次出現都會被誤認成第三人稱。
 */
const THIRD_PERSON = new RegExp(`${EXPLICIT_STUDENT.source}|(?<![其])[他她]`);

/**
 * 回饋的聲音：對學生說話。
 *
 * 「您」也算——模型偶爾會轉成敬語。「你們」不另外處理，它一樣是對讀者
 * 說話。
 */
const ADDRESSES_READER = /[你妳您]|\byou\b|\byour\b/i;

/**
 * 問句。**問句本身不可能是代寫**——沒有人會把一個問句貼進學習歷程檔案。
 *
 * 這是這一層最重要的豁免之一，而且它與介面層的設計是同一件事：
 * 規格書要求回饋以問題與觀察呈現，所以合格的輸出裡問句佔多數。
 */
const IS_QUESTION = /[？?]\s*$/;

/**
 * 把輸出切成「不是在對學生說話」的連續段落。**不問人稱。**
 *
 * 規則：不是問句、**且不含「你」**的句子會累積成一段；任何其他句子
 * 把段落切斷。切斷而不是跳過，理由見檔頭。段落（換行）也切斷——
 * 跨行累積會把制度檢查的三行條列串成一段，然後那一段開始湊得到字數。
 *
 * # 為什麼這一支不問人稱
 *
 * 因為人稱是**最容易換掉的東西**：「我」→「該生」→ 拿掉主詞，
 * 三步都讀得通，而且每一步在字串上都完全不同。**共同的、換不掉的
 * 特徵是「這一段沒有在對讀者說話」**——那是檔頭那一招的原話，
 * 只是原本的實作把它與「第一人稱」綁在一起了。
 *
 * 人稱留給呼叫端當**條件**：規格書 §13 那條 40 字的規則問第一人稱，
 * 自傳口吻那條問「有沒有指到學生」，可整段貼走那條完全不問。
 *
 * @returns {{text: string, chars: number, sentences: number}[]}
 */
export function narrativeRuns(text) {
  const out = [];
  for (const para of normalizeForPortfolio(text).split(/\n+/)) {
    let buf = [];
    const flush = () => {
      if (buf.length === 0) return;
      const joined = buf.join('');
      out.push({ text: joined, chars: charLen(joined), sentences: buf.length });
      buf = [];
    };
    for (const s of sentences(para)) {
      if (IS_QUESTION.test(s) || ADDRESSES_READER.test(s)) {
        flush();
        continue;
      }
      buf.push(s);
    }
    flush();
  }
  return out;
}

/**
 * 其中帶第一人稱的那幾段（規格書 §13 第一條要數的東西）。
 *
 * 匯出是給測試用的——切錯的症狀是某一類代寫永遠擋不到，而那在
 * 端到端測試裡看不出來。
 *
 * @returns {{text: string, chars: number, sentences: number}[]}
 */
export function firstPersonRuns(text) {
  return narrativeRuns(text).filter((r) => FIRST_PERSON.test(r.text));
}

/** 規格書 §13 明訂的字數門檻。 */
export const FIRST_PERSON_MAX_CHARS = 40;

// ─────────────────────────────────────────────────────────────────
// 規則
// ─────────────────────────────────────────────────────────────────

/**
 * 代寫的框。**這一組是模型被長度規則擋掉之後最常改寫成的樣子。**
 *
 * 每一條都是一個獨立的說法，因為它們在字串上完全不同而在學生眼裡
 * 是同一句話。少寫一條，模型就會找到那一條——與 tutorGuard 的
 * 排除法、adviceGuard 的成數是同一種現象。
 */
const GHOSTWRITE_LEAD = [
  // 「可以這樣寫」與「可以寫：」都要抓。後者少了「這樣」兩個字，
  // 而它正是被前者擋掉之後最省力的改寫。
  ['你可以這樣寫', /(?:你|妳|您)?可以(?:這樣|這麼|如此)(?:寫|說|表達|描述|陳述)|可以(?:這樣|這麼)?(?:寫|說)[：:「『]/],
  // 中間允許「把這句」「把這段」這類插入語：「幫你把這句改寫成：」
  // 與「幫你寫」是同一件事，而它們在字串上完全不同。
  [
    '幫你寫',
    /(?:幫|替|為)(?:你|妳|您)(?:把[^。；;：:]{0,12})?(?:寫|撰寫|草擬|擬|生成|產出|完成|潤飾|潤稿|改寫|重寫|修改)/,
  ],
  ['參考範例', /參考(?:範例|範文|例句|寫法|版本)|範例(?:如下)?[：:]|範文|樣稿|模板|範本/],
  ['修改後的版本', /(?:修改|改寫|潤飾|優化|調整|重寫)(?:後|過)(?:的)?(?:版本|內容|段落|文字|如下)/],
  ['以下是', /以下(?:是|為|提供)(?:一段|一篇|我(?:幫|為)你)?/],
  ['建議改成', /建議(?:改|寫|改寫|修改)(?:成|為)[：:「『]/],
  ['直接使用', /直接(?:複製|貼上|拿去用|套用|使用即可|使用)/],
  ['試著這樣說', /(?:試著|不妨)(?:這樣|這麼)(?:寫|說|表達)/],
  ['一鍵套用', /一鍵(?:套用|採用|帶入)|採用此版本/],
  ['草稿如下', /(?:草稿|初稿|全文|內容)(?:如下|如右|在下面)[：:]?/],
  ['第一段可以', /第[一二三四1234](?:段|部分)(?:可以|建議|不妨)(?:這樣|這麼)?(?:寫|開頭|描述)?[：:]/],
];

/**
 * 申請文件的語域。**這幾個詞在回饋裡沒有任何正當用途。**
 *
 * 「貴系」「貴校」是寫給招生委員看的稱呼，回饋是寫給學生看的；
 * 「綜上所述」「由此可見」是結論句式，回饋不下結論。
 * 出現這幾個字，等於模型已經切換成在寫那份文件而不是在看它。
 */
const APPLICATION_VOICE =
  /貴(?:系|校|所|院|中心)|敝人|職涯規劃如下|綜上所述|由此可見|承上所述|職是之故|準此/;

/**
 * 敘事的時間標記。**這一組讓短的代寫也擋得住。**
 *
 * 規格書訂的 40 字是一條保守的線，而實務上一句 38 字的
 * 「本人自高中一年級起即積極參與科學研究社團，累積了扎實的實驗設計
 * 能力」照樣貼得進檔案。差別不在長度而在**它是不是一段自傳**：
 * 自傳一定有時間或事件的落點（高二、國中、那次、當時、第一次），
 * 回饋沒有——回饋講的是「你這一段」而不是「那一年」。
 *
 * 這一條與 40 字那一條並存而不是取代它：40 字那一條是規格書明訂的
 * 驗收準則，不能因為有了更好的規則就把它拿掉。
 */
const NARRATIVE_MARKER =
  /高[一二三123]|高中|國中|國小|[一二三]年級|從小|自小|那時|當時|那次|那年|那段|三年來|這三年|升上|學期|從那之後|第一次|一開始/;

/**
 * 帶敘事標記、而且指得出主角是學生的段落，超過這個長度就貼得進去。
 *
 * 「我」「本人」「該生」「他」都算指得出主角——**換人稱不改變那一段
 * 是誰的故事**，而學生只要把「該生」換回「我」就可以貼。
 */
const NARRATIVE_MIN_CHARS = 20;

/**
 * 同樣帶敘事標記、但**一個主詞都沒有**的段落要多長才算貼得走。
 *
 * 40 而不是 20，與可整段貼走那條同一個數字：沒有主詞的時候，
 * 「高二那年的課程有兩門是必修」這種制度說明與「高二那年的專題研究
 * 成為一個明確的轉折點」在規則上分不開，而前者是這個功能該說的話。
 * 拉到 40 字之後，分得開的是長度——制度說明講不到那麼長還不提到「你」。
 */
const NARRATIVE_MIN_CHARS_NO_SUBJECT = 40;

/**
 * 「成段」的門檻：幾個**連續的**完整句子。
 *
 * 連續而不是「整段裡的所有陳述句」：一段以提問為主的好回饋裡會夾雜
 * 幾句零散的觀察，把它們全部串起來湊字數，擋到的是好輸出。
 *
 * 兩句而不是三句。三句的話，兩句一組的代寫（起句 + 結論句）過得去，
 * 而那個長度已經足夠貼進一個段落的開頭。
 */
const PASTEABLE_MIN_SENTENCES = 2;
/**
 * 「成段」的字數門檻。
 *
 * 40 而不是 60，與第一人稱那條規則同一個數字：一段 42 字、沒有主詞的
 * 「高二那年的專題研究是一個轉折。從那之後，對材料科學的興趣就不再
 * 只是好奇，而是變成明確的方向。」貼得進檔案，而它沒有任何一個「我」。
 * 兩條規則用同一個門檻，是為了不讓「把主詞拿掉」變成一個過關的辦法。
 */
const PASTEABLE_MIN_CHARS = 40;

/** 回饋的長度上限。比升學建議寬——這裡要引用學生的原文再提問。 */
const MAX_FEEDBACK_CHARS = 900;

/**
 * @typedef {object} PortfolioViolation
 * @property {string} code
 * @property {'GHOST'|'STYLE'} severity GHOST 一定重來；STYLE 重來一次還這樣就收下
 * @property {string} detail 給伺服器日誌與老師端看的一句話。**會引用被擋掉的文字。**
 */

/**
 * 一段回饋可以送給學生嗎。
 *
 * @param {string} output 模型產生的一整段文字
 * @param {ReturnType<typeof ghostwriteFacts>} facts
 * @param {{maxChars?: number, requireQuestion?: boolean}} [opts]
 * @returns {{ok: boolean, violations: PortfolioViolation[], ghostwritten: boolean}}
 */
export function checkGhostwriting(output, facts = ghostwriteFacts(), opts = {}) {
  /** @type {PortfolioViolation[]} */
  const v = [];
  const text = normalizeForPortfolio(output);
  const add = (code, severity, detail) => {
    if (!v.some((x) => x.code === code)) v.push({ code, severity, detail });
  };

  // ── 一、連續的第一人稱敘述超過 40 字（規格書 §13 的第一條）──
  //
  // 引用學生自己寫的東西豁免，理由見檔頭。豁免的判定用重疊率而不是
  // 「有沒有被引號包住」——引號可以自己加，重疊率不行。
  const runs = narrativeRuns(text);
  const quoted = (run) => overlapWithOwn(run.text, facts) >= QUOTE_THRESHOLD;
  for (const run of runs) {
    if (!FIRST_PERSON.test(run.text)) continue;
    if (run.chars <= FIRST_PERSON_MAX_CHARS) continue;
    if (quoted(run)) continue;
    add(
      'FIRST_PERSON_RUN',
      'GHOST',
      `有一段 ${run.chars} 字的連續第一人稱敘述，而且在學生自己的文字裡找不到：` +
        `「${run.text.slice(0, 40)}…」。這一段可以被直接貼進檔案。`,
    );
    break;
  }

  // ── 一之二、把「我」換成「該生」的同一段（§13 那條的鏡像）────
  //
  // **這是被上面那一條擋掉之後最省力的一步**，而且換完之後那一段對
  // 學生來說一樣貼得進去——他只要再換回「我」。用同一個 40 字門檻，
  // 理由與「拿掉主詞」那一條相同：不讓換一個詞變成一個過關的辦法。
  //
  // 只認指名學生的說法（該生／該名同學／這位學生），**不認裸的「他」**：
  // 「委員手上只有那份檔案，他讀到這裡接不上前因後果」是回饋該說的話，
  // 而它一樣可以寫到四十幾字。裸的「他」交給下一條（要同時帶時間落點）。
  for (const run of runs) {
    if (!EXPLICIT_STUDENT.test(run.text)) continue;
    if (run.chars <= FIRST_PERSON_MAX_CHARS) continue;
    if (quoted(run)) continue;
    add(
      'THIRD_PERSON_RUN',
      'GHOST',
      `有一段 ${run.chars} 字的敘述用「${(run.text.match(EXPLICIT_STUDENT) ?? [''])[0]}」` +
        `稱呼學生，而且在他自己的文字裡找不到：「${run.text.slice(0, 40)}…」。` +
        '換一個人稱不改變那一段是誰的故事——他只要把它換回「我」就貼得進去。',
    );
    break;
  }

  // ── 二、自傳的口吻（比 40 字那一條更早命中的短代寫）──────────
  //
  // **這一條不問人稱**（見 `narrativeRuns` 的說明）：自傳的共同特徵是
  // 時間與事件的落點，而人稱是三步就換掉的東西。分兩個門檻——指得出
  // 主角是學生的 20 字，一個主詞都沒有的 40 字，理由見兩個常數。
  for (const run of runs) {
    const named = FIRST_PERSON.test(run.text) || THIRD_PERSON.test(run.text);
    if (run.chars < (named ? NARRATIVE_MIN_CHARS : NARRATIVE_MIN_CHARS_NO_SUBJECT)) continue;
    if (!NARRATIVE_MARKER.test(run.text)) continue;
    if (quoted(run)) continue;
    add(
      'NARRATIVE_VOICE',
      'GHOST',
      `有一段 ${run.chars} 字的敘述帶著時間與事件的落點（「${
        (run.text.match(NARRATIVE_MARKER) ?? [''])[0]
      }」），而且在學生的文字裡找不到：「${run.text.slice(0, 40)}…」。` +
        '這是自傳的口吻，不是回饋的口吻。',
    );
    break;
  }

  // ── 三、代寫的框 ────────────────────────────────────────────
  //
  // 比長度規則更早命中的一類：模型把代寫包起來之後，包住的那句話
  // 本身就是證據，而且它不受長度影響。
  //
  // **否定形要放過去。** 「我沒有辦法幫你寫這一段」是這個功能最該說
  // 的一句話，而它的字串裡就含著「幫你寫」——擋掉它等於逼模型不准
  // 拒絕代寫，而那正好是反效果。
  for (const [label, re] of GHOSTWRITE_LEAD) {
    const at = text.search(re);
    if (at < 0) continue;
    if (/[不沒無別]|拒絕|不能|不會|無法|沒有辦法/.test(text.slice(Math.max(0, at - 8), at))) continue;
    add(
      'GHOSTWRITE_LEAD',
      'GHOST',
      `出現了「${label}」這一類的句型。不管後面接的是什麼，這個句型本身就是在提供` +
        '一段拿去用的文字，而這個功能的界線是協助整理與回饋，不是代寫。',
    );
    break;
  }

  // ── 四、可以被直接複製使用（規格書 §13 的第二條）────────────
  //
  // 「成段的完整句子且與學生原文高度不同」。第一人稱不是必要條件——
  // 用「本人」「筆者」寫、或者根本不用主詞的段落一樣貼得進去。
  for (const run of runs) {
    if (run.sentences < PASTEABLE_MIN_SENTENCES) continue;
    if (run.chars < PASTEABLE_MIN_CHARS) continue;
    if (quoted(run)) continue;
    add(
      'PASTEABLE',
      'GHOST',
      `有一段 ${run.chars} 字的連續陳述，既沒有對學生說話也不是提問，` +
        `而且與他的原文對不上：「${run.text.slice(0, 40)}…」。這一段可以被整段貼走。`,
    );
    break;
  }

  // ── 五、申請文件的語域 ──────────────────────────────────────
  if (APPLICATION_VOICE.test(text)) {
    add(
      'APPLICATION_VOICE',
      'GHOST',
      '用了「貴系」「綜上所述」這一類寫給招生委員看的措辭。回饋是寫給學生看的，' +
        '出現這種語域代表模型已經切換成在寫那份文件而不是在看它。',
    );
  }

  // ── 六、體例 ────────────────────────────────────────────────
  //
  // 這兩條是 STYLE：重來一次還是這樣就收下。為了少一個問號把一段
  // 有用的觀察丟掉是虧的，而它們都不會讓學生多一段可以貼的文字。
  if (opts.requireQuestion !== false && !/[？?]/.test(text) && charLen(text) > 0) {
    add(
      'NO_QUESTION',
      'STYLE',
      '整段沒有任何一個問句。規格書 §9.1 要求回饋以問題與觀察呈現——' +
        '沒有問句的回饋讀起來就是一段結論，而學生要的是被問到他還沒想到的地方。',
    );
  }
  const len = charLen(text);
  const max = opts.maxChars ?? MAX_FEEDBACK_CHARS;
  if (len > max) {
    add('TOO_LONG', 'STYLE', `這一段有 ${len} 字，超過 ${max} 字。學生不會讀完。`);
  }

  return {
    ok: v.length === 0,
    violations: v,
    /** 有沒有代寫。true 就一定要重新生成。 */
    ghostwritten: v.some((x) => x.severity === 'GHOST'),
  };
}

// ─────────────────────────────────────────────────────────────────
// 揭露聲明：另一條路
//
// 這一組規則問的是完全不同的問題。上面那一組問「這段話會不會被貼
// 進檔案」，這一組問「這段話說的是不是真的」——因為揭露聲明本來就是
// 要被貼進檔案的，那是它的用途。
// ─────────────────────────────────────────────────────────────────

/**
 * 把 `AiDisclosureLog` 的記錄折成閘門要的事實。
 *
 * @param {{feature: string, occurredAt?: Date|string, aiLevel?: number|null}[]} logs
 * @returns {{counts: Record<string, number>, features: string[], total: number,
 *            disclosedTotal: number, levels: number[],
 *            firstAt: string|null, lastAt: string|null}}
 *
 * # `total` 與 `disclosedTotal` 是兩個數字，而聲明上要印的是後面那一個
 *
 * `total` 是這張表裡的全部筆數（稽核用的事實）。`disclosedTotal` 只數
 * `MUST_DISCLOSE` 那幾類——也就是**聲明裡真的會被列舉出來的那幾類**。
 *
 * 兩者混用的症狀很難看：一位只用過 3 次撰寫回饋、但按了 4 次「重新
 * 產生聲明」的學生，會拿到一份寫著「進行文字具體性與邏輯一致性的回饋，
 * 共 7 次」的文件——列舉的類別只有一種，數字卻是七，而**這份文件會被
 * 貼進學習歷程給招生委員看**。`makeStatement()` 是先讀記錄再寫記錄，
 * 所以按越多次差越多。
 */
export function disclosureFacts(logs) {
  /** @type {Record<string, number>} */
  const counts = {};
  const levels = new Set();
  let firstAt = null;
  let lastAt = null;
  for (const l of logs ?? []) {
    const f = String(l?.feature ?? '').trim();
    if (!f) continue;
    counts[f] = (counts[f] ?? 0) + 1;
    if (Number.isInteger(l?.aiLevel)) levels.add(l.aiLevel);
    const t = l?.occurredAt ? new Date(l.occurredAt) : null;
    if (t && !Number.isNaN(t.getTime())) {
      const iso = t.toISOString();
      if (!firstAt || iso < firstAt) firstAt = iso;
      if (!lastAt || iso > lastAt) lastAt = iso;
    }
  }
  return {
    counts,
    features: Object.keys(counts).sort(),
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    disclosedTotal: MUST_DISCLOSE.reduce((a, f) => a + (counts[f] ?? 0), 0),
    levels: [...levels].sort((a, b) => a - b),
    firstAt,
    lastAt,
  };
}

/**
 * 哪幾種互動**必須**在聲明裡被提到。
 *
 * `RULE_CHECK` 與 `DISCLOSURE_STATEMENT` 不在裡面，理由不同：
 *
 *   · `RULE_CHECK` 是純規則、一行都不呼叫模型。把「系統幫我數了字數」
 *     寫進 AI 使用揭露，會讓真正該被注意的那幾項被稀釋掉。
 *   · `DISCLOSURE_STATEMENT` 是**這份聲明自己**。要求聲明揭露自己的
 *     產生過程會變成一個沒有底的遞迴，而且它對招生委員沒有資訊——
 *     他手上拿到的就是這份聲明。
 *
 * 不在必揭露清單裡，不代表記錄裡沒有：`AiDisclosureLog` 一樣照記，
 * 因為那張表是稽核用的事實，不是聲明的草稿。
 */
export const MUST_DISCLOSE = [
  'WRITING_FEEDBACK',
  'MATERIAL_HINT',
  'SELECTION_DISCUSS',
  'INTERVIEW_FEEDBACK',
];

/**
 * 每一種互動在聲明裡認得出來的說法。
 *
 * 一種互動有好幾種寫法，因為聲明是**模型生成而且必須隨互動性質變化**
 * ——寫死一種說法等於要求它照樣板寫，而那正是 §9.6 禁止的。
 * 所以這裡收的是一組同義的關鍵詞，命中任何一個就算提到了。
 */
const DISCLOSURE_MENTIONS = {
  WRITING_FEEDBACK: /具體性|一致性|文字(?:的)?回饋|撰寫(?:的)?(?:回饋|建議|意見)|修改建議|文句(?:的)?檢視|針對(?:初稿|草稿|文稿)/,
  MATERIAL_HINT: /素材|學習(?:歷程)?紀錄(?:的)?(?:回想|提問)|回想|學習軌跡|成績(?:的)?變化|經歷(?:的)?整理/,
  SELECTION_DISCUSS: /選件|成果(?:的)?(?:挑選|選擇|討論)|件數(?:的)?討論|作品(?:的)?挑選|哪幾件/,
  INTERVIEW_FEEDBACK: /面試|口試|回答(?:的)?結構|模擬(?:面試|問答)/,
};

/**
 * 宣稱完全沒有用過 AI。
 *
 * # 為什麼要求「否認」在子句的結尾收掉
 *
 * 因為**「未使用 AI」這四個字後面接什麼，決定它是不是全稱的否認**：
 *
 *   「全程未使用 AI 輔助工具。」        ← 全稱。記錄裡有東西就是不實
 *   「未使用 AI 生成內容。」             ← 合格聲明的標準結尾（§9.2）
 *   「未使用 AI 協助挑選素材，」        ← 只否認一件事，而且是誠實的
 *
 * 舊的寫法用一個否定的 lookahead 排掉「生成／撰寫／產出」，於是第三種
 * 被判成全稱否認——一位誠實寫出「我沒有用 AI 挑素材」的學生會看到
 * 「模型三次都寫出與記錄不符的聲明」。冤枉三次之後他會轉去用別的
 * 工具，而那才是最壞的結果：他用了、系統沒記錄、聲明上寫著沒用過。
 *
 * 改成要求受詞在子句邊界收掉之後，三種都判得對，而且不必逐一列舉
 * 「生成／撰寫／產出」——**新的動詞不會再開一個洞**。
 */
const CLAIMS_NO_USE =
  /(?:未|沒有|不曾|從未|無)(?:使用|借助|運用|透過|藉由)(?:任何)?(?:AI|人工智慧|生成式|智慧)(?:輔助)?(?:工具|技術|軟體)?(?=[，,、；;。.]|$)/i;

// ─────────────────────────────────────────────────────────────────
// 子句的極性：這一句在講「用了 AI」還是「沒有用 AI」
//
// 規則二與規則三**只比對關鍵詞在不在**，不看那句話是肯定還是否定，
// 而這份文件的每一句話幾乎都是「未……」。兩個方向都出事：
//
//   誤擋：「未使用 AI 協助挑選素材」→ 判成「宣稱用了沒用過的功能」
//   漏擋：「具體性的檢視亦由本人反覆進行」→ 判成「提到了這一類互動」
//
// 後面那一種正是檔頭說要擋的「用一句真話遮住一件該說的事」：句子裡
// 確實有「具體性」三個字，而那句話講的正好相反。
// ─────────────────────────────────────────────────────────────────

/** 這一段在講 AI 做了什麼。 */
const AI_TOKEN = /AI|人工智慧|生成式|智慧工具/i;

/** 否定詞。這份文件的每一句話幾乎都帶著一個。 */
const DENIAL = /[未無]|沒有|不曾|從未|並非|不是|皆非/;

/** 把事情歸給學生自己。**這也是一種否定**——它說的是「AI 沒有做這件事」。 */
const SELF_ATTRIBUTION =
  /由本人|本人(?:自行|獨力|獨立|親自|反覆)?(?:完成|撰寫|檢視|進行|整理|判斷)|自行(?:完成|撰寫|檢視|進行|整理|判斷)/;

/**
 * 把聲明切成子句，逐句判極性，**沒有線索的子句沿用前一句**。
 *
 * 沿用是必要的而不是偷懶：一份合格的聲明長這樣——
 *
 *   「……使用 AI 輔助工具進行文字具體性的回饋、從個人學習紀錄回想
 *     素材的提問，以及成果選件的討論，未使用 AI 生成內容。」
 *
 * 中間那兩個子句裡一個 AI 都沒有，它們掛在第一句的「使用 AI」底下。
 * 不沿用的話，一份把三類都列出來的正確聲明會被判成只揭露了一類。
 *
 * @returns {{text: string, affirmative: boolean}[]}
 */
function aiClauses(text) {
  const out = [];
  let state = false;
  for (const clause of String(text ?? '').split(/[，,、；;。.]+/)) {
    if (!clause) continue;
    const at = clause.search(AI_TOKEN);
    if (at >= 0) {
      // 否定詞要出現在 AI 之前才算否認這一次使用。「使用 AI 進行回饋，
      // 未再做其他修改」裡的「未」在後面，管的是別件事。
      state = !DENIAL.test(clause.slice(0, at));
    } else if (SELF_ATTRIBUTION.test(clause)) {
      state = false;
    }
    out.push({ text: clause, affirmative: state });
  }
  return out;
}

/**
 * 這一類互動**被當成 AI 做的事**寫出來了嗎。
 *
 * 與 `re.test(text)` 的差別就是那句話的肯否：關鍵詞落在一個否認的子句
 * 裡（「未使用 AI 挑選素材」）或一個歸給學生自己的子句裡（「具體性的
 * 檢視由本人進行」）都不算揭露過。
 */
function disclosedAsAiUse(clauses, re) {
  return clauses.some((c) => c.affirmative && re.test(c.text));
}

/** 宣稱沒有用 AI 生成內容。**這一句本身是合法而且應該有的**。 */
const CLAIMS_NO_GENERATION =
  /(?:未|沒有|不曾|無)(?:使用|藉由|透過|讓)?(?:AI|人工智慧|生成式(?:AI|工具)?)(?:工具)?(?:生成|產生|撰寫|代寫|產出)/i;

/** 承認由 AI 撰寫。系統從來不代寫，所以這句話一定是錯的。 */
const CLAIMS_GENERATION =
  /(?:由|經)(?:AI|人工智慧|生成式)[^。；;]{0,12}(?:生成|撰寫|代寫|完成|產出)|AI(?:代寫|生成(?:了)?(?:本文|內容|全文|草稿))/i;

/**
 * 否定詞。**在這一組規則裡它比在別處重要**：這份文件的每一句話幾乎
 * 都是「未……」，而少看一個否定就會把最誠實的那一份聲明擋下來。
 */
function negatedBefore(text, index, back = 6) {
  return /[不沒無未非]|從未|亦未/.test(text.slice(Math.max(0, index - back), index));
}

/** 本人完成的宣告。聲明的第一句幾乎一定是這個。 */
const CLAIMS_OWN_WORK = /由本人(?:獨立)?(?:完成|撰寫|構思)|本人(?:自行|獨力|獨立)(?:完成|撰寫)|構思(?:與|及)撰寫(?:均)?由本人/;

/** 揭露聲明的長度上限。它要貼進檔案，太長會佔掉正文的篇幅。 */
const MAX_STATEMENT_CHARS = 300;

/**
 * 這一份揭露聲明說的話與記錄相符嗎。
 *
 * @param {string} statement
 * @param {ReturnType<typeof disclosureFacts>} facts
 * @returns {{ok: boolean, violations: PortfolioViolation[], ghostwritten: boolean}}
 *
 * 回傳的形狀與 `checkGhostwriting()` 一樣（含 `ghostwritten`），
 * 是為了讓呼叫端的重試迴圈只有一份。這裡的 `GHOST` 嚴重度代表
 * 「聲明不實」——與代寫不同的錯，但同樣一定要重新生成。
 */
export function checkDisclosureStatement(statement, facts = disclosureFacts([])) {
  /** @type {PortfolioViolation[]} */
  const v = [];
  // **空白全部拿掉再比對。** 這份聲明裡的「未使用 AI 生成內容」，模型有
  // 時候寫成「未使用AI生成內容」、有時候中間有半形空白、有時候是全形。
  // 三種寫法在招生委員眼裡完全一樣，而在正規表達式上是三條規則。
  const text = normalizeForPortfolio(statement).replace(/\s+/g, '');
  const add = (code, severity, detail) => {
    if (!v.some((x) => x.code === code)) v.push({ code, severity, detail });
  };

  const used = MUST_DISCLOSE.filter((f) => (facts.counts?.[f] ?? 0) > 0);
  const disclosedTotal = facts.disclosedTotal ?? facts.total ?? 0;
  const clauses = aiClauses(text);

  // ── 一、宣稱完全沒用過，但記錄裡有 ──────────────────────────
  if (used.length > 0 && CLAIMS_NO_USE.test(text)) {
    add(
      'CLAIMS_NO_AI',
      'GHOST',
      `聲明宣稱未使用 AI，但記錄裡有 ${disclosedTotal} 次要揭露的互動（${used.join('、')}）。` +
        '這不是揭露，這是否認。',
    );
  }

  // ── 二、漏掉了記錄裡確實發生過的一類 ────────────────────────
  //
  // **這是這一組規則的主體。** 「未使用 AI 生成內容」這句話本身是真的
  // （系統從不生成內容），但如果整份聲明只有這一句、而記錄裡有十次
  // 撰寫回饋，那它就是用一句真話遮住一件該說的事。招生委員讀到的是
  // 「這位學生沒有用 AI」，而那與事實不符。
  //
  // 問的是「有沒有**被當成 AI 做的事**寫出來」而不是「關鍵詞在不在」：
  // 「文字具體性的檢視亦由本人反覆進行」裡有「具體性」三個字，
  // 而那句話講的正好相反——它遮住的正是那十次。
  for (const f of used) {
    const re = DISCLOSURE_MENTIONS[f];
    if (re && !disclosedAsAiUse(clauses, re)) {
      add(
        'OMITS_FEATURE',
        'GHOST',
        `記錄裡有 ${facts.counts[f]} 次「${f}」，但聲明沒有把它寫成 AI 做過的事。` +
          '揭露的意思是把發生過的事說出來，不是挑幾件說，也不是換一個說法帶過去。',
      );
      break;
    }
  }

  // ── 三、提到了記錄裡沒有的一類 ──────────────────────────────
  //
  // 過度宣稱同樣是不符。它比較少見但更難查——一份寫了「使用 AI 進行
  // 面試回答結構的回饋」而其實沒練過面試的聲明，招生委員無從查證，
  // 而系統查得出來。
  //
  // 同樣只看肯定的子句：「未使用 AI 協助挑選素材」是**誠實**地說出
  // 一件沒發生的事，把它判成過度宣稱是冤枉，而冤枉的代價是他轉去用
  // 別的工具——他用了、系統沒記錄、聲明上寫著沒用過。
  for (const f of MUST_DISCLOSE) {
    if ((facts.counts?.[f] ?? 0) > 0) continue;
    const re = DISCLOSURE_MENTIONS[f];
    if (re && disclosedAsAiUse(clauses, re)) {
      add(
        'CLAIMS_UNUSED_FEATURE',
        'GHOST',
        `聲明提到了「${f}」這一類的互動，但記錄裡一次都沒有。` +
          '多說與少說一樣是不符——揭露聲明的價值在於它對得回記錄。',
      );
      break;
    }
  }

  // ── 三之二、次數對不對 ──────────────────────────────────────
  //
  // 前面兩條查的是「哪幾類」，這一條查「幾次」。**這份文件會被貼進
  // 學習歷程給招生委員看，所以上面的每一個數字也要對得回記錄。**
  //
  // 只認「共 N 次」這種總計的說法，而且 N 剛好等於某一類的次數時放過去
  // （「共 3 次撰寫回饋」講的是那一類，不是總計）。逐項的數字不查，
  // 因為「使用 3 次撰寫回饋與 2 次素材提示」要對到哪一個數字，
  // 規則判不出來，而判錯的方向是把一份正確的聲明擋下來。
  const stated = text.match(/共(\d+)次/);
  if (stated) {
    const n = Number(stated[1]);
    const matchesOne = MUST_DISCLOSE.some((f) => (facts.counts?.[f] ?? 0) === n);
    if (n !== disclosedTotal && !matchesOne) {
      add(
        'MISCOUNTS',
        'GHOST',
        `聲明寫「共 ${n} 次」，但記錄裡要揭露的互動是 ${disclosedTotal} 次。` +
          '這份文件會被貼進學習歷程給招生委員看，上面的數字要對得回記錄。',
      );
    }
  }

  // ── 四、承認由 AI 撰寫 ──────────────────────────────────────
  //
  // 系統從來不代寫（那正是 `checkGhostwriting()` 在守的事），所以
  // 這句話在事實上就是錯的。放它過去的話，一位其實自己寫完的學生
  // 會交出一份說自己沒有自己寫的聲明。
  const genHit = text.search(CLAIMS_GENERATION);
  if (genHit >= 0 && !negatedBefore(text, genHit)) {
    add(
      'CLAIMS_GENERATION',
      'GHOST',
      '聲明說內容由 AI 生成或撰寫。本系統的學習歷程功能不代寫（防代寫閘門擋著），' +
        '所以這句話與事實不符，而它會讓學生揹上一件他沒有做的事。',
    );
  }

  // ── 五、沒有任何一次互動時，要說得出「沒有」──────────────────
  if (facts.total === 0 && !CLAIMS_NO_USE.test(text) && !CLAIMS_NO_GENERATION.test(text)) {
    add(
      'SILENT_WHEN_UNUSED',
      'GHOST',
      '記錄裡一次互動都沒有，但聲明沒有說出「未使用」。' +
        '一份含糊的聲明比沒有聲明糟：招生委員會以為他用了而沒說清楚。',
    );
  }

  // ── 六、體例 ────────────────────────────────────────────────
  if (!CLAIMS_OWN_WORK.test(text)) {
    add(
      'NO_OWN_WORK_CLAIM',
      'STYLE',
      '聲明沒有說出「構思與撰寫由本人完成」這一件最重要的事。' +
        '揭露的重點不是用了什麼工具，是這份文件仍然是他的。',
    );
  }
  const len = charLen(text);
  if (len > MAX_STATEMENT_CHARS) {
    add(
      'TOO_LONG',
      'STYLE',
      `這份聲明有 ${len} 字，超過 ${MAX_STATEMENT_CHARS} 字。它要貼進檔案，` +
        '太長會佔掉正文的篇幅。',
    );
  }
  if (len === 0) {
    add('EMPTY', 'GHOST', '聲明是空的。');
  }

  return {
    ok: v.length === 0,
    violations: v,
    ghostwritten: v.some((x) => x.severity === 'GHOST'),
  };
}

// ─────────────────────────────────────────────────────────────────
// 分流
// ─────────────────────────────────────────────────────────────────

/** 走揭露聲明那一組規則的功能。**只有這一個。** */
export const DISCLOSURE_FEATURE = 'DISCLOSURE_STATEMENT';

/**
 * 唯一的入口。**呼叫端不分流，這裡分。**
 *
 * 分流寫在呼叫端的話，會有兩個地方要記得「揭露聲明走另一條」，
 * 而漏掉的那一個的症狀是揭露聲明產生器永遠轉圈——一個功能把自己
 * 擋掉，而且畫面上看起來只是它比較慢。
 *
 * @param {string} feature `PortfolioAiFeature` 的值
 * @param {string} output
 * @param {{ghostwrite?: ReturnType<typeof ghostwriteFacts>,
 *          disclosure?: ReturnType<typeof disclosureFacts>}} facts
 * @param {{maxChars?: number, requireQuestion?: boolean}} [opts]
 *
 * 認不得的 feature 走**嚴的那一組**（防代寫）。日後新增一個 AI 功能
 * 而忘了在這裡登錄時，症狀是「它的輸出常常被擋」，有人會來講；
 * 反過來的症狀是沒有人會來講。
 */
export function checkPortfolioOutput(feature, output, facts = {}, opts = {}) {
  if (feature === DISCLOSURE_FEATURE) {
    return checkDisclosureStatement(output, facts.disclosure ?? disclosureFacts([]));
  }
  return checkGhostwriting(output, facts.ghostwrite ?? ghostwriteFacts(), opts);
}

/** 把違規清單折成一行寫進伺服器日誌。**這一份會引用被擋掉的文字。** */
export function describePortfolioViolations(violations) {
  if (!violations || violations.length === 0) return '';
  return violations.map((x) => `${x.code}：${x.detail}`).join('；');
}

/**
 * 每一種違規的**不含被擋文字**的說法。
 *
 * 兩套說法的理由與 adviceGuard 相同，但這裡更嚴重：`detail` 會把被擋掉
 * 的那一段代寫引用出來，而把它顯示在學生的畫面上，等於用「這段被擋了」
 * 這個包裝把代寫送到他眼前。他會記住那句話，然後自己打一次。
 */
export const PORTFOLIO_VIOLATION_LABELS = {
  FIRST_PERSON_RUN: '寫出了一段可以直接貼進檔案的第一人稱敘述',
  THIRD_PERSON_RUN: '用「該生」這樣的第三人稱寫了一段你的經歷',
  NARRATIVE_VOICE: '用自傳的口吻寫了一段你的經歷',
  MISCOUNTS: '聲明上的次數與記錄對不起來',
  GHOSTWRITE_LEAD: '用了「你可以這樣寫」這一類提供現成文字的句型',
  PASTEABLE: '寫出了一段可以整段貼走的文字',
  APPLICATION_VOICE: '用了寫給招生委員看的措辭，而不是對你說話',
  NO_QUESTION: '整段沒有問句',
  TOO_LONG: '寫太長了',
  CLAIMS_NO_AI: '聲明宣稱未使用 AI，但記錄裡有',
  OMITS_FEATURE: '聲明漏掉了記錄裡確實發生過的互動',
  CLAIMS_UNUSED_FEATURE: '聲明提到了記錄裡沒有的互動',
  CLAIMS_GENERATION: '聲明說內容由 AI 生成，但系統不代寫',
  SILENT_WHEN_UNUSED: '沒有用過 AI，但聲明沒有說出來',
  NO_OWN_WORK_CLAIM: '聲明沒有說出構思與撰寫由本人完成',
  EMPTY: '是空的',
};

/** 可以給學生看的違規說明。**不含任何被擋掉的原文。** */
export function summarizePortfolioViolations(violations) {
  if (!violations || violations.length === 0) return [];
  const seen = new Set();
  const out = [];
  for (const v of violations) {
    if (seen.has(v.code)) continue;
    seen.add(v.code);
    out.push(`${v.code}：${PORTFOLIO_VIOLATION_LABELS[v.code] ?? '不符合這一層的規則'}`);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────
// 退路
// ─────────────────────────────────────────────────────────────────

/**
 * 重試用完之後給學生的東西：**一份由程式組出來的制度檢查結果。**
 *
 * 不可以是「AI 暫時無法回應」。對學生來說那等於功能壞了，而它沒壞——
 * 是模型剛剛三次都想幫他寫。而且制度檢查本身就有用而且完全確定：
 * 字數、必要子項、件數，這幾件事不需要模型也答得出來，
 * 而它們正是實務上最常出事的地方。
 *
 * @param {{code: string, ok: boolean, detail: string}[]} ruleChecks
 *   `portfolio.mjs` 的 `checkSummaryEssay` / `checkSelfStatement` 的輸出
 */
export function safeFeedback(ruleChecks = []) {
  const bad = ruleChecks.filter((c) => !c.ok);
  const lines = [];
  if (bad.length > 0) {
    lines.push('制度上有幾項要先處理：');
    for (const c of bad.slice(0, 6)) lines.push(`· ${c.detail}`);
  } else if (ruleChecks.length > 0) {
    lines.push('制度上的檢查都過了：');
    for (const c of ruleChecks.slice(0, 6)) lines.push(`· ${c.detail}`);
  }
  lines.push(
    '文字上的回饋這一次沒有產出來。可以先自己看兩件事：' +
      '每一個「我學到很多」「收穫良多」的後面，有沒有接一件具體發生過的事？' +
      '你的就讀動機講的那個方向，在你挑的成果裡看得出來嗎？',
  );
  return lines.join('\n');
}

/**
 * 由程式組出來的揭露聲明。
 *
 * 三個時機用得到：層級 1 的學生（他根本不該呼叫模型）、模型重試用完、
 * 以及模型連不上。三種情形都不該讓學生交不出揭露——**那是及格線，
 * 不是加分項**，交不出來他就是在違規。
 *
 * 這一份刻意讀起來像樣板，而樣板正是 §9.6 不接受的東西——所以它是
 * 退路不是主線：`disclosureDraft()` 的第一選擇永遠是模型生成的版本，
 * 因為只有它做得到「隨互動性質變化」。
 *
 * @param {ReturnType<typeof disclosureFacts>} facts
 * @param {Record<string, string>} phrases `portfolio.mjs` 的 AI_FEATURE_DISCLOSURE_PHRASES
 */
export function safeStatement(facts = disclosureFacts([]), phrases = {}) {
  const used = MUST_DISCLOSE.filter((f) => (facts.counts?.[f] ?? 0) > 0);
  if (used.length === 0) {
    return '本文之構思與撰寫均由本人完成，過程中未使用 AI 輔助工具，亦未使用 AI 生成內容。';
  }
  const list = used.map((f) => phrases[f] ?? f).join('、');
  // **`disclosedTotal` 而不是 `total`。** 列舉的是 `used` 那幾類，
  // 數字就要數同樣那幾類——用 `total` 的話，一位只用過 3 次撰寫回饋、
  // 按了 4 次「重新產生」的學生會拿到「共 7 次」，而列舉的類別只有一種。
  return (
    `本文之構思與撰寫由本人完成，過程中使用 AI 輔助工具進行${list}，` +
    `共 ${facts.disclosedTotal ?? facts.total} 次，未使用 AI 生成內容。`
  );
}
