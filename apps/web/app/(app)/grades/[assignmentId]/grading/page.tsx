/**
 * 批次閱卷：一份任務的同一題，全班一起看。
 *
 * # 為什麼是「一題 × 三十位學生」而不是「一份 × 全部題目」
 *
 * 因為那是老師真正的工作方式。三十份作文比較著改比一份一份改快得多，
 * 而且**標準比較一致**——一個人連續看同一題的三十份答案，心裡的尺度
 * 會穩定下來；換題目換學生地跳著改，第五份與第二十五份的標準不一樣，
 * 而那個不一樣沒有任何辦法事後修正。
 *
 * 答案卷那一頁（`[attemptId]/page.tsx`）是另一種用途：家長打電話來問
 * 某一位學生。兩頁共用同一個 `ProposalCard`，所以「AI 提出、老師決定」
 * 那條規則不會只在其中一頁成立。
 *
 * # 為什麼信心低的排前面
 *
 * 因為那些最需要人看。排序在 `sortForReview`（純函式、有測試）：
 * 被安全規則擋下的最前面（不改就沒有分數）、判斷不穩的第二、
 * 然後照信心從低到高、已決定的沉到最後。
 *
 * # 為什麼「準不準」那一塊在這一頁而不是另開一頁
 *
 * 因為它是給正在閱卷的那個人看的。放在設定頁裡的話，看到它的人是
 * 三個月後在找別的東西的管理員，而那時候該做的決定（要不要繼續開
 * 這個功能）已經拖了三個月。
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Denied, Empty, Note } from '@/components/Feedback';
import { MathText } from '@/components/MathText';
import { Table } from '@/components/Table';
import {
  gradingAccuracy,
  loadQuestionBatch,
  nonObjectiveItems,
  type AccuracyView,
  type BatchRow,
} from '@/lib/gradingProposalDb';
import { mayUse } from '@/lib/nav';
import { scopedPage } from '@/lib/page';
import { prisma } from '@/lib/prisma';
import { mayGrade, mayViewGrades } from '@/lib/scoring';
import { ProposalCard } from '../ProposalCard';
import { ProposeAll } from './ProposeAll';

export const dynamic = 'force-dynamic';

const TYPE_LABEL: Record<string, string> = {
  ESSAY: '申論',
  TRANSLATION: '翻譯',
  SHORT_ANSWER: '簡答',
};

const fmt = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : String(Math.round(n * 100) / 100);

const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`);

export default async function BatchGradingPage({
  params,
  searchParams,
}: {
  params: Promise<{ assignmentId: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { assignmentId } = await params;
  const { q } = await searchParams;

  return scopedPage(async (user) => {
    if (!mayUse(user.systemRole, '/grades')) {
      return (
        <main className="yz-panel">
          <Denied
            what="批次閱卷"
            why="這一頁上有全班的作答內容與評分規準，屬於老師的工作區。"
          />
        </main>
      );
    }

    const assignment = await prisma.assignment.findFirst({
      where: { id: assignmentId },
      select: {
        id: true,
        title: true,
        createdBy: true,
        paper: { select: { subjectId: true, title: true } },
      },
    });
    if (!assignment) notFound();

    // **列表濾掉不等於內頁擋住。** 把網址列的 id 換成別科那一份，
    // 外洩的是全班每一位學生的作文。
    if (
      !(await mayViewGrades(user, {
        subjectId: assignment.paper.subjectId,
        createdBy: assignment.createdBy,
      }))
    ) {
      return (
        <main className="yz-panel">
          <Denied
            what="這份任務的閱卷"
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
    if (!(await mayGrade(user, assignment.paper.subjectId))) {
      return (
        <main className="yz-panel">
          <Denied
            what="批次閱卷"
            why={
              <>
                你看得到這份任務的成績，但改不動分數——閱卷要這一科的授課權限。
                　<Link href={`/grades/${assignmentId}`}>回到全班成績</Link>
              </>
            }
          />
        </main>
      );
    }

    const items = await nonObjectiveItems(assignmentId);
    const accuracy = await gradingAccuracy({ assignmentId });

    if (items.length === 0) {
      return (
        <main className="yz-panel">
          <Head assignmentId={assignmentId} title={assignment.title} paper={assignment.paper.title} />
          <Empty
            title="這份卷子上沒有非選題"
            hint="申論、翻譯、以及沒有設自動比對規則的簡答題才需要閱卷。其他題型由系統計分。"
          />
        </main>
      );
    }

    const questionId = q && items.some((i) => i.questionId === q) ? q : items[0].questionId;
    const view = await loadQuestionBatch(user, assignmentId, questionId);
    const dimensionNames = (view.rubric?.dimensions ?? []).map((d) => d.name);

    return (
      <main className="yz-panel">
        <Head assignmentId={assignmentId} title={assignment.title} paper={assignment.paper.title} />

        <Note tone="info">
          <strong>AI 的評分是建議，不是分數。</strong>
          每一列旁邊的輸入框都是空的——照建議給分請按「採用」，那是一個會記進稽核的動作。
          分數寫進去的是與你在答案卷上手動給分完全同一條路（所以「全班重新計分」不會蓋掉它）。
        </Note>

        {/* ── 選一題 ────────────────────────────────────── */}
        <section style={{ marginBottom: 22 }}>
          <h2 className="yz-grade-h">這份卷子的非選題</h2>
          <Table
            caption="這份卷子上的非選題與閱卷進度"
            columns={[
              {
                key: 'o',
                head: '題號',
                numeric: true,
                cell: (i: (typeof items)[number]) =>
                  i.questionId === questionId ? (
                    <strong>{i.order}</strong>
                  ) : (
                    <Link href={`/grades/${assignmentId}/grading?q=${i.questionId}`}>{i.order}</Link>
                  ),
              },
              {
                key: 't',
                head: '題型',
                cell: (i: (typeof items)[number]) => TYPE_LABEL[i.type] ?? i.type,
              },
              {
                key: 's',
                head: '配分',
                numeric: true,
                cell: (i: (typeof items)[number]) => fmt(i.score),
              },
              {
                key: 'r',
                head: '規準',
                cell: (i: (typeof items)[number]) =>
                  i.hasRubric ? '有' : <span className="yz-warn">沒有</span>,
              },
              {
                key: 'd',
                head: '已給分',
                numeric: true,
                cell: (i: (typeof items)[number]) => `${i.scored} / ${i.total}`,
              },
              {
                key: 'w',
                head: '等你決定',
                numeric: true,
                cell: (i: (typeof items)[number]) =>
                  i.undecided > 0 ? <span className="yz-warn">{i.undecided}</span> : '—',
              },
              {
                key: 'p',
                head: '',
                cell: (i: (typeof items)[number]) =>
                  i.questionId === questionId ? (
                    <span className="yz-muted">正在看</span>
                  ) : (
                    <Link href={`/grades/${assignmentId}/grading?q=${i.questionId}`}>改這一題</Link>
                  ),
              },
            ]}
            rows={items}
            rowKey={(i) => i.questionId}
            selectedKey={questionId}
            empty={<Empty title="沒有非選題" />}
          />
        </section>

        {/* ── 這一題 ────────────────────────────────────── */}
        <section style={{ marginBottom: 22 }}>
          <h2 className="yz-grade-h">
            第 {view.questionOrder} 題（{TYPE_LABEL[view.questionType] ?? view.questionType}，
            {fmt(view.maxScore)} 分）
          </h2>
          <div className="yz-prop__stem">
            <MathText>{view.stem}</MathText>
          </div>

          {view.rubric ? (
            <details className="yz-prop__rubric">
              <summary>
                評分規準：{view.rubric.name}（總分 {fmt(view.rubric.totalScore)} 分）
                {view.rubric.internalOnly && <span className="yz-prop__internal">內部使用</span>}
              </summary>
              <div className="yz-prop__rubricbody">
                <p className="yz-grade-hint">
                  {view.rubric.internalOnly
                    ? '這一份規準標為內部使用（評分原則的描述文字受著作權保護，授權範圍是機構內部閱卷）。學生看不到它，也不會被匯出或印在給學生的東西上。'
                    : '這一份規準沒有標內部使用。'}
                </p>
                {view.rubric.dimensions.length > 0 && (
                  <ul className="yz-prop__dims">
                    {view.rubric.dimensions.map((d) => (
                      <li key={d.id} className="yz-prop__dim">
                        <span className="yz-prop__dimname">{d.name}</span>
                        <span className="yz-prop__dimscore">上限 {fmt(d.maxScore)}</span>
                        <span className="yz-prop__dimwhy">{d.descriptor ?? ''}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {view.rubric.bands.length > 0 && (
                  <ul className="yz-prop__dims">
                    {view.rubric.bands.map((b) => (
                      <li key={b.id} className="yz-prop__dim">
                        <span className="yz-prop__dimname">{b.grade}</span>
                        <span className="yz-prop__dimscore">
                          {fmt(b.scoreMin)}–{fmt(b.scoreMax)}
                        </span>
                        <span className="yz-prop__dimwhy">{b.descriptor}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </details>
          ) : (
            <Note tone="warn">
              這一題<strong>沒有評分規準</strong>，所以 AI 的建議沒有逐面向的分數，
              可信度也低得多。要讓它幫得上忙，先到
              　<Link href={`/bank/${questionId}`}>題庫的這一題</Link>
              　建一份規準（有現成的範本可以套）。
            </Note>
          )}

          <ProposeAll
            assignmentId={assignmentId}
            questionId={questionId}
            waiting={view.waiting}
            pending={view.pending}
            total={view.rows.length}
          />

          <p className="yz-grade-hint">
            順序是<strong>最需要人看的排前面</strong>：被安全規則擋下的（沒有建議，不改就沒有分數）、
            AI 判斷不穩的、然後信心從低到高。已經決定過的沉到最後。
          </p>

          {view.rows.length === 0 ? (
            <Empty
              title="還沒有人交這份卷子"
              hint="交卷之後才有答案可以評。進行中的作答不會出現在這裡。"
            />
          ) : (
            <ol className="yz-batch">
              {view.rows.map((r) => (
                <StudentRow
                  key={r.attemptId}
                  r={r}
                  assignmentId={assignmentId}
                  questionId={questionId}
                  dimensionNames={dimensionNames}
                />
              ))}
            </ol>
          )}
        </section>

        <AccuracyBlock a={accuracy} assignmentId={assignmentId} />
      </main>
    );
  });
}

function Head({
  assignmentId,
  title,
  paper,
}: {
  assignmentId: string;
  title: string;
  paper: string;
}) {
  return (
    <div className="yz-panel__head">
      <h1>批次閱卷</h1>
      <p className="yz-panel__sub">
        {title}　·　{paper}
        <br />
        <Link href={`/grades/${assignmentId}`}>回到全班成績</Link>
        　·　<Link href="/grades">成績列表</Link>
      </p>
    </div>
  );
}

function StudentRow({
  r,
  assignmentId,
  questionId,
  dimensionNames,
}: {
  r: BatchRow;
  assignmentId: string;
  questionId: string;
  dimensionNames: string[];
}) {
  return (
    <li className="yz-batch__row">
      <div className="yz-batch__who">
        <span className="yz-batch__name">{r.displayName}</span>
        <span className="yz-muted">{r.username}</span>
        {r.attemptNo > 1 && <span className="yz-muted">第 {r.attemptNo} 次</span>}
        <span className={r.earnedScore === null ? 'yz-warn' : 'yz-batch__score'}>
          {r.earnedScore === null ? '待評分' : `${fmt(r.earnedScore)} / ${fmt(r.maxScore)} 分`}
        </span>
        {/* 整份答案卷在另一頁。家長打電話來問某一位學生時要跳得過去
            ——那一頁看得到他的每一題與交卷時刻。 */}
        <Link href={`/grades/${assignmentId}/${r.attemptId}`}>看整份</Link>
      </div>

      {/* 學生寫的**照原樣顯示，不排版**。他是在一個純文字方塊裡打的，
          打了什麼就該看到什麼——把它當數學式排一次，畫面上會出現一個
          他沒有寫過的東西，而老師正要拿它評分。 */}
      <div className={r.answered ? 'yz-batch__answer' : 'yz-batch__answer yz-muted'}>
        {r.answered ? r.answerText : '（沒有作答）'}
      </div>

      <ProposalCard
        attemptId={r.attemptId}
        questionId={questionId}
        max={r.maxScore}
        current={r.earnedScore}
        manual={r.manual}
        proposal={r.proposal}
        rubricDimensions={dimensionNames}
        compact
      />
    </li>
  );
}

/**
 * 這個功能到底準不準。
 *
 * 三個數字要一起看：**採用率高不代表評得準**——老師趕著改三十份時，
 * 一個看起來合理的分數他會直接按。所以配上平均誤差（他改的時候改了
 * 多少）與被改最多的面向（改的是哪一塊）。
 */
function AccuracyBlock({ a, assignmentId }: { a: AccuracyView; assignmentId: string }) {
  return (
    <section style={{ marginBottom: 22 }}>
      <h2 className="yz-grade-h">這個功能到底準不準（這份任務）</h2>
      <p className="yz-grade-hint">
        這幾個數字<strong>只算得出來因為被否決的建議留著</strong>。
        它們是判斷「要不要繼續用 AI 閱卷」的依據——採用率 90% 與 30% 是兩個完全不同的世界。
      </p>

      <dl className="yz-summary">
        <div>
          <dt>老師看過</dt>
          <dd>{a.decided}</dd>
        </div>
        <div>
          <dt>照建議給分</dt>
          <dd>{a.ACCEPTED}</dd>
        </div>
        <div>
          <dt>改了分數</dt>
          <dd>{a.ADJUSTED}</dd>
        </div>
        <div>
          <dt>不採用</dt>
          <dd>{a.REJECTED}</dd>
        </div>
        <div>
          <dt>被擋下</dt>
          <dd className={a.BLOCKED > 0 ? 'yz-warn' : undefined}>{a.BLOCKED || '—'}</dd>
        </div>
        <div>
          <dt>採用率</dt>
          <dd>{pct(a.adoptionRate)}</dd>
        </div>
        <div>
          <dt>平均誤差</dt>
          <dd>{a.mae === null ? '—' : `${fmt(a.mae)} 分`}</dd>
        </div>
        <div>
          <dt>改的時候差</dt>
          <dd>{a.maeWhenChanged === null ? '—' : `${fmt(a.maeWhenChanged)} 分`}</dd>
        </div>
      </dl>

      <Note tone={a.enough && (a.adoptionRate ?? 1) < 0.5 ? 'warn' : 'info'}>{a.verdict}</Note>

      {a.bias !== null && Math.abs(a.bias) >= 0.5 && (
        <p className="yz-grade-hint">
          有號誤差 {fmt(a.bias)} 分：
          {a.bias > 0
            ? 'AI 給得比老師低（偏嚴）。系統性偏一邊是提示詞改得動的，隨機誤差不是。'
            : 'AI 給得比老師高（偏寬鬆）。'}
        </p>
      )}

      {a.worstDimensions.length > 0 ? (
        <p className="yz-grade-hint">
          被改最多的面向：
          {a.worstDimensions.map((d) => `${d.name}（${d.count} 次）`).join('、')}
          {a.untaggedChanges > 0 && `　·　另有 ${a.untaggedChanges} 次改分沒有標面向`}
        </p>
      ) : (
        a.untaggedChanges > 0 && (
          <p className="yz-grade-hint">
            有 {a.untaggedChanges} 次改分沒有標「哪個面向評不準」。
            那一格是選填的，但少了它，「該改哪一句提示詞」就沒有任何線索。
          </p>
        )
      )}

      {a.promptVersions.length > 1 && (
        <Note tone="warn">
          這批數字裡混了 {a.promptVersions.length} 個提示詞版本
          （{a.promptVersions.join('、')}）。兩套規則的表現被平均掉了，
          要判斷改動有沒有效，看換版之後的那一段。
        </Note>
      )}

      {a.byQuestion.length > 1 && (
        <>
          <h3 className="yz-tutor__h3">哪一題最不準</h3>
          <Table
            caption="各題的 AI 閱卷採用率"
            columns={[
              { key: 'o', head: '題號', numeric: true, cell: (r) => r.order ?? '—' },
              { key: 'p', head: '題幹', cell: (r) => r.peek },
              { key: 'd', head: '看過', numeric: true, cell: (r) => r.decided },
              { key: 'a', head: '採用率', numeric: true, cell: (r) => pct(r.adoptionRate) },
              {
                key: 'e',
                head: '平均誤差',
                numeric: true,
                cell: (r) => (r.mae === null ? '—' : fmt(r.mae)),
              },
            ]}
            rows={a.byQuestion}
            rowKey={(r) => r.questionId}
            empty={<Empty title="還沒有決定過的建議" />}
          />
        </>
      )}

      <p className="yz-grade-hint">
        看整個補習班的數字（不只這一份任務）：
        　<Link href={`/grades/${assignmentId}`}>全班成績頁</Link>
        　上有這份任務的其他統計。
      </p>
    </section>
  );
}
