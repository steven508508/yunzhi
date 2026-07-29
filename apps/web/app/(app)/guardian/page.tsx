/**
 * 家長端：孩子的狀況。
 *
 * # 這一頁刻意不是一個儀表板
 *
 * 家長一個月看兩次，而且多半是在手機上、站著、一分鐘之內。他要的
 * 答案只有三句：**該交的交了沒、有沒有錯過什麼、最近考得怎麼樣。**
 *
 * 所以這裡沒有圖表、沒有百分位、沒有知識點掌握度。那些是老師的
 * 工作面板（`/classes/[classId]/students/[studentId]`），把它改個
 * 標題端給家長，結果是他每一項都看得懂字、但不知道自己該做什麼——
 * 然後打電話問老師，而那正是這一頁要省下來的那通電話。
 *
 * # 界線
 *
 * 資料全部來自 `lib/guardian.ts` 的 `childView`，而那一支是
 * **學生自己那份任務清單的投影**：欄位只減不加，放行時機
 * （`maySeeResult`）在來源那一側就算過了。這一頁不查任何東西，
 * 所以它加不了它不該有的欄位——逐題作答、智慧老師的對話、
 * 考試行為事件，這一頁連查詢都發不出去。完整說明見那個檔案的檔頭。
 *
 * # 為什麼空狀態要分四種
 *
 * 因為「空」的原因不同，家長的下一步就不同：孩子還沒排班（找櫃檯）、
 * 班上還沒派任務（等老師）、派了沒交（問孩子）、交了還沒放行（等老師）。
 * 四種都畫成一片空白的話，四種都會變成同一通電話。
 */
import Link from 'next/link';

import { Denied, Empty, Note } from '@/components/Feedback';
import { childrenOf, childView, type ChildTask } from '@/lib/guardian';
import { scopedPage } from '@/lib/page';

export const dynamic = 'force-dynamic';

/**
 * **一定要指定台北時區。** 資料庫存 UTC、伺服器多半跑 UTC，
 * 不指定的話 8/2 00:30（台北）會被印成 8/1——只差一天，而家長
 * 看到的是一個看起來完全正常的日期，然後以為孩子早就該交了。
 */
function day(iso: string | null): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: 'numeric',
    day: 'numeric',
  }).format(new Date(iso));
}

/** 「還有 3 天」。時程提醒要講剩多久，日期本身家長還要自己換算。 */
function within(iso: string | null, now: Date): string {
  if (!iso) return '';
  const days = Math.ceil((new Date(iso).getTime() - now.getTime()) / 86_400_000);
  if (days < 0) return '已經過期';
  if (days === 0) return '今天到期';
  if (days === 1) return '明天到期';
  return `還有 ${days} 天`;
}

const STATE_LABEL: Record<string, string> = {
  IN_PROGRESS: '寫到一半',
  OPEN: '還沒交',
  UPCOMING: '還沒開放',
  DONE: '已完成',
  MISSED: '沒有交',
};

export default async function GuardianPage({
  searchParams,
}: {
  searchParams: Promise<{ child?: string }>;
}) {
  const { child: wanted } = await searchParams;
  return scopedPage(async (user) => {
    if (user.systemRole !== 'GUARDIAN') {
      // 老師要看一位學生走班級頁，那邊有帶班的判定，而且看得到的
      // 東西完全不同。讓老師也進得來的話，這一頁就會慢慢長出
      // 老師要的欄位——而那些欄位長出來之後家長也看得到。
      return (
        <main className="yz-panel">
          <Denied
            what="家長端"
            why="這一頁是家長看自己孩子的畫面。老師要看一位學生這學期的狀況，請到那個班的名冊頁點他的姓名。"
          />
        </main>
      );
    }

    const kids = await childrenOf(user.id);
    if (kids.length === 0) {
      return (
        <main className="yz-panel">
          <div className="yz-panel__head">
            <h1>孩子的狀況</h1>
          </div>
          <Empty
            title="這個帳號目前沒有連結到任何一位學生"
            hint={
              <>
                家長帳號要由補習班接到孩子身上才看得到東西。
                如果你剛拿到這組帳號密碼，請告訴櫃檯或班級老師，
                他們在名冊上按一下就好。
              </>
            }
          />
        </main>
      );
    }

    // 網址上的 id 不認得就退回第一個孩子，不是報錯：家長從 LINE 上
    // 別人轉來的舊連結點進來時，看到自己孩子比看到一句錯誤有用。
    // 真正的擋在 `childView` → `requireChild`：那裡認的是連結，
    // 而這裡的 `kids` 本來就只有他自己的孩子。
    const picked = kids.find((k) => k.studentId === wanted) ?? kids[0];
    const view = await childView(user.id, picked.studentId);
    const now = new Date();

    const needsAction = view.tasks.filter(
      (t) => t.state === 'OPEN' || t.state === 'IN_PROGRESS',
    );
    const missed = view.tasks.filter((t) => t.state === 'MISSED');
    // 成績只列最近幾份。家長要的是「最近考得怎麼樣」，不是一份學期
    // 總表——那是老師的畫面。全部列出來的話，手機上要捲十幾頁。
    const scored = view.tasks
      .filter((t) => t.resultVisible && t.score != null)
      .sort((a, b) => (b.lastSubmittedAt ?? '').localeCompare(a.lastSubmittedAt ?? ''))
      .slice(0, 8);

    return (
      <main className="yz-panel yz-kid">
        <div className="yz-panel__head">
          <h1>{picked.displayName}</h1>
          <p className="yz-panel__sub">
            {picked.className ?? '還沒有編班'}
            {view.summary.total > 0 && `　·　這學期 ${view.summary.total} 份任務`}
          </p>
        </div>

        {/* 兩個孩子以上才畫切換。一個孩子的家長不該看到一排只有一顆的
            按鈕，那會讓他以為自己漏了什麼。 */}
        {kids.length > 1 && (
          <nav className="yz-kid__switch" aria-label="切換孩子">
            {kids.map((k) => (
              <Link
                key={k.studentId}
                href={`/guardian?child=${k.studentId}`}
                className="yz-kid__tab"
                aria-current={k.studentId === picked.studentId ? 'page' : undefined}
              >
                {k.displayName}
              </Link>
            ))}
          </nav>
        )}

        {/* 未確認交付的連結要對家長自己說一次。打錯的信箱因此會在
            第一次登入時被發現，而不是等到期末。理由見
            lib/guardian.ts 的 `notifiableGuardians`。 */}
        {!picked.delivered && (
          <Note tone="info">
            補習班還沒有確認這組帳號是交到你手上的。
            <strong>如果上面顯示的不是你的孩子，請立刻告訴補習班</strong>——
            那代表名冊上的家長信箱打錯了。
          </Note>
        )}

        {/* 整頁真的沒有東西的兩種：孩子還沒編班、班上還沒派過任務。
            這兩種底下不會有任何區塊，所以空狀態就是整頁。
            另外兩種（還沒交、還沒放行）畫在成績那一段的位置上——
            缺的是成績，那句解釋就該長在成績本來會出現的地方。 */}
        {view.emptyReason === 'NO_CLASS' && (
          <Empty
            title={`${picked.displayName}還沒有編進任何班級`}
            hint="沒有班級就收不到作業，所以這裡是空的。請告訴櫃檯或班級老師。"
          />
        )}
        {view.emptyReason === 'NO_TASK' && (
          <Empty
            title="老師還沒有派任何作業或考試"
            hint="老師派了作業或考試之後，這裡就會出現該交的份數與截止時間。"
          />
        )}

        {/* 要注意的事排最前面，而且只有真的有事時才出現。
            沒有事的時候留一塊「目前沒有異常」的區塊，是在教家長
            每次都要掃過一塊沒有內容的東西。 */}
        {missed.length > 0 && (
          <section className="yz-kid__alert">
            <h2>有 {missed.length} 份沒有交</h2>
            <p>
              截止時間已經過了，系統上不能再作答。要補交或有特殊狀況，
              直接跟班級老師說。
            </p>
            <ul>
              {missed.slice(0, 5).map((t, i) => (
                <li key={`${t.subjectName}-${t.title}-${i}`}>
                  {t.subjectName}　{t.title}
                  {t.dueAt && <span className="yz-kid__when">{day(t.dueAt)} 截止</span>}
                </li>
              ))}
              {missed.length > 5 && <li>…還有 {missed.length - 5} 份</li>}
            </ul>
          </section>
        )}

        {view.emptyReason !== 'NO_CLASS' && view.emptyReason !== 'NO_TASK' && (
          <section className="yz-kid__block">
            <h2 className="yz-kid__h">還沒交的</h2>
            {needsAction.length === 0 ? (
              <p className="yz-kid__none">目前該交的都交了。</p>
            ) : (
              <ul className="yz-kid__list">
                {needsAction.map((t, i) => (
                  <li key={`${t.subjectName}-${t.title}-${i}`}>
                    <span className="yz-kid__what">
                      <b>{t.title}</b>
                      <span className="yz-kid__meta">
                        {t.subjectName}　·　{STATE_LABEL[t.state] ?? t.state}
                      </span>
                    </span>
                    <span className="yz-kid__when">
                      {t.dueAt ? within(t.dueAt, now) : '沒有截止時間'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {view.summary.upcoming > 0 && (
              <p className="yz-kid__note">
                另外有 {view.summary.upcoming} 份還沒開放，時間到了才寫得了。
              </p>
            )}
          </section>
        )}

        {view.emptyReason !== 'NO_CLASS' && view.emptyReason !== 'NO_TASK' && (
          <section className="yz-kid__block">
            <h2 className="yz-kid__h">最近的成績</h2>
            {scored.length === 0 ? (
              // 缺的是成績，所以解釋長在成績本來會出現的地方。
              // 「還沒交」與「交了但還沒放行」的下一步完全不同：
              // 前者要問孩子，後者只能等老師。
              <Empty
                title={
                  view.emptyReason === 'NOT_SUBMITTED' ? '還沒有交過任何一份' : '成績還沒有開放'
                }
                hint={
                  view.emptyReason === 'NOT_SUBMITTED'
                    ? `目前有 ${view.summary.pending} 份還可以寫。交出去之後這裡才會有成績。`
                    : '考卷已經交了，但老師還沒有開放成績——有些考試會等全班都考完才一起開放。開放之後這裡就看得到。'
                }
              />
            ) : (
              <>
                <ul className="yz-kid__scores">
                  {scored.map((t, i) => (
                    <Score key={`${t.subjectName}-${t.title}-${i}`} task={t} />
                  ))}
                </ul>
                {view.summary.waiting > 0 && (
                  <p className="yz-kid__note">
                    另外有 {view.summary.waiting} 份已經交了，但老師還沒有開放成績。
                    有些考試會等全班都考完才一起開放。
                  </p>
                )}
                <p className="yz-kid__note">
                  這裡只列老師已經開放的成績。
                  <strong>逐題的作答與檢討只有孩子自己和老師看得到</strong>——
                  那是他的學習過程，想一起看的話請他打開給你，或問老師。
                </p>
              </>
            )}
          </section>
        )}
      </main>
    );
  });
}

/**
 * 一份成績。
 *
 * 分數與「跟班上比起來如何」擺在同一塊，因為分開的話家長只會看到
 * 一個 68 分——而 68 分是好是壞，要看那份卷子難不難。
 *
 * 比不出來的時候**要說出為什麼**（人數太少，平均反推得出別人的
 * 分數）。空白的欄位會被讀成「系統壞了」或「老師還沒改完」。
 */
function Score({ task }: { task: ChildTask }) {
  const c = task.compare;
  return (
    <li className="yz-kid__score">
      <span className="yz-kid__what">
        <b>{task.title}</b>
        <span className="yz-kid__meta">
          {task.subjectName}
          {task.lastSubmittedAt && `　·　${day(task.lastSubmittedAt)} 交`}
          {task.lastLate && <span className="yz-warn">　·　遲交</span>}
        </span>
      </span>
      <span className="yz-kid__num">
        <b>{task.score}</b>
        <span className="yz-kid__full">／{task.maxScore}</span>
      </span>
      <span className="yz-kid__vs">
        {c.show ? (
          <>
            {c.label}
            <span className="yz-kid__meta">
              班級平均 {c.mean}（{(c.delta ?? 0) >= 0 ? '+' : ''}
              {c.delta}）
            </span>
          </>
        ) : (
          <span className="yz-kid__meta">{c.why}</span>
        )}
      </span>
    </li>
  );
}
