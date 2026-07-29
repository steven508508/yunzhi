import Link from 'next/link';

import { Empty, ErrorBox, Note } from '@/components/Feedback';
import { MathText } from '@/components/MathText';
import { AttemptError } from '@/lib/attempt';
import { scopedPage } from '@/lib/page';
import { fmtTaipei } from '@/lib/release.mjs';
import {
  listOwnAttempts,
  loadAttemptResult,
  type QuestionVerdict,
  type ResultAttemptChoice,
  type ResultQuestion,
  type ResultView,
} from '@/lib/result';

export const dynamic = 'force-dynamic';

/**
 * 學生的成績與檢討。
 *
 * # 這一頁是這套系統存在的理由的一半
 *
 * 訪談時業主講的第一個痛點是「解析不足」：學生交完卷只看到一個分數，
 * 看不到自己錯在哪、也看不到講解。在這一頁之前，這套系統在學生眼裡
 * 與那個被抱怨的工具**一模一樣**——計分早就算好了、逐題對錯也早就
 * 寫進資料庫了，只是沒有任何畫面把它們拿出來。
 *
 * # 版面的順序就是學生的問題順序
 *
 * 打開這一頁的人心裡有三個問題，而且順序固定：**我幾分 → 我錯了哪幾題
 * → 那幾題怎麼算。** 所以摘要在最上面、逐題在下面、解析收在每一題裡。
 *
 * 答對的題目預設收合、答錯與未作答的預設展開，因為第二個問題的答案
 * 應該一眼看到，而不是捲過三十題正確答案去找。
 *
 * # 三段畫面，不是兩段
 *
 * `maySeeResult` 回三種：看得到全部、只看得到分數、什麼都還看不到。
 * 第三種**不是空畫面**——它要說出什麼時候才看得到，否則學生會以為
 * 系統壞了，然後打電話問老師，而老師也不知道。
 *
 * # 為什麼沒有對應的 API 路由
 *
 * 這是 server component，資料不經過網路。多開一支會回傳正確答案的
 * 端點，就多一個要自己重做一次放行判斷與 `userId` 比對的地方——
 * 而那兩件事漏掉的時候都不會有任何症狀。要看別人的卷子走 `/grades`，
 * 那邊有科目授課權限的判斷。
 */
export default async function ResultPage({
  params,
  searchParams,
}: {
  params: Promise<{ assignmentId: string }>;
  searchParams: Promise<{ attempt?: string }>;
}) {
  const { assignmentId } = await params;
  const { attempt: wanted } = await searchParams;

  return scopedPage(async (user) => {
    const attempts = await listOwnAttempts(assignmentId, user.id);

    if (attempts.length === 0) {
      // 三種情況會走到這裡：任務不存在、沒有派給你、派了但你沒開始寫。
      // **刻意不分開講。** 分開講的話，改一下網址列的 id 就能問出
      // 「這個任務存不存在」，而那是別班的考試表。
      return (
        <main className="yz-panel">
          <Empty
            title="找不到你在這份任務上的作答記錄"
            hint="要嘛還沒開始寫，要嘛這份任務不是派給你的。回任務清單看看。"
            action={
              <Link href="/take" className="yz-btn yz-btn--primary">
                回到任務清單
              </Link>
            }
          />
        </main>
      );
    }

    const chosen = pickAttempt(attempts, wanted);

    let view: ResultView;
    try {
      view = await loadAttemptResult(chosen.attemptId, user.id);
    } catch (e) {
      // 版面快照壞掉、題目讀不出來這一類。**不要給一個空白畫面**——
      // 學生會以為自己的成績不見了，而它其實還在。
      return (
        <main className="yz-panel">
          <ErrorBox
            title="這份成績打不開"
            detail={e instanceof AttemptError ? e.message : '請把這一頁的網址告訴老師。'}
            action={
              <Link href="/take" className="yz-btn">
                回到任務清單
              </Link>
            }
          />
        </main>
      );
    }

    const { level, reason } = view.visibility;
    const rate =
      view.totalScore === null || view.maxScore === 0
        ? null
        : Math.round((view.totalScore / view.maxScore) * 1000) / 10;

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>{view.assignmentTitle}</h1>
          <p className="yz-panel__sub">
            {view.subjectName}　·　{view.paperTitle}
            {view.submittedAt && `　·　${fmtTaipei(new Date(view.submittedAt))} 交卷`}
            {view.mode === 'PRACTICE' && '　·　練習'}
            　·　<Link href="/take">回到任務清單</Link>
          </p>
        </div>

        {attempts.length > 1 && (
          <AttemptPicker
            assignmentId={assignmentId}
            attempts={attempts}
            currentId={view.attemptId}
          />
        )}

        {level === 'NONE' ? (
          <Empty
            // 不寫「還」看不到：不開放與作廢這兩種是永遠不會開的，
            // 而「還」會讓學生每天回來看一次。
            title="現在看不到這份成績"
            hint={reason}
            action={
              <Link href="/take" className="yz-btn yz-btn--primary">
                回到任務清單
              </Link>
            }
          />
        ) : (
          <>
            <dl className="yz-summary">
              <div>
                <dt>得分</dt>
                <dd>{view.totalScore === null ? '—' : fmtScore(view.totalScore)}</dd>
              </div>
              <div>
                <dt>滿分</dt>
                <dd>{fmtScore(view.maxScore)}</dd>
              </div>
              <div>
                <dt>得分率</dt>
                <dd>{rate === null ? '—' : `${rate}%`}</dd>
              </div>
              {view.tally && (
                <>
                  <div>
                    <dt>答對</dt>
                    <dd>{view.tally.CORRECT}</dd>
                  </div>
                  <div>
                    <dt>答錯</dt>
                    <dd>{view.tally.WRONG + view.tally.PARTIAL}</dd>
                  </div>
                  <div>
                    <dt>沒作答</dt>
                    <dd>{view.tally.BLANK}</dd>
                  </div>
                </>
              )}
            </dl>

            {/* 這幾條會影響學生怎麼讀上面那個數字，所以緊接著它。 */}
            {view.totalScore === null && (
              <Note tone="warn">
                這一份還沒有計分。交卷是收到了，分數要請老師按一次重新計分才會出來。
              </Note>
            )}
            {view.tally && view.tally.PENDING > 0 && (
              <Note tone="warn">
                還有 {view.tally.PENDING} 題等老師評分（多半是非選擇題），
                <strong>上面的分數不是最後的分數</strong>，會再往上加。
              </Note>
            )}
            {view.late && <Note tone="warn">這一份是逾期交卷，老師看得到。</Note>}
            {view.autoSubmitted && <Note>這一份是時間到之後由系統自動交卷的。</Note>}

            {level === 'SCORE_ONLY' ? (
              <div className="yz-card">
                <h2 className="yz-card__title">逐題檢討還沒開放</h2>
                <p className="yz-panel__sub">{reason}</p>
                <p className="yz-panel__sub">
                  開放之後，這一頁會列出每一題你選了什麼、正確答案是什麼、以及解析。
                </p>
              </div>
            ) : (
              <>
                <h2 className="yz-grade-h">逐題檢討</h2>
                <p className="yz-grade-hint">
                  答錯與沒作答的題目預設展開，答對的收起來——按標題可以打開。
                  選項的順序與你作答當時看到的一樣。
                </p>
                {view.questions.length === 0 ? (
                  <Empty title="這份卷子沒有題目" hint="請告訴老師。" />
                ) : (
                  <ol className="yz-review__list">
                    {view.questions.map((q) => (
                      <QuestionBlock key={`${q.questionId}-${q.order}`} q={q} />
                    ))}
                  </ol>
                )}
              </>
            )}
          </>
        )}
      </main>
    );
  });
}

/**
 * 預設打開哪一次。
 *
 * 網址帶了 `?attempt=` 就用那一次；否則挑**最近一次交出去的**，
 * 而不是單純的最後一次——最後一次可能是一份剛開始寫、還沒交的。
 * 那樣的話學生點進成績頁看到的是「還在作答中」，而他想看的是
 * 上禮拜考完的那一次。
 */
function pickAttempt(attempts: ResultAttemptChoice[], wanted?: string): ResultAttemptChoice {
  const no = Number(wanted);
  if (Number.isInteger(no)) {
    const hit = attempts.find((a) => a.attemptNo === no);
    // 找不到就退回預設，不報錯：網址被亂改或那一次被刪了，
    // 學生想看的仍然是自己的成績。
    if (hit) return hit;
  }
  return attempts.find((a) => a.submittedAt !== null) ?? attempts[0];
}

function AttemptPicker({
  assignmentId,
  attempts,
  currentId,
}: {
  assignmentId: string;
  attempts: ResultAttemptChoice[];
  currentId: string;
}) {
  return (
    <nav className="yz-review__picker" aria-label="選擇要看哪一次作答">
      <span className="yz-review__pickerlabel">作答次數</span>
      {attempts.map((a) => {
        const current = a.attemptId === currentId;
        return (
          <Link
            key={a.attemptId}
            href={`/take/${assignmentId}/result?attempt=${a.attemptNo}`}
            className={`yz-review__pick${current ? ' yz-review__pick--on' : ''}`}
            aria-current={current ? 'page' : undefined}
          >
            第 {a.attemptNo} 次
            <span className="yz-muted">
              {a.status === 'VOIDED'
                ? '已作廢'
                : a.submittedAt === null
                  ? '作答中'
                  : a.level === 'NONE'
                    ? '未開放'
                    : a.totalScore === null
                      ? '未計分'
                      : `${fmtScore(a.totalScore)} 分`}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────────
// 一題
// ─────────────────────────────────────────────────────────────────

/**
 * 五種結果各有自己的字，**而且未作答不與答錯合併**。
 *
 * 一個是不會，一個是沒時間——對學生要不要回去補這個章節、
 * 以及要不要練習配速，是完全不同的兩件事。合併之後那個訊息就沒了。
 */
const VERDICT_LABEL: Record<QuestionVerdict, string> = {
  CORRECT: '答對',
  PARTIAL: '部分給分',
  WRONG: '答錯',
  BLANK: '沒有作答',
  PENDING: '等老師評分',
};

/** 顏色之外還要有記號：色盲的人與黑白列印都讀得到。 */
const VERDICT_MARK: Record<QuestionVerdict, string> = {
  CORRECT: '✓',
  PARTIAL: '△',
  WRONG: '×',
  BLANK: '—',
  PENDING: '？',
};

function QuestionBlock({ q }: { q: ResultQuestion }) {
  const wrong = q.verdict === 'WRONG' || q.verdict === 'PARTIAL' || q.verdict === 'BLANK';

  return (
    <li className={`yz-review yz-review--${q.verdict.toLowerCase()}`}>
      {q.stimulus && (
        <div className="yz-take__stimulus">
          {q.stimulusLabel && <div className="yz-take__stimlabel">{q.stimulusLabel}</div>}
          <MathText>{q.stimulus}</MathText>
        </div>
      )}

      {/* 原生 details：不需要任何 JavaScript，而這一頁是 server component。
          自己做一顆展開按鈕的話，整頁就得變成 client component，
          正確答案也就跟著進了瀏覽器的 props。 */}
      <details open={wrong}>
        <summary className="yz-review__sum">
          <span className="yz-review__no">{q.order}</span>
          <span className="yz-review__mark" aria-hidden="true">
            {VERDICT_MARK[q.verdict]}
          </span>
          <span className="yz-review__verdict">{VERDICT_LABEL[q.verdict]}</span>
          <span className="yz-review__score">
            {q.earnedScore === null ? '—' : fmtScore(q.earnedScore)} / {fmtScore(q.score)} 分
          </span>
          {/* 收合時的一行預覽也要排出來：學生是靠這一行認出「這就是我卡住
              的那一題」的，而一整串反斜線在一行的寬度裡認不出任何東西。 */}
          <span className="yz-review__peek"><MathText>{q.content}</MathText></span>
        </summary>

        <div className="yz-review__body">
          <div className="yz-review__stem">
            {q.subLabel && <b>{q.subLabel}</b>}
            <MathText>{q.content}</MathText>
          </div>

          {q.options.length > 0 && (
            <div className="yz-review__opts">
              {q.options.map((o) => (
                <div
                  key={o.key}
                  className={[
                    'yz-review__opt',
                    o.correct ? 'yz-review__opt--correct' : '',
                    o.picked && !o.correct ? 'yz-review__opt--badpick' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <span className="yz-review__optmark" aria-hidden="true">
                    {o.correct ? '✓' : o.picked ? '×' : ''}
                  </span>
                  <span className="yz-take__optkey">({o.label})</span>
                  <span><MathText>{o.content}</MathText></span>
                  {/* 文字標記與底色並存。只靠底色的話，把畫面印出來
                      或色覺不同的人就分不出哪一個是自己選的。 */}
                  {o.picked && <span className="yz-review__tag">你選的</span>}
                  {o.correct && !o.picked && <span className="yz-review__tag">正解</span>}
                </div>
              ))}
              {q.verdict === 'BLANK' && (
                <p className="yz-review__blank">這一題你沒有作答。</p>
              )}
            </div>
          )}

          {q.options.length === 0 && <WrittenAnswer q={q} />}

          {q.scoreNote && <p className="yz-review__note">{q.scoreNote}</p>}

          <Explanation q={q} />
        </div>
      </details>
    </li>
  );
}

/** 非選擇題：填充、選填、簡答、申論、翻譯。 */
function WrittenAnswer({ q }: { q: ResultQuestion }) {
  const mine =
    q.mySlots && q.mySlots.length > 0
      ? q.mySlots.map((s) => `${s.slot} ${s.value || '（空白）'}`).join('　')
      : (q.myText ?? '');

  const correct =
    q.correctSlots && q.correctSlots.length > 0
      ? q.correctSlots.join('　')
      : q.correctTexts && q.correctTexts.length > 0
        ? q.correctTexts.join('　或　')
        : null;

  return (
    <div className="yz-review__ans">
      <div className="yz-review__ansrow">
        <span className="yz-review__anslabel">你寫的</span>
        {/* 學生寫的**照原樣顯示，不排版**。他是在一個純文字方塊裡打的，
            打了什麼就該看到什麼——把它當數學式排一次，畫面上就會出現
            一個他沒有寫過的東西，而他正要拿這一行去對答案。 */}
        <span className={mine.trim() === '' ? 'yz-muted' : 'yz-review__anstext'}>
          {mine.trim() === '' ? '（沒有作答）' : mine}
        </span>
      </div>
      <div className="yz-review__ansrow">
        <span className="yz-review__anslabel">標準答案</span>
        {correct === null ? (
          // 申論與翻譯本來就沒有唯一解。給一個空欄位會讓學生以為
          // 系統漏了東西，然後去問老師「我的答案呢」。
          <span className="yz-muted">這一題由老師依評分標準給分，沒有單一的標準答案。</span>
        ) : (
          // 標準答案是題庫裡的，寫法與題幹同一套（`$\frac{3}{4}$`）。
          <span className="yz-review__anstext"><MathText>{correct}</MathText></span>
        )}
      </div>
      {q.correctTexts && q.correctTexts.length > 1 && (
        <p className="yz-review__note">上面幾種寫法都算對。</p>
      )}
    </div>
  );
}

/**
 * 解析。
 *
 * # 這一段是法律問題，不是功能問題
 *
 * `rawBody`（匯入的出版社原文）在這裡拿不到——`lib/result.ts` 的 select
 * 裡根本沒有那一欄。畫面上顯示的一律是 `layers`，也就是結構化之後的
 * 分層內容。
 *
 * `noExport` 的那幾份只授權「本補習班的學生線上閱讀」，所以這一頁
 * 不提供任何複製、下載、列印的便利功能，而且列印時整塊解析不出現。
 * 這擋不住截圖，也不打算擋——它要做到的是**系統本身沒有幫忙散布**。
 */
function Explanation({ q }: { q: ResultQuestion }) {
  if (q.explanationPending) {
    // 原稿詳解還沒改寫。**這種一個字都不能顯示**：權利基礎未確認的
    // 原文不可原文收錄（資料庫的 explanations_unverified_must_rewrite
    // 約束擋的就是這件事），所以連「先給你看原文」都不行。
    return (
      <p className="yz-review__pending">
        這一題的詳解還在整理中，整理好之後會出現在這裡。現在想弄懂的話，直接問老師。
      </p>
    );
  }

  const e = q.explanation;
  if (!e) {
    return (
      <p className="yz-review__pending">
        這一題還沒有解析。想知道怎麼算，把題號抄下來問老師。
      </p>
    );
  }

  return (
    <section className={`yz-explain${e.noExport ? ' yz-explain--noexport' : ''}`}>
      <h3 className="yz-explain__head">解析</h3>
      <div className="yz-explain__layers">
        {e.layers.map((layer) => (
          <div key={layer.key} className="yz-explain__layer">
            <div className="yz-explain__label">{layer.label}</div>
            <ul className="yz-explain__items">
              {layer.items.map((item, i) => (
                <li key={i}>
                  {item.lead && <b className="yz-explain__lead">{item.lead}</b>}
                  {/* 解析是這一頁存在的理由，而解析裡全是式子。
                      這一段沒有排出來的話，「先求合力 $\vec{F} = m\vec{a}$」
                      這種一步一步的推導會變成學生讀不下去的一長串符號。 */}
                  <MathText>{item.body}</MathText>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* 列印時代替上面那一塊。留一行字而不是整塊消失，
          否則印出來的檢討會少一段而沒有人知道少了什麼。 */}
      {e.noExport && (
        <p className="yz-explain__noprint">（這一題的解析只授權線上閱讀，不列印。）</p>
      )}
      {e.noExport && (
        <p className="yz-explain__rights">
          這份解析只授權本補習班的學生在線上閱讀，請不要轉發、下載或列印。
        </p>
      )}

      <p className="yz-attrib">{attribution(e.origin, e.modelUsed, e.sourceRef)}</p>
    </section>
  );
}

/**
 * 這份解析是誰寫的。
 *
 * 家長與老師對「這是不是 AI 寫的」有疑慮，而學生也該知道自己在讀誰的
 * 東西——尤其是 AI 生成的那幾份仍然可能出錯。藏起來不會讓疑慮消失，
 * 只會讓它在出錯那一次一次爆發。
 */
function attribution(origin: string, modelUsed: string | null, sourceRef: string | null): string {
  const who =
    origin === 'TEACHER_WRITTEN'
      ? '本班老師撰寫'
      : origin === 'OFFICIAL_CEEC'
        ? '大考中心公布的參考解答'
        : origin === 'AI_REWRITTEN'
          ? 'AI 依原始詳解改寫'
          : origin === 'AI_GENERATED'
            ? 'AI 生成'
            : '匯入的詳解';
  const parts = [who];
  if (modelUsed) parts.push(modelUsed);
  if (sourceRef) parts.push(sourceRef);
  return parts.join('　·　');
}

// ─────────────────────────────────────────────────────────────────

/** 78 而不是 78.00，78.5 而不是 78.50。浮點加總會印出 78.30000000000001。 */
function fmtScore(n: number): string {
  return String(Math.round(n * 100) / 100);
}
