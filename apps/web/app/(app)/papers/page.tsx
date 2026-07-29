import Link from 'next/link';

import { Denied, Empty, Note } from '@/components/Feedback';
import { Table } from '@/components/Table';
import { mayComposeArea } from '@/lib/paper';
import { scopedPage } from '@/lib/page';
import { prisma } from '@/lib/prisma';
import NewPaper from './NewPaper';

export const dynamic = 'force-dynamic';

/** 一頁列幾份。翻得到下一頁，所以不必列到 200。 */
const PAGE = 40;

// 不 export：Next 15 為每個 page 產生的型別驗證檔不允許頁面
// 匯出 default 與少數保留名稱以外的東西，而症狀是 `next build`
// 在型別檢查階段停住。
const STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  READY: '可派發',
  ARCHIVED: '已封存',
};

type SP = { q?: string; st?: string; p?: string };

function withParam(sp: SP, patch: Partial<SP>): string {
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...sp, ...patch })) {
    if (v) next.set(k, String(v));
  }
  const s = next.toString();
  return s ? `?${s}` : '';
}

export default async function PapersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;

  return scopedPage(async (user) => {
    // 學生不該看到卷子——那是還沒考的題目。導覽列不畫這個連結，
    // 但**把連結藏起來不等於擋住**：直接改網址就進來了。
    if (!mayComposeArea(user.systemRole, '/papers')) {
      return (
        <main className="yz-panel">
          <Denied what="試卷" why="卷子上的題目是還沒考的，只有老師與管理員看得到。" />
        </main>
      );
    }

    const page = Math.max(1, Number(sp.p) || 1);
    const where = {
      // 卷名與科目名兩邊都搜。老師記得的常常是「數學那份模擬」，
      // 而不是卷名的前幾個字。
      ...(sp.q
        ? {
            OR: [
              { title: { contains: sp.q, mode: 'insensitive' as const } },
              { subject: { name: { contains: sp.q, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
      ...(sp.st && STATUS_LABEL[sp.st] ? { status: sp.st as never } : {}),
    };

    const [papers, matched, subjects] = await Promise.all([
      prisma.examPaper.findMany({
        where,
        orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
        skip: (page - 1) * PAGE,
        take: PAGE,
        include: {
          subject: { select: { name: true } },
          _count: { select: { items: true, assignments: true } },
        },
      }),
      // 總數要說出來。安靜地截斷，老師會以為某一份卷子被誰刪掉了，
      // 然後重新組一份一模一樣的。
      prisma.examPaper.count({ where }),
      prisma.subject.findMany({ where: { active: true }, orderBy: { order: 'asc' } }),
    ]);
    type Row = (typeof papers)[number];
    const pages = Math.max(1, Math.ceil(matched / PAGE));

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>試卷</h1>
          <p className="yz-panel__sub">
            一份試卷是從題庫挑出來的一組題目與各題的配分。編好之後標記為
            「可派發」，才派得出去——草稿派出去，學生會打開一份還在編輯中的卷子。
          </p>
        </div>

        {subjects.length > 0 ? (
          <NewPaper subjects={subjects.map((s) => ({ id: s.id, name: s.name }))} />
        ) : (
          <Note tone="warn">還沒有任何科目，所以建不了卷子。請先請管理員建立科目。</Note>
        )}

        {/* 搜尋走 GET 表單，理由與組卷頁一樣：篩完的網址貼得給同事，
            而且重新整理不會掉。 */}
        <form className="yz-filters" method="get">
          <div className="yz-field yz-filters__grow">
            <label className="yz-label" htmlFor="f-q">
              卷名或科目
            </label>
            <input
              id="f-q"
              name="q"
              className="yz-in"
              defaultValue={sp.q ?? ''}
              placeholder="例如「第一次段考」或「數學」"
            />
          </div>
          <div className="yz-field yz-filters__grow">
            <label className="yz-label" htmlFor="f-st">
              狀態
            </label>
            <select id="f-st" name="st" className="yz-in" defaultValue={sp.st ?? ''}>
              <option value="">不限</option>
              {Object.entries(STATUS_LABEL).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="yz-btn">
            搜尋
          </button>
        </form>

        <Table
          caption="試卷一覽"
          columns={[
            {
              key: 't',
              head: '卷名',
              cell: (p: Row) => <Link href={`/papers/${p.id}`}>{p.title}</Link>,
            },
            { key: 's', head: '科目', cell: (p: Row) => p.subject.name },
            {
              key: 'st',
              head: '狀態',
              cell: (p: Row) =>
                p.status === 'READY' ? (
                  STATUS_LABEL[p.status]
                ) : (
                  // 草稿與封存都用側註的灰，不用色塊——一整欄的彩色
                  // 藥丸會把「狀態」這一欄變成畫面上最重的東西。
                  <span className="yz-muted">{STATUS_LABEL[p.status] ?? p.status}</span>
                ),
            },
            { key: 'n', head: '題數', numeric: true, cell: (p: Row) => p._count.items },
            { key: 'sc', head: '總分', numeric: true, cell: (p: Row) => p.totalScore },
            {
              key: 'a',
              head: '已派任務',
              numeric: true,
              cell: (p: Row) => p._count.assignments || <span className="yz-muted">—</span>,
            },
            {
              key: 'v',
              head: '',
              cell: (p: Row) => <Link href={`/papers/${p.id}/preview`}>預覽／列印</Link>,
            },
          ]}
          rows={papers}
          rowKey={(p) => p.id}
          empty={
            <Empty
              title={sp.q || sp.st ? '沒有符合的試卷' : '還沒有任何試卷'}
              hint={
                sp.q || sp.st
                  ? '換個關鍵字，或把狀態改成「不限」。已封存的卷子預設也會列出來。'
                  : '建一份卷子，然後從題庫挑題。挑完標記為可派發，就可以派給班級了。'
              }
            />
          }
        />

        {pages > 1 && (
          <p className="yz-pager">
            {page > 1 ? (
              <Link href={withParam(sp, { p: String(page - 1) })}>上一頁</Link>
            ) : (
              <span className="yz-muted">上一頁</span>
            )}
            <span className="yz-pager__at">
              第 {page} / {pages} 頁　共 {matched} 份
            </span>
            {page < pages ? (
              <Link href={withParam(sp, { p: String(page + 1) })}>下一頁</Link>
            ) : (
              <span className="yz-muted">下一頁</span>
            )}
          </p>
        )}
      </main>
    );
  });
}
