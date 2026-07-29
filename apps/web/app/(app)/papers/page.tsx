import Link from 'next/link';

import { Denied, Empty, Note } from '@/components/Feedback';
import { Table } from '@/components/Table';
import { mayComposeArea } from '@/lib/paper';
import { scopedPage } from '@/lib/page';
import { prisma } from '@/lib/prisma';
import NewPaper from './NewPaper';

export const dynamic = 'force-dynamic';

/** 一頁最多列幾份。超過時要說出來，見下面的 `truncated`。 */
const PAGE = 200;

// 不 export：Next 15 為每個 page 產生的型別驗證檔不允許頁面
// 匯出 default 與少數保留名稱以外的東西，而症狀是 `next build`
// 在型別檢查階段停住。
const STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  READY: '可派發',
  ARCHIVED: '已封存',
};

export default async function PapersPage() {
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

    const [found, subjects] = await Promise.all([
      prisma.examPaper.findMany({
        orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
        // 多取一筆，只為了知道「後面還有沒有」。安靜地截斷，老師會
        // 以為某一份卷子被誰刪掉了，然後重新組一份一模一樣的。
        take: PAGE + 1,
        include: {
          subject: { select: { name: true } },
          _count: { select: { items: true, assignments: true } },
        },
      }),
      prisma.subject.findMany({ where: { active: true }, orderBy: { order: 'asc' } }),
    ]);
    const truncated = found.length > PAGE;
    const papers = found.slice(0, PAGE);
    type Row = (typeof papers)[number];

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

        {truncated && (
          <Note tone="warn">
            只列出最近異動的 {PAGE} 份試卷，還有更早的沒有顯示。
            不再使用的卷子請封存，列表會乾淨很多。
          </Note>
        )}

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
          ]}
          rows={papers}
          rowKey={(p) => p.id}
          empty={
            <Empty
              title="還沒有任何試卷"
              hint="建一份卷子，然後從題庫挑題。挑完標記為可派發，就可以派給班級了。"
            />
          }
        />
      </main>
    );
  });
}
