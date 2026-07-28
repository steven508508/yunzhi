import Link from 'next/link';

import { prisma } from '@/lib/prisma';
import { scopedPage } from '@/lib/page';
import { mayUse } from '@/lib/nav';
import { Denied, Empty } from '@/components/Feedback';
import { Table } from '@/components/Table';
import NewClass from './NewClass';

export const dynamic = 'force-dynamic';

const ADMIN = new Set(['SYS_ADMIN', 'SCHOOL_ADMIN']);

export default async function ClassesPage() {
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
    const [classes, years] = await Promise.all([
      prisma.class.findMany({
        where: isAdmin
          ? {}
          : { memberships: { some: { userId: user.id, leftAt: null } } },
        orderBy: [{ active: 'desc' }, { name: 'asc' }],
        include: {
          academicYear: { select: { name: true, isCurrent: true } },
          _count: { select: { memberships: true } },
        },
      }),
      prisma.academicYear.findMany({ orderBy: { startDate: 'desc' } }),
    ]);

    type Row = (typeof classes)[number];

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>班級</h1>
          <p className="yz-panel__sub">
            班級是派任務、看成績、算能力分析的單位。學生要先在某個班裡，
            才收得到任何東西。
          </p>
        </div>

        {isAdmin && years.length > 0 && <NewClass years={years.map((y) => ({ id: y.id, name: y.name, isCurrent: y.isCurrent }))} />}
        {isAdmin && years.length === 0 && (
          <Empty
            title="還沒有學年度"
            hint="班級要掛在某個學年度底下，所以要先有學年度才開得了班。"
            action={<Link href="/settings/years">建立學年度</Link>}
          />
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
                  {!c.active && <span className="yz-muted">（已停用）</span>}
                </Link>
              ),
            },
            { key: 'year', head: '學年度', cell: (c: Row) => c.academicYear.name },
            {
              key: 'n',
              head: '人數',
              numeric: true,
              cell: (c: Row) => c._count.memberships,
            },
          ]}
          rows={classes}
          rowKey={(c) => c.id}
          empty={
            <Empty
              title={isAdmin ? '還沒有任何班級' : '你還沒有帶任何班'}
              hint={
                isAdmin
                  ? '建一個班，然後匯入名冊。之後派任務、看成績都以班為單位。'
                  : '要看到班級，請管理員把你加進該班的名冊。'
              }
            />
          }
        />
      </main>
    );
  });
}
