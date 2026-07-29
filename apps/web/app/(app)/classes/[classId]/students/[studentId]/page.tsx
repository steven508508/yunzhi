/**
 * 一位學生這學期的表現。
 *
 * # 為什麼這一頁非有不可
 *
 * 家長明天來約談，要拿出這孩子這學期的狀況：考了幾次、分數走勢、
 * 哪一科在退步。在此之前**全系統沒有任何一頁是以學生為單位的**——
 * 導覽列九項裡沒有「學生」，路由樹裡沒有 `students/[id]`，
 * 而三個列出學生姓名的地方（班級名冊、成績表、派卷的個別指定）
 * 姓名都是純文字，不是連結。
 *
 * 所以要回答家長的問題，唯一的辦法是開 `/grades`、一份一份點進去、
 * 每一份用 Ctrl+F 找這孩子的名字、把分數抄到紙上——而 `/grades`
 * 只列得出最近幾十份，第一個月的考試已經點不到了。
 * 一學期發生二十次以上。
 *
 * # 它同時是「移出班級之後檢討入口消失」的補救
 *
 * 學生的任務清單只認在籍的班，所以轉班或退補的那一秒，原班考過的
 * 每一份就從他的畫面上消失了。資料還在（作答結果那個網址還打得開），
 * 但沒有任何一頁會給他那個網址。這一頁給的就是那些網址——
 * 老師拿得到，就給得出去。
 *
 * # 這一版做得到什麼、做不到什麼
 *
 * 做得到：每一份的日期、任務、科目、分數、班級平均、遲交與否，
 * 以及依科目分開的平均。這些全部是現成的資料，一次 group by。
 *
 * **做不到「哪些單元一直錯」**，而且要在畫面上誠實說。那需要同時
 * join `attempt_answers` 與 `question_knowledge_points`，
 * 而全 repo 沒有任何一處這樣查——知識點的標註本身還沒有資料。
 * 不寫出來的話，看的人會以為是這個學生沒有錯題。
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { isHomeroomOf } from '@/lib/auth';
import { mayUse } from '@/lib/nav';
import { prisma } from '@/lib/prisma';
import { scopedPage } from '@/lib/page';
import { teachesClass } from '@/lib/teaching';
import { Denied, Empty, Note } from '@/components/Feedback';
import { Table } from '@/components/Table';

export const dynamic = 'force-dynamic';

const ADMIN = new Set(['SYS_ADMIN', 'SCHOOL_ADMIN']);

/**
 * **一定要指定台北時區。** 資料庫存 UTC、伺服器多半跑 UTC，
 * 不指定的話 8/2 00:30（台北）會被印成 8/1——只差一天，
 * 而家長看到的是一個看起來完全正常的日期。
 */
function day(d: Date | null): string {
  if (!d) return '—';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).format(d);
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export default async function StudentPage({
  params,
}: {
  params: Promise<{ classId: string; studentId: string }>;
}) {
  const { classId, studentId } = await params;
  return scopedPage(async (user) => {
    if (!mayUse(user.systemRole, '/classes')) {
      return (
        <main className="yz-panel">
          <Denied
            what="學生的成績紀錄"
            why="這一頁是一位學生的完整成績歷程，屬於老師與管理員的工作區。學生看的是自己的任務與成績。"
          />
        </main>
      );
    }

    const klass = await prisma.class.findFirst({
      where: { id: classId },
      select: { id: true, name: true, academicYear: { select: { name: true } } },
    });
    if (!klass) notFound();

    // 存取判定與班級頁完全相同：名冊成員、這個班的授課老師，或管理員。
    // 兩處各寫一套的話，最可能分岐的方向是這一頁比較寬——
    // 而它列的是一位學生的完整成績歷程。
    const isAdmin = ADMIN.has(user.systemRole);
    const [membership, teaching] = await Promise.all([
      prisma.classMembership.findFirst({
        where: { classId, userId: user.id, leftAt: null },
        select: { id: true },
      }),
      teachesClass(user.id, classId),
    ]);
    if (!isAdmin && !membership && !teaching) {
      return (
        <main className="yz-panel">
          <Denied
            what={`「${klass.name}」的學生紀錄`}
            why="你不在這個班的名冊裡，也沒有被指派教這個班。"
          />
        </main>
      );
    }

    // 這位學生要真的與這個班有關係（含已經移出的）。少了這一道，
    // 一個帶班的老師把網址上的 id 換掉就看得到全補習班任何一位學生的
    // 成績歷程——而那不是他該拿到的東西。
    const link = await prisma.classMembership.findFirst({
      where: { classId, userId: studentId, role: 'STUDENT' },
      select: { joinedAt: true, leftAt: true },
    });
    if (!link) notFound();

    const student = await prisma.user.findFirst({
      where: { id: studentId, systemRole: 'STUDENT' },
      select: {
        id: true,
        username: true,
        displayName: true,
        status: true,
        consentAt: true,
        guardianEmail: true,
        deletedAt: true,
      },
    });
    if (!student) notFound();

    // 他所有交過卷的作答，不限這個班——家長問的是「這學期的狀況」，
    // 而一位轉過班的學生的成績分散在兩個班的任務上。
    const attempts = await prisma.attempt.findMany({
      where: { userId: studentId, status: { in: ['SUBMITTED', 'GRADED'] } },
      orderBy: [{ submittedAt: 'desc' }],
      // 三年份的紀錄不該一次全撈。約談要看的是最近這一段，
      // 而超過的部分在畫面上說出來比安靜地截斷好。
      take: 201,
      select: {
        id: true,
        assignmentId: true,
        totalScore: true,
        late: true,
        submittedAt: true,
        assignment: {
          select: {
            id: true,
            title: true,
            dueAt: true,
            paper: {
              select: { totalScore: true, subject: { select: { name: true } } },
            },
          },
        },
      },
    });
    const truncated = attempts.length > 200;
    const shown = attempts.slice(0, 200);

    // 班級平均：一次查完這幾份任務的所有作答再分組，不是每一列各查
    // 一次。後者是一頁 200 次往返。
    //
    // **只算學生的作答**，與 `classStats` 同一條規則：老師自己試考的
    // 那一份會把平均拉高，而那個數字看起來完全正常。
    const ids = shown.map((a) => a.assignmentId);
    const peers = ids.length
      ? await prisma.attempt.findMany({
          where: {
            assignmentId: { in: ids },
            status: { in: ['SUBMITTED', 'GRADED'] },
            totalScore: { not: null },
            user: { systemRole: 'STUDENT' },
          },
          select: { assignmentId: true, totalScore: true },
        })
      : [];
    const cohort = new Map<string, { sum: number; n: number }>();
    for (const p of peers) {
      const b = cohort.get(p.assignmentId) ?? { sum: 0, n: 0 };
      b.sum += p.totalScore as number;
      b.n += 1;
      cohort.set(p.assignmentId, b);
    }

    const rows = shown.map((a) => {
      const c = cohort.get(a.assignmentId);
      const full = a.assignment.paper.totalScore;
      return {
        id: a.id,
        assignmentId: a.assignmentId,
        title: a.assignment.title,
        subject: a.assignment.paper.subject.name,
        submittedAt: a.submittedAt,
        score: a.totalScore,
        full,
        late: a.late,
        mean: c && c.n > 0 ? round1(c.sum / c.n) : null,
        peers: c?.n ?? 0,
      };
    });
    type Row = (typeof rows)[number];

    /**
     * 依科目的摘要。
     *
     * 百分比而不是原始分數：一份 100 分的卷子與一份 24 分的卷子放在
     * 同一欄比較沒有意義，而「這一科平均 68%、班上 74%」是家長聽得懂
     * 的一句話。沒有配分的卷子（totalScore 是 0）跳過，不是當成 0——
     * 除以零會讓整科的平均變成 NaN，而畫面上那是一個空格。
     */
    const bySubject = new Map<
      string,
      { n: number; mine: number; peer: number; scored: number }
    >();
    for (const r of rows) {
      const b = bySubject.get(r.subject) ?? { n: 0, mine: 0, peer: 0, scored: 0 };
      b.n += 1;
      if (r.score !== null && r.full > 0) {
        b.mine += r.score / r.full;
        b.scored += 1;
        if (r.mean !== null) b.peer += r.mean / r.full;
      }
      bySubject.set(r.subject, b);
    }
    const subjects = [...bySubject.entries()]
      .map(([name, b]) => ({
        name,
        n: b.n,
        mine: b.scored > 0 ? round1((b.mine / b.scored) * 100) : null,
        peer: b.scored > 0 ? round1((b.peer / b.scored) * 100) : null,
      }))
      .sort((a, b) => b.n - a.n);
    type Sub = (typeof subjects)[number];

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>{student.displayName}</h1>
          <p className="yz-panel__sub">
            {student.username}　·
            <Link href={`/classes/${classId}`}>{klass.name}</Link>
            　·　{klass.academicYear.name}
            {link.leftAt && `　·　已於 ${day(link.leftAt)} 移出`}
            {student.status === 'ARCHIVED' && '　·　帳號已停用'}
          </p>
        </div>

        {student.deletedAt && (
          <Note tone="warn">
            這個帳號的個人資料已經依個資法第 11 條刪除。下面的成績留著是刻意的——
            抽掉的話，那幾場考試的班級平均與各題答對率會在今天改變，
            而已經發出去的成績單就對不上了。
          </Note>
        )}

        {link.leftAt && (
          <Note tone="info">
            他已經不在這個班了，所以<strong>他自己的任務清單上看不到這個班的檢討</strong>
            ——包含移出前剛考完的那幾份。資料沒有不見，下面每一列的「他的作答」
            就是那個網址，需要的話直接給他。
          </Note>
        )}

        {!student.consentAt && !student.deletedAt && (
          <Note tone="warn">
            這位學生還沒有法定代理人的同意紀錄，帳號登不進去。
            回到班級頁按他那一列的「登錄同意」。
          </Note>
        )}

        <h2 className="yz-card__title" style={{ marginTop: 6, marginBottom: 6 }}>
          各科概況
        </h2>
        <Table
          caption={`${student.displayName}各科的平均`}
          columns={[
            { key: 's', head: '科目', cell: (s: Sub) => s.name },
            { key: 'n', head: '份數', numeric: true, cell: (s: Sub) => s.n },
            {
              key: 'm',
              head: '他的平均',
              numeric: true,
              cell: (s: Sub) =>
                s.mine === null ? <span className="yz-muted">—</span> : `${s.mine}%`,
            },
            {
              key: 'c',
              head: '班級平均',
              numeric: true,
              cell: (s: Sub) =>
                s.peer === null ? <span className="yz-muted">—</span> : `${s.peer}%`,
            },
            {
              key: 'd',
              head: '差距',
              numeric: true,
              cell: (s: Sub) =>
                s.mine === null || s.peer === null ? (
                  <span className="yz-muted">—</span>
                ) : (
                  <span className={s.mine < s.peer ? 'yz-warn' : undefined}>
                    {s.mine >= s.peer ? '+' : ''}
                    {round1(s.mine - s.peer)}
                  </span>
                ),
            },
          ]}
          rows={subjects}
          rowKey={(s) => s.name}
          empty={
            <Empty
              title="還沒有交過任何一份"
              hint="他交卷之後這裡才會有東西。只列已經交出去的——寫到一半沒交的那幾份在成績頁上。"
            />
          }
        />

        <h2 className="yz-card__title" style={{ marginTop: 30, marginBottom: 6 }}>
          逐份紀錄
        </h2>
        {truncated && (
          <Note tone="warn">
            只列出最近 200 份。更早的還在資料庫裡，但這一頁拿不到——
            要看完整歷程請從成績頁逐份查。
          </Note>
        )}
        <Table
          caption={`${student.displayName}的逐份成績`}
          columns={[
            { key: 'd', head: '交卷', cell: (r: Row) => day(r.submittedAt) },
            {
              key: 't',
              head: '任務',
              cell: (r: Row) => (
                <>
                  <Link href={`/grades/${r.assignmentId}`}>{r.title}</Link>
                  {r.late && <span className="yz-grade__sub yz-warn">遲交</span>}
                </>
              ),
            },
            { key: 's', head: '科目', cell: (r: Row) => r.subject },
            {
              key: 'sc',
              head: '分數',
              numeric: true,
              cell: (r: Row) =>
                r.score === null ? (
                  // 「還沒改完」與「考 0 分」在畫面上不能長得一樣。
                  <span className="yz-warn">未計分</span>
                ) : (
                  `${r.score} / ${r.full}`
                ),
            },
            {
              key: 'm',
              head: '班級平均',
              numeric: true,
              cell: (r: Row) =>
                r.mean === null ? (
                  <span className="yz-muted">—</span>
                ) : (
                  <span title={`${r.peers} 人交卷`}>{r.mean}</span>
                ),
            },
            {
              key: 'l',
              head: <span className="yz-sr">作答</span>,
              // 這個連結就是「移出班級之後入口消失」的補救。學生自己
              // 的清單上已經沒有這一份了，但這個網址還打得開。
              cell: (r: Row) => (
                <Link href={`/take/${r.assignmentId}/result`}>他的作答</Link>
              ),
            },
          ]}
          rows={rows}
          rowKey={(r) => r.id}
          empty={
            <Empty
              title="還沒有交過任何一份"
              hint="他交卷之後這裡才會有東西。"
            />
          }
        />

        {/* 做不到的事要寫出來。空白會被讀成「這個學生沒有錯題」，
            而那與「系統算不出來」是完全不同的兩件事。 */}
        <Note tone="info">
          <strong>這一頁還給不出「哪些單元一直錯」。</strong>
          逐題對錯有記，但要把它對到章節需要題目的知識點標註，
          而那份圖譜目前還沒有資料。在它建起來之前，各題答對率請到
          單份任務的成績頁看——那一頁算得出「這次哪一題全班最不會」。
        </Note>
      </main>
    );
  });
}
