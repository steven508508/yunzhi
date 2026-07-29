import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Denied, Empty, Note } from '@/components/Feedback';
import { MathText } from '@/components/MathText';
import { canEditSubject } from '@/lib/auth';
import { COMPOSABLE_QUESTION_STATUS, mayComposeArea } from '@/lib/paper';
import { scopedPage } from '@/lib/page';
import { prisma } from '@/lib/prisma';
import AddQuestion from './AddQuestion';
import Composer from './Composer';
import PaperTools from './PaperTools';

export const dynamic = 'force-dynamic';

/** 左欄一次最多列這麼多題。再多就該用篩選，而不是捲。 */
const PAGE = 60;

const TYPE: Record<string, string> = {
  SINGLE_CHOICE: '單選',
  MULTI_CHOICE: '多選',
  FILL_SLOT: '選填',
  FILL_TEXT: '填空',
  SHORT_ANSWER: '簡答',
  ESSAY: '作文',
  TRANSLATION: '翻譯',
  TRUE_FALSE: '是非',
};

export default async function PaperPage({
  params,
  searchParams,
}: {
  params: Promise<{ paperId: string }>;
  searchParams: Promise<{ q?: string; kp?: string; sub?: string }>;
}) {
  const { paperId } = await params;
  const sp = await searchParams;

  return scopedPage(async (user) => {
    if (!mayComposeArea(user.systemRole, '/papers')) {
      return (
        <main className="yz-panel">
          <Denied what="試卷" why="卷子上的題目是還沒考的，只有老師與管理員看得到。" />
        </main>
      );
    }

    const paper = await prisma.examPaper.findFirst({
      where: { id: paperId },
      include: { subject: { select: { id: true, name: true, code: true } } },
    });
    if (!paper) notFound();

    const mayEdit = await canEditSubject(user, paper.subjectId);

    // 合科的卷子（自然、社會）要能挑到分科的題目：學測考的是一張
    // 自然卷，但補習班是分科教的，題目掛在化學、生物、物理底下。
    // 這一段與 lib/paper.ts 的 subjectAllows 是同一條規則。
    const children = await prisma.subject.findMany({
      where: { parentCode: paper.subject.code },
      select: { id: true, name: true },
      orderBy: { order: 'asc' },
    });
    const scope = [{ id: paper.subject.id, name: paper.subject.name }, ...children];
    const scopeIds = scope.map((s) => s.id);
    const picked = sp.sub && scopeIds.includes(sp.sub) ? [sp.sub] : scopeIds;

    const [items, bank, kps] = await Promise.all([
      prisma.examPaperItem.findMany({
        where: { paperId },
        orderBy: { order: 'asc' },
        include: {
          question: {
            select: { id: true, content: true, type: true, score: true, subjectId: true },
          },
        },
      }),
      prisma.question.findMany({
        where: {
          subjectId: { in: picked },
          status: { in: [...COMPOSABLE_QUESTION_STATUS] },
          ...(sp.q ? { content: { contains: sp.q, mode: 'insensitive' as const } } : {}),
          ...(sp.kp ? { knowledgePoints: { some: { knowledgePointId: sp.kp } } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: PAGE,
        select: {
          id: true,
          content: true,
          type: true,
          score: true,
          difficulty: true,
          nationalCorrectRate: true,
          sourceRef: true,
        },
      }),
      prisma.knowledgePoint.findMany({
        where: { subjectId: { in: scopeIds } },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
    ]);

    const inPaper = new Map(items.map((i) => [i.questionId, i.order]));

    return (
      <main className="yz-panel" style={{ maxWidth: 1180 }}>
        <div className="yz-panel__head">
          <h1>{paper.title}</h1>
          <p className="yz-panel__sub">
            {paper.subject.name}　·　{items.length} 題　·　總分 {paper.totalScore}
            　·　<Link href="/papers">回到試卷列表</Link>
          </p>
        </div>

        {!mayEdit && (
          <Note tone="warn">
            你不是{paper.subject.name}的授課老師，這份卷子只能看不能改。
          </Note>
        )}

        {mayEdit && (
          <PaperTools
            paperId={paper.id}
            title={paper.title}
            status={paper.status}
            itemCount={items.length}
            totalScore={paper.totalScore}
          />
        )}

        <div className="yz-compose">
          {/* ── 左：題庫 ─────────────────────────────────────── */}
          <section>
            <div className="yz-compose__head">
              <h2>題庫</h2>
              <span className="yz-compose__count">
                {bank.length >= PAGE ? `顯示前 ${PAGE} 題，請用篩選縮小範圍` : `${bank.length} 題`}
              </span>
            </div>

            {/* 篩選走一般的 GET 表單而不是 client 端狀態：這樣篩完的
                網址可以貼給同事，而且重新整理不會掉。 */}
            <form className="yz-filters" method="get">
              {scope.length > 1 && (
                <div className="yz-field yz-filters__grow">
                  <label className="yz-label" htmlFor="f-sub">
                    科目
                  </label>
                  <select id="f-sub" name="sub" className="yz-in" defaultValue={sp.sub ?? ''}>
                    <option value="">{paper.subject.name}（全部）</option>
                    {scope.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="yz-field yz-filters__grow">
                <label className="yz-label" htmlFor="f-kp">
                  知識點
                </label>
                <select id="f-kp" name="kp" className="yz-in" defaultValue={sp.kp ?? ''}>
                  <option value="">不限</option>
                  {kps.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="yz-field yz-filters__grow">
                <label className="yz-label" htmlFor="f-q">
                  關鍵字
                </label>
                <input
                  id="f-q"
                  name="q"
                  className="yz-in"
                  defaultValue={sp.q ?? ''}
                  placeholder="題幹裡的字"
                />
              </div>
              <button type="submit" className="yz-btn">
                篩選
              </button>
            </form>

            {bank.length === 0 ? (
              <Empty
                title="沒有符合的題目"
                hint={
                  sp.q || sp.kp
                    ? '換個關鍵字或知識點試試。也可能是這些題目還在校對中——校對完成前不會出現在這裡。'
                    : '這一科還沒有校對完成的題目。先到匯入或題庫把題目校對完。'
                }
              />
            ) : (
              <ul className="yz-pick">
                {bank.map((q, i) => {
                  const at = inPaper.get(q.id);
                  return (
                    <li
                      key={q.id}
                      className={`yz-pick__row${at ? ' yz-pick__row--in' : ''}`}
                    >
                      <span className="yz-pick__no">{i + 1}</span>
                      <span>
                        {/* 挑題時看的就是題幹。兩題只差在指數或向量箭頭是
                            很常見的（同一組的變化題），而那個差別在原始碼
                            狀態下藏在一堆反斜線中間。 */}
                        <span className="yz-pick__text"><MathText>{q.content}</MathText></span>
                        <span className="yz-pick__meta">
                          {TYPE[q.type] ?? q.type}　配分 {q.score}
                          {q.difficulty != null && `　難度 ${q.difficulty.toFixed(2)}`}
                          {q.nationalCorrectRate != null &&
                            `　全國答對率 ${(q.nationalCorrectRate * 100).toFixed(0)}%`}
                          {q.sourceRef && `　${q.sourceRef}`}
                        </span>
                      </span>
                      <span className="yz-pick__act">
                        {at ? (
                          <span className="yz-pick__in">已在第 {at} 題</span>
                        ) : mayEdit ? (
                          <AddQuestion paperId={paper.id} questionId={q.id} />
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* ── 右：這份卷子 ─────────────────────────────────── */}
          <section className="yz-compose__right">
            <div className="yz-compose__head">
              <h2>這份卷子</h2>
              <span className="yz-compose__count">{items.length} 題</span>
            </div>

            <Composer
              paperId={paper.id}
              mayEdit={mayEdit}
              totalScore={paper.totalScore}
              items={items.map((i) => ({
                id: i.id,
                order: i.order,
                score: i.score,
                // 題幹在**這裡**排好再傳下去。Composer 是 client component，
                // 它自己匯入 MathText 的話，KaTeX 會整包跟著進瀏覽器
                // （約 90 kB），而這一欄的內容在瀏覽器端從來不會變。
                content: <MathText>{i.question.content}</MathText>,
                type: TYPE[i.question.type] ?? i.question.type,
              }))}
            />
          </section>
        </div>
      </main>
    );
  });
}
