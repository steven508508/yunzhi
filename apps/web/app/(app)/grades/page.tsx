/**
 * 成績的入口：哪幾份任務有卷子要看。
 *
 * 這一頁回答老師開電腦後的第一個問題——「哪一份還沒改完」。
 * 所以列表上最重要的兩欄不是平均分，是**還沒計分的份數**與
 * **需人工確認的題數**：那兩個數字大於 0 代表有事情要做。
 */
import Link from 'next/link';

import { Denied, Empty, Note } from '@/components/Feedback';
import { Table } from '@/components/Table';
import { mayUse } from '@/lib/nav';
import { prisma } from '@/lib/prisma';
import { scopedPage } from '@/lib/page';
import { releaseControl } from '@/lib/release.mjs';
import { gradeScopeWhere } from '@/lib/scoring';

export const dynamic = 'force-dynamic';

/** 一頁最多列幾份。超過時要說出來，見下面的 `truncated`。 */
const PAGE = 60;

/**
 * 截止日。**一定要指定台北時區**：資料庫存的是 UTC，而伺服器多半
 * 跑在 UTC。不指定的話 8/2 00:30（台北）會被印成 8/1——只差一天，
 * 而老師看到的是一個看起來完全正常的日期。
 */
function dueDay(d: Date): string {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).format(d);
}

export default async function GradesPage() {
  return scopedPage(async (user) => {
    if (!mayUse(user.systemRole, '/grades')) {
      return (
        <main className="yz-panel">
          <Denied
            what="成績總覽"
            why="這一頁是全班的成績與各題答對率，屬於老師的工作區。學生看的是自己的成績。"
          />
        </main>
      );
    }

    // 老師只看得到自己教的科目與自己派出去的任務；學科召集人與
    // 管理員看得到全部。少了這一段，數學老師會看到國文班每一位
    // 學生的分數。規則的正本在 lib/scoring.ts——內頁用的是同一份
    // （`mayViewGrades`），兩邊分開寫就是分開錯。
    const where = await gradeScopeWhere(user);
    const scoped = Object.keys(where).length > 0;

    const assignments = await prisma.assignment.findMany({
      where,
      orderBy: [{ dueAt: 'desc' }, { createdAt: 'desc' }],
      // 多取一筆，只為了知道「後面還有沒有」。老師最怕的不是分頁，
      // 是以為自己看到的就是全部。
      take: PAGE + 1,
      select: {
        id: true,
        title: true,
        mode: true,
        dueAt: true,
        // 放行狀態。列表上要看得到，否則老師得一份一份點進去才知道
        // 哪幾份的學生還看不到成績——而那正是不會有人回報的那種事。
        releasePolicy: true,
        releasedAt: true,
        paper: { select: { title: true, subject: { select: { name: true } } } },
        attempts: {
          where: { status: { in: ['SUBMITTED', 'GRADED'] } },
          select: { id: true, totalScore: true, status: true },
        },
      },
    });

    const truncated = assignments.length > PAGE;
    const rows = assignments.slice(0, PAGE).map((a) => {
      const scored = a.attempts.filter((t) => t.totalScore !== null);
      const mean = scored.length
        ? Math.round(
            (scored.reduce((s, t) => s + (t.totalScore as number), 0) / scored.length) * 10,
          ) / 10
        : null;
      const release = releaseControl(a);
      return {
        id: a.id,
        title: a.title,
        paperTitle: a.paper.title,
        subject: a.paper.subject.name,
        mode: a.mode as string,
        dueAt: a.dueAt,
        submitted: a.attempts.length,
        ungraded: a.attempts.filter((t) => t.totalScore === null).length,
        mean,
        // 只有手動放行的任務才有「放行了沒」可言。其餘政策的開放時機
        // 由設定決定，硬要在這一欄寫個東西反而會讓老師以為那幾份也
        // 需要他按什麼。
        needsRelease: release.applicable && !release.released,
        released: release.applicable && release.released,
      };
    });
    type Row = (typeof rows)[number];
    const awaitingRelease = rows.filter((r) => r.needsRelease && r.submitted > 0).length;

    // 「這位老師一科都沒被指定」與「有科目但還沒有人交卷」在畫面上
    // 都是一張空表，但要做的事完全不同：前者要找管理員，後者要等
    // 學生作答。空狀態要說得出是哪一種——老師看到空白會打電話。
    // 只在真的空的時候才查，正常路徑上不多一次往返。
    const teachesNothing =
      scoped &&
      rows.length === 0 &&
      (await prisma.classSubjectTeacher.count({ where: { userId: user.id } })) === 0;

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>成績</h1>
          <p className="yz-panel__sub">
            交卷後客觀題會自動計分。老師改了標準答案或決定送分之後，
            進到任務裡按「全班重新計分」——重算只動分數，學生原本
            選了什麼不會被改掉。
          </p>
        </div>

        {awaitingRelease > 0 && (
          <Note tone="warn">
            有 {awaitingRelease} 份設定為「老師手動放行」而且已經有人交卷，但還沒放行——
            那幾份的學生看不到自己的分數，也看不到逐題檢討。點進去按「放行成績與檢討」。
          </Note>
        )}

        {truncated && (
          <Note tone="warn">
            只列出最近 {PAGE} 份任務，還有更早的沒有顯示。要找更早的成績，
            請從「派卷」進到那一份任務。
          </Note>
        )}

        <Table
          caption="有作答記錄的任務"
          columns={[
            {
              key: 't',
              head: '任務',
              cell: (r: Row) => (
                <>
                  <Link href={`/grades/${r.id}`}>{r.title}</Link>
                  <span className="yz-grade__sub">{r.paperTitle}</span>
                </>
              ),
            },
            { key: 's', head: '科目', cell: (r: Row) => r.subject },
            {
              key: 'm',
              head: '型態',
              cell: (r: Row) => (r.mode === 'EXAM' ? '測驗' : '練習'),
            },
            { key: 'n', head: '交卷', numeric: true, cell: (r: Row) => r.submitted },
            {
              key: 'u',
              head: '未計分',
              numeric: true,
              cell: (r: Row) =>
                r.ungraded ? <span className="yz-warn">{r.ungraded}</span> : '',
            },
            {
              key: 'a',
              head: '平均',
              numeric: true,
              cell: (r: Row) => (r.mean === null ? <span className="yz-muted">—</span> : r.mean),
            },
            {
              key: 'd',
              head: '截止',
              cell: (r: Row) =>
                r.dueAt ? dueDay(r.dueAt) : <span className="yz-muted">未設</span>,
            },
            {
              key: 'r',
              head: '放行',
              cell: (r: Row) =>
                r.needsRelease ? (
                  <span className="yz-warn">待放行</span>
                ) : r.released ? (
                  '已放行'
                ) : (
                  // 非手動放行的任務在這一欄留白，不寫「自動」之類的字。
                  // 這一欄問的是「你要不要做一件事」，而它們的答案是不用。
                  <span className="yz-muted">—</span>
                ),
            },
          ]}
          rows={rows}
          rowKey={(r) => r.id}
          empty={
            teachesNothing ? (
              <Empty
                title="你還沒有被指定任何授課科目"
                hint="成績只看得到自己教的科目與自己派出去的任務。請管理員把你加進班級的授課老師名單，這一頁就會有東西。"
              />
            ) : (
              <Empty
                title="還沒有任何作答記錄"
                hint="要先組一份卷子、派給班級，學生交卷之後這裡才會有東西。"
                action={<Link href="/papers">去組卷</Link>}
              />
            )
          }
        />
      </main>
    );
  });
}
