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
import { attemptStranded } from '@/lib/attemptClock.mjs';
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
        // 「卡住了沒」要看它：一份沒設時限的作答，在任務截止而且不收
        // 遲交之後就再也不會有人來交它。判定與 `attemptStranded` 共用。
        allowLate: true,
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
    const shown = assignments.slice(0, PAGE);

    // 卡在「進行中」的份數。**首頁的待辦連到這一頁，而這張表以前
    // 沒有任何一欄說得出是哪一份**——一場 32 人的考試裡有 3 個人
    // 斷線，那一列的「交卷」顯示 29，跟正常的任務長得一模一樣。
    // 週一早上翻上週三個班的任務時，那等於逐份點開。
    //
    // 一次查完再分組，不是每一列各查一次：後者是一頁 60 次往返。
    const now = new Date();
    const openRows = shown.length
      ? await prisma.attempt.findMany({
          where: {
            assignmentId: { in: shown.map((a) => a.id) },
            status: 'IN_PROGRESS',
            // 不濾掉老師自己的試考。首頁的待辦沒有濾，濾了的話
            // 那個數字點過來會落在一張說「0」的表上。
          },
          select: { assignmentId: true, status: true, expiresAt: true },
        })
      : [];
    const strandedBy = new Map<string, number>();
    const clockOf = new Map(shown.map((a) => [a.id, { dueAt: a.dueAt, allowLate: a.allowLate }]));
    for (const r of openRows) {
      // 判定與成績內頁、首頁待辦共用同一支純函式。三份各寫一個 if 的話，
      // 最可能不一致的是邊界那一秒，而症狀是「首頁說有 3 份卡住，
      // 點進去每一份都說還在作答時間內」。
      if (!attemptStranded({ ...r, assignment: clockOf.get(r.assignmentId) }, now)) continue;
      strandedBy.set(r.assignmentId, (strandedBy.get(r.assignmentId) ?? 0) + 1);
    }

    const rows = shown.map((a) => {
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
        stranded: strandedBy.get(a.id) ?? 0,
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
    const strandedTotal = rows.reduce((n, r) => n + r.stranded, 0);

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

        {/* 首頁的待辦「N 份作答卡在進行中」連到這一頁。它以前落在
            一張沒有這個資訊的表上，所以老師要逐份點開才知道是哪一份。 */}
        {strandedTotal > 0 && (
          <Note tone="warn">
            有 {strandedTotal} 份作答卡在「進行中」——時間已經到了，但沒有人按下交卷
            （多半是斷線或關掉分頁）。在他們被收掉之前，成績列表上看不到這些人，
            班級統計也把他們當成缺考。下面的「卡住」那一欄標出是哪幾份。
          </Note>
        )}

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
              key: 'k',
              head: '卡住',
              numeric: true,
              cell: (r: Row) =>
                r.stranded ? (
                  // 連到任務內頁而不是成績頁：那一頁上有「代為結算」，
                  // 也有「延長時間」與「立刻結束」——現場要做的三件事
                  // 都在同一個地方。
                  <Link href={`/assignments/${r.id}`} className="yz-warn">
                    {r.stranded}
                  </Link>
                ) : (
                  ''
                ),
            },
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
