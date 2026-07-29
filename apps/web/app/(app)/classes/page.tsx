import Link from 'next/link';

import { keepQuery, resolveYearFilter } from '@/lib/listing.mjs';
import { prisma } from '@/lib/prisma';
import { scopedPage } from '@/lib/page';
import { mayUse } from '@/lib/nav';
import { Denied, Empty, Note } from '@/components/Feedback';
import { Table } from '@/components/Table';
import NewClass from './NewClass';

export const dynamic = 'force-dynamic';

const ADMIN = new Set(['SYS_ADMIN', 'SCHOOL_ADMIN']);

export default async function ClassesPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; archived?: string }>;
}) {
  const sp = await searchParams;
  return scopedPage(async (user) => {
    // 學生自己也是班級成員，所以少了這一道，他從網址進來會看到
    // 全班的名冊——含每個同學的家長信箱。
    if (!mayUse(user.systemRole, '/classes')) {
      return (
        <main className="yz-panel">
          <Denied what="班級名冊" why="名冊含全班同學與家長的聯絡資料，只有老師與管理員看得到。" />
        </main>
      );
    }
    const isAdmin = ADMIN.has(user.systemRole);

    const years = await prisma.academicYear.findMany({
      orderBy: { startDate: 'desc' },
      select: { id: true, name: true, isCurrent: true, endDate: true },
    });

    /**
     * 預設只看當前學年度。
     *
     * # 為什麼這一行是「期末結算」那一項的一半
     *
     * `isCurrent` 在此之前唯一有行為的使用是開班對話框的下拉預選
     * （`NewClass.tsx`）——這一頁列的是**所有年度的所有班**。
     * 第二年開學時列表上是 14 個班，其中 7 個已經沒有人了，
     * 而看的人分不出是哪 7 個。
     *
     * `?year=all` 看得到全部，`?year=<id>` 看某一年。切換在畫面上，
     * 所以「舊班去哪了」有答案——預設藏起來而沒有出口的話，
     * 那不是篩選，那是資料不見了。
     */
    const pickedId = resolveYearFilter(sp.year, years);
    const picked = pickedId ? (years.find((y) => y.id === pickedId) ?? null) : null;
    const showArchived = sp.archived === '1';

    const classes = await prisma.class.findMany({
      where: {
        ...(picked ? { academicYearId: picked.id } : {}),
        // 封存的班預設不列。它們是「收起來了」而不是「不存在」，
        // 所以切換就在旁邊，而且數量看得見。
        ...(showArchived ? {} : { active: true }),
        ...(isAdmin
          ? {}
          : {
              // **兩張表都要查。** 在此之前只查 `ClassMembership`，
              // 而授課指派寫的是 `ClassSubjectTeacher`——一位被指派教
              // 七個班數學的老師在這裡一個班都看不到，畫面寫「你還沒有
              // 帶任何班」，而他其實派得了那七個班的卷
              // （`assignableClassIds` 兩張表都看）。
              // **同一個系統的兩頁對同一件事給出相反的答案。**
              OR: [
                { memberships: { some: { userId: user.id, leftAt: null } } },
                { subjectTeachers: { some: { userId: user.id } } },
              ],
            }),
      },
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
      include: {
        academicYear: { select: { name: true, isCurrent: true } },
        _count: { select: { memberships: true } },
      },
    });

    type Row = (typeof classes)[number];
    const ids = classes.map((c) => c.id);

    /**
     * 每個班有幾位在籍、幾位還沒有家長同意。
     *
     * `_count.memberships` 算的是**所有**列（含已移出的、含老師），
     * 所以一個帶了三年的班會顯示 90 人。要的是在籍的學生數。
     *
     * 「未同意」這一欄是首頁那一項待辦的落地：首頁說「N 位學生還沒有
     * 家長同意紀錄」而連結指到這個列表，而列表在此之前沒有任何一欄
     * 說得出是哪一班——七個班要一班一班點進去看有沒有黃色警告條。
     *
     * 一次查完再分組，不是每一列各查一次。
     */
    const roster = ids.length
      ? await prisma.classMembership.findMany({
          where: { classId: { in: ids }, leftAt: null, role: 'STUDENT' },
          select: { classId: true, user: { select: { consentAt: true, systemRole: true } } },
        })
      : [];
    const stat = new Map<string, { active: number; waiting: number }>();
    for (const m of roster) {
      if (m.user.systemRole !== 'STUDENT') continue;
      const b = stat.get(m.classId) ?? { active: 0, waiting: 0 };
      b.active += 1;
      if (!m.user.consentAt) b.waiting += 1;
      stat.set(m.classId, b);
    }

    // 被藏起來的數量。有數字才知道「切過去看得到什麼」，
    // 而一個永遠寫著「顯示已封存」的連結看起來像沒有作用。
    const hidden = await prisma.class.count({
      where: {
        ...(picked ? { academicYearId: picked.id } : {}),
        active: false,
        ...(isAdmin
          ? {}
          : {
              OR: [
                { memberships: { some: { userId: user.id, leftAt: null } } },
                { subjectTeachers: { some: { userId: user.id } } },
              ],
            }),
      },
    });

    const q = { year: sp.year, archived: sp.archived };
    const waitingTotal = [...stat.values()].reduce((n, b) => n + b.waiting, 0);

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>班級</h1>
          <p className="yz-panel__sub">
            班級是派任務、看成績、算能力分析的單位。學生要先在某個班裡，
            才收得到任何東西。
          </p>
        </div>

        {isAdmin && years.length > 0 && (
          <NewClass years={years.map((y) => ({ id: y.id, name: y.name, isCurrent: y.isCurrent }))} />
        )}
        {isAdmin && years.length === 0 && (
          <Empty
            title="還沒有學年度"
            hint="班級要掛在某個學年度底下，所以要先有學年度才開得了班。"
            action={<Link href="/settings/years">建立學年度</Link>}
          />
        )}

        {/* 學年度切換。年度數超過一個才畫——第一年畫一個只有一個選項
            的篩選列只是噪音。 */}
        {years.length > 1 && (
          <div className="yz-filters">
            <span className="yz-filters__label">學年度</span>
            {years.map((y) => (
              <Link
                key={y.id}
                href={keepQuery('/classes', q, { year: y.id })}
                className={`yz-chip${picked?.id === y.id ? ' yz-chip--on' : ''}`}
              >
                {y.name}
                {y.isCurrent && '（當前）'}
              </Link>
            ))}
            <Link
              href={keepQuery('/classes', q, { year: 'all' })}
              className={`yz-chip${picked === null ? ' yz-chip--on' : ''}`}
            >
              全部年度
            </Link>
          </div>
        )}

        {(hidden > 0 || showArchived) && (
          <div className="yz-filters">
            <Link
              href={keepQuery('/classes', q, { archived: showArchived ? undefined : '1' })}
              className={`yz-chip${showArchived ? ' yz-chip--on' : ''}`}
            >
              {showArchived ? '只看使用中的班' : `連已封存的一起看（${hidden}）`}
            </Link>
          </div>
        )}

        {waitingTotal > 0 && (
          <Note tone="warn">
            這個範圍裡有 {waitingTotal} 位學生還沒有法定代理人的同意紀錄，
            <strong>那些帳號登不進去</strong>。下面「未同意」那一欄標出是哪幾個班——
            點進去可以整批登錄，不必一位一位按。
          </Note>
        )}

        <Table
          caption="班級一覽"
          columns={[
            {
              key: 'name',
              head: '班級',
              cell: (c: Row) => (
                <Link href={`/classes/${c.id}`}>
                  {c.name}
                  {!c.active && <span className="yz-muted">（已封存）</span>}
                </Link>
              ),
            },
            { key: 'year', head: '學年度', cell: (c: Row) => c.academicYear.name },
            {
              key: 'n',
              head: '在籍',
              numeric: true,
              cell: (c: Row) => stat.get(c.id)?.active ?? 0,
            },
            {
              key: 'w',
              head: '未同意',
              numeric: true,
              cell: (c: Row) => {
                const n = stat.get(c.id)?.waiting ?? 0;
                return n > 0 ? (
                  <Link href={`/classes/${c.id}`} className="yz-warn">
                    {n}
                  </Link>
                ) : (
                  ''
                );
              },
            },
            {
              key: 'g',
              head: <span className="yz-sr">成績</span>,
              cell: (c: Row) => <Link href={`/classes/${c.id}/grades`}>整學期成績</Link>,
            },
          ]}
          rows={classes}
          rowKey={(c) => c.id}
          empty={
            <Empty
              title={
                isAdmin
                  ? picked
                    ? `${picked.name}還沒有班級`
                    : '還沒有任何班級'
                  : '你還沒有帶任何班，也沒有被指派授課'
              }
              hint={
                isAdmin
                  ? picked
                    ? '這一年還沒有開班。換一個學年度看看，或直接開一個。'
                    : '建一個班，然後匯入名冊。之後派任務、看成績都以班為單位。'
                  : '請管理員把你指派成某個班某一科的授課老師，或加進該班的名冊當導師。'
              }
            />
          }
        />
      </main>
    );
  });
}
