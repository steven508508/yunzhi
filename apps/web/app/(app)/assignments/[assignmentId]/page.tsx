/**
 * 一份任務的內頁：**派給了誰、誰開了、誰交了、誰還沒動。**
 *
 * # 這一頁補的是「我沒收到」這句話的起點
 *
 * `resolveRecipients` 回的形狀正好就是這一頁要的（姓名、學號、帳號
 * 狀態、透過哪幾個班收到、是不是個別指定），而它的畫面呼叫端只做了
 * `return { recipients: recipients.length }`——**名單當場丟掉，只留
 * 一個數字**。於是老師手上是「派給 31 人」而班上有 32 個人，少的那
 * 一個是誰，系統一個字都不說。
 *
 * 而成績頁只查 `Attempt`：連考卷都沒打開的那一位在那一頁的每一塊裡
 * 都不存在——不在全班表、不在未完成、不在已作廢。他徹底隱形。
 *
 * # 三個現場狀況在同一頁上解決
 *
 *   · **「我的清單裡沒有這份考試」**——收件名單直接列出來，而且標出
 *     帳號還沒有家長同意所以登不進來的那幾位（`Recipient.status` 的
 *     註解本來就寫著「畫面上要標出來」）。
 *   · **「全班斷網十分鐘」**——延長作答時間就在這一頁上，而它是全系統
 *     唯一改得動 `expiresAt` 的地方。
 *   · **「3 個人卡在進行中」**——首頁待辦點過去是 `/grades` 列表，而
 *     那張表沒有任何一欄指出是哪一份。這一頁是那個連結該去的地方。
 *
 * # 為什麼權限與成績頁同一條而不是與任務列表同一條
 *
 * 列表頁對全機構的老師開放（要看得到別人派了什麼才不會撞課），
 * 它只有數字。這一頁有全班的姓名與學號，那是 `mayViewGrades` 管的
 * 東西——**列表濾掉不等於內頁擋住**，而這一類漏洞最常見的形狀正是
 * 「把網址列的 id 換成別科那一份」。
 *
 * # 考試行為那一段只陳述事實
 *
 * 「切走 14 次、最長一次 4 分鐘」是事實，「疑似作弊」是判斷——而判斷
 * 是老師的事。理由寫在 schema.prisma 的 `ProctorEvent` 註解裡：
 * 瀏覽器層的偵測一定有偽陽性（來電、通知、輸入法、螢幕旋轉都會產生
 * 同樣的訊號），而自動判定的代價是一位沒有作弊的學生在考試中被踢出去。
 *
 * 所以這一段上沒有分數、沒有等級、沒有紅色的「可疑」標籤，只有數字與
 * 一句可以驗證的比較（「全班中位數 2 次」）。老師看完之後要做的事
 * ——作廢那一份——用的是既有的入口（`VoidOne`，要填理由、進稽核、
 * 可撤銷），不另做一套。
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Denied, Empty, Note } from '@/components/Feedback';
import { Table } from '@/components/Table';
import {
  assignmentRoster,
  paperCohort,
  unfinishedCohort,
  type RosterEntry,
} from '@/lib/assignment';
import { mayComposeArea } from '@/lib/paper';
import { scopedPage } from '@/lib/page';
import { durationText, PROCTOR } from '@/lib/proctor.mjs';
import { assignmentProctorReport, type ProctorStudentRow } from '@/lib/proctorDb';
import { mayGrade, mayViewGrades } from '@/lib/scoring';
import { FinalizeOne } from '../../grades/[assignmentId]/Finalize';
import { UnvoidOne, VoidOne } from '../../grades/[assignmentId]/Void';
import { AssignmentClock, ExtendOne } from './Clock';

export const dynamic = 'force-dynamic';

const MODE: Record<string, string> = { EXAM: '正式測驗', PRACTICE: '練習' };

const POLICY: Record<string, string> = {
  IMMEDIATE: '每題作答後',
  ON_SUBMIT: '交卷後',
  ON_DUE: '截止後',
  MANUAL: '老師手動放行',
  NEVER: '不開放',
};

/** 帳號狀態。**只有進不來的那幾種要說話**，正常的留白。 */
const ACCOUNT_TROUBLE: Record<string, string> = {
  PENDING_CONSENT: '還沒有家長同意，登不進來',
  SUSPENDED: '帳號已停用，登不進來',
};

/**
 * 給人看的時刻。
 *
 * **一定要指定台北時區。** 資料庫存 UTC 而伺服器多半也跑在 UTC，
 * 不指定的話「15:00 到期」會被印成 07:00——而老師會照著它判斷
 * 一位學生是不是真的斷線了。
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

export default async function AssignmentDetailPage({
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
            what="任務內頁"
            why="這裡是老師派任務的地方。學生看到的是自己的任務清單。"
          />
        </main>
      );
    }

    const roster = await assignmentRoster(assignmentId);
    if (!roster) notFound();

    if (
      !(await mayViewGrades(user, { subjectId: roster.subjectId, createdBy: roster.createdBy }))
    ) {
      return (
        <main className="yz-panel">
          <Denied
            what="這份任務的收件名單"
            why={
              <>
                名單含每一位學生的姓名與學號，只看得到自己教的科目，
                以及自己派出去的任務。
                　<Link href="/assignments">回到任務列表</Link>
              </>
            }
          />
        </main>
      );
    }

    // 改得動進行中的作答（延長、結束、代為結算、作廢）＝ 與改分數同一條。
    const mayEdit = await mayGrade(user, roster.subjectId);

    // 同一份卷子還被哪些任務用著。**這一句以前全 repo 不存在**，
    // 而它正是跨班洩題那個洞的偵測方式。
    const cohort = await paperCohort(roster.paperId, roster.assignmentId);
    const pending = unfinishedCohort(cohort);

    // 考試行為。**只有真的有人開過考卷才查**——沒有作答就沒有事件，
    // 而多一次查詢會出現在每一次打開這一頁的時候。
    const proctor = roster.started > 0 ? await assignmentProctorReport(roster.assignmentId) : null;

    const running = roster.entries.filter((e) => e.state === 'IN_PROGRESS');
    const stranded = running.filter((e) => e.stranded);
    const missing = roster.entries.filter((e) => e.state === 'UNTOUCHED');
    const blocked = missing.filter((e) => ACCOUNT_TROUBLE[e.status]);

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>{roster.title}</h1>
          <p className="yz-panel__sub">
            {roster.paperTitle}　·　{roster.subjectName}　·　{MODE[roster.mode] ?? roster.mode}
            　·　{roster.questionCount} 題
            <br />
            開放 {when(roster.openAt)} → 截止 {when(roster.dueAt)}　·
            時限 {roster.timeLimitMin ? `${roster.timeLimitMin} 分` : '不限'}　·
            可作答 {roster.maxAttempts} 次{roster.allowLate && '　·　收遲交'}　·
            成績與解析：{POLICY[roster.releasePolicy] ?? roster.releasePolicy}
            <br />
            <Link href="/assignments">回到任務列表</Link>
            　·　<Link href={`/grades/${roster.assignmentId}`}>看全班成績</Link>
            　·　<Link href={`/papers/${roster.paperId}`}>看這份卷子</Link>
          </p>
        </div>

        {/* 跨班洩題的警告擺最前面：它是這一頁上唯一一件「不處理就會
            自動出事」的事，而出事的時刻是自動到來的（截止那一秒）。 */}
        {pending.length > 0 && roster.releasePolicy === 'ON_DUE' && (
          <Note tone="warn">
            這份卷子還有 {pending.length} 個任務沒有結束（
            {pending.map((a) => a.title).join('、')}）。這一份設定為「截止後開放」，
            所以 {when(roster.dueAt)} 之後這一班就看得到全部的答案與詳解——
            而那幾個班還沒考完。
            <strong>
              　系統已經把開放時刻自動延到最後一班結束為止
            </strong>
            ，不必手動改設定；要更保險，把這幾份都改成「老師手動放行」，
            等最後一班考完再一起放行。
          </Note>
        )}
        {pending.length > 0 && roster.releasePolicy !== 'ON_DUE' && (
          <Note tone="info">
            這份卷子還有 {pending.length} 個任務沒有結束（
            {pending.map((a) => a.title).join('、')}）。改這份卷子的題目或配分會
            同時影響那幾個班。
          </Note>
        )}

        {/* 四個數字。**應交來自收件名單，不是從作答記錄反推的**——
            少了它，「連考卷都沒打開的人」就沒有分母。 */}
        <dl className="yz-summary">
          <div>
            <dt>應交</dt>
            <dd>{roster.expected}</dd>
          </div>
          <div>
            <dt>已開始</dt>
            <dd>{roster.started}</dd>
          </div>
          <div>
            <dt>已交卷</dt>
            <dd>{roster.submitted}</dd>
          </div>
          <div>
            <dt>作答中</dt>
            <dd>{roster.inProgress || '—'}</dd>
          </div>
          <div>
            <dt>未動作</dt>
            <dd className={roster.untouched > 0 ? 'yz-warn' : undefined}>
              {roster.untouched || '—'}
            </dd>
          </div>
        </dl>

        {roster.expected === 0 && (
          <Note tone="warn">
            這份任務的實際收件人數是 0——通常是派給了一個還沒匯入名冊的班。
            它在列表上與正常的任務長得一模一樣，但沒有任何人收得到。
          </Note>
        )}

        {/* ── 進行中 ───────────────────────────────────────────── */}
        {(roster.inProgress > 0 || mayEdit) && (
          <section style={{ marginBottom: 22 }}>
            <h2 className="yz-grade-h">進行中的作答（{roster.inProgress}）</h2>
            {roster.inProgress === 0 ? (
              <p className="yz-grade-hint">
                現在沒有人在寫。延長時間只對進行中的作答有作用，
                已經交卷的分數不會因為任何設定而改變。
              </p>
            ) : (
              <p className="yz-grade-hint">
                這幾份開了但還沒交卷，所以<strong>不在成績頁的任何一個統計裡</strong>。
                {stranded.length > 0 && (
                  <>
                    　其中 <strong>{stranded.length} 份的作答時間已經結束</strong>，
                    系統不會再收他們的答案，也沒有人按下交卷——那幾份會一直停在這裡：
                    學生看不到分數，你也看不到他考了幾分。
                  </>
                )}
              </p>
            )}

            {mayEdit && (
              <AssignmentClock
                assignmentId={roster.assignmentId}
                inProgress={roster.inProgress}
              />
            )}

            {roster.inProgress > 0 && (
              <Table
                caption="還在進行中的作答"
                columns={[
                  { key: 'n', head: '姓名', cell: (r: RosterEntry) => r.displayName },
                  { key: 'u', head: '學號', cell: (r: RosterEntry) => r.username },
                  {
                    key: 'a',
                    head: '已作答',
                    numeric: true,
                    cell: (r: RosterEntry) => `${r.answered} / ${roster.questionCount}`,
                  },
                  { key: 's', head: '開始', cell: (r: RosterEntry) => when(r.startedAt) },
                  {
                    key: 'e',
                    head: '狀態',
                    cell: (r: RosterEntry) =>
                      r.stranded ? (
                        <span className="yz-warn">
                          {r.expiresAt ? `${when(r.expiresAt)} 時間到` : '已結束'}，未交卷
                        </span>
                      ) : (
                        <>
                          作答中
                          {r.expiresAt ? (
                            <span className="yz-grade__sub">{when(r.expiresAt)} 到期</span>
                          ) : (
                            <span className="yz-grade__sub">不限時</span>
                          )}
                        </>
                      ),
                  },
                  ...(mayEdit
                    ? [
                        {
                          key: 'x',
                          // 表頭視覺上留白，但不能真的是空的——讀螢幕的人
                          // 聽到的會是一個沒有名字的欄位。
                          head: <span className="yz-sr">操作</span>,
                          cell: (r: RosterEntry) => (
                            <span className="yz-rowacts">
                              {r.attemptId && r.expiresAt && (
                                <ExtendOne
                                  assignmentId={roster.assignmentId}
                                  attemptId={r.attemptId}
                                  who={r.displayName}
                                />
                              )}
                              {r.stranded && r.attemptId && (
                                <FinalizeOne
                                  attemptId={r.attemptId}
                                  who={r.displayName}
                                  answered={r.answered}
                                  total={roster.questionCount}
                                />
                              )}
                              {r.attemptId && (
                                <VoidOne
                                  attemptId={r.attemptId}
                                  who={r.displayName}
                                  wasSubmitted={false}
                                />
                              )}
                            </span>
                          ),
                        },
                      ]
                    : []),
                ]}
                rows={running}
                rowKey={(r) => r.userId}
                empty={<Empty title="沒有進行中的作答" />}
              />
            )}
          </section>
        )}

        {/* ── 未動作 ───────────────────────────────────────────── */}
        {missing.length > 0 && (
          <section style={{ marginBottom: 22 }}>
            <h2 className="yz-grade-h">還沒有開始作答（{missing.length}）</h2>
            <p className="yz-grade-hint">
              這幾位收到了這份任務，但<strong>連考卷都沒有打開過</strong>——
              他們在成績頁的每一塊裡都不存在。
              {blocked.length > 0 && (
                <>
                  　其中 <strong>{blocked.length} 位的帳號現在登不進來</strong>，
                  那不是他沒考，是他進不來。
                </>
              )}
            </p>
            <Table
              caption="還沒有開始作答的人"
              columns={[
                { key: 'n', head: '姓名', cell: (r: RosterEntry) => r.displayName },
                { key: 'u', head: '學號', cell: (r: RosterEntry) => r.username },
                {
                  key: 'c',
                  head: '從哪裡收到',
                  cell: (r: RosterEntry) =>
                    r.classNames.length > 0 ? (
                      r.classNames.join('、')
                    ) : (
                      <span className="yz-muted">個別指定</span>
                    ),
                },
                {
                  key: 's',
                  head: '帳號',
                  cell: (r: RosterEntry) =>
                    ACCOUNT_TROUBLE[r.status] ? (
                      <span className="yz-warn">{ACCOUNT_TROUBLE[r.status]}</span>
                    ) : (
                      <span className="yz-muted">可登入</span>
                    ),
                },
              ]}
              rows={missing}
              rowKey={(r) => r.userId}
              empty={<Empty title="每一位都動過了" />}
            />
          </section>
        )}

        {/* ── 考試行為 ─────────────────────────────────────────── */}
        {proctor && (
          <section style={{ marginBottom: 22 }}>
            <h2 className="yz-grade-h">考試行為</h2>
            {proctor.total === 0 ? (
              // 「沒有記錄」與「沒有人離開過」是兩件事，而畫面上很容易
              // 被讀成同一件。舊的作答、偵測上線之前考的那幾份、
              // 送不出去的瀏覽器，看起來全都是這個樣子。
              <p className="yz-grade-hint">
                這份任務目前<strong>沒有收到任何行為記錄</strong>。
                這句話的意思是「沒有收到訊號」，<strong>不等於「沒有人離開過考卷」</strong>
                ——在這個功能上線之前考的、或者瀏覽器送不出去的，都會是這個樣子。
              </p>
            ) : (
              <>
                <p className="yz-grade-hint">
                  學生的瀏覽器離開這份考卷幾次、多久、當時在第幾題。
                  系統<strong>不判斷這些是不是作弊</strong>——手機來電、系統通知、
                  切換輸入法、螢幕旋轉會產生一模一樣的訊號，而自動判定的代價是
                  一位沒有作弊的學生在考試中被踢出去。這裡只列事實。
                </p>

                {/* 全班都這樣的時候，這一段要擋在名單前面：老師的視線
                    一落到表格上就會挑出最上面那一位，而那時他挑到的
                    只是網路最差的那一位。 */}
                {proctor.baseline.widespread && (
                  <Note tone="info">
                    有作答的 {proctor.baseline.students} 位裡，{proctor.baseline.busy} 位都有{' '}
                    {PROCTOR.WIDESPREAD_MIN_COUNT} 次以上的離開記錄。全班一致的模式通常
                    來自環境而不是個人——同一個熱點斷斷續續、教室裡的裝置每隔幾分鐘
                    跳一次通知、某個瀏覽器版本在捲動時誤送訊號。
                    <strong>先看環境，不要先看人。</strong>
                    所以下面不標記任何一位「與全班不同」。
                  </Note>
                )}

                <Table
                  caption="每一位學生的考試行為"
                  columns={[
                    { key: 'n', head: '姓名', cell: (r: ProctorStudentRow) => r.displayName },
                    { key: 'u', head: '學號', cell: (r: ProctorStudentRow) => r.username },
                    {
                      key: 'c',
                      head: '離開次數',
                      numeric: true,
                      cell: (r: ProctorStudentRow) => r.summary.awayCount,
                    },
                    {
                      key: 't',
                      head: '總離開時間',
                      numeric: true,
                      cell: (r: ProctorStudentRow) => (
                        <>
                          {durationText(r.summary.awayMs)}
                          {/* 沒有回來的那幾次量不到長度，所以總時間是
                              **下限**而不是實際值。不講的話，「總共離開
                              12 秒」會被讀成「他只離開了 12 秒」。 */}
                          {r.summary.unfinished > 0 && (
                            <span className="yz-grade__sub">
                              另有 {r.summary.unfinished} 次沒有回來，長度不明
                            </span>
                          )}
                        </>
                      ),
                    },
                    {
                      key: 'm',
                      head: '最長一次',
                      numeric: true,
                      cell: (r: ProctorStudentRow) =>
                        r.summary.longestMs > 0 ? durationText(r.summary.longestMs) : '—',
                    },
                    {
                      key: 'o',
                      head: '其他',
                      cell: (r: ProctorStudentRow) => {
                        const bits: string[] = [];
                        if (r.summary.fullscreenExits > 0) {
                          bits.push(`離開全螢幕 ${r.summary.fullscreenExits} 次`);
                        }
                        if (r.summary.pastes > 0) {
                          // 只有字數。內容刻意不存——那可能是他自己打的草稿。
                          bits.push(`貼上 ${r.summary.pastes} 次共 ${r.summary.pasteChars} 字`);
                        }
                        return bits.length > 0 ? bits.join('、') : <span className="yz-muted">—</span>;
                      },
                    },
                    {
                      key: 'w',
                      head: '與全班的差別',
                      cell: (r: ProctorStudentRow) =>
                        r.why.length > 0 ? (
                          <span className="yz-proctor__why">{r.why.join('；')}</span>
                        ) : (
                          <span className="yz-muted">—</span>
                        ),
                    },
                    ...(mayEdit
                      ? [
                          {
                            key: 'x',
                            head: <span className="yz-sr">操作</span>,
                            cell: (r: ProctorStudentRow) =>
                              // 看到之後要做的事已經有了：作廢那一份
                              // （要填理由、進稽核、可撤銷）。這裡只是
                              // 把入口接上，不另做一套。
                              r.status === 'VOIDED' ? (
                                <UnvoidOne
                                  attemptId={r.attemptId}
                                  who={r.displayName}
                                  wasSubmitted={r.submittedAt != null}
                                />
                              ) : (
                                <VoidOne
                                  attemptId={r.attemptId}
                                  who={r.displayName}
                                  wasSubmitted={r.submittedAt != null}
                                />
                              ),
                          },
                        ]
                      : []),
                  ]}
                  rows={proctor.rows.filter((r) => r.summary.total > 0)}
                  rowKey={(r) => r.attemptId}
                  empty={<Empty title="沒有任何一位留下記錄" />}
                />

                <p className="yz-grade-hint">
                  {proctor.silent > 0 && (
                    <>
                      {/* 同上：沒有訊號不等於沒有離開。 */}
                      另外 {proctor.silent} 位沒有任何記錄——那代表沒有收到訊號，
                      不代表他一次都沒有切走。{' '}
                    </>
                  )}
                  <Link href={`/assignments/${roster.assignmentId}/proctor`}>
                    看每一位的時間軸（第幾題、什麼時候、多久）
                  </Link>
                </p>
              </>
            )}
          </section>
        )}

        {/* ── 全部收件名單 ─────────────────────────────────────── */}
        <details className="yz-fold" open={missing.length === 0 && roster.inProgress === 0}>
          <summary className="yz-fold__head">收件名單（{roster.expected}）</summary>
          <div className="yz-fold__body">
            <p className="yz-grade-hint">
              這是這份任務<strong>實際</strong>派給的人：班級成員加上個別指定的，去重。
              已離班的、名冊裡的老師與助教都不算——所以它與班級人數不一定相同。
            </p>
            <Table
              caption="收件名單"
              columns={[
                { key: 'n', head: '姓名', cell: (r: RosterEntry) => r.displayName },
                { key: 'u', head: '學號', cell: (r: RosterEntry) => r.username },
                {
                  key: 'c',
                  head: '從哪裡收到',
                  cell: (r: RosterEntry) =>
                    r.classNames.length > 0 ? (
                      <>
                        {r.classNames.join('、')}
                        {r.individual && <span className="yz-grade__sub">另外個別指定</span>}
                      </>
                    ) : (
                      <span className="yz-muted">個別指定</span>
                    ),
                },
                {
                  key: 'st',
                  head: '狀態',
                  cell: (r: RosterEntry) =>
                    r.state === 'SUBMITTED' ? (
                      <>
                        已交卷
                        <span className="yz-grade__sub">{when(r.submittedAt)}</span>
                      </>
                    ) : r.state === 'IN_PROGRESS' ? (
                      r.stranded ? (
                        <span className="yz-warn">時間到，未交卷</span>
                      ) : (
                        '作答中'
                      )
                    ) : r.state === 'VOIDED' ? (
                      <span className="yz-warn">已作廢</span>
                    ) : ACCOUNT_TROUBLE[r.status] ? (
                      <span className="yz-warn">{ACCOUNT_TROUBLE[r.status]}</span>
                    ) : (
                      <span className="yz-warn">未動作</span>
                    ),
                },
                {
                  key: 'sc',
                  head: '得分',
                  numeric: true,
                  cell: (r: RosterEntry) =>
                    r.state === 'SUBMITTED' && r.attemptId ? (
                      <Link href={`/grades/${roster.assignmentId}/${r.attemptId}`}>
                        {r.totalScore ?? '未計分'}
                      </Link>
                    ) : (
                      <span className="yz-muted">—</span>
                    ),
                },
              ]}
              rows={roster.entries}
              rowKey={(r) => r.userId}
              empty={
                <Empty
                  title="沒有任何人收到這份任務"
                  hint="選到的班可能還沒有匯入名冊，或者名冊裡沒有學生身分的成員。"
                />
              }
            />
          </div>
        </details>

        {/* 老師自己試考的那幾份。**不進應交人數也不進成績統計**，
            但一定要看得見——看不見的話，老師會以為自己那一次沒有存下來。 */}
        {roster.trials.length > 0 && (
          <p className="yz-grade-hint">
            另外有 {roster.trials.length} 份試考（
            {roster.trials.map((t) => t.displayName).join('、')}），
            不算在應交人數裡，也不進成績統計。
          </p>
        )}
      </main>
    );
  });
}
