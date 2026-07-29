/**
 * 一個班這學期的狀況。
 *
 * # 為什麼這一頁非有不可
 *
 * 段考後的班務會議問的是「哪幾個學生在退步、哪一次全班都不會」，
 * 而在此之前**沒有任何一頁把兩份任務放在一起看**。單次任務的統計
 * 做得很好（交卷數、平均、中位數、逐題答對率），但跨任務的什麼都
 * 沒有——「誰在退步」要自己把六份任務的分數抄成 Excel，
 * 而第一個月的任務已經從成績列表上滑出去了。
 *
 * # 這一版做得到什麼
 *
 * 一張分數矩陣：橫軸是這個班收到的每一份任務，縱軸是在籍學生，
 * 格子裡是他那一份的百分比。最後一欄是他的總平均與相對班平均的差距。
 * 全部是現成的資料，兩次查詢加一次分組。
 *
 * **做不到章節層級的分析**，理由與學生頁相同（知識點圖譜還沒有資料），
 * 而且要在畫面上說出來。
 *
 * # 為什麼限制在最近 12 份
 *
 * 因為矩陣的欄數就是任務數，而 30 欄的表格在螢幕上讀不了。
 * 12 份大約是一個學期的段考加隨堂——超過的部分用日期篩選往前翻。
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { isHomeroomOf } from '@/lib/auth';
import { parseDayRange } from '@/lib/listing.mjs';
import { mayUse } from '@/lib/nav';
import { prisma } from '@/lib/prisma';
import { scopedPage } from '@/lib/page';
import { teachesClass } from '@/lib/teaching';
import { Denied, Empty, Note } from '@/components/Feedback';
import { Table } from '@/components/Table';

export const dynamic = 'force-dynamic';

const ADMIN = new Set(['SYS_ADMIN', 'SCHOOL_ADMIN']);

/** 一次看得完的欄數。超過的用日期篩選往前翻。 */
const COLUMNS = 12;

const round1 = (n: number) => Math.round(n * 10) / 10;

function day(d: Date | null): string {
  if (!d) return '—';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: 'numeric',
    day: 'numeric',
  }).format(d);
}

export default async function ClassGradesPage({
  params,
  searchParams,
}: {
  params: Promise<{ classId: string }>;
  searchParams: Promise<{ subject?: string; from?: string; to?: string }>;
}) {
  const { classId } = await params;
  const sp = await searchParams;
  return scopedPage(async (user) => {
    if (!mayUse(user.systemRole, '/classes')) {
      return (
        <main className="yz-panel">
          <Denied
            what="班級的成績總覽"
            why="這一頁是全班每一位學生的分數矩陣，屬於老師與管理員的工作區。"
          />
        </main>
      );
    }

    const klass = await prisma.class.findFirst({
      where: { id: classId },
      select: { id: true, name: true, academicYear: { select: { name: true } } },
    });
    if (!klass) notFound();

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
            what={`「${klass.name}」的成績`}
            why="你不在這個班的名冊裡，也沒有被指派教這個班。"
          />
        </main>
      );
    }
    const isHomeroom = !isAdmin && (await isHomeroomOf(user.id, classId));

    /**
     * 科任老師只看得到自己教的那一科。
     *
     * 導師與管理員看得到全部——導師的職權是班務與催繳，
     * 而「這個班這學期整體如何」正是那件事。科任老師的職權是科目，
     * 讓他看到別科的分數矩陣等於用另一條路繞過 `gradeScopeWhere`。
     */
    const mine = isAdmin || isHomeroom
      ? null
      : (
          await prisma.classSubjectTeacher.findMany({
            where: { userId: user.id, classId },
            select: { subjectId: true },
            distinct: ['subjectId'],
          })
        ).map((r) => r.subjectId);

    const subjects = await prisma.subject.findMany({
      where: { active: true, ...(mine === null ? {} : { id: { in: mine } }) },
      orderBy: { order: 'asc' },
      select: { id: true, name: true },
    });

    const range = parseDayRange(sp.from, sp.to);
    const subjectId = sp.subject && subjects.some((s) => s.id === sp.subject) ? sp.subject : undefined;

    const assignments = await prisma.assignment.findMany({
      where: {
        targets: { some: { classId } },
        ...(mine === null ? {} : { paper: { subjectId: { in: mine } } }),
        ...(subjectId ? { paper: { subjectId } } : {}),
        ...(range.gte || range.lt
          ? {
              createdAt: {
                ...(range.gte ? { gte: range.gte } : {}),
                ...(range.lt ? { lt: range.lt } : {}),
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: COLUMNS,
      select: {
        id: true,
        title: true,
        dueAt: true,
        createdAt: true,
        paper: { select: { totalScore: true, subject: { select: { name: true } } } },
      },
    });
    // 舊的排左邊：讀走勢的方向是左到右。查詢用 desc 是為了取到最近的
    // 那幾份，畫的時候要反過來。
    const cols = [...assignments].reverse();

    const members = await prisma.classMembership.findMany({
      where: { classId, leftAt: null, role: 'STUDENT' },
      orderBy: { joinedAt: 'asc' },
      select: { user: { select: { id: true, username: true, displayName: true } } },
    });

    const attempts =
      cols.length > 0 && members.length > 0
        ? await prisma.attempt.findMany({
            where: {
              assignmentId: { in: cols.map((a) => a.id) },
              userId: { in: members.map((m) => m.user.id) },
              status: { in: ['SUBMITTED', 'GRADED'] },
            },
            select: { assignmentId: true, userId: true, totalScore: true },
          })
        : [];

    // key 是 `assignmentId|userId`。兩層 Map 也可以，但一次作答次數
    // 大於一的任務會讓內層被覆蓋——這裡取最後一份，與成績頁一致。
    const cell = new Map<string, number | null>();
    for (const a of attempts) cell.set(`${a.assignmentId}|${a.userId}`, a.totalScore);

    const pct = (score: number | null | undefined, full: number) =>
      score === null || score === undefined || full <= 0 ? null : round1((score / full) * 100);

    const rows = members.map((m) => {
      const scores = cols.map((a) => pct(cell.get(`${a.id}|${m.user.id}`), a.paper.totalScore));
      const got = scores.filter((s): s is number => s !== null);
      return {
        id: m.user.id,
        username: m.user.username,
        displayName: m.user.displayName,
        scores,
        mean: got.length ? round1(got.reduce((s, n) => s + n, 0) / got.length) : null,
        missing: scores.filter((s) => s === null).length,
      };
    });
    type Row = (typeof rows)[number];

    // 每一份的班級平均，畫在表尾。學生要看的是自己與它的差距，
    // 而那個數字若要他自己心算，這張表就只是一堆數字。
    const colMean = cols.map((a) => {
      const got = rows
        .map((r) => pct(cell.get(`${a.id}|${r.id}`), a.paper.totalScore))
        .filter((s): s is number => s !== null);
      return got.length ? round1(got.reduce((s, n) => s + n, 0) / got.length) : null;
    });
    const overall = (() => {
      const got = rows.map((r) => r.mean).filter((s): s is number => s !== null);
      return got.length ? round1(got.reduce((s, n) => s + n, 0) / got.length) : null;
    })();

    const here = `/classes/${classId}/grades`;

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>{klass.name}　這學期的成績</h1>
          <p className="yz-panel__sub">
            {klass.academicYear.name}　·　{members.length} 位在籍　·
            最近 {cols.length} 份任務　·
            <Link href={`/classes/${classId}`}>回到名冊</Link>
          </p>
        </div>

        {/* 篩選列。日期用原生 date input——瀏覽器自己有日曆，
            而自己刻一個只會在手機上比較難按。 */}
        <form className="yz-filters" method="get" action={here}>
          <label className="yz-filters__item">
            <span>科目</span>
            <select name="subject" defaultValue={sp.subject ?? ''} className="yz-in">
              <option value="">全部</option>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="yz-filters__item">
            <span>從</span>
            <input type="date" name="from" defaultValue={sp.from ?? ''} className="yz-in" />
          </label>
          <label className="yz-filters__item">
            <span>到</span>
            <input type="date" name="to" defaultValue={sp.to ?? ''} className="yz-in" />
          </label>
          <button type="submit" className="yz-btn">
            套用
          </button>
          {(sp.subject || sp.from || sp.to) && (
            <Link className="yz-btn yz-btn--quiet" href={here}>
              清除
            </Link>
          )}
        </form>

        {cols.length === COLUMNS && (
          <Note tone="info">
            一次只畫得下 {COLUMNS} 份（再多的話這張表在螢幕上讀不了）。
            這是最近的 {COLUMNS} 份，要看更早的請用上面的日期區間往前翻。
          </Note>
        )}

        <Table
          caption={`${klass.name}的分數矩陣`}
          columns={[
            {
              key: 'n',
              head: '學生',
              cell: (r: Row) => (
                <>
                  <Link href={`/classes/${classId}/students/${r.id}`}>{r.displayName}</Link>
                  <span className="yz-grade__sub">{r.username}</span>
                </>
              ),
            },
            ...cols.map((a, i) => ({
              key: a.id,
              numeric: true,
              head: (
                <Link href={`/grades/${a.id}`} title={`${a.paper.subject.name}・${a.title}`}>
                  {day(a.dueAt ?? a.createdAt)}
                </Link>
              ),
              cell: (r: Row) => {
                const v = r.scores[i];
                if (v === null) {
                  // 沒交與考 0 分在畫面上不能長得一樣。
                  return <span className="yz-muted" title="沒有交卷紀錄">—</span>;
                }
                const m = colMean[i];
                return (
                  <span className={m !== null && v < m ? 'yz-warn' : undefined}>{v}</span>
                );
              },
            })),
            {
              key: 'avg',
              head: '平均',
              numeric: true,
              cell: (r: Row) =>
                r.mean === null ? (
                  <span className="yz-muted">—</span>
                ) : (
                  <strong className={overall !== null && r.mean < overall ? 'yz-warn' : undefined}>
                    {r.mean}
                  </strong>
                ),
            },
            {
              key: 'miss',
              head: '未交',
              numeric: true,
              cell: (r: Row) => (r.missing ? <span className="yz-warn">{r.missing}</span> : ''),
            },
          ]}
          rows={rows}
          rowKey={(r) => r.id}
          empty={
            <Empty
              title={
                members.length === 0 ? '這個班還沒有學生' : '這個班還沒有收到任何任務'
              }
              hint={
                members.length === 0
                  ? '先匯入名冊，之後派出去的任務才會落在這張表上。'
                  : '派一份給這個班，學生交卷之後這裡就會有分數。'
              }
              action={<Link href={`/classes/${classId}`}>回到名冊</Link>}
            />
          }
        />

        {rows.length > 0 && cols.length > 0 && (
          <p className="yz-hint" style={{ marginTop: 10 }}>
            數字是百分比（他的分數 ÷ 那份卷子的滿分）。
            <strong>硃砂色代表低於那一份的班級平均</strong>，最後一欄的平均低於全班
            {overall !== null && ` ${overall}`} 也一樣。「—」是沒有交卷紀錄，不是考 0 分。
            表頭的日期點得進那一份的完整統計，學生的姓名點得進他整學期的紀錄。
          </p>
        )}

        <Note tone="info">
          <strong>這一頁還給不出「哪一個章節全班都不會」。</strong>
          逐題答對率在單份任務的成績頁上算得出來，但要把它對到章節需要題目的知識點
          標註，而那份圖譜目前還沒有資料。
        </Note>
      </main>
    );
  });
}
