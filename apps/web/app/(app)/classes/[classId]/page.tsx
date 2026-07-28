import Link from 'next/link';
import { notFound } from 'next/navigation';

import { isHomeroomOf } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { scopedPage } from '@/lib/page';
import { Denied, Empty, Note } from '@/components/Feedback';
import { Table } from '@/components/Table';
import RosterImport from './RosterImport';

export const dynamic = 'force-dynamic';

const ADMIN = new Set(['SYS_ADMIN', 'SCHOOL_ADMIN']);

export default async function ClassPage({
  params,
}: {
  params: Promise<{ classId: string }>;
}) {
  const { classId } = await params;
  return scopedPage(async (user) => {
    const klass = await prisma.class.findFirst({
      where: { id: classId },
      include: { academicYear: { select: { name: true } } },
    });
    if (!klass) notFound();

    const isAdmin = ADMIN.has(user.systemRole);
    const mine = await prisma.classMembership.findFirst({
      where: { classId, userId: user.id, leftAt: null },
      select: { id: true },
    });
    if (!isAdmin && !mine) {
      return (
        <main className="yz-panel">
          <Denied what={`「${klass.name}」的名冊`} why="你不在這個班的名冊裡。" />
        </main>
      );
    }
    const mayEdit = isAdmin || (await isHomeroomOf(user.id, classId));

    const members = await prisma.classMembership.findMany({
      where: { classId, leftAt: null, role: 'STUDENT' },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
            status: true,
            consentAt: true,
            guardianEmail: true,
          },
        },
      },
      orderBy: { joinedAt: 'asc' },
    });
    type Row = (typeof members)[number];

    const waiting = members.filter((m) => !m.user.consentAt).length;

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>{klass.name}</h1>
          <p className="yz-panel__sub">
            {klass.academicYear.name}　·　{members.length} 位學生
            {!klass.active && '　·　已停用'}
            　·　<Link href="/classes">回到班級列表</Link>
          </p>
        </div>

        {waiting > 0 && (
          <Note tone="warn">
            有 {waiting} 位學生還沒有法定代理人的同意紀錄，帳號無法登入。
            個資法第 15 條要求蒐集未成年人的個人資料需法定代理人同意——
            這不是形式，沒有同意紀錄，這些資料的蒐集就沒有依據。
          </Note>
        )}

        {mayEdit && <RosterImport classId={classId} className={klass.name} />}

        <Table
          caption={`${klass.name}的學生名冊`}
          columns={[
            { key: 'u', head: '學號', cell: (m: Row) => m.user.username },
            { key: 'n', head: '姓名', cell: (m: Row) => m.user.displayName },
            {
              key: 'c',
              head: '家長同意',
              cell: (m: Row) =>
                m.user.consentAt ? (
                  <span title={m.user.consentAt.toLocaleDateString('zh-TW')}>已取得</span>
                ) : (
                  <span className="yz-warn">未取得</span>
                ),
            },
            {
              key: 'g',
              head: '家長信箱',
              cell: (m: Row) =>
                m.user.guardianEmail ?? <span className="yz-muted">未填</span>,
            },
            {
              key: 's',
              head: '帳號狀態',
              cell: (m: Row) =>
                m.user.status === 'ACTIVE' ? (
                  '可登入'
                ) : m.user.status === 'PENDING_CONSENT' ? (
                  <span className="yz-warn">等待同意</span>
                ) : (
                  m.user.status
                ),
            },
          ]}
          rows={members}
          rowKey={(m) => m.id}
          empty={
            <Empty
              title="這個班還沒有學生"
              hint={
                mayEdit
                  ? '用 CSV 匯入整份名冊。Excel 存出來的 Big5 也讀得懂，不必先轉檔。'
                  : '要調整名冊請找該班導師或管理員。'
              }
            />
          }
        />
      </main>
    );
  });
}
