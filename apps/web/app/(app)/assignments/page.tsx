import Link from 'next/link';

import { Denied, Empty, Note } from '@/components/Feedback';
import { Pager } from '@/components/Pager';
import { Table } from '@/components/Table';
import { assignableClassIds, countRecipients } from '@/lib/assignment';
import {
  PAGE_SIZE,
  keepQuery,
  pageQuery,
  pageSlice,
  parseDayRange,
  parseSearch,
} from '@/lib/listing.mjs';
import { mayComposeArea } from '@/lib/paper';
import { scopedPage } from '@/lib/page';
import { prisma } from '@/lib/prisma';
import { gradeScopeWhere, teachingSubjectIds } from '@/lib/scoring';
import AssignmentTools from './AssignmentTools';
import NewAssignment from './NewAssignment';

export const dynamic = 'force-dynamic';

/**
 * 一頁最多列幾份。
 *
 * # 為什麼這個數字以前是一條死路
 *
 * 舊版取 100 筆、沒有分頁、**連 `where` 都沒有**（列的是全補習班的
 * 任務），超過時顯示「要看更早的成績請到『成績』」——而成績那一頁
 * 取 60 筆、也沒有分頁，超過時顯示「要找更早的成績，請從『派卷』
 * 進到那一份任務」。**兩頁互相指向對方，而兩頁都看不到。**
 *
 * 7 個班 × 3 科 × 每週各一份 = 21 份／週，第五週就越過 100。
 */
const PAGE = PAGE_SIZE;

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

export default async function AssignmentsPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    q?: string;
    subject?: string;
    class?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const sp = await searchParams;
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

    /**
     * 這一頁列的是**他看得到的範圍**，不是全補習班。
     *
     * 舊版的查詢連 `where` 都沒有，理由寫著「老師要看得到別人派了
     * 什麼，才不會撞課」——但代價是一位只教孝班數學的老師，
     * 看得到七個班每一份任務的名稱、派給誰、以及那一列上的「看成績」
     * 連結。而右邊的操作欄已經用 `teachingSubjectIds` 判過
     * 「改不改得動」了，所以畫面上同時存在兩套不同的範圍。
     *
     * 用 `gradeScopeWhere`（我教的科目 **或** 我派的任務），與成績頁
     * 完全同一份規則——兩頁對同一位老師該看到什麼給出同一個答案。
     * 管理員與學科召集人不受限（那一支回 `{}`）。
     */
    const scope = await gradeScopeWhere(user);

    // 篩選的選項先算出來：科目與班級下拉列的東西要與清單同一個範圍。
    const [subjects, classList] = await Promise.all([
      prisma.subject.findMany({
        where: { active: true },
        orderBy: { order: 'asc' },
        select: { id: true, name: true },
      }),
      prisma.class.findMany({
        where: { active: true },
        orderBy: [{ academicYear: { startDate: 'desc' } }, { name: 'asc' }],
        take: 100,
        select: { id: true, name: true },
      }),
    ]);

    const q = parseSearch(sp.q);
    const range = parseDayRange(sp.from, sp.to);
    const subjectId = subjects.some((x) => x.id === sp.subject) ? sp.subject : undefined;
    const filterClassId = classList.some((c) => c.id === sp.class) ? sp.class : undefined;
    const filtered = Boolean(q || subjectId || filterClassId || range.gte || range.lt);

    // 用 AND 併而不是展開合併：`gradeScopeWhere` 回的那個 `OR` 會被
    // 同名的鍵蓋掉，而症狀是老師看得到別科的任務，且只在他用了篩選
    // 的時候發生。
    const where = {
      AND: [
        scope,
        ...(q ? [{ title: { contains: q, mode: 'insensitive' as const } }] : []),
        ...(subjectId ? [{ paper: { subjectId } }] : []),
        ...(filterClassId ? [{ targets: { some: { classId: filterClassId } } }] : []),
        ...(range.gte || range.lt
          ? [
              {
                createdAt: {
                  ...(range.gte ? { gte: range.gte } : {}),
                  ...(range.lt ? { lt: range.lt } : {}),
                },
              },
            ]
          : []),
      ],
    };

    const window = pageQuery(sp.page, PAGE);
    const [found, papers] = await Promise.all([
      prisma.assignment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: window.skip,
        // 多取一筆，只為了知道「後面還有沒有」。以為看到的就是全部，
        // 比看到一個分頁按鈕糟糕得多。
        take: window.take,
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
          // **同一份卷子上還沒結束的任務。**
          //
          // 這是跨班洩題那個洞的偵測方式：忠班週五 15:00 截止，
          // `releasePolicy = ON_DUE` 的預設值會在那一刻對忠班開放整份
          // 答案與詳解，而孝仁兩班週六早上才考同一份卷子。派卷表單
          // 那句「正式考試選『截止後』，先寫完的人不會洩題」在一個班
          // 之內是對的，跨班是錯的，而它是唯一在場的指引。
          assignments: {
            where: { OR: [{ dueAt: null }, { dueAt: { gt: new Date() } }] },
            orderBy: { dueAt: 'asc' },
            take: 8,
            select: { id: true, title: true, dueAt: true },
          },
        },
      }),
    ]);

    const paged = pageSlice(found, sp.page, PAGE);
    const rows = paged.rows;

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

    // 派給哪幾個班。同一份卷子分三個班考時，這一欄是老師唯一分得出
    // 「這一列是忠班還是孝班」的東西——在此之前他只能靠自己取的任務
    // 名稱，而改錯一份不會有任何提示。一次查完再分組。
    const targetRows = rows.length
      ? await prisma.assignmentTarget.findMany({
          where: { assignmentId: { in: rows.map((a) => a.id) } },
          select: { assignmentId: true, userId: true, class: { select: { name: true } } },
        })
      : [];
    const targetsOf = new Map<string, { classes: string[]; individuals: number }>();
    for (const t of targetRows) {
      const bucket = targetsOf.get(t.assignmentId) ?? { classes: [], individuals: 0 };
      if (t.class?.name) bucket.classes.push(t.class.name);
      else if (t.userId) bucket.individuals++;
      targetsOf.set(t.assignmentId, bucket);
    }

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
              openTasks: p.assignments.map((a) => ({
                title: a.title,
                dueAt: a.dueAt?.toISOString() ?? null,
              })),
            }))}
            classes={classes.map((c) => ({
              id: c.id,
              name: c.name,
              members: c._count.memberships,
            }))}
            students={students}
            me={{ id: user.id, displayName: user.displayName }}
          />
        )}

        {rows.some((a) => (recipientCount.get(a.id) ?? 0) === 0) && (
          <Note tone="warn">
            有任務的實際人數是 0——通常是派給了一個還沒匯入名冊的班。
            那樣的任務在列表上與正常的任務長得一模一樣，但沒有任何人收得到。
          </Note>
        )}

        {/* 篩選列。以前這裡是一句「要看更早的成績請到『成績』」，
            而成績那一頁的提示是「請從派卷進去」——兩句話互相指向對方，
            而兩頁都看不到。 */}
        <form className="yz-filters" method="get" action="/assignments">
          <label className="yz-filters__item">
            <span className="yz-sr">搜尋任務名稱</span>
            <input
              name="q"
              defaultValue={sp.q ?? ''}
              placeholder="搜尋任務名稱"
              className="yz-in"
              style={{ width: 180 }}
            />
          </label>
          <label className="yz-filters__item">
            <span>科目</span>
            <select name="subject" defaultValue={sp.subject ?? ''} className="yz-in">
              <option value="">全部</option>
              {subjects.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
          <label className="yz-filters__item">
            <span>班級</span>
            <select name="class" defaultValue={sp.class ?? ''} className="yz-in">
              <option value="">全部</option>
              {classList.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
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
          {filtered && (
            <Link className="yz-btn yz-btn--quiet" href="/assignments">
              清除
            </Link>
          )}
        </form>

        <Table
          caption="任務一覽"
          columns={[
            {
              key: 't',
              head: '任務',
              // 任務名稱是連結。這一頁以前完全沒有內頁，所以「這份任務
              // 派給了哪幾個人、誰還沒動」在系統裡沒有任何出口。
              cell: (a: Row) => <Link href={`/assignments/${a.id}`}>{a.title}</Link>,
            },
            {
              key: 'p',
              head: '試卷',
              cell: (a: Row) => <Link href={`/papers/${a.paper.id}`}>{a.paper.title}</Link>,
            },
            { key: 'm', head: '模式', cell: (a: Row) => MODE[a.mode] ?? a.mode },
            {
              key: 'r',
              head: '派給',
              cell: (a: Row) => {
                const n = recipientCount.get(a.id) ?? 0;
                const t = targetsOf.get(a.id);
                const who = [
                  ...(t?.classes ?? []),
                  ...(t && t.individuals > 0 ? [`個別 ${t.individuals} 位`] : []),
                ].join('、');
                return (
                  <>
                    {n === 0 ? <span className="yz-warn">0 人</span> : `${n} 人`}
                    {who && <span className="yz-grade__sub">{who}</span>}
                  </>
                );
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
            filtered ? (
              // 「篩掉了」與「真的沒有」要分得出來。合成一句的話，
              // 老師會以為這一科從來沒有派過任務。
              <Empty
                title="這組條件下沒有任務"
                hint="換一個科目、班級或日期區間看看。也可能是它落在別的日期區間裡。"
                action={<Link href="/assignments">清除篩選</Link>}
              />
            ) : (
              <Empty
                title="還沒有派過任務"
                hint="選一份可派發的卷子、選班級、設好開放與截止時間，就派出去了。"
              />
            )
          }
        />

        <Pager
          page={paged.page}
          hasPrev={paged.hasPrev}
          hasNext={paged.hasNext}
          from={paged.from}
          to={paged.to}
          unit="份"
          hrefFor={(n) =>
            keepQuery('/assignments', { ...sp }, { page: n === 1 ? undefined : String(n) })
          }
        />
      </main>
    );
  });
}
