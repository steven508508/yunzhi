import Link from 'next/link';
import { notFound } from 'next/navigation';

import { isHomeroomOf } from '@/lib/auth';
import { mayUse } from '@/lib/nav';
import { prisma } from '@/lib/prisma';
import { scopedPage } from '@/lib/page';
import { Denied, Empty, Note } from '@/components/Feedback';
import { Table } from '@/components/Table';
import ConsentButton from './ConsentButton';
import { LeaveClass, RejoinClass } from './Membership';
import { ResetClass, ResetOne } from './ResetPassword';
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
    // 下面的成員檢查對學生是**通過**的（他確實在這個班裡），
    // 所以角色要先擋一次，否則學生看得到全班的家長信箱與帳號狀態。
    if (!mayUse(user.systemRole, '/classes')) {
      return (
        <main className="yz-panel">
          <Denied what="班級名冊" why="名冊含全班同學與家長的聯絡資料，只有老師與管理員看得到。" />
        </main>
      );
    }

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

    // 在名冊上的與已經移出的分兩次查，不是查回來再自己分。
    // 一次查完再分的話，兩份的排序、欄位、空狀態都得自己拼，而**已移出
    // 的那一份只會愈來愈長**（每一年的轉出都留在裡面）——把它與在籍
    // 的人放在同一個查詢裡，總有一天在籍名冊要等一份三年份的歷史查完。
    const memberSelect = {
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
    } as const;

    const members = await prisma.classMembership.findMany({
      where: { classId, leftAt: null, role: 'STUDENT' },
      include: memberSelect,
      orderBy: { joinedAt: 'asc' },
    });
    type Row = (typeof members)[number];

    const departed = await prisma.classMembership.findMany({
      where: { classId, leftAt: { not: null }, role: 'STUDENT' },
      include: memberSelect,
      // 最近移出的排最前面：要復原的多半是剛剛按錯的那一位。
      orderBy: { leftAt: 'desc' },
    });

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
                ) : mayEdit ? (
                  // 沒有這顆按鈕的話，匯入名冊建出來的帳號永遠登不進去，
                  // 而系統裡沒有任何方式可以解決——那是一條死路。
                  <ConsentButton studentId={m.user.id} studentName={m.user.displayName} />
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
            ...(mayEdit
              ? [
                  {
                    key: 'x',
                    // 表頭視覺上留白，但不能真的是空的——讀螢幕的人
                    // 聽到的會是一個沒有名字的欄位。
                    head: <span className="yz-sr">操作</span>,
                    cell: (m: Row) => (
                      <span className="yz-rowacts">
                        {/* 重設密碼排在移出前面：它一天會被按好幾次，
                            移出一學期按幾次。破壞性的那一個不該擋在
                            常用的那一個前面。 */}
                        <ResetOne
                          studentId={m.user.id}
                          studentName={m.user.displayName}
                          username={m.user.username}
                        />
                        <LeaveClass
                          classId={classId}
                          className={klass.name}
                          studentId={m.user.id}
                          studentName={m.user.displayName}
                        />
                      </span>
                    ),
                  },
                ]
              : []),
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

        {/* 已移出的人收起來。攤開來的話，一個帶了三年的班級名冊上
            會有一半是已經不在的人，而老師每天要看的是在籍的那一半。
            但也不能不顯示：看不到就復原不了，而「不小心把人移出了」
            是這一頁最可能發生的誤操作。 */}
        {mayEdit && departed.length > 0 && (
          <details className="yz-fold">
            <summary className="yz-fold__head">
              已移出的學生（{departed.length}）
            </summary>
            <div className="yz-fold__body">
              <p className="yz-hint" style={{ marginBottom: 10 }}>
                這些人<strong>不會收到這個班的新任務</strong>，也不算進應交人數。
                他們過去的作答與成績都還在，仍然對得回這個班——
                移出寫的是離班日期，不是刪掉那一列。
              </p>
              <Table
                caption={`${klass.name}已移出的學生`}
                columns={[
                  { key: 'u', head: '學號', cell: (m: Row) => m.user.username },
                  { key: 'n', head: '姓名', cell: (m: Row) => m.user.displayName },
                  {
                    key: 'l',
                    head: '移出日期',
                    cell: (m: Row) => m.leftAt?.toLocaleDateString('zh-TW') ?? '—',
                  },
                  {
                    key: 'x',
                    head: <span className="yz-sr">操作</span>,
                    cell: (m: Row) => (
                      <RejoinClass classId={classId} studentId={m.user.id} />
                    ),
                  },
                ]}
                rows={departed}
                rowKey={(m) => m.id}
                empty={<Empty title="沒有已移出的學生" />}
              />
            </div>
          </details>
        )}

        {/* 整班重設密碼擺在最下面，而且與名冊之間隔著一段。
            它是這一頁最危險的動作（全班現有的密碼同時失效），
            不該與每天在按的那幾顆放在一起。 */}
        {mayEdit && members.length > 0 && (
          <div className="yz-danger">
            <h2 className="yz-card__title">整批處理</h2>
            <p className="yz-hint" style={{ marginBottom: 10 }}>
              重設全班密碼會讓這 {members.length} 位學生<strong>現在的密碼同時失效</strong>，
              包含已經改過、自己記得的人。只有一位登不進去的話，
              請用上面名冊那一列的「重設密碼」。
            </p>
            <ResetClass
              classId={classId}
              className={klass.name}
              students={members.length}
            />
          </div>
        )}
      </main>
    );
  });
}
