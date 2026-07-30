/**
 * 老師看的某一位學生的答案卷。
 *
 * # 為什麼這一頁非有不可
 *
 * 家長晚上八點打電話來說「我孩子說他寫了」，而老師手上有的是：
 * 一個分數，或者一列「進行中」。**逐題作答、交卷時刻、他選了哪一個
 * 選項——全系統沒有任何一個畫面看得到。**
 *
 * 資料全部都在。`AttemptAnswer.answerKeys` 的註解甚至寫著「申訴時
 * 唯一能拿出來的東西」，`loadAttemptResult` 也早就寫好了——它只是
 * 擋著非本人（`if (attempt.userId !== userId) throw notYours()`），
 * 而檔頭寫著「要看別人的卷子走 `/grades`，那邊有科目授課權限的判斷」。
 * **`/grades` 沒有這個功能。** 這一頁就是那句註解指的地方。
 *
 * # 為什麼老師這一版不套 `maySeeResult`
 *
 * 放行時機管的是**學生**看不看得到。一份 ON_DUE 的考試在截止之前，
 * 老師連自己班的答案卷都打不開的話，這一頁在最需要它的那幾天
 * （考完當天、家長打電話那一晚）等於不存在。
 *
 * 分界在 `lib/result.ts`：`loadAttemptForGrading` 是另一支函式，
 * 不是同一支加一個旗標——旗標遲早會有一支呼叫端傳錯，而傳錯的方向
 * 是學生看得到別人的卷子。
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Denied, Empty, Note } from '@/components/Feedback';
import { MathText } from '@/components/MathText';
import { isManualScore } from '@/lib/examOps.mjs';
import { isAiGradable } from '@/lib/gradingProposal.mjs';
import { loadProposalsForAttempt, type ProposalView } from '@/lib/gradingProposalDb';
import { mayUse } from '@/lib/nav';
import { scopedPage } from '@/lib/page';
import {
  loadAttemptForGrading,
  type QuestionVerdict,
  type ResultQuestion,
} from '@/lib/result';
import { attemptTarget, mayGrade, mayViewGrades } from '@/lib/scoring';
import { prisma } from '@/lib/prisma';
import { ProposalCard } from '../ProposalCard';
import { ScoreOne } from './ScoreOne';

export const dynamic = 'force-dynamic';

/** 五種結果各有自己的字，**而且未作答不與答錯合併**。 */
const VERDICT_LABEL: Record<QuestionVerdict, string> = {
  CORRECT: '答對',
  PARTIAL: '部分給分',
  WRONG: '答錯',
  BLANK: '沒有作答',
  PENDING: '待評分',
};

/** 顏色之外還要有記號：色盲的人與黑白列印都讀得到。 */
const VERDICT_MARK: Record<QuestionVerdict, string> = {
  CORRECT: '✓',
  PARTIAL: '△',
  WRONG: '×',
  BLANK: '—',
  PENDING: '？',
};

/** 分數一律去掉沒有意義的小數。78.00 印成 78。 */
function fmtScore(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/**
 * 給人看的時刻。
 *
 * **一定要指定台北時區。** 這一頁上那個時刻是要唸給家長聽的，
 * 印成 UTC 會差八小時——而「他 06:58 交的」聽起來像是系統壞了。
 */
function when(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

export default async function TeacherAttemptPage({
  params,
}: {
  params: Promise<{ assignmentId: string; attemptId: string }>;
}) {
  const { assignmentId, attemptId } = await params;

  return scopedPage(async (user) => {
    if (!mayUse(user.systemRole, '/grades')) {
      return (
        <main className="yz-panel">
          <Denied
            what="學生的答案卷"
            why="這一頁是某一位學生的逐題作答與標準答案，屬於老師的工作區。"
          />
        </main>
      );
    }

    const target = await attemptTarget(attemptId);
    if (!target || target.assignmentId !== assignmentId) notFound();

    const assignment = await prisma.assignment.findFirst({
      where: { id: assignmentId },
      select: { createdBy: true },
    });
    // **列表濾掉不等於內頁擋住。** 這一類漏洞最常見的形狀就是把網址列
    // 的 id 換成別科那一份——而這一頁外洩的是一位學生的整份答案卷。
    if (
      !assignment ||
      !(await mayViewGrades(user, { subjectId: target.subjectId, createdBy: assignment.createdBy }))
    ) {
      return (
        <main className="yz-panel">
          <Denied
            what="這份作答"
            why={
              <>
                只看得到自己教的科目，以及自己派出去的任務。
                　<Link href="/grades">回到成績列表</Link>
              </>
            }
          />
        </main>
      );
    }

    const mayEdit = await mayGrade(user, target.subjectId);
    const view = await loadAttemptForGrading(attemptId);
    const student = await prisma.user.findFirst({
      where: { id: target.userId },
      select: { displayName: true, username: true },
    });

    // 非選題的 AI 建議。**這一頁只讀，不產生**——產生要按按鈕
    // （`ProposalCard` 裡那一顆），而按鈕走 `/api/proposals`。
    //
    // 為什麼在這一層查而不是在 `ProposalCard` 裡：`scopedPage` 建立的
    // 租戶脈絡在 render 回傳之後就不存在了，而 RLS 是 fail closed
    // ——查詢寫在子元件裡的症狀是「那一塊永遠是空的，而且沒有錯誤訊息」。
    // 與 `TutorReview` 同一個理由。
    // `ResultQuestion` 沒有帶 `scoringRule`（那是計分用的東西，不該進
    // 學生的檢討頁），所以這裡自己查一次——設了關鍵詞比對的簡答題是
    // 自動計分的，不該出現 AI 建議那一塊。
    const rules = await prisma.question.findMany({
      where: { id: { in: view.questions.map((q) => q.questionId) } },
      select: { id: true, type: true, scoringRule: true },
    });
    const aiGradable = new Set(
      rules
        .filter((r) =>
          isAiGradable(
            r.type,
            r.scoringRule && typeof r.scoringRule === 'object' && !Array.isArray(r.scoringRule)
              ? r.scoringRule
              : null,
          ),
        )
        .map((r) => r.id),
    );
    const proposals = mayEdit ? await loadProposalsForAttempt(attemptId) : new Map();
    const rubrics =
      aiGradable.size > 0
        ? await prisma.rubric.findMany({
            where: { questionId: { in: [...aiGradable] } },
            select: {
              questionId: true,
              dimensions: { select: { name: true }, orderBy: { order: 'asc' } },
            },
          })
        : [];
    const dimensionsByQuestion = new Map(
      rubrics.map((r) => [r.questionId ?? '', r.dimensions.map((d) => d.name)]),
    );

    const rate =
      view.totalScore === null || view.maxScore === 0
        ? null
        : Math.round((view.totalScore / view.maxScore) * 1000) / 10;

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>
            {student?.displayName ?? '（找不到這位學生）'}
            <span className="yz-muted">{student?.username}</span>
          </h1>
          <p className="yz-panel__sub">
            {view.assignmentTitle}　·　{view.paperTitle}　·　{view.subjectName}
            {view.attemptNo > 1 && `　·　第 ${view.attemptNo} 次作答`}
            <br />
            開始 {when(view.startedAt)}　·
            <strong>交卷 {when(view.submittedAt)}</strong>
            {view.autoSubmitted && '（時間到自動交卷）'}
            {view.late && <span className="yz-warn">　遲交</span>}
            <br />
            <Link href={`/grades/${assignmentId}`}>回到全班成績</Link>
            　·　<Link href={`/assignments/${assignmentId}`}>看收件名單</Link>
          </p>
        </div>

        {view.status === 'IN_PROGRESS' && (
          <Note tone="warn">
            這一份還在進行中，還沒有交卷，所以下面的分數是暫時的。
            要處理卡住的作答，回到全班成績頁按「代為結算」。
          </Note>
        )}
        {view.status === 'VOIDED' && (
          <Note tone="warn">
            這一份已經作廢，不計分、不進任何統計。學生那邊看到的是
            「這一份作答已經作廢，要知道原因或申請重考，請直接找老師」。
          </Note>
        )}

        <dl className="yz-summary">
          <div>
            <dt>得分</dt>
            <dd>{view.totalScore === null ? '未計分' : fmtScore(view.totalScore)}</dd>
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
                <dt>未作答</dt>
                <dd>{view.tally.BLANK}</dd>
              </div>
              <div>
                <dt>待評分</dt>
                <dd className={view.tally.PENDING > 0 ? 'yz-warn' : undefined}>
                  {view.tally.PENDING || '—'}
                </dd>
              </div>
            </>
          )}
        </dl>

        {view.tally && view.tally.PENDING > 0 && (
          <Note tone="warn">
            有 {view.tally.PENDING} 題還沒有分數（非選題，或客觀題的資料要人看一眼）。
            {mayEdit
              ? '在那幾題底下的輸入框直接給分——給完總分會立刻更新，而且之後按「全班重新計分」不會把它蓋掉。'
              : '請這一科的授課老師或管理員評分。'}
          </Note>
        )}

        <p className="yz-grade-hint">
          這是<strong>學生當時看到的版面</strong>：題號與選項順序都照他那一份的快照重畫，
          所以「他選的 (2)」就是他螢幕上的 (2)。
          {mayEdit && '　人工給的分數會蓋過自動計分，而且重新計分不會把它改回去。'}
        </p>

        {view.questions.length === 0 ? (
          <Empty
            title="這一份沒有逐題資料"
            hint="卷子的版面快照讀不出來。這種情況要看伺服器記錄，請告訴管理員。"
          />
        ) : (
          <ol className="yz-review__list">
            {view.questions.map((q) => (
              <QuestionBlock
                key={q.questionId}
                q={q}
                attemptId={attemptId}
                mayEdit={mayEdit && view.status !== 'VOIDED' && view.status !== 'IN_PROGRESS'}
                aiGradable={aiGradable.has(q.questionId)}
                proposal={proposals.get(q.questionId) ?? null}
                rubricDimensions={dimensionsByQuestion.get(q.questionId) ?? []}
              />
            ))}
          </ol>
        )}
      </main>
    );
  });
}

// ─────────────────────────────────────────────────────────────────

function QuestionBlock({
  q,
  attemptId,
  mayEdit,
  aiGradable,
  proposal,
  rubricDimensions,
}: {
  q: ResultQuestion;
  attemptId: string;
  mayEdit: boolean;
  /** 非選題（而且沒有設自動比對規則）。只有這種題目畫得出 AI 建議。 */
  aiGradable: boolean;
  proposal: ProposalView | null;
  rubricDimensions: string[];
}) {
  // 老師看的預設展開順序與學生相反：他是來查這一份的，所以**沒有分數
  // 的與寫錯的先打開**，答對的收起來。
  const open = q.verdict !== 'CORRECT';

  return (
    <li className={`yz-review yz-review--${q.verdict.toLowerCase()}`}>
      {q.stimulus && (
        <div className="yz-take__stimulus">
          {q.stimulusLabel && <div className="yz-take__stimlabel">{q.stimulusLabel}</div>}
          <MathText>{q.stimulus}</MathText>
        </div>
      )}

      {/* 原生 details：不需要任何 JavaScript。自己做一顆展開按鈕的話，
          整頁就得變成 client component，而標準答案也就跟著進了 props。 */}
      <details open={open}>
        <summary className="yz-review__sum">
          <span className="yz-review__no">{q.order}</span>
          <span className="yz-review__mark" aria-hidden="true">
            {VERDICT_MARK[q.verdict]}
          </span>
          <span className="yz-review__verdict">{VERDICT_LABEL[q.verdict]}</span>
          <span className="yz-review__score">
            {q.earnedScore === null ? '—' : fmtScore(q.earnedScore)} / {fmtScore(q.score)} 分
          </span>
          <span className="yz-review__peek">
            <MathText>{q.content}</MathText>
          </span>
        </summary>

        <div className="yz-review__body">
          <div className="yz-review__stem">
            {q.subLabel && <b>{q.subLabel}</b>}
            <MathText>{q.content}</MathText>
          </div>

          {q.options.length > 0 ? (
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
                  <span>
                    <MathText>{o.content}</MathText>
                  </span>
                  {/* 文字標記與底色並存：把這一頁印出來給家長看的時候，
                      只靠底色就分不出他選了哪一個。 */}
                  {o.picked && <span className="yz-review__tag">他選的</span>}
                  {o.correct && !o.picked && <span className="yz-review__tag">正解</span>}
                </div>
              ))}
              {q.verdict === 'BLANK' && <p className="yz-review__blank">這一題他沒有作答。</p>}
            </div>
          ) : (
            <WrittenAnswer q={q} />
          )}

          {q.scoreNote && (
            <p className="yz-review__note">
              {q.scoreNote}
              {isManualScore(q.scoreNote) && (
                <span className="yz-grade__sub">
                  這個分數是人給的，「全班重新計分」不會把它改掉。
                </span>
              )}
            </p>
          )}

          {/* AI 的建議與老師的輸入框**並列**，而且建議不會被填進輸入框。
              預填的話老師會直接按確認——那就是「AI 決定」而不是「AI 提出」。
              兩塊都畫是刻意的：`ScoreOne` 是不看建議也給得了分的那一條路，
              而它必須一直在（AI 掛掉、預算用完、建議被擋下時就靠它）。 */}
          {mayEdit && aiGradable && (
            <ProposalCard
              attemptId={attemptId}
              questionId={q.questionId}
              max={q.score}
              current={q.earnedScore}
              manual={isManualScore(q.scoreNote)}
              proposal={proposal}
              rubricDimensions={rubricDimensions}
            />
          )}

          {mayEdit && (
            <ScoreOne
              attemptId={attemptId}
              questionId={q.questionId}
              order={q.order}
              max={q.score}
              current={q.earnedScore}
              manual={isManualScore(q.scoreNote)}
            />
          )}
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
        <span className="yz-review__anslabel">他寫的</span>
        {/* 學生寫的**照原樣顯示，不排版**。他是在一個純文字方塊裡打的，
            打了什麼就該看到什麼——把它當數學式排一次，畫面上會出現一個
            他沒有寫過的東西，而老師正要拿它評分。 */}
        <span className={mine.trim() === '' ? 'yz-muted' : 'yz-review__anstext'}>
          {mine.trim() === '' ? '（沒有作答）' : mine}
        </span>
      </div>
      <div className="yz-review__ansrow">
        <span className="yz-review__anslabel">標準答案</span>
        {correct === null ? (
          <span className="yz-muted">這一題沒有單一的標準答案，依評分標準給分。</span>
        ) : (
          <span className="yz-review__anstext">
            <MathText>{correct}</MathText>
          </span>
        )}
      </div>
    </div>
  );
}
