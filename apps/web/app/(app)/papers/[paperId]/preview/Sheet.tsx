/**
 * 一份卷子攤開來的樣子——螢幕上是預覽，按下列印就是紙本考卷。
 *
 * # 為什麼預覽與列印是同一個元件
 *
 * 因為老師在螢幕上看過、按下列印、然後發現印出來的是另一個東西，
 * 這件事只會發生一次：之後他就不再相信預覽了。同一棵 DOM、
 * 一份 `@media print` 只調版面（頁邊、分頁、隱藏導覽），
 * 螢幕上看到的每一個字都會出現在紙上。
 *
 * # 為什麼它不碰資料庫
 *
 * 為了能離線渲染成 HTML 交給瀏覽器排版驗證（見 tools/print-check.mjs）。
 * 分頁有沒有把題目切斷、數學式有沒有排出來、答案有沒有漏到學生版上，
 * 這三件事**只有真的排版引擎答得出來**，而起一個要資料庫的 Next.js
 * 伺服器才驗得到的東西，實際上就是沒有人會驗。
 *
 * # 答案怎麼保證不會印在學生版上
 *
 * 不是靠 CSS 藏起來——`display: none` 的東西仍然在 HTML 原始碼裡，
 * 而學生版是一份會被印出來、也會被截圖轉傳的東西。
 * **答案欄位在學生版根本沒有進到 props**（見 page.tsx 的 `answer` 對映），
 * 這個元件連可以印的東西都沒有。
 */
import { MathText } from '@/components/MathText';

export type SheetQuestion = {
  /** 卷面題號。與 `ExamPaperItem.order` 不一定相同（原卷刪過題會有洞）。 */
  no: number;
  score: number;
  /** 「單選」「選填」這類。印在題號旁邊，學生要知道這一題怎麼作答。 */
  typeLabel: string;
  type: string;
  subLabel: string | null;
  content: string;
  /**
   * 附圖。原樣帶 `Question.contentAssets` 那一欄過來，交給 `<MathText>`
   * 排——圖要出現在題幹裡 `![[a:…]]` 指的位置，不是全部堆在題幹後面。
   * 「如右圖的三角形 ABC 中…」堆在後面的話，指的是哪一張看不出來。
   */
  assets: unknown;
  /** 選項自己的附圖。物理的四個選項常常是四張力圖，文字都一樣。 */
  options: { order: number; label: string; content: string; assets: unknown }[];
  /** 選填題要留幾個格位。0 代表這一題不是選填。 */
  slotCount: number;
  /**
   * 標準答案。**學生版一律是 null**，而且不是「有值但不畫」——
   * 是根本沒有傳進來。
   */
  answer: string | null;
};

export type SheetRow =
  | { kind: 'group'; id: string; label: string | null; stimulus: string; assets: unknown }
  | { kind: 'q'; q: SheetQuestion };

export type SheetData = {
  title: string;
  subjectName: string;
  instructions: string | null;
  totalScore: number;
  count: number;
  /** 教師版。決定要不要畫答案欄與卷末的答案總表。 */
  withAnswers: boolean;
  /**
   * 附圖的網址前綴，後面直接接上編碼過的物件鍵。
   * 走 `/api/papers/[paperId]/image`：它問的是「這張圖在不在這份卷子
   * 的某一題上」，而這一頁正是那份卷子。離線渲染時給空字串。
   */
  imageBase: string;
  rows: SheetRow[];
};

/** 非選題要留幾行書寫空間。作文另計。 */
const LINES: Record<string, number> = {
  SHORT_ANSWER: 3,
  TRANSLATION: 3,
  FILL_TEXT: 1,
  ESSAY: 12,
};

export function Sheet(data: SheetData) {
  const answers = data.withAnswers
    ? data.rows.flatMap((r) => (r.kind === 'q' && r.q.answer ? [r.q] : []))
    : [];

  return (
    <article className="yz-paper">
      <header className="yz-paper__head">
        {data.withAnswers && (
          // 教師版最容易出的錯是「印一疊發下去」。這一行要在最上面、
          // 而且要印得出來——它是這張紙唯一與學生版不同的外觀特徵。
          <p className="yz-paper__stamp">教師版・含標準答案・請勿發給學生</p>
        )}
        <h1 className="yz-paper__title">{data.title}</h1>
        <p className="yz-paper__meta">
          {data.subjectName}　共 {data.count} 題　滿分 {data.totalScore} 分
        </p>

        {!data.withAnswers && (
          <p className="yz-paper__fields">
            <span>班級</span>
            <span>座號</span>
            <span>姓名</span>
            <span>分數</span>
          </p>
        )}

        {data.instructions && (
          <div className="yz-paper__inst">
            <MathText>{data.instructions}</MathText>
          </div>
        )}
      </header>

      <div className="yz-paper__body">
        {data.rows.map((row) =>
          row.kind === 'group' ? (
            <section key={`g-${row.id}`} className="yz-paper__stim">
              {row.label && <p className="yz-paper__stimlabel">{row.label}</p>}
              <div className="yz-paper__stimtext">
                <MathText assets={row.assets} assetBase={data.imageBase} assetLoading="eager">
                  {row.stimulus}
                </MathText>
              </div>
            </section>
          ) : (
            <Question key={`q-${row.q.no}`} q={row.q} base={data.imageBase} />
          ),
        )}
      </div>

      {answers.length > 0 && (
        // 逐題的答案已經印在每一題底下了，這一張是給改卷用的：
        // 一疊 30 份卷子逐份對答案時，翻回卷末看一張表比在題目之間
        // 找那一行小字快得多。
        <section className="yz-paper__keys">
          <h2 className="yz-paper__keyshead">答案一覽</h2>
          <ol className="yz-paper__keylist">
            {answers.map((q) => (
              <li key={q.no}>
                <span className="yz-paper__keyno">{q.no}</span>
                <span className="yz-paper__keyval">
                  <MathText>{q.answer}</MathText>
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* 兩個頁尾，內容一樣，因為它們負責的頁面不一樣。
          `__run` 在列印時是每一頁重畫的那一條（螢幕上不存在），
          而 **Chromium 不會把它畫在最後一頁**——實測如此，
          位置與寫法見 globals.css 的說明。`__foot` 是流內的那一個，
          它落在內容的最後面，剛好補上最後一頁。
          兩條都在的頁面不存在；漏掉任何一條，就會有幾張紙上沒有卷名。 */}
      <p className="yz-paper__run" aria-hidden="true">
        {foot(data)}
      </p>
      <footer className="yz-paper__foot">{foot(data)}</footer>
    </article>
  );
}

function foot(data: SheetData) {
  return `${data.title}　${data.subjectName}　共 ${data.count} 題　滿分 ${data.totalScore} 分${
    data.withAnswers ? '　（教師版）' : ''
  }`;
}

function Question({ q, base }: { q: SheetQuestion; base: string }) {
  const lines = LINES[q.type] ?? 0;

  return (
    <div className="yz-paper__q">
      <div className="yz-paper__qno">
        {q.no}
        {q.subLabel && <span className="yz-paper__sub">{q.subLabel}</span>}
      </div>
      <div className="yz-paper__qbody">
        <p className="yz-paper__qmeta">
          {q.typeLabel}　{q.score} 分
        </p>
        <div className="yz-paper__stem">
          {/* eager：這一頁注定要進印表機，而 lazy 的圖有機會在列印預覽
              跑完之後才載進來——印出來是一格空白，而老師是在把考卷
              發下去之後才看到的。 */}
          <MathText
            assets={q.assets}
            assetBase={base}
            assetLoading="eager"
            label={`第 ${q.no} 題`}
          >
            {q.content}
          </MathText>
        </div>

        {q.options.length > 0 && (
          <ol className="yz-paper__opts">
            {q.options.map((o) => (
              <li key={o.order} className="yz-paper__opt">
                <span className="yz-paper__optkey">{o.label}</span>
                <span>
                  <MathText
                    assets={o.assets}
                    assetBase={base}
                    assetLoading="eager"
                    label={`第 ${q.no} 題選項 ${o.label}`}
                  >
                    {o.content}
                  </MathText>
                </span>
              </li>
            ))}
          </ol>
        )}

        {q.slotCount > 0 && (
          // 選填題在答案卡上就是一格一個字元。印出來留同樣的格數，
          // 學生才知道答案有幾位——那是題目的一部分。
          <p className="yz-paper__slots">
            {Array.from({ length: q.slotCount }, (_, i) => (
              <span key={i} className="yz-paper__slot" />
            ))}
          </p>
        )}

        {lines > 0 && (
          <div className="yz-paper__work">
            {Array.from({ length: lines }, (_, i) => (
              <span key={i} className="yz-paper__line" />
            ))}
          </div>
        )}

        {q.answer && (
          <p className="yz-paper__ans">
            <span className="yz-paper__anslabel">答案</span>
            <MathText>{q.answer}</MathText>
          </p>
        )}
      </div>
    </div>
  );
}

