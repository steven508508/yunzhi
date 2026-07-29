/**
 * 一份任務的考試行為時間軸：**每一位、每一次、第幾題、多久。**
 *
 * # 為什麼摘要不夠，一定要有這一頁
 *
 * 「切走 14 次、總共 3 分 20 秒」與「切走 14 次、其中一次 4 分鐘」是
 * 兩件完全不同的事，而摘要那一列說不出差別。更重要的是**分布**：
 * 平均散在整場考試的 14 次比較像網路或通知，全部集中在第 18 到 22 題
 * 那五分鐘裡的 14 次是另一回事——而那個形狀只有排成時間軸才看得出來。
 *
 * 題號在這裡才真的有用。老師要問的是「他是在難題上離開的嗎」，
 * 而那句話的答案是「第 14 題，離開 4 分 12 秒」。
 *
 * # 這一頁一樣不下判斷
 *
 * 事件的說法只描述動作，不描述動機（`eventText`：「切到別的分頁，
 * 47 秒後回來」，不是「離開考卷去查資料」）。沒有紅字、沒有標籤、
 * 沒有分數。理由在 schema.prisma 的 `ProctorEvent` 註解裡。
 *
 * 唯一的例外是「沒有回來」那幾列——它們要看得出來，因為那種離開的
 * 長度是量不到的，而畫面上不標的話它看起來像 0 秒。
 *
 * # 為什麼是獨立的一頁而不是任務內頁上的一塊
 *
 * 因為任務內頁是考試當天要看的東西（誰沒開、誰卡住、要不要延長），
 * 而這一頁是事後才看的。把三十個人的時間軸攤在那一頁上，會把
 * 「3 個人卡在進行中」推到螢幕外面去——而那一句才是當下要處理的。
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Denied, Empty, Note } from '@/components/Feedback';
import { Table } from '@/components/Table';
import { assignmentRoster } from '@/lib/assignment';
import { mayComposeArea } from '@/lib/paper';
import { scopedPage } from '@/lib/page';
import { durationText, eventText, PROCTOR } from '@/lib/proctor.mjs';
import {
  assignmentProctorReport,
  assignmentProctorTimelines,
  type ProctorEventRow,
  type ProctorStudentRow,
} from '@/lib/proctorDb';
import { mayGrade, mayViewGrades } from '@/lib/scoring';
import { UnvoidOne, VoidOne } from '../../../grades/[assignmentId]/Void';

export const dynamic = 'force-dynamic';

/**
 * 時間軸上的時刻要精確到秒。
 *
 * 分鐘不夠：連續的抖動合併之後仍然可能出現同一分鐘裡的兩列，而那時
 * 「09:41、09:41」看起來像重複的資料。**一定要指定台北時區**——
 * 資料庫存 UTC 而伺服器多半也跑在 UTC，不指定的話整份時間軸會整體
 * 平移八小時，而老師會拿它去對照監考記錄上的時刻。
 */
function hms(d: Date): string {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d);
}

/** 沒有回來的那幾列要看得出來，理由見檔頭。 */
function isOpenEnded(e: ProctorEventRow): boolean {
  return e.type === 'TAB_HIDDEN' || e.type === 'WINDOW_BLUR';
}

export default async function AssignmentProctorPage({
  params,
}: {
  params: Promise<{ assignmentId: string }>;
}) {
  const { assignmentId } = await params;

  return scopedPage(async (user) => {
    if (!mayComposeArea(user.systemRole, '/assignments')) {
      return (
        <main className="yz-panel">
          <Denied
            what="考試行為記錄"
            why="這裡是老師看監考記錄的地方。學生看到的是自己的任務清單。"
          />
        </main>
      );
    }

    const roster = await assignmentRoster(assignmentId);
    if (!roster) notFound();

    // 與任務內頁同一條權限。這一頁上有全班的姓名、學號，以及每一個人
    // 在考試中做了什麼——**比成績更敏感**，所以不可以比成績寬鬆。
    if (
      !(await mayViewGrades(user, { subjectId: roster.subjectId, createdBy: roster.createdBy }))
    ) {
      return (
        <main className="yz-panel">
          <Denied
            what="這份任務的考試行為記錄"
            why={
              <>
                記錄含每一位學生的姓名、學號與作答期間的行為，只看得到自己教的
                科目，以及自己派出去的任務。
                　<Link href="/assignments">回到任務列表</Link>
              </>
            }
          />
        </main>
      );
    }

    const mayEdit = await mayGrade(user, roster.subjectId);
    const report = await assignmentProctorReport(assignmentId);
    const timelines = await assignmentProctorTimelines(assignmentId);
    const withEvents = report.rows.filter((r) => r.summary.total > 0);

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>考試行為 · {roster.title}</h1>
          <p className="yz-panel__sub">
            {roster.paperTitle}　·　{roster.subjectName}　·
            有作答 {report.rows.length} 份，其中 {withEvents.length} 份有記錄
            <br />
            <Link href={`/assignments/${roster.assignmentId}`}>回到任務內頁</Link>
            　·　<Link href={`/grades/${roster.assignmentId}`}>看全班成績</Link>
          </p>
        </div>

        {/* 這一段擺在最前面而不是收在底下的說明裡：老師是帶著一個
            懷疑打開這一頁的，而那個懷疑會決定他怎麼讀下面每一列。 */}
        <Note tone="info">
          這些記錄是<strong>證據，不是判定</strong>。瀏覽器分不出「切出去查資料」與
          「手機來電、系統通知、切換輸入法、螢幕旋轉」——它們產生的訊號一模一樣。
          系統因此不會自動判定作弊、不會自動交卷、也不會鎖住學生的畫面：
          一位沒有作弊的學生在考試中被踢出去，那件事無法補救。
          怎麼處理是你的判斷，而處理的入口（作廢那一份、填理由、進稽核）就在下面。
        </Note>

        {report.baseline.widespread && (
          <Note tone="warn">
            有作答的 {report.baseline.students} 位裡，{report.baseline.busy} 位都有{' '}
            {PROCTOR.WIDESPREAD_MIN_COUNT} 次以上的離開記錄，中位數是{' '}
            {report.baseline.medianCount} 次。全班一致的模式通常來自環境而不是個人
            ——同一個熱點斷斷續續、教室裡的裝置每隔幾分鐘跳一次通知、
            某個瀏覽器版本在捲動時誤送訊號。<strong>先查環境。</strong>
          </Note>
        )}

        {withEvents.length === 0 ? (
          <Empty
            title="沒有任何一份留下記錄"
            hint="這代表沒有收到訊號，不代表沒有人離開過考卷——在這個功能上線之前考的、或者瀏覽器送不出去的，都會是這個樣子。"
            action={
              <Link href={`/assignments/${roster.assignmentId}`} className="yz-btn">
                回到任務內頁
              </Link>
            }
          />
        ) : (
          withEvents.map((r) => (
            <StudentTimeline
              key={r.attemptId}
              row={r}
              events={timelines.get(r.attemptId) ?? []}
              mayEdit={mayEdit}
            />
          ))
        )}

        {report.silent > 0 && (
          <p className="yz-grade-hint">
            另外 {report.silent} 份作答沒有任何記錄。同樣地，那代表沒有收到訊號，
            不代表那幾位一次都沒有切走。
          </p>
        )}
      </main>
    );
  });
}

/**
 * 一位學生的時間軸。
 *
 * 預設**摺起來**，只有被標為「與全班不同」的那幾位打開。三十個人的
 * 時間軸全部攤開有好幾百列，而老師要找的是形狀不是條目——攤開的
 * 結果是他捲了三頁之後放棄。
 */
function StudentTimeline({
  row,
  events,
  mayEdit,
}: {
  row: ProctorStudentRow;
  events: ProctorEventRow[];
  mayEdit: boolean;
}) {
  return (
    <details className="yz-fold yz-proctor__one" open={row.standsOut}>
      <summary className="yz-fold__head">
        {row.displayName}
        <span className="yz-proctor__sum">
          {row.username}　·　離開 {row.summary.awayCount} 次　·
          共 {durationText(row.summary.awayMs)}
          {row.summary.unfinished > 0 && `（另有 ${row.summary.unfinished} 次沒有回來）`}
          {row.summary.longestMs > 0 && `　·　最長 ${durationText(row.summary.longestMs)}`}
          {row.summary.fullscreenExits > 0 && `　·　離開全螢幕 ${row.summary.fullscreenExits} 次`}
          {row.summary.pastes > 0 &&
            `　·　貼上 ${row.summary.pastes} 次共 ${row.summary.pasteChars} 字`}
        </span>
      </summary>
      <div className="yz-fold__body">
        {row.why.length > 0 && (
          // 一句可以驗證的比較句，不是一個標籤。「切走 14 次，全班中位數
          // 2 次」老師可以自己去核對；「高風險」他只能相信。
          <p className="yz-proctor__why">與全班的差別：{row.why.join('；')}</p>
        )}
        {row.status === 'VOIDED' && (
          <Note tone="warn">這一份已經作廢，不計分也不進班級統計。</Note>
        )}

        <Table
          caption={`${row.displayName}的考試行為時間軸`}
          columns={[
            { key: 't', head: '時刻', cell: (e: ProctorEventRow) => hms(e.at) },
            {
              key: 'q',
              head: '第幾題',
              numeric: true,
              cell: (e: ProctorEventRow) =>
                e.questionOrder ?? <span className="yz-muted">—</span>,
            },
            {
              key: 'w',
              head: '發生什麼',
              cell: (e: ProctorEventRow) =>
                isOpenEnded(e) ? (
                  // 量不到長度的那幾種。不標的話它在畫面上看起來像 0 秒，
                  // 而它其實是這一份記錄裡最長的一次離開。
                  <span className="yz-warn">{eventText(e)}</span>
                ) : (
                  eventText(e)
                ),
            },
          ]}
          rows={events}
          rowKey={(e) => e.id}
          empty={<Empty title="這一份沒有記錄" />}
        />

        {mayEdit && (
          <p className="yz-proctor__act">
            {/* 既有的入口：要填理由、寫進稽核、可以撤銷。
                看到異常之後要做的事只有這一件，不另做一套。 */}
            {row.status === 'VOIDED' ? (
              <UnvoidOne
                attemptId={row.attemptId}
                who={row.displayName}
                wasSubmitted={row.submittedAt != null}
              />
            ) : (
              <VoidOne
                attemptId={row.attemptId}
                who={row.displayName}
                wasSubmitted={row.submittedAt != null}
              />
            )}
          </p>
        )}
      </div>
    </details>
  );
}
