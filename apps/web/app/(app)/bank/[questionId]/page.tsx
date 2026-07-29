/**
 * 一題的內頁：看得到全部、改得動全部。
 *
 * # 在這一頁之前，題庫是唯讀的
 *
 * 匯入的題本裡有一題答案抓錯，老師唯一的辦法是重新匯入一次整本——
 * 而三個地方（成績列表的說明、重新計分對話框的兩個範例）都已經
 * 承諾了「改標準答案」這件事做得到。這一頁就是那件事。
 *
 * # 版面的順序是「先講後果，再給編輯框」
 *
 * 因為改標準答案最貴的錯誤不是改錯，是**改完以為結束了**。所以
 * 「這一題已經有 N 份作答計過分」與那幾份任務的連結擺在編輯區上面，
 * 而不是收在儲存後的提示裡。
 *
 * # 為什麼題幹在伺服器端就排好，編輯框卻在 client
 *
 * 上方那一塊唯讀的呈現走 server component 的 `MathText`（零 JavaScript）。
 * 編輯區要即時預覽，所以它是 client——KaTeX 會跟著進 bundle，
 * 這與匯入校對頁的取捨一樣：那兩頁都會停留很久，划得來。
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Denied, Note } from '@/components/Feedback';
import { MathText } from '@/components/MathText';
import { mayUse } from '@/lib/nav';
import { scopedPage } from '@/lib/page';
import { prisma } from '@/lib/prisma';
import { loadQuestionDetail, mayEditQuestion } from '@/lib/question';
import { TYPE_LABELS, checkRetire } from '@/lib/questionEdit.mjs';
import QuestionEditor from './QuestionEditor';
import StatusControl from './StatusControl';

export const dynamic = 'force-dynamic';

const STATUS_LABELS: Record<string, string> = {
  DRAFT: '未校對',
  PENDING_REVIEW: '待發布',
  PUBLISHED: '已發布',
  RETIRED: '已下架',
};

const SOURCE_LABELS: Record<string, string> = {
  OFFICIAL_PAST: '歷屆試題',
  TEACHER_ORIGINAL: '老師自編',
  SCHOOL_EXAM: '校內考卷',
  PUBLISHER_SCAN: '出版社題本',
  AI_GENERATED: 'AI 生成',
};

function when(d: Date | null): string {
  if (!d) return '—';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

export default async function QuestionPage({
  params,
}: {
  params: Promise<{ questionId: string }>;
}) {
  const { questionId } = await params;

  return scopedPage(async (user) => {
    // 導覽列不畫題庫給學生，但**藏起來不等於擋住**——把網址改成
    // /bank/xxx 就會看到一題連標準答案與詳解都在上面的頁面。
    if (!mayUse(user.systemRole, '/bank')) {
      return (
        <main className="yz-panel">
          <Denied
            what="題庫"
            why="這一頁上有標準答案與詳解，是老師的工作區。你看得到的是自己的任務與成績。"
          />
        </main>
      );
    }

    const q = await loadQuestionDetail(questionId);
    if (!q) notFound();

    const canEdit = await mayEditQuestion(user, q.subjectId);

    // 附圖另外查一次。
    //
    // `loadQuestionDetail` 的回傳型別是 `lib/question.ts` 定的白名單，
    // 而那一支同時服務改答案、下架、送分三條路——為了在這一頁畫一張圖
    // 而動它的形狀，代價是那三條路都要跟著改。這裡只多一次很小的查詢，
    // 換掉一次跨檔案的連鎖修改。
    const media = await prisma.question.findFirst({
      where: { id: questionId },
      select: {
        contentAssets: true,
        group: { select: { stimulusAssets: true } },
        options: { select: { order: true, assets: true } },
      },
    });
    const optionAssets = new Map((media?.options ?? []).map((o) => [o.order, o.assets]));
    const knowledgePoints = await prisma.knowledgePoint.findMany({
      where: { subjectId: q.subjectId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    // 已經計過分、會被這次改動影響的任務。上面那一塊與確認視窗共用。
    const affected = q.usage.papers
      .flatMap((p) => p.assignments)
      .filter((a) => a.graded > 0)
      .map((a) => ({ assignmentId: a.assignmentId, title: a.title, graded: a.graded }));

    // 下架現在會不會被擋，以及被誰擋。**先算出來畫在確認視窗裡**——
    // 按下去才知道被擋，老師只會覺得系統在跟他作對。
    const retire = checkRetire(
      q.usage.papers.map((p) => ({
        paperId: p.paperId,
        paperTitle: p.paperTitle,
        paperStatus: p.paperStatus,
        assignments: p.assignments,
      })),
      new Date(),
    );

    return (
      <main className="yz-panel" style={{ maxWidth: 900 }}>
        <div className="yz-panel__head">
          <h1>
            {TYPE_LABELS[q.type] ?? q.type}
            <span className="yz-muted">　{STATUS_LABELS[q.status] ?? q.status}</span>
          </h1>
          <p className="yz-panel__sub">
            {q.subjectName}　·　第 {q.version} 版　·　{SOURCE_LABELS[q.sourceType] ?? q.sourceType}
            {q.sourceRef && `　·　${q.sourceRef}`}
            　·　<Link href={`/bank?subject=${q.subjectId}`}>回到題庫</Link>
          </p>
        </div>

        {!canEdit && (
          <Note tone="warn">
            你不是{q.subjectName}的授課老師，這一題只能看不能改。
            改別科的題目會直接動到那一科的成績。
          </Note>
        )}

        {/* 後果先講。**這一塊在編輯區上面是刻意的**：老師改完標準答案
            之後最常見的誤會是「改完就生效了」。 */}
        {q.usage.graded > 0 && (
          <Note tone="warn">
            這一題已經有 <strong>{q.usage.graded} 份作答計過分</strong>。
            改了標準答案之後那些分數<strong>不會自動更新</strong>——
            要到這幾份任務按一次「全班重新計分」：
            {affected.map((a) => (
              <span key={a.assignmentId}>
                　<Link href={`/grades/${a.assignmentId}`}>{a.title}</Link>（{a.graded} 份）
              </span>
            ))}
            {q.usage.inProgress > 0 &&
              `　另外現在有 ${q.usage.inProgress} 份作答正在進行中，改了題幹他們會立刻看到。`}
          </Note>
        )}

        {q.award && (
          <Note tone="warn">
            這一題<strong>已經全班送分</strong>：不論作答一律得滿分，
            <strong>每一份用到它的卷子都一樣</strong>。
            {q.award.reason && `　原因：${q.award.reason}`}
            {(q.award.byName || q.award.at) &&
              `（${[q.award.byName, q.award.at ? when(new Date(q.award.at)) : null]
                .filter(Boolean)
                .join('　')}）`}
            　要取消送分，到當初按下它的成績頁：
            {q.award.assignmentId ? (
              <Link href={`/grades/${q.award.assignmentId}`}>
                {q.award.assignmentTitle ?? '那份任務'}
              </Link>
            ) : (
              '那份任務的各題答對率那一張表'
            )}
            。
          </Note>
        )}

        {/* 題組的前導敘述。這一題單看可能完全看不懂，而它不在題幹裡。 */}
        {q.group && (
          <div className="yz-card">
            <h2 className="yz-card__title">題組{q.group.label ? `　${q.group.label}` : ''}</h2>
            <div className="yz-qedit__stimulus">
              <MathText assets={media?.group?.stimulusAssets} label="題組素材">
                {q.group.stimulus}
              </MathText>
            </div>
          </div>
        )}

        <QuestionEditor
          question={{
            id: q.id,
            type: q.type,
            content: q.content,
            score: q.score,
            options: q.options.map((o) => ({
              order: o.order,
              label: o.label,
              content: o.content,
              assets: optionAssets.get(o.order) ?? null,
            })),
            contentAssets: media?.contentAssets ?? null,
            answerKeys: q.answerKeys,
            answerText: q.answerText,
            answerSlots: q.answerSlots,
            knowledgePointIds: q.knowledgePointIds,
            explanation: q.explanation
              ? { conclusion: q.explanation.conclusion, steps: q.explanation.steps }
              : null,
          }}
          impact={{
            graded: q.usage.graded,
            attempts: q.usage.attempts,
            inProgress: q.usage.inProgress,
            assignments: affected,
          }}
          knowledgePoints={knowledgePoints}
          canEdit={canEdit}
        />

        {q.foreignExplanations > 0 && (
          <Note>
            這一題另外有 {q.foreignExplanations} 份不是老師寫的詳解（匯入的原文或 AI 改寫）。
            那幾份的權利基礎不同，這一頁不編輯它們——上面那一格存的是老師自己寫的版本，
            存了之後學生看到的會是它。
          </Note>
        )}

        <h2 className="yz-grade-h">狀態</h2>
        {canEdit ? (
          <StatusControl
            questionId={q.id}
            status={q.status}
            usedBy={retire.blocking.map((b) => ({ title: b.title, why: b.why }))}
          />
        ) : (
          <p className="yz-grade-hint">
            目前是「{STATUS_LABELS[q.status] ?? q.status}」。要發布或下架請找這一科的授課老師。
          </p>
        )}

        <h2 className="yz-grade-h">用在哪裡</h2>
        {q.usage.papers.length === 0 ? (
          <p className="yz-grade-hint">
            還沒有任何卷子用到這一題。<Link href="/papers">到考卷那邊組一份</Link>。
          </p>
        ) : (
          <ul className="yz-qedit__uses">
            {q.usage.papers.map((p) => (
              <li key={p.paperId}>
                <Link href={`/papers/${p.paperId}`}>{p.paperTitle}</Link>
                <span className="yz-muted">　卷上配分 {p.score}</span>
                {p.assignments.length === 0 ? (
                  <span className="yz-muted">　還沒派出去</span>
                ) : (
                  <ul>
                    {p.assignments.map((a) => (
                      <li key={a.assignmentId}>
                        <Link href={`/grades/${a.assignmentId}`}>{a.title}</Link>
                        <span className="yz-muted">
                          　{a.dueAt ? `${when(a.dueAt)} 截止` : '沒有截止時間'}
                          {a.graded > 0 && `　·　${a.graded} 份已計分`}
                          {a.inProgress > 0 && `　·　${a.inProgress} 份作答中`}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}

        <p className="yz-grade-hint">
          建立於 {when(q.createdAt)}　·　最後更新 {when(q.updatedAt)}
          {q.nationalCorrectRate != null &&
            `　·　全國答對率 ${(q.nationalCorrectRate * 100).toFixed(0)}%`}
        </p>
      </main>
    );
  });
}
