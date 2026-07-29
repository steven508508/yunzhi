import Link from 'next/link';
import { Denied } from '@/components/Feedback';
import { MathText } from '@/components/MathText';
import { Pager } from '@/components/Pager';
import { PAGE_SIZE, keepQuery, pageQuery, pageSlice } from '@/lib/listing.mjs';
import { mayUse } from '@/lib/nav';
import { scopedPage } from '@/lib/page';
import { prisma } from '@/lib/prisma';
import { readAward } from '@/lib/questionEdit.mjs';

export const dynamic = 'force-dynamic';

/**
 * 題庫列表。
 *
 * # 為什麼要有狀態這一欄與「已下架」這個篩選
 *
 * 原本這一頁只列 `PUBLISHED` 與 `PENDING_REVIEW`。有了下架功能之後，
 * 那等於**下架是一條單行道**——按下去題目就從這一頁消失，連同把它
 * 救回來的按鈕。老師會以為題目被刪掉了。
 *
 * 所以：預設仍然只看得到還能用的那些（那是他每天要挑題的清單），
 * 但「已下架」在篩選列上，而且數量看得見。
 */
const USABLE = ['PUBLISHED', 'PENDING_REVIEW', 'DRAFT'] as const;

export default async function BankPage({
  searchParams,
}: {
  searchParams: Promise<{ subject?: string; q?: string; status?: string; page?: string }>;
}) {
  const sp = await searchParams;
  return scopedPage(async (user) => {

  // 導覽列不畫這個連結給學生，但**把連結藏起來不等於擋住**——
  // 學生把網址列改成 /bank 就會看到整個題庫。同一份規則要在兩邊生效。
  if (!mayUse(user.systemRole, '/bank')) {
    return (
      <main className="yz-panel">
        <Denied what="題庫" why="題庫是老師的工作區，學生看到的會是自己的任務與成績。" />
      </main>
    );
  }

  const subjects = await prisma.subject.findMany({
    where: { tenantId: user.tenantId, active: true },
    orderBy: { order: 'asc' },
  });

  const retiredOnly = sp.status === 'RETIRED';

  /**
   * 分頁。
   *
   * 舊版固定 `take: 100` 而且沒有分頁——**超過 100 題之後，
   * 舊的題目在這一頁上就不存在了**。而題庫是只增不減的：一學期匯
   * 十份題本就是四百題，於是第一份題本裡的題目再也點不到，
   * 而題庫頁是老師挑題組卷的唯一入口。
   *
   * 搜尋與科目篩選以前就有，它們擋得住一部分——但「我知道有這一題、
   * 只是想不起關鍵字」的情況擋不住，而那是最常見的一種。
   */
  const window = pageQuery(sp.page, PAGE_SIZE);

  const [found, retiredCount] = await Promise.all([
    prisma.question.findMany({
      where: {
        tenantId: user.tenantId,
        status: retiredOnly ? { in: ['RETIRED'] } : { in: [...USABLE] },
        ...(sp.subject ? { subjectId: sp.subject } : {}),
        ...(sp.q ? { content: { contains: sp.q, mode: 'insensitive' as const } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      skip: window.skip,
      // 多取一筆，只為了知道「後面還有沒有」。
      take: window.take,
      include: {
        subject: { select: { name: true } },
        options: { select: { id: true }, take: 1 },
      },
    }),
    prisma.question.count({
      where: {
        tenantId: user.tenantId,
        status: 'RETIRED',
        ...(sp.subject ? { subjectId: sp.subject } : {}),
      },
    }),
  ]);

  const paged = pageSlice(found, sp.page, PAGE_SIZE);
  const questions = paged.rows;

  // 換科目、切「已下架」、改搜尋字都要**把頁碼歸零**。不歸零的話，
  // 停在第 5 頁換一個只有 30 題的科目會得到一片空白，
  // 而使用者看到的是「這一科沒有題目」。
  const keep = (extra: Record<string, string | undefined>) =>
    keepQuery(
      '/bank',
      { subject: sp.subject, q: sp.q, status: sp.status },
      { page: undefined, ...extra },
    );

  return (
    <div className="yz-app">
      {/* 跨區的連結與登出移到共用導覽列（components/Nav.tsx）。
          原本那個登出是 <form> 直接送到 API，成功後畫面會停在
          `{"ok":true}` 這行 JSON 上——cookie 清掉了，但使用者看到的
          是一頁亂碼。 */}
      <header className="yz-head">
        <span className="yz-head__title">題庫</span>
        <span className="yz-head__sub">
          {paged.from > 0 ? `第 ${paged.from}–${paged.to} 題` : '0 題'}
        </span>
      </header>

      <div style={{ padding: '9px 22px', borderBottom: '1px solid var(--rule)', display: 'flex', gap: 14, fontSize: 12 }}>
        <Link href={keep({ subject: undefined })} style={{ fontWeight: sp.subject ? 400 : 600 }}>全部</Link>
        {subjects.map((s) => (
          <Link key={s.id} href={keep({ subject: s.id })} style={{ fontWeight: sp.subject === s.id ? 600 : 400 }}>
            {s.name}
          </Link>
        ))}
        <span style={{ color: 'var(--rule)' }}>|</span>
        {/* 下架的題目要找得回來，否則「下架」就是刪除。 */}
        <Link href={keep({ status: retiredOnly ? undefined : 'RETIRED' })}
              style={{ fontWeight: retiredOnly ? 600 : 400, color: retiredOnly ? undefined : 'var(--ink-2)' }}>
          已下架{retiredCount > 0 ? `（${retiredCount}）` : ''}
        </Link>
        <form style={{ marginLeft: 'auto' }}>
          {sp.subject && <input type="hidden" name="subject" value={sp.subject} />}
          {sp.status && <input type="hidden" name="status" value={sp.status} />}
          <input name="q" defaultValue={sp.q ?? ''} placeholder="搜尋題幹"
                 style={{ padding: '3px 8px', border: '1px solid var(--rule)', borderRadius: 'var(--r-sm)',
                          background: 'var(--paper-raised)', fontSize: 12, width: 200 }} />
        </form>
      </div>

      <main className="yz-col" style={{ flex: 1 }}>
        <div className="yz-colbody">
          {questions.length === 0 ? (
            <p style={{ color: 'var(--ink-2)' }}>
              {retiredOnly
                ? '沒有下架的題目。'
                : sp.q
                  ? `找不到含「${sp.q}」的題目。`
                  : paged.page > 1
                    ? '這一頁沒有題目了——大概是有人在你翻頁的時候下架了幾題。回第一頁看看。'
                    : '題庫是空的。先匯入一份題本。'}
            </p>
          ) : (
            <table className="yz-table">
              <thead>
                <tr>
                  <th>題幹</th><th>科目</th><th>題型</th><th>狀態</th>
                  <th className="yz-table__num">配分</th>
                  <th className="yz-table__num">難度</th>
                  <th className="yz-table__num">作答</th>
                  <th className="yz-table__num">答對率</th>
                  <th>來源</th>
                </tr>
              </thead>
              <tbody>
                {questions.map((q) => (
                  <tr key={q.id}>
                    <td style={{ maxWidth: 460, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {/* 這一欄是掃視用的，一列只有一行。排出來的式子在這裡
                          仍然比原始碼好認——`$\ce{H2SO4}$` 佔掉的寬度是
                          「H₂SO₄」的五倍，題幹會被它擠到看不見。

                          整段是連結：在這一頁之前題庫沒有內頁，題目進來
                          就改不動了。點進去才改得到標準答案。 */}
                      <Link href={`/bank/${q.id}`}>
                        <MathText>{q.content}</MathText>
                      </Link>
                    </td>
                    <td style={{ color: 'var(--ink-2)' }}>{q.subject.name}</td>
                    <td style={{ color: 'var(--ink-2)' }}>{TYPE[q.type] ?? q.type}</td>
                    <td style={{ color: 'var(--ink-2)' }}>
                      {STATUS[q.status] ?? q.status}
                      {/* 送過分的題目在列表上就要看得出來：它在每一份卷子上
                          都是滿分，而畫面上其他地方完全看不出原因。 */}
                      {readAward(q.scoringRule) && <span className="yz-warn">　已送分</span>}
                    </td>
                    <td className="yz-table__num">{q.score}</td>
                    <td className="yz-table__num">{q.difficulty?.toFixed(2) ?? '—'}</td>
                    <td className="yz-table__num">{q.responseCount || '—'}</td>
                    <td className="yz-table__num">
                      {q.correctRate != null ? `${(q.correctRate * 100).toFixed(0)}%` : '—'}
                    </td>
                    <td style={{ color: 'var(--ink-3)', fontSize: 11.5 }}>{q.sourceRef ?? SRC[q.sourceType]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <Pager
            page={paged.page}
            hasPrev={paged.hasPrev}
            hasNext={paged.hasNext}
            from={paged.from}
            to={paged.to}
            unit="題"
            hrefFor={(n) =>
              keepQuery(
                '/bank',
                { subject: sp.subject, q: sp.q, status: sp.status },
                { page: n === 1 ? undefined : String(n) },
              )
            }
          />
        </div>
      </main>
    </div>
  );
  });
}

const TYPE: Record<string, string> = {
  SINGLE_CHOICE: '單選', MULTI_CHOICE: '多選', FILL_SLOT: '選填',
  FILL_TEXT: '填空', SHORT_ANSWER: '簡答', ESSAY: '作文', TRANSLATION: '翻譯', TRUE_FALSE: '是非',
};
const STATUS: Record<string, string> = {
  DRAFT: '未校對', PENDING_REVIEW: '待發布', PUBLISHED: '已發布', RETIRED: '已下架',
};
const SRC: Record<string, string> = {
  OFFICIAL_PAST: '歷屆試題', TEACHER_ORIGINAL: '老師自編', SCHOOL_EXAM: '校內考卷',
  PUBLISHER_SCAN: '出版社題本', AI_GENERATED: 'AI 生成',
};
