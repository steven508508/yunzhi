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
 * # 「哪些單元一直錯」
 *
 * 這一頁原本寫著做不到，理由是「要同時 join `attempt_answers` 與
 * `question_knowledge_points`，而全 repo 沒有任何一處這樣查」。
 * 現在有了（`lib/abilityDb.ts`），所以那一段換成真的分析。
 *
 * 但**前提沒有變**：知識點圖譜是老師自己建的，題目要標上知識點才對得到
 * 章節。所以這一段有三種狀態，而且要分得出來——有分析、沒有分析因為
 * 圖譜還沒建、沒有分析因為考過的題目沒標。三種的下一步完全不同，
 * 都畫成空白的話，看的人會以為這個學生沒有錯題。
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { abilityReadiness, studentSubjectAbility, SOLID, WEAK } from '@/lib/abilityDb';
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

    /**
     * 章節（知識點）層級的狀況。
     *
     * **不依科目過濾**，與這一頁其他每一塊一致：上面的成績表也列出
     * 這位學生所有科目的分數。這一頁的存取判定是「你帶不帶這個班」，
     * 而不是「你教哪一科」——在同一頁裡讓兩塊用不同的規則，
     * 遲早會有人以為其中一塊壞了。
     *
     * 可靠與不可靠分開放：資料不足的知識點**只給題數、不給掌握度**。
     * 一個看起來精確的小數會被家長當成結論，而它背後可能只有兩題。
     */
    const [kp, readiness] = await Promise.all([
      studentSubjectAbility(studentId),
      abilityReadiness(),
    ]);
    const solidPoints = kp.filter((p) => p.reliable);
    const thinPoints = kp.filter((p) => !p.reliable);
    type Kp = (typeof kp)[number];

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

        <h2 className="yz-card__title" style={{ marginTop: 30, marginBottom: 6 }}>
          哪些單元一直錯
        </h2>

        {solidPoints.length === 0 && thinPoints.length === 0 ? (
          // 空的時候要說得出卡在哪一關。三種情況的下一步完全不同，
          // 而空白會被讀成「這個學生沒有錯題」。
          <Empty
            title="還算不出章節層級的分析"
            hint={
              readiness.points === 0
                ? '要把逐題對錯對到章節，題目得先掛在知識點上，而目前全系統一個知識點都還沒有建。建知識點是老師的工時（一科大約 4 到 8 小時），建議先做一科試看看。'
                : readiness.taggedQuestions === 0
                  ? `已經有 ${readiness.points} 個知識點，但一題都還沒有標上去，所以對不到任何章節。到題庫逐題補標註，或重新匯入題本讓自動標註處理。`
                  : `知識點與標註都有了，但這位學生還沒有算出快照——他考過的題目可能都還沒標到知識點，或者快照還沒重建過。到班級的能力分析頁按一次「重建快照」。`
            }
            action={
              readiness.points === 0 ? (
                <Link href="/knowledge">去建立知識點</Link>
              ) : (
                <Link href={`/classes/${classId}/ability`}>這個班的能力分析</Link>
              )
            }
          />
        ) : (
          <>
            <Table
              caption={`${student.displayName}各知識點的掌握度`}
              columns={[
                { key: 'k', head: '知識點', cell: (p: Kp) => p.name },
                { key: 's', head: '科目', cell: (p: Kp) => p.subjectName },
                {
                  key: 'm',
                  head: '掌握度',
                  numeric: true,
                  cell: (p: Kp) => (
                    <span className={p.mastery < WEAK ? 'yz-warn' : undefined}>
                      {Math.round(p.mastery * 100)}%
                    </span>
                  ),
                },
                {
                  key: 'c',
                  head: '答對 / 作答',
                  numeric: true,
                  // 掌握度是算出來的，這一欄是數出來的。家長問「這個
                  // 35% 怎麼來的」時，這是當場驗證得了的東西。
                  cell: (p: Kp) => `${p.correct} / ${p.total}`,
                },
                {
                  key: 'w',
                  head: '狀況',
                  cell: (p: Kp) =>
                    p.streakWrong >= 3 ? (
                      <span className="yz-warn">連續錯 {p.streakWrong} 題</span>
                    ) : p.mastery >= SOLID ? (
                      '穩'
                    ) : p.mastery < WEAK ? (
                      <span className="yz-warn">要補</span>
                    ) : (
                      ''
                    ),
                },
              ]}
              rows={solidPoints}
              rowKey={(p) => p.id}
              empty={
                <Empty
                  title="還沒有一個知識點累積到足夠的作答"
                  hint="下面那幾個題數還太少，給不出可靠的掌握度。"
                />
              }
            />
            <p className="yz-hint" style={{ marginTop: 10 }}>
              掌握度<strong>不是答對率</strong>：愈久以前的作答權重愈低（所以一個學期沒碰的
              單元會往下掉），難度高的題目權重較高。低於 {Math.round(WEAK * 100)}% 算要補、
              {Math.round(SOLID * 100)}% 以上算穩。全班的狀況在
              <Link href={`/classes/${classId}/ability`}>這個班的能力分析</Link>。
            </p>

            {thinPoints.length > 0 && (
              <Note tone="info">
                另外 {thinPoints.length} 個知識點的作答太少（
                {thinPoints
                  .slice(0, 6)
                  .map((p) => `${p.name} ${p.total} 題`)
                  .join('、')}
                {thinPoints.length > 6 && ' 等'}
                ），<strong>刻意不給掌握度</strong>——兩三題算出來的小數看起來很精確，
                但它站不住，而約談時被拿去當結論的正是那種數字。
              </Note>
            )}
          </>
        )}
      </main>
    );
  });
}
