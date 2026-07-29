import Link from 'next/link';

import { Denied, Empty, Note } from '@/components/Feedback';
import { Table } from '@/components/Table';
import { assignableClassIds, countRecipients } from '@/lib/assignment';
import { mayComposeArea } from '@/lib/paper';
import { scopedPage } from '@/lib/page';
import { prisma } from '@/lib/prisma';
import { teachingSubjectIds } from '@/lib/scoring';
import AssignmentTools from './AssignmentTools';
import NewAssignment from './NewAssignment';

export const dynamic = 'force-dynamic';

/** 一頁最多列幾份。超過時要說出來，見下面的 `truncated`。 */
const PAGE = 100;

const MODE: Record<string, string> = { EXAM: '正式測驗', PRACTICE: '練習' };

/**
 * 給人看的時間。年份省略是因為列表上全部都是今年的。
 *
 * **一定要指定台北時區。** 資料庫存的是 UTC，而伺服器多半跑在 UTC，
 * 不指定的話晚上八點截止的考試會顯示成中午十二點——一個看起來
 * 完全正常、只是差八小時的時間。老師會照著它跟學生說錯的時間。
 */
function when(d: Date | null): string {
  if (!d) return '—';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

export default async function AssignmentsPage() {
  return scopedPage(async (user) => {
    if (!mayComposeArea(user.systemRole, '/assignments')) {
      return (
        <main className="yz-panel">
          <Denied
            what="任務管理"
            why="這裡是老師派任務的地方。學生看到的是自己的任務清單。"
          />
        </main>
      );
    }

    const [assignments, papers] = await Promise.all([
      prisma.assignment.findMany({
        orderBy: { createdAt: 'desc' },
        // 多取一筆，只為了知道「後面還有沒有」。以為看到的就是全部，
        // 比看到一個分頁按鈕糟糕得多。
        take: PAGE + 1,
        include: {
          // subjectId 是給「這一列要不要畫調整鈕」用的：改任務設定的
          // 職權看的是卷子的科目，任務自己沒有科目欄位。
          paper: { select: { id: true, title: true, totalScore: true, subjectId: true } },
          _count: { select: { attempts: true } },
        },
      }),
      // 只有可派發的卷子出現在下拉選單裡。草稿也列出來的話，老師會
      // 選了它、按了送出、然後才看到「還是草稿」——那是可以在選之前
      // 就避免的挫折。
      prisma.examPaper.findMany({
        where: { status: 'READY' },
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          title: true,
          totalScore: true,
          subject: { select: { name: true } },
          _count: { select: { items: true } },
        },
      }),
    ]);

    const truncated = assignments.length > PAGE;
    const rows = assignments.slice(0, PAGE);

    // 勾選清單只列自己派得出去的班。伺服器端仍然會再擋一次
    // （`resolveTargetInput`）——這裡少列一個班只是不方便，
    // 那裡少擋一次是別人的學生收到我的考卷。
    //
    // 這裡傳 null（我教的任何一科）：老師還沒選卷子，科目未定。
    // 選了之後若那個班不屬於該科，送出時伺服器會說得很清楚。
    const allowedClassIds = await assignableClassIds(user, null);
    const classes = await prisma.class.findMany({
      where: {
        active: true,
        ...(allowedClassIds === null ? {} : { id: { in: allowedClassIds } }),
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, _count: { select: { memberships: true } } },
    });

    // 「派給幾人」是這個畫面最重要的一欄——沒有它，老師看不出
    // 「派給了一個還沒匯入名冊的空班」這種錯。一次查完再分組，
    // 不是每一份各查一次：後者是 4 次查詢乘上任務數。
    const recipientCount = await countRecipients(rows.map((a) => a.id));

    // 這一頁列出全機構的任務（老師要看得到別人派了什麼，才不會撞課），
    // 但**改得動的只有自己教的那幾科**。一次算完再逐列判斷，不是逐列
    // 查一次。畫了按鈕按下去才被拒絕，老師會以為系統壞了。
    // 真正的擋在 `PATCH /api/assignments/:id`，這裡只決定畫不畫。
    const editableSubjects = await teachingSubjectIds(user);
    const mayEdit = (subjectId: string) =>
      editableSubjects === null || editableSubjects.includes(subjectId);

    // 個別指定的候選人只到自己帶的班為止：這個清單會整份送到瀏覽器，
    // 而全校每一位學生的姓名與學號不是每位老師都該拿到的東西。
    // 不受班級限制的人（管理員、學科召集人）不過濾——他們本來就要
    // 找得到停用班級裡的學生（轉學生、重補修的補考）。
    const students = await prisma.user.findMany({
      where: {
        systemRole: 'STUDENT',
        deletedAt: null,
        ...(allowedClassIds === null
          ? {}
          : {
              memberships: {
                some: { role: 'STUDENT', leftAt: null, classId: { in: allowedClassIds } },
              },
            }),
      },
      orderBy: { username: 'asc' },
      select: { id: true, username: true, displayName: true },
      take: 2000,
    });

    type Row = (typeof rows)[number];

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>任務</h1>
          <p className="yz-panel__sub">
            一個任務是一份卷子加上「派給誰、什麼時候、玩法是什麼」。
            派出去之後，設定裡與考試條件有關的那幾項就會鎖住——
            已經開始作答的人與還沒開始的人不能拿到不同的考試。
          </p>
        </div>

        {papers.length === 0 ? (
          <Empty
            title="還沒有可以派的卷子"
            hint="任務要綁一份標記為「可派發」的試卷。先去組一份卷子，挑完題目之後標記為可派發。"
            action={<Link href="/papers">去組卷</Link>}
          />
        ) : classes.length === 0 ? (
          // 「全校還沒開班」與「你沒有帶班」是兩件事，要做的也不同：
          // 前者去開班，後者去找管理員。合成一句「還沒有班級」的話，
          // 沒帶班的老師會跑去開班或以為系統壞了。
          allowedClassIds !== null ? (
            <Empty
              title="你還沒有被指定任何班級"
              hint="任務只能派給自己授課或擔任導師的班。請管理員把你加進班級的授課老師名單。"
            />
          ) : (
            <Empty
              title="還沒有班級"
              hint="任務要派給班級或個別學生，所以要先有班。"
              action={<Link href="/classes">去開班</Link>}
            />
          )
        ) : (
          <NewAssignment
            papers={papers.map((p) => ({
              id: p.id,
              title: p.title,
              subject: p.subject.name,
              items: p._count.items,
              totalScore: p.totalScore,
            }))}
            classes={classes.map((c) => ({
              id: c.id,
              name: c.name,
              members: c._count.memberships,
            }))}
            students={students}
          />
        )}

        {rows.some((a) => (recipientCount.get(a.id) ?? 0) === 0) && (
          <Note tone="warn">
            有任務的實際人數是 0——通常是派給了一個還沒匯入名冊的班。
            那樣的任務在列表上與正常的任務長得一模一樣，但沒有任何人收得到。
          </Note>
        )}

        {truncated && (
          <Note tone="warn">
            只列出最近 {PAGE} 個任務，還有更早的沒有顯示。要看更早的成績請到「成績」。
          </Note>
        )}

        <Table
          caption="任務一覽"
          columns={[
            { key: 't', head: '任務', cell: (a: Row) => a.title },
            {
              key: 'p',
              head: '試卷',
              cell: (a: Row) => <Link href={`/papers/${a.paper.id}`}>{a.paper.title}</Link>,
            },
            { key: 'm', head: '模式', cell: (a: Row) => MODE[a.mode] ?? a.mode },
            {
              key: 'r',
              head: '派給',
              numeric: true,
              cell: (a: Row) => {
                const n = recipientCount.get(a.id) ?? 0;
                return n === 0 ? <span className="yz-warn">0 人</span> : `${n} 人`;
              },
            },
            {
              key: 'w',
              head: '開放 → 截止',
              cell: (a: Row) => `${when(a.openAt)} → ${when(a.dueAt)}`,
            },
            {
              key: 'l',
              head: '時限',
              numeric: true,
              cell: (a: Row) =>
                a.timeLimitMin ? `${a.timeLimitMin} 分` : <span className="yz-muted">不限</span>,
            },
            {
              key: 'd',
              head: '已作答',
              numeric: true,
              cell: (a: Row) => a._count.attempts || <span className="yz-muted">—</span>,
            },
            {
              key: 'g',
              head: '成績',
              cell: (a: Row) =>
                a._count.attempts > 0 ? (
                  <Link href={`/grades/${a.id}`}>看成績</Link>
                ) : (
                  <span className="yz-muted">—</span>
                ),
            },
            {
              key: 'x',
              // 表頭視覺上留白，但不能真的是空的——讀螢幕的人聽到的
              // 會是一個沒有名字的欄位。
              head: <span className="yz-sr">操作</span>,
              cell: (a: Row) =>
                mayEdit(a.paper.subjectId) ? (
                  <AssignmentTools
                    assignment={{
                      id: a.id,
                      title: a.title,
                      openAt: a.openAt?.toISOString() ?? null,
                      dueAt: a.dueAt?.toISOString() ?? null,
                      allowLate: a.allowLate,
                      maxAttempts: a.maxAttempts,
                      releasePolicy: a.releasePolicy,
                      attempts: a._count.attempts,
                    }}
                  />
                ) : (
                  <span className="yz-muted">別科</span>
                ),
            },
          ]}
          rows={rows}
          rowKey={(a) => a.id}
          empty={
            <Empty
              title="還沒有派過任務"
              hint="選一份可派發的卷子、選班級、設好開放與截止時間，就派出去了。"
            />
          }
        />
      </main>
    );
  });
}
