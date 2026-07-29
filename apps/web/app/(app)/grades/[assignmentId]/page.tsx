/**
 * 一份任務的全班成績。
 *
 * 老師來這一頁做三件事，所以版面就是這三塊：
 *
 *   **誰考幾分**（全班列表，依分數排序）
 *   **哪一題大家都不會**（各題答對率——這是老師最常看的東西，
 *     因為它直接決定下一堂課要重講什麼）
 *   **重新計分**（改了標準答案或送分之後）
 *
 * 另外放了一塊級分換算。班級人數幾乎一定不足以可靠換算級分，
 * 所以它多半顯示「人數不足」——**那不是缺陷，那就是它要說的話**。
 * 給出一個不可靠的級分，學生會當真並據以填志願，比不給更糟
 * （文件 03 第 6.4 節）。
 *
 * 後來補上的兩塊，都是為了「畫面完全正常但學生卡住了」的情況：
 *
 *   **放行**（`releasePolicy = MANUAL` 時）。沒有它，老師選了手動放行
 *     的那些考試，學生永遠看不到成績——而這一頁在放行前後長得一模一樣。
 *   **未完成的作答**。時間到了卻沒有人按下交卷的那幾份，在上面每一個
 *     統計裡都不存在，於是斷線的學生看起來就跟沒來考的人一樣。
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Denied, Empty, Note } from '@/components/Feedback';
import { Table } from '@/components/Table';
import { mayUse } from '@/lib/nav';
import { prisma } from '@/lib/prisma';
import { scopedPage } from '@/lib/page';
import { METHOD_LABELS } from '@/lib/gsat.mjs';
import { checkReleaseChange, releaseControl } from '@/lib/release.mjs';
import { updateAssignment } from '@/lib/assignment';
import { classStats, mayGrade, mayViewGrades, regradeAssignment } from '@/lib/scoring';
import { FinalizeOne } from './Finalize';
import { RegradeAll, RegradeOne } from './Regrade';
import { ReleaseControl } from './Release';
import { UnvoidOne, VoidOne } from './Void';

export const dynamic = 'force-dynamic';


/** 答對率的一條線。低於 40% 的用硃砂色——那是要重講的題目。 */
function Rate({ value }: { value: number | null }) {
  if (value === null) return <span className="yz-muted">—</span>;
  return (
    <span className={`yz-rate${value < 40 ? ' yz-rate--low' : ''}`}>
      <span className="yz-rate__num">{value}%</span>
      <span className="yz-rate__bar">
        <span className="yz-rate__fill" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </span>
    </span>
  );
}

/**
 * 給人看的時刻。
 *
 * **一定要指定台北時區。** 資料庫存 UTC 而伺服器多半也跑在 UTC，
 * 不指定的話「10:30 時間到」會被印成 02:30——老師會照著這個時間
 * 去判斷某個學生是不是真的斷線了，而那個判斷會是錯的。
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

const TYPE_LABELS: Record<string, string> = {
  SINGLE_CHOICE: '單選',
  MULTI_CHOICE: '多選',
  FILL_SLOT: '選填',
  FILL_TEXT: '填充',
  SHORT_ANSWER: '簡答',
  ESSAY: '申論',
  TRANSLATION: '翻譯',
  TRUE_FALSE: '是非',
};

export default async function AssignmentGradesPage({
  params,
}: {
  params: Promise<{ assignmentId: string }>;
}) {
  const { assignmentId } = await params;

  /**
   * 全班重新計分。
   *
   * **這是一個 server action，每次執行都是一次獨立的請求**——
   * 上面 render 時建立的租戶脈絡在這裡已經不存在了，所以要自己
   * 再包一次（`scopedPage` 做的正是登入檢查加租戶脈絡）。
   * 少了這一層，RLS 會讓它一筆資料都查不到。
   */
  async function regradeAll(reason: string) {
    'use server';
    return scopedPage(async (user) => {
      const target = await prisma.assignment.findFirst({
        where: { id: assignmentId },
        select: { paper: { select: { subjectId: true } } },
      });
      if (!target) return { error: '找不到這份任務' };
      if (!(await mayGrade(user, target.paper.subjectId))) {
        return { error: '只有這一科的授課老師與管理員可以重新計分' };
      }
      try {
        const r = await regradeAssignment(assignmentId, {
          actorId: user.id,
          reason: reason || undefined,
        });
        return {
          attempts: r.attempts,
          changedAttempts: r.changedAttempts,
          needsReview: r.needsReview,
          pendingManual: r.pendingManual,
          failures: r.failures.length,
        };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    });
  }

  /**
   * 放行／收回成績與檢討。
   *
   * 與 `regradeAll` 一樣是 server action，所以要自己再包一次
   * `scopedPage`——上面 render 時的租戶脈絡在這裡已經不存在了。
   *
   * # 為什麼權限多認一種人：任務的建立者
   *
   * 導師派一份跨科的小考是正常的事（`assignableClassIds` 允許班級職員
   * 派卷），而他不是那一科的授課老師。只認 `mayGrade` 的話，他派出去的
   * MANUAL 任務**只有別人放行得了**，而他不會知道要去找誰——這一頁上
   * 他看得到全班成績（`mayViewGrades` 認建立者），卻按不動放行鈕。
   *
   * 放行的後果是「我派出去的那一班看得到自己的分數」，範圍不會超出
   * 他本來就看得到的東西，所以與 `mayViewGrades` 對齊是安全的。
   */
  async function setReleased(release: boolean) {
    'use server';
    return scopedPage(async (user) => {
      const target = await prisma.assignment.findFirst({
        where: { id: assignmentId },
        select: {
          createdBy: true,
          releasePolicy: true,
          releasedAt: true,
          dueAt: true,
          paper: { select: { subjectId: true } },
        },
      });
      if (!target) return { error: '找不到這份任務' };

      const mine = target.createdBy === user.id;
      if (!mine && !(await mayGrade(user, target.paper.subjectId))) {
        return { error: '只有這一科的授課老師、管理員，或這份任務的派卷者可以放行成績' };
      }

      // 合不合法在純函式裡判（`lib/release.mjs`，有測試）：非 MANUAL 的
      // 任務寫 releasedAt 是一個看起來成功卻毫無作用的動作，而那正是
      // 這一整輪在清的那種錯。
      const allowed = checkReleaseChange(target, release);
      if (!allowed.ok) return { error: allowed.error };

      try {
        await updateAssignment(assignmentId, { released: release }, user);
        return { released: release };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    });
  }

  return scopedPage(async (user) => {
    if (!mayUse(user.systemRole, '/grades')) {
      return (
        <main className="yz-panel">
          <Denied
            what="全班成績"
            why="這一頁含全班每一位學生的分數，屬於老師的工作區。"
          />
        </main>
      );
    }

    const exists = await prisma.assignment.findFirst({
      where: { id: assignmentId },
      select: {
        id: true,
        createdBy: true,
        // 放行那一塊要這兩欄。順手查出來而不是另外一次往返：
        // 它們與權限判斷來自同一列。
        releasePolicy: true,
        releasedAt: true,
        paper: { select: { subjectId: true } },
      },
    });
    if (!exists) notFound();

    // **這一頁沒有這一道時，`/grades` 的科目過濾等於沒有用。**
    // 列表濾掉別科的任務，但任務 id 就在網址上——國文老師把它換成
    // 數學那一份的 id，就看得到那一班每一位學生的姓名、學號與分數。
    // 擋在這裡而不是只擋重新計分：外洩的是名單，不是按鈕。
    if (!(await mayViewGrades(user, { subjectId: exists.paper.subjectId, createdBy: exists.createdBy }))) {
      return (
        <main className="yz-panel">
          <Denied
            what="這份任務的成績"
            why={
              <>
                成績只看得到自己教的科目，以及自己派出去的任務。
                要看這一份，請該科的授課老師或學科召集人代為查看。
                　<Link href="/grades">回到成績列表</Link>
              </>
            }
          />
        </main>
      );
    }

    const mayEdit = await mayGrade(user, exists.paper.subjectId);
    const stats = await classStats(assignmentId);
    type ScoreRow = (typeof stats.scores)[number];
    type QRow = (typeof stats.questions)[number];
    type OpenRow = (typeof stats.unfinished)[number];
    type VoidRow = (typeof stats.voided)[number];

    const pct = (v: number | null) =>
      v === null || stats.maxScore === 0 ? null : Math.round((v / stats.maxScore) * 1000) / 10;

    // 放行狀態。判定與學生端共用 `lib/release.mjs`——兩邊分開寫的話，
    // 老師看到「已放行」而學生看到「還沒開放」，而那通電話查不出原因。
    const release = releaseControl(exists);
    // 派卷者也放行得了。理由見上面 `setReleased` 的註解。
    const mayRelease = mayEdit || exists.createdBy === user.id;
    // 會立刻看到成績的人數。**去重**：可作答多次的任務裡，一位學生
    // 有好幾份作答，用份數會讓確認視窗上的數字比實際人數大。
    const willSee = new Set(stats.scores.map((s) => s.userId)).size;

    // 時間到了卻還掛在進行中的那幾份。還在考試時間內的不算——
    // 那些人正在寫，放著就好，混在一起會讓老師以為每一份都要處理。
    const stranded = stats.unfinished.filter((u) => u.stranded);

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>{stats.title}</h1>
          <p className="yz-panel__sub">
            {stats.paperTitle}　·　{stats.subject.name}　·　卷面總分 {stats.maxScore} 分
            {stats.subject.gsatFullScore !== null &&
              `（學測滿分 ${stats.subject.gsatFullScore}）`}
            　·　<Link href="/grades">回到成績列表</Link>
          </p>
        </div>

        {/* 放行擺在最前面，而且在「還沒有人交卷」那一支之前——
            它是這一頁唯一一個「不按下去學生就永遠看不到東西」的動作，
            擺在表格後面等於藏起來。 */}
        {release.applicable &&
          (mayRelease ? (
            <ReleaseControl
              action={setReleased}
              released={release.released}
              note={release.note}
              affected={willSee}
            />
          ) : (
            // 看得到成績但放行不了的人（例如代課、或別科的召集人來看）
            // 也要知道現在的狀態，否則他會回報「學生說看不到成績」
            // 而不知道那是設定使然。
            <Note tone={release.released ? 'info' : 'warn'}>
              這份任務設定為老師手動放行。{release.note}
              {!release.released && '　放行請找這一科的授課老師或派卷的老師。'}
            </Note>
          ))}

        {/* 未完成的作答也在「還沒有人交卷」那一支之前。全班一個人都
            沒交、但有三個人卡在進行中，是真的會發生的情況，而那時候
            這一頁若只寫「還沒有人交卷」，老師就完全不知道發生了什麼。 */}
        {stats.unfinished.length > 0 && (
          <section style={{ marginBottom: 22 }}>
            <h2 className="yz-grade-h">未完成的作答</h2>
            <p className="yz-grade-hint">
              這幾份開了但沒有交卷，所以<strong>不在上面任何一個統計裡</strong>
              ——平均、答對率、交卷人數都沒有算他們。
              {stranded.length > 0 && (
                <>
                  　其中 <strong>{stranded.length} 份的作答時間已經結束</strong>
                  ，系統不會再收他們的答案，但也沒有人按下交卷，
                  所以那幾份會一直停在這裡：學生看不到分數，你也看不到他考了幾分。
                  {mayEdit ? '按「代為結算」把它收掉並計分。' : '請該科老師或管理員代為結算。'}
                </>
              )}
            </p>
            <Table
              caption="開了但還沒交卷的作答"
              columns={[
                { key: 'n', head: '姓名', cell: (r: OpenRow) => r.displayName },
                { key: 'u', head: '學號', cell: (r: OpenRow) => r.username },
                {
                  key: 'a',
                  head: '已作答',
                  numeric: true,
                  cell: (r: OpenRow) => `${r.answered} / ${stats.questions.length}`,
                },
                { key: 's', head: '開始', cell: (r: OpenRow) => when(r.startedAt) },
                {
                  key: 'e',
                  head: '狀態',
                  cell: (r: OpenRow) =>
                    r.stranded ? (
                      <span className="yz-warn">
                        {r.expiresAt ? `${when(r.expiresAt)} 時間到` : '已結束'}，未交卷
                      </span>
                    ) : (
                      <>
                        作答中
                        {r.expiresAt && (
                          <span className="yz-grade__sub">{when(r.expiresAt)} 到期</span>
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
                        cell: (r: OpenRow) => (
                          <span className="yz-rowacts">
                            {r.stranded ? (
                              <FinalizeOne
                                attemptId={r.attemptId}
                                who={r.displayName}
                                answered={r.answered}
                                total={stats.questions.length}
                              />
                            ) : (
                              // 還在考的不給結算鈕。把它畫出來然後按下去回一個
                              // 錯誤，等於讓老師去試——而他會以為是系統壞了。
                              <span className="yz-muted">還在作答時間內</span>
                            )}
                            {/* 作廢在這一列上不分卡住與否，因為它要處理的正是
                                「代為結算會給出一個不合理的分數」那一種：
                                教室跳電、機器當掉。作廢不佔作答次數，
                                所以學生還能重考一次——那比收下一個 12 分合理。 */}
                            <VoidOne
                              attemptId={r.attemptId}
                              who={r.displayName}
                              wasSubmitted={false}
                            />
                          </span>
                        ),
                      },
                    ]
                  : []),
              ]}
              rows={stats.unfinished}
              rowKey={(r) => r.attemptId}
              empty={<Empty title="沒有未完成的作答" />}
            />
          </section>
        )}

        {/* 已作廢的收起來，但一定要在頁面上。

            上面每一個統計都排除 VOIDED，所以作廢的那一份會從這一頁
            消失得乾乾淨淨——連同撤銷它的按鈕。誤判的那一次就永遠救不
            回來，而老師看到的只是一個從班上消失的學生。**有入口沒出口
            正是這一輪在清的東西，不能自己再造一個。**

            擺在交卷統計之前，是因為「全班 30 人只有 28 份成績」的疑問
            要在看到統計數字的當下就有答案。 */}
        {stats.voided.length > 0 && (
          <details className="yz-fold">
            <summary className="yz-fold__head">已作廢的作答（{stats.voided.length}）</summary>
            <div className="yz-fold__body">
              <p className="yz-grade-hint">
                這幾份<strong>不計分、不進上面任何一個統計</strong>——平均、答對率、
                級分換算與交卷人數都沒有算他們。學生那邊看到的是
                「這一份作答已經作廢，要知道原因或申請重考，請直接找老師」，
                不是一個分數。
                {mayEdit
                  ? '　作廢的原因記在稽核裡；誤判或申訴成立時按「撤銷作廢」。'
                  : '　要撤銷請找這一科的授課老師或管理員。'}
              </p>
              <Table
                caption="已作廢的作答"
                columns={[
                  { key: 'n', head: '姓名', cell: (r: VoidRow) => r.displayName },
                  { key: 'u', head: '學號', cell: (r: VoidRow) => r.username },
                  {
                    key: 's',
                    head: '作廢前的分數',
                    numeric: true,
                    cell: (r: VoidRow) =>
                      r.totalScore === null ? <span className="yz-muted">—</span> : r.totalScore,
                  },
                  {
                    key: 'b',
                    head: '交卷',
                    cell: (r: VoidRow) =>
                      r.submittedAt ? (
                        when(r.submittedAt)
                      ) : (
                        // 沒交卷就被作廢的那一種。撤銷之後會回到「進行中」
                        // 而不是「待評分」，所以要標出來——那兩種還原
                        // 結果差很多，見 Void.tsx。
                        <span className="yz-warn">未交卷</span>
                      ),
                  },
                  ...(mayEdit
                    ? [
                        {
                          key: 'x',
                          head: <span className="yz-sr">操作</span>,
                          cell: (r: VoidRow) => (
                            <UnvoidOne
                              attemptId={r.attemptId}
                              who={r.displayName}
                              wasSubmitted={r.submittedAt !== null}
                            />
                          ),
                        },
                      ]
                    : []),
                ]}
                rows={stats.voided}
                rowKey={(r) => r.attemptId}
                empty={<Empty title="沒有已作廢的作答" />}
              />
            </div>
          </details>
        )}

        {stats.submitted === 0 ? (
          <Empty
            title="還沒有人交卷"
            hint="學生交卷之後，客觀題會自動計分並出現在這裡。"
          />
        ) : (
          <>
            {stats.ungraded > 0 && (
              <Note tone="warn">
                有 {stats.ungraded} 份交了卷但還沒有分數。
                {mayEdit
                  ? '按「全班重新計分」把它們算出來。'
                  : '請該科老師或管理員重新計分。'}
              </Note>
            )}

            <dl className="yz-summary">
              <div>
                <dt>交卷</dt>
                <dd>{stats.submitted}</dd>
              </div>
              <div>
                <dt>平均</dt>
                <dd>{stats.mean ?? '—'}</dd>
              </div>
              <div>
                <dt>中位數</dt>
                <dd>{stats.median ?? '—'}</dd>
              </div>
              <div>
                <dt>最高</dt>
                <dd>{stats.max ?? '—'}</dd>
              </div>
              <div>
                <dt>最低</dt>
                <dd>{stats.min ?? '—'}</dd>
              </div>
            </dl>

            {/* 級分。多數情況下這一塊講的是「為什麼沒有級分」。 */}
            <p className="yz-grade-gsat">
              <b>模擬級分：{METHOD_LABELS[stats.gsat.method] ?? stats.gsat.method}</b>
              <span>{stats.gsat.note}</span>
            </p>

            {mayEdit && (
              <div className="yz-grade-act">
                {/* 份數傳進去是為了讓確認視窗說得出「這 37 位學生的分數會
                    重算」。「確定要重新計分嗎」沒有給老師任何判斷依據。 */}
                <RegradeAll action={regradeAll} affected={stats.submitted} />
              </div>
            )}

            <h2 className="yz-grade-h">全班</h2>
            <Table
              caption={`${stats.title}的全班成績`}
              columns={[
                { key: 'r', head: '#', numeric: true, cell: (_r: ScoreRow, i: number) => i + 1 },
                { key: 'n', head: '姓名', cell: (r: ScoreRow) => r.displayName },
                { key: 'u', head: '學號', cell: (r: ScoreRow) => r.username },
                {
                  key: 's',
                  head: '得分',
                  numeric: true,
                  cell: (r: ScoreRow) =>
                    r.totalScore === null ? <span className="yz-warn">未計分</span> : r.totalScore,
                },
                {
                  key: 'p',
                  head: '得分率',
                  numeric: true,
                  cell: (r: ScoreRow) => {
                    const v = pct(r.totalScore);
                    return v === null ? <span className="yz-muted">—</span> : `${v}%`;
                  },
                },
                {
                  key: 'q',
                  head: '百分位',
                  numeric: true,
                  cell: (r: ScoreRow) =>
                    r.percentile === null ? <span className="yz-muted">—</span> : r.percentile,
                },
                {
                  key: 'l',
                  head: '級分',
                  numeric: true,
                  cell: (r: ScoreRow) =>
                    r.level === null ? <span className="yz-muted">—</span> : r.level,
                },
                {
                  key: 'v',
                  head: '待確認',
                  numeric: true,
                  cell: (r: ScoreRow) =>
                    r.needsReview ? <span className="yz-warn">{r.needsReview}</span> : '',
                },
                {
                  key: 'x',
                  head: '狀態',
                  cell: (r: ScoreRow) => (
                    <>
                      {r.status === 'GRADED' ? '已評分' : '待評分'}
                      {r.late && <span className="yz-warn yz-muted">遲交</span>}
                    </>
                  ),
                },
                ...(mayEdit
                  ? [
                      {
                        key: 'a',
                        // 表頭視覺上留白，但不能真的是空的——讀螢幕的人
                        // 聽到的會是一個沒有名字的欄位。
                        head: <span className="yz-sr">操作</span>,
                        cell: (r: ScoreRow) => (
                          <span className="yz-rowacts">
                            <RegradeOne attemptId={r.attemptId} who={r.displayName} />
                            {/* 這一列上的每一份都交過卷了（`classStats` 只查
                                SUBMITTED / GRADED），所以 wasSubmitted 恆為 true
                                ——撤銷時會回到「待評分」而不是進行中。 */}
                            <VoidOne
                              attemptId={r.attemptId}
                              who={r.displayName}
                              wasSubmitted
                            />
                          </span>
                        ),
                      },
                    ]
                  : []),
              ]}
              rows={stats.scores}
              rowKey={(r) => r.attemptId}
              empty={<Empty title="沒有交卷記錄" />}
            />

            <h2 className="yz-grade-h">各題答對率</h2>
            <p className="yz-grade-hint">
              答對率的分母是交卷人數，<strong>未作答計為答錯</strong>——老師問的是
              「這一題全班有多少人會」。多選題的「平均得分率」會高於答對率，
              那個差就是部分給分吃掉的部分。
            </p>
            <Table
              caption="各題答對率"
              columns={[
                { key: 'o', head: '題號', numeric: true, cell: (q: QRow) => q.order },
                { key: 't', head: '題型', cell: (q: QRow) => TYPE_LABELS[q.type] ?? q.type },
                { key: 's', head: '配分', numeric: true, cell: (q: QRow) => q.score },
                { key: 'c', head: '答對率', cell: (q: QRow) => <Rate value={q.correctRate} /> },
                {
                  key: 'e',
                  head: '平均得分率',
                  numeric: true,
                  cell: (q: QRow) =>
                    q.earnedRate === null ? <span className="yz-muted">—</span> : `${q.earnedRate}%`,
                },
                {
                  key: 'v',
                  head: '待確認',
                  numeric: true,
                  cell: (q: QRow) =>
                    q.needsReview ? <span className="yz-warn">{q.needsReview}</span> : '',
                },
              ]}
              rows={stats.questions}
              rowKey={(q) => q.questionId}
              empty={<Empty title="這份卷子沒有題目" />}
            />
          </>
        )}
      </main>
    );
  });
}
