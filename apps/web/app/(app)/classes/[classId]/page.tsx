import Link from 'next/link';
import { notFound } from 'next/navigation';

import { isHomeroomOf } from '@/lib/auth';
import { mayUse } from '@/lib/nav';
import { prisma } from '@/lib/prisma';
import { scopedPage } from '@/lib/page';
import {
  assignableStaff,
  classHomerooms,
  classSubjectTeachers,
  teachesClass,
} from '@/lib/teaching';
import { Denied, Empty, Note } from '@/components/Feedback';
import { Table } from '@/components/Table';
import ClassTools from './ClassTools';
import ConsentButton from './ConsentButton';
import ConsentBatch from './ConsentBatch';
import { LeaveClass, RejoinClass, TransferClass } from './Membership';
import { ResetClass, ResetOne } from './ResetPassword';
import RosterImport from './RosterImport';
import StudentEditor from './StudentEditor';
import Teachers from './Teachers';

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
    // 存取判定要**同時**看兩張表。在此之前只查 `ClassMembership`，
    // 而授課指派寫的是 `ClassSubjectTeacher`——於是一位被指派教這個班
    // 數學的老師整頁被 Denied，而重設密碼與登錄家長同意那兩支 API
    // 本來就允許他。**規則寫對了，畫面把它關起來了**，而畫面比 API 嚴
    // 是反的。理由詳見 `lib/teaching.ts` 的 `teachesClass`。
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
            what={`「${klass.name}」的名冊`}
            why="你不在這個班的名冊裡，也沒有被指派教這個班。請管理員把你加進授課老師名單。"
          />
        </main>
      );
    }

    const isHomeroom = !isAdmin && (await isHomeroomOf(user.id, classId));

    /**
     * 兩級權限，對得上兩支 API 各自的規則。
     *
     *   `mayManage`  管理員與導師。改名冊、移出、轉班、整班重設密碼、
     *                改學生資料、退補——與匯入名冊同一條規則
     *                （`POST /api/classes/[classId]/roster`）。
     *   `mayAssist`  再加上這個班的授課老師。重設一位的密碼、
     *                登錄家長同意——與那兩支路由允許的角色完全相同。
     *
     * 分成兩級是因為它們的後果不同：整班重設會讓 30 個人明天登不進來，
     * 單一位重設是急件（學生站在櫃檯說登不進去，現場的那一位老師就要
     * 處理得了）。合成一級的話，不是把急件關起來，就是把整班的權限
     * 發給每一位科任老師。
     */
    const mayManage = isAdmin || isHomeroom;
    const mayAssist = mayManage || teaching;

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

    const waiting = members.filter((m) => !m.user.consentAt);

    // 轉班的候選：其他還啟用中的班。只在真的可能用到時才查——
    // 科任老師轉不了班，多一次查詢換一個他按不到的下拉沒有意義。
    const transferTargets = mayManage
      ? await prisma.class.findMany({
          where: { active: true, id: { not: classId } },
          orderBy: [{ academicYear: { startDate: 'desc' } }, { name: 'asc' }],
          select: { id: true, name: true, academicYear: { select: { name: true } } },
          // 轉班的下拉不該是一份三年份的班級史。夠用就好。
          take: 60,
        })
      : [];
    const targets = transferTargets.map((c) => ({
      id: c.id,
      name: c.name,
      year: c.academicYear.name,
    }));

    // 授課老師與導師只有管理員動得了（見 lib/teaching.ts 的檔頭：
    // 指派發出去的是權限，不是排課表）。所以不是管理員的話連查都不查
    // ——多四次查詢換一個他看不到的區塊，而班級頁是每天都會開的頁面。
    const [subjectTeachers, homerooms, staffPool, activeSubjects] = isAdmin
      ? await Promise.all([
          classSubjectTeachers(classId),
          classHomerooms(classId),
          assignableStaff(),
          // 只列啟用中的科目：停用的科目指派了也選不到，
          // 而伺服器端本來就會擋（見 lib/teaching.ts 的 loadTargets）。
          prisma.subject.findMany({
            where: { active: true },
            orderBy: { order: 'asc' },
            select: { id: true, name: true },
          }),
        ])
      : [null, null, null, null];

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>{klass.name}</h1>
          <p className="yz-panel__sub">
            {klass.academicYear.name}　·　{members.length} 位學生
            {!klass.active && '　·　已封存'}
            　·　<Link href="/classes">回到班級列表</Link>
            {' '}·{' '}
            <Link href={`/classes/${classId}/grades`}>這個班整學期的成績</Link>
            {' '}·{' '}
            {/* 成績回答「誰在退步」，能力分析回答「下一堂課要重講哪一個章節」。
                兩個問題不同，資料來源也不同，所以是兩頁。 */}
            <Link href={`/classes/${classId}/ability`}>能力分析</Link>
          </p>
        </div>

        {!klass.active && (
          <Note tone="warn">
            這個班已經封存。它不會出現在班級列表的預設檢視與派卷的班級清單上，
            但名冊、成績與作答都還在。要重新使用請按下面的「重新啟用」。
          </Note>
        )}

        {waiting.length > 0 && !mayAssist && (
          <Note tone="warn">
            有 {waiting.length} 位學生還沒有法定代理人的同意紀錄，帳號無法登入。
            個資法第 15 條要求蒐集未成年人的個人資料需法定代理人同意——
            這不是形式，沒有同意紀錄，這些資料的蒐集就沒有依據。
            要登錄請找該班導師或管理員。
          </Note>
        )}

        {/* 批次登錄排在名冊表格之前：它是這一頁上唯一一件「不做的話，
            剛匯進來的每一個帳號都登不進去」的事，而且它只在有人待處理
            時才出現——處理完就消失，不會變成永遠佔著版面的一塊。 */}
        {mayAssist && waiting.length > 0 && (
          <ConsentBatch
            classId={classId}
            className={klass.name}
            students={waiting.map((m) => ({
              id: m.user.id,
              username: m.user.username,
              displayName: m.user.displayName,
            }))}
          />
        )}

        {mayManage && <RosterImport classId={classId} className={klass.name} />}

        <Table
          caption={`${klass.name}的學生名冊`}
          columns={[
            { key: 'u', head: '學號', cell: (m: Row) => m.user.username },
            {
              key: 'n',
              head: '姓名',
              // 姓名是連結。在此之前它是純文字，而全系統沒有任何一頁
              // 以學生為單位——家長明天來約談，要回答「這學期考了幾次、
              // 哪一科在退步」，唯一的辦法是一份一份點進成績頁用 Ctrl+F
              // 找他的名字。
              cell: (m: Row) => (
                <Link href={`/classes/${classId}/students/${m.user.id}`}>
                  {m.user.displayName}
                </Link>
              ),
            },
            {
              key: 'c',
              head: '家長同意',
              cell: (m: Row) =>
                m.user.consentAt ? (
                  <span title={m.user.consentAt.toLocaleDateString('zh-TW')}>已取得</span>
                ) : mayAssist ? (
                  // 沒有這顆按鈕的話，匯入名冊建出來的帳號永遠登不進去，
                  // 而系統裡沒有任何方式可以解決——那是一條死路。
                  // 整批那一顆在上面，這一顆留給「只有他的回條今天到」。
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
                ) : m.user.status === 'ARCHIVED' ? (
                  <span className="yz-warn">已退補</span>
                ) : (
                  m.user.status
                ),
            },
            ...(mayAssist
              ? [
                  {
                    key: 'x',
                    // 表頭視覺上留白，但不能真的是空的——讀螢幕的人
                    // 聽到的會是一個沒有名字的欄位。
                    head: <span className="yz-sr">操作</span>,
                    cell: (m: Row) => (
                      <span className="yz-rowacts">
                        {/* 重設密碼排在最前面：它一天會被按好幾次，
                            編輯與移出一學期按幾次。破壞性的那一個不該
                            擋在常用的那一個前面。 */}
                        <ResetOne
                          studentId={m.user.id}
                          studentName={m.user.displayName}
                          username={m.user.username}
                        />
                        {mayManage && (
                          <>
                            <StudentEditor
                              student={{
                                id: m.user.id,
                                username: m.user.username,
                                displayName: m.user.displayName,
                                guardianEmail: m.user.guardianEmail,
                                status: m.user.status,
                              }}
                              mayErase={isAdmin}
                            />
                            <TransferClass
                              classId={classId}
                              className={klass.name}
                              studentId={m.user.id}
                              studentName={m.user.displayName}
                              targets={targets}
                            />
                            <LeaveClass
                              classId={classId}
                              className={klass.name}
                              studentId={m.user.id}
                              studentName={m.user.displayName}
                            />
                          </>
                        )}
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
                mayManage
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
        {mayManage && departed.length > 0 && (
          <details className="yz-fold">
            <summary className="yz-fold__head">
              已移出的學生（{departed.length}）
            </summary>
            <div className="yz-fold__body">
              <p className="yz-hint" style={{ marginBottom: 10 }}>
                這些人<strong>不會收到這個班的新任務</strong>，也不算進應交人數。
                他們過去的作答與成績都還在，仍然對得回這個班——
                移出寫的是離班日期，不是刪掉那一列。
                他們自己的清單上看不到這個班的檢討了，但點姓名進去拿得到那些網址。
              </p>
              <Table
                caption={`${klass.name}已移出的學生`}
                columns={[
                  { key: 'u', head: '學號', cell: (m: Row) => m.user.username },
                  {
                    key: 'n',
                    head: '姓名',
                    cell: (m: Row) => (
                      <Link href={`/classes/${classId}/students/${m.user.id}`}>
                        {m.user.displayName}
                      </Link>
                    ),
                  },
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

        {/* 授課老師排在名冊之後：開一個班的順序就是「先有學生，
            再決定誰教他們」，而且指派時要選的科目與人都與名冊無關，
            混在名冊表格旁邊只會讓每天在看名冊的人多掃過一區。 */}
        {subjectTeachers && homerooms && staffPool && activeSubjects && (
          <Teachers
            classId={classId}
            className={klass.name}
            subjects={activeSubjects}
            candidates={staffPool.map((s) => ({
              id: s.id,
              displayName: s.displayName,
              username: s.username,
            }))}
            teachers={subjectTeachers.map((t) => ({
              id: t.id,
              subjectId: t.subjectId,
              subjectName: t.subject.name,
              subjectActive: t.subject.active,
              userId: t.userId,
              teacherName: t.user.displayName,
              teacherUsername: t.user.username,
              teacherActive: t.user.status === 'ACTIVE',
              isPrimary: t.isPrimary,
            }))}
            homerooms={homerooms.map((h) => ({
              id: h.id,
              userId: h.userId,
              teacherName: h.user.displayName,
              teacherUsername: h.user.username,
              teacherActive: h.user.status === 'ACTIVE',
            }))}
          />
        )}

        {/* 整班重設密碼與封存擺在最下面，而且與名冊之間隔著一段。
            它們是這一頁最危險的動作，不該與每天在按的那幾顆放在一起。 */}
        {mayManage && (
          <div className="yz-danger">
            <h2 className="yz-card__title">整批處理</h2>
            {members.length > 0 && (
              <>
                <p className="yz-hint" style={{ marginBottom: 10 }}>
                  重設全班密碼會讓這 {members.length} 位學生
                  <strong>現在的密碼同時失效</strong>，包含已經改過、自己記得的人。
                  只有一位登不進去的話，請用上面名冊那一列的「重設密碼」。
                  <strong>新密碼只顯示那一次</strong>，畫面上有「列印這一頁」——
                  離開之前一定要印，否則隔天早上這 {members.length} 個人都登不進來。
                </p>
                <ResetClass
                  classId={classId}
                  className={klass.name}
                  students={members.length}
                />
              </>
            )}
            {isAdmin && (
              <div style={{ marginTop: members.length > 0 ? 16 : 0 }}>
                <p className="yz-hint" style={{ marginBottom: 10 }}>
                  改班名會同時改掉學生畫面上看到的名稱。封存把這個班從列表與派卷的
                  勾選清單上收起來，名冊與成績都留著。
                </p>
                <ClassTools
                  classId={classId}
                  className={klass.name}
                  active={klass.active}
                  members={members.length}
                />
              </div>
            )}
          </div>
        )}
      </main>
    );
  });
}
