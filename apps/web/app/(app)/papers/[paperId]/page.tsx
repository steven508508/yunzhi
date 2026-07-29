import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Denied, Empty, Note } from '@/components/Feedback';
import { MathText } from '@/components/MathText';
import { canEditSubject } from '@/lib/auth';
import { slotList } from '@/lib/grading.mjs';
import { COMPOSABLE_QUESTION_STATUS, mayComposeArea, questionUsage } from '@/lib/paper';
import { alreadyPicked } from '@/lib/paperPlan.mjs';
import { scopedPage } from '@/lib/page';
import { prisma } from '@/lib/prisma';
import AddQuestion from './AddQuestion';
import Composer from './Composer';
import PaperTools from './PaperTools';

export const dynamic = 'force-dynamic';

/** 左欄一次列這麼多題。再多就該用篩選，而不是捲——但捲得到第 61 題。 */
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

/**
 * 難度區間。`difficulty` 的慣例是「1 = 最難」（見 lib/commit.ts：
 * 難度是 1 減去全國答對率），所以數字越大越難。
 *
 * 分三段而不是讓老師打數字：老師心裡的分類本來就是「送分題／中間／
 * 壓軸」，而 0.62 這個數字要對到哪一段，畫面上沒有任何地方說得出來。
 */
const DIFF: Record<string, { label: string; gte?: number; lt?: number }> = {
  easy: { label: '簡單（答對率高）', lt: 0.4 },
  mid: { label: '中等', gte: 0.4, lt: 0.7 },
  hard: { label: '困難（答對率低）', gte: 0.7 },
};

type SP = {
  q?: string;
  kp?: string;
  sub?: string;
  type?: string;
  diff?: string;
  p?: string;
};

/** 換一個參數，其餘保留。篩完的網址要能貼給同事，翻頁也不該掉篩選。 */
function withParam(sp: SP, patch: Partial<SP>): string {
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...sp, ...patch })) {
    if (v) next.set(k, String(v));
  }
  const s = next.toString();
  return s ? `?${s}` : '';
}

export default async function PaperPage({
  params,
  searchParams,
}: {
  params: Promise<{ paperId: string }>;
  searchParams: Promise<SP>;
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

    const band = sp.diff ? DIFF[sp.diff] : undefined;
    const where = {
      subjectId: { in: picked },
      status: { in: [...COMPOSABLE_QUESTION_STATUS] },
      // 關鍵字掃三個地方，不只題幹。「向量」只出現在選項裡、
      // 「110學測」只出現在出處裡——搜不到的時候老師不知道是
      // 「題庫裡沒有」還是「搜錯了」。數學式仍然搜不到（題幹存的是
      // `$\frac{x^2}{4}$` 這種原始碼），所以欄位的說明要講清楚。
      ...(sp.q
        ? {
            OR: [
              { content: { contains: sp.q, mode: 'insensitive' as const } },
              { sourceRef: { contains: sp.q, mode: 'insensitive' as const } },
              {
                options: {
                  some: { content: { contains: sp.q, mode: 'insensitive' as const } },
                },
              },
            ],
          }
        : {}),
      ...(sp.kp ? { knowledgePoints: { some: { knowledgePointId: sp.kp } } } : {}),
      ...(sp.type && TYPE[sp.type] ? { type: sp.type as never } : {}),
      ...(band
        ? {
            difficulty: {
              ...(band.gte !== undefined ? { gte: band.gte } : {}),
              ...(band.lt !== undefined ? { lt: band.lt } : {}),
            },
          }
        : {}),
    };

    const page = Math.max(1, Number(sp.p) || 1);

    const [items, bank, matched, kps] = await Promise.all([
      prisma.examPaperItem.findMany({
        where: { paperId },
        orderBy: { order: 'asc' },
        include: {
          question: {
            select: {
              id: true,
              familyId: true,
              content: true,
              type: true,
              score: true,
              subjectId: true,
              answerKeys: true,
              answerText: true,
              answerSlots: true,
              options: {
                orderBy: { order: 'asc' },
                select: { order: true, label: true, content: true },
              },
            },
          },
        },
      }),
      prisma.question.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE,
        take: PAGE,
        select: {
          id: true,
          familyId: true,
          content: true,
          type: true,
          score: true,
          difficulty: true,
          nationalCorrectRate: true,
          sourceRef: true,
          // 選項與答案是挑題時真正要看的東西。在此之前它們一個字都
          // 查不出來，而數學題最常見的情況正是「同一組的變化題只差
          // 一個負號」——那個差別在題幹的前兩行看不出來。
          answerKeys: true,
          answerText: true,
          answerSlots: true,
          options: {
            orderBy: { order: 'asc' },
            select: { order: true, label: true, content: true },
          },
        },
      }),
      // 符合條件的總數。安靜地截斷是最難查的一種錯：老師以為
      // 「三角函數只有 60 題」，而實際上有 80 題。
      prisma.question.count({ where }),
      prisma.knowledgePoint.findMany({
        where: { subjectId: { in: scopeIds } },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
    ]);

    // 「這一題上次段考用過沒有」。索引 `@@index([questionId])` 就是為了
    // 這個方向建的，而在此之前沒有任何一句查詢用得到它。
    const usage = await questionUsage(
      bank.map((q) => q.id),
      paperId,
    );

    const onPaper = items.map((i) => ({
      questionId: i.questionId,
      familyId: i.question.familyId,
      order: i.order,
    }));
    const pages = Math.max(1, Math.ceil(matched / PAGE));

    return (
      <main className="yz-panel" style={{ maxWidth: 1180 }}>
        <div className="yz-panel__head">
          <h1>{paper.title}</h1>
          <p className="yz-panel__sub">
            {paper.subject.name}　·　{items.length} 題　·　總分 {paper.totalScore}
            　·　<Link href={`/papers/${paper.id}/preview`}>整卷預覽與列印</Link>
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
            instructions={paper.instructions}
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
                符合 {matched} 題
                {pages > 1 && `　第 ${page} / ${pages} 頁`}
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
                <label className="yz-label" htmlFor="f-type">
                  題型
                </label>
                <select id="f-type" name="type" className="yz-in" defaultValue={sp.type ?? ''}>
                  <option value="">不限</option>
                  {Object.entries(TYPE).map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="yz-field yz-filters__grow">
                <label className="yz-label" htmlFor="f-diff">
                  難度
                </label>
                <select id="f-diff" name="diff" className="yz-in" defaultValue={sp.diff ?? ''}>
                  <option value="">不限</option>
                  {Object.entries(DIFF).map(([v, d]) => (
                    <option key={v} value={v}>
                      {d.label}
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
                  placeholder="題幹、選項或出處裡的中文字"
                />
              </div>
              <button type="submit" className="yz-btn">
                篩選
              </button>
            </form>
            {sp.q && (
              <p className="yz-hint">
                關鍵字比對的是題目原始碼裡的字。
                <strong>數學式搜不到</strong>——題幹裡存的是{' '}
                <code>$\frac{'{x^2}'}{'{4}'}$</code> 這種原始碼，不是你看到的式子。
              </p>
            )}

            {bank.length === 0 ? (
              <Empty
                title="沒有符合的題目"
                hint={
                  matched > 0
                    ? '這一頁沒有題目了，請回到前一頁。'
                    : sp.q || sp.kp || sp.type || sp.diff
                      ? '放寬一個篩選條件試試。也可能是這些題目還在校對中——校對完成前不會出現在這裡。'
                      : '這一科還沒有校對完成的題目。先到匯入或題庫把題目校對完。'
                }
              />
            ) : (
              <ul className="yz-pick">
                {bank.map((q, i) => {
                  const dup = alreadyPicked(onPaper, {
                    questionId: q.id,
                    familyId: q.familyId,
                  });
                  const used = usage.get(q.id);
                  return (
                    <li
                      key={q.id}
                      className={`yz-pick__row${dup ? ' yz-pick__row--in' : ''}`}
                    >
                      <span className="yz-pick__no">{(page - 1) * PAGE + i + 1}</span>
                      <details className="yz-pick__q">
                        <summary className="yz-pick__sum">
                          {/* 挑題時看的就是題幹。兩題只差在指數或向量箭頭是
                              很常見的（同一組的變化題），而那個差別在原始碼
                              狀態下藏在一堆反斜線中間。 */}
                          <span className="yz-pick__text">
                            <MathText>{q.content}</MathText>
                          </span>
                          <span className="yz-pick__meta">
                            {TYPE[q.type] ?? q.type}　配分 {q.score}
                            {q.difficulty != null && `　難度 ${q.difficulty.toFixed(2)}`}
                            {q.nationalCorrectRate != null &&
                              `　全國答對率 ${(q.nationalCorrectRate * 100).toFixed(0)}%`}
                            {q.sourceRef && `　${q.sourceRef}`}
                            {used && (
                              <span className="yz-pick__used">
                                　用過 {used.count} 次（
                                {used.papers.map((p) => p.title).join('、')}
                                {used.more > 0 && ` 等 ${used.count} 份`}）
                              </span>
                            )}
                          </span>
                          {/* 展開的提示。文字在 CSS 裡，因為它要隨著
                              [open] 換成「收起」，而那件事在伺服器元件上
                              做不到——這一頁沒有 client 端狀態。 */}
                          <span className="yz-pick__toggle" />
                        </summary>
                        <div className="yz-pick__full">
                          <Detail q={q} />
                        </div>
                      </details>
                      <span className="yz-pick__act">
                        {dup ? (
                          <span className="yz-pick__in">
                            已在第 {dup.order} 題
                            {dup.kind === 'version' && '（另一版本）'}
                          </span>
                        ) : mayEdit ? (
                          <AddQuestion paperId={paper.id} questionId={q.id} />
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}

            {pages > 1 && (
              <p className="yz-pager">
                {page > 1 ? (
                  <Link href={withParam(sp, { p: String(page - 1) })}>上一頁</Link>
                ) : (
                  <span className="yz-muted">上一頁</span>
                )}
                <span className="yz-pager__at">
                  第 {page} / {pages} 頁　共 {matched} 題
                </span>
                {page < pages ? (
                  <Link href={withParam(sp, { p: String(page + 1) })}>下一頁</Link>
                ) : (
                  <span className="yz-muted">下一頁</span>
                )}
              </p>
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
                detail: <Detail q={i.question} />,
                type: TYPE[i.question.type] ?? i.question.type,
              }))}
            />
          </section>
        </div>
      </main>
    );
  });
}

/**
 * 展開之後的一整題：完整題幹、選項、標準答案。
 *
 * **這是老師的畫面，不是學生的**，所以答案直接畫出來——挑題時最重要的
 * 判斷是「這一題的答案是不是我要考的那個觀念」，而在此之前這個系統裡
 * 沒有任何一個畫面看得到入庫後的答案。
 */
function Detail({
  q,
}: {
  q: {
    content: string;
    type: string;
    answerKeys: number[];
    answerText: string | null;
    answerSlots: unknown;
    options: { order: number; label: string; content: string }[];
  };
}) {
  const keys = new Set(q.answerKeys);
  const slots = q.type === 'FILL_SLOT' ? slotList(q.answerSlots).filter(Boolean) : [];

  return (
    <>
      <MathText>{q.content}</MathText>
      {q.options.length > 0 && (
        <ol>
          {q.options.map((o) => (
            <li key={o.order}>
              <span className="yz-pick__key">{o.label}</span>
              <MathText>{o.content}</MathText>
              {keys.has(o.order) && <span className="yz-pick__key">←　答案</span>}
            </li>
          ))}
        </ol>
      )}
      <p className="yz-pick__ans">
        標準答案：
        <strong>
          {q.options.length > 0 && keys.size > 0
            ? q.options
                .filter((o) => keys.has(o.order))
                .map((o) => o.label)
                .join('　')
            : slots.length > 0
              ? slots.join('　')
              : (q.answerText?.trim() ?? '') || '（沒有標準答案，要人工評閱）'}
        </strong>
      </p>
    </>
  );
}
