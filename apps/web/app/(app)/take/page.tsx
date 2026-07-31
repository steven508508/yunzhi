import Link from 'next/link';

import { Denied, Empty } from '@/components/Feedback';
import { listStudentTasks, type StudentTask } from '@/lib/attempt';
import { mayUse } from '@/lib/nav';
import { scopedPage } from '@/lib/page';

export const dynamic = 'force-dynamic';

/**
 * 學生的任務清單。
 *
 * # 為什麼分成三段而不是一張表
 *
 * 學生打開這一頁只想知道一件事：**現在要寫哪一份。** 一張混在一起
 * 依日期排的表，會讓「寫到一半的」那一份跟三週前交完的那一份長得
 * 一樣重要，而寫到一半那一份是有時限的——它可能正在倒數。
 *
 * 所以順序是：進行中（正在倒數，最緊急）→ 待完成（含還沒開放與
 * 已經錯過的）→ 已完成（背景資訊，收在最後）。
 *
 * # 逾期未交不藏起來
 *
 * 「已錯過」那幾份仍然列出來並且說明原因。藏起來的話學生會以為
 * 自己沒有那份作業，而老師那邊記的是一次未交。
 *
 * # 誰進得來
 *
 * 學生（`nav.ts` 的 LEARNER）與職員。**職員是唯一的例外，而例外
 * 不等於沒有規則**：`nav.ts` 寫得很清楚，老師偶爾會被指定為作答
 * 對象（自己先試考一份再派出去），所以導覽列不畫但網址進得去。
 * 這一頁原本把那句話實作成「誰都不擋」，於是家長直接打 `/take`
 * 會看到「我的任務／王小美家長」與一句「如果你知道有一份但這裡
 * 沒有，請告訴班級老師」——沒有資料外洩，但她會照著打電話，
 * 而那通電話問的是一個不存在的問題。
 */
export default async function TakePage() {
  return scopedPage(async (user) => {
    // 老師與管理員也進得來（他們可能被指定為作答對象，例如試考一份），
    // 但多數情況下他們的清單是空的。空畫面要說得出為什麼，
    // 否則看起來像壞掉。
    const staff = mayUse(user.systemRole, '/bank');

    // 「看不到連結」與「進不去」必須是同一份規則（見 `lib/nav.ts`
    // 的檔頭）。這一行就是那份規則在這一頁的那一半——少了它，
    // 導覽列上的過濾只是把入口藏起來。
    if (!mayUse(user.systemRole, '/take') && !staff) {
      return (
        <main className="yz-panel">
          <Denied
            what="作答"
            why={
              <>
                這一頁是學生自己的任務清單。家長要看孩子交了沒有、
                考得怎麼樣，在<Link href="/guardian">「孩子的狀況」</Link>那一頁。
              </>
            }
          />
        </main>
      );
    }

    const tasks = await listStudentTasks(user.id);

    const inProgress = tasks.filter((t) => t.state === 'IN_PROGRESS');
    const todo = tasks.filter((t) => ['OPEN', 'UPCOMING', 'MISSED'].includes(t.state));
    const done = tasks.filter((t) => t.state === 'DONE');

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>我的任務</h1>
          <p className="yz-panel__sub">
            {user.displayName}
            {tasks.length > 0 && `　·　共 ${tasks.length} 份`}
          </p>
        </div>

        {tasks.length === 0 ? (
          <Empty
            title="現在沒有任務"
            hint={
              staff
                ? '這一頁列的是「派給你本人」的任務。你要看班上誰交了沒有，去班級那一區。'
                : '老師派新的作業或考試時會出現在這裡。如果你知道有一份但這裡沒有，請告訴班級老師。'
            }
          />
        ) : (
          <>
            {inProgress.length > 0 && (
              <Section title="進行中" note="這幾份已經開始了。有時限的會繼續倒數。">
                {inProgress.map((t) => (
                  <TaskRow key={t.assignmentId} task={t} />
                ))}
              </Section>
            )}

            {todo.length > 0 && (
              <Section title="待完成">
                {todo.map((t) => (
                  <TaskRow key={t.assignmentId} task={t} />
                ))}
              </Section>
            )}

            {done.length > 0 && (
              <Section title="已完成">
                {done.map((t) => (
                  <TaskRow key={t.assignmentId} task={t} />
                ))}
              </Section>
            )}
          </>
        )}
      </main>
    );
  });
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 26 }}>
      <h2 className="yz-card__title" style={{ marginBottom: note ? 2 : 8 }}>
        {title}
      </h2>
      {note && <p className="yz-task__note">{note}</p>}
      <ul className="yz-task__list">{children}</ul>
    </section>
  );
}

function TaskRow({ task }: { task: StudentTask }) {
  const clickable = task.state === 'IN_PROGRESS' || task.state === 'OPEN';
  // 交過卷才有成績可以看。**與「已完成」不是同一件事**：可以作答三次的
  // 任務交了第一次之後仍然是「可作答」，而那一次的成績已經在了。
  const graded = task.lastSubmittedAt != null && task.resultVisible;
  const result = resultLine(task);

  return (
    <li className={`yz-task${task.state === 'IN_PROGRESS' ? ' yz-task--now' : ''}`}>
      <div className="yz-task__main">
        <div className="yz-task__title">
          {task.title}
          {task.mode === 'PRACTICE' && <span className="yz-muted">練習</span>}
        </div>
        <div className="yz-task__meta">
          {task.subjectName}
          {' · '}
          {task.questionCount} 題
          {task.timeLimitMin ? ` · 限時 ${task.timeLimitMin} 分鐘` : ''}
          {task.maxAttempts > 1 ? ` · 可作答 ${task.maxAttempts} 次` : ''}
        </div>
        <div className="yz-task__meta">{describe(task)}</div>
        {result && <div className="yz-task__meta">{result}</div>}
      </div>

      <div className="yz-task__act">
        {clickable && (
          <Link href={`/take/${task.assignmentId}`} className="yz-btn yz-btn--primary">
            {task.state === 'IN_PROGRESS' ? '繼續作答' : '開始作答'}
          </Link>
        )}
        {graded && (
          <Link
            href={`/take/${task.assignmentId}/result`}
            className={`yz-btn${clickable ? ' yz-btn--quiet' : ''}`}
          >
            {task.resultLevel === 'FULL' ? '看檢討' : '看成績'}
          </Link>
        )}
        {!clickable && !graded && <span className="yz-task__state">{STATE_LABEL[task.state]}</span>}
      </div>
    </li>
  );
}

/**
 * 成績那一行。
 *
 * 分成三句話，因為學生在這三種情況下要做的事不一樣：
 *
 *   · 還看不到 → 說**什麼時候**看得到（老師手動放行、或截止之後）
 *   · 交了但沒分數 → 說這不是他的問題，而且要請老師處理
 *   · 有分數 → 就給分數，順便說逐題檢討開了沒
 *
 * 三種都寫成「已交卷」的話，最後那一種的資訊就沒了，而那正是
 * 學生打開這一頁最想看的東西。
 */
function resultLine(t: StudentTask): React.ReactNode {
  if (!t.lastSubmittedAt) return null;
  if (t.resultLevel === 'NONE') return t.resultNote;
  if (t.score === null) return '已交卷，還在等計分。分數沒有出來請告訴老師。';
  return (
    <>
      <b className="yz-task__score">{fmtScore(t.score)}</b>
      {t.maxScore !== null && ` / ${fmtScore(t.maxScore)} 分`}
      {t.resultLevel === 'SCORE_ONLY' && '　·　逐題檢討與解析還沒開放'}
    </>
  );
}

/** 78 而不是 78.00。浮點加總會印出 78.30000000000001。 */
function fmtScore(n: number): string {
  return String(Math.round(n * 100) / 100);
}

const STATE_LABEL: Record<StudentTask['state'], string> = {
  IN_PROGRESS: '進行中',
  OPEN: '可作答',
  UPCOMING: '尚未開放',
  DONE: '已完成',
  MISSED: '已逾期',
};

/**
 * 這一列底下那句話。
 *
 * 每一種狀態都要說出**下一步或原因**，不要只是重複狀態名稱。
 * 「已逾期」是一個結論，「7/28 17:00 截止，沒有作答記錄」才讓學生
 * 知道發生了什麼、以及要不要去找老師。
 */
function describe(t: StudentTask): string {
  switch (t.state) {
    case 'IN_PROGRESS':
      return t.openRemainingSeconds != null
        ? `還剩 ${Math.floor(t.openRemainingSeconds / 60)} 分鐘`
        : '沒有時限，寫完再交';
    case 'UPCOMING':
      return `${fmt(t.openAt)} 開放`;
    case 'OPEN':
      if (t.dueAt && t.allowLate && new Date(t.dueAt) < new Date()) {
        return `已經超過 ${fmt(t.dueAt)} 的截止時間，現在交會標記為遲交`;
      }
      return t.dueAt ? `${fmt(t.dueAt)} 截止` : '沒有截止時間';
    case 'DONE': {
      if (!t.lastSubmittedAt) return `已作答 ${t.attemptsUsed} 次`;
      return `${fmt(t.lastSubmittedAt)} 交卷${t.lastLate ? '（遲交）' : ''}`;
    }
    case 'MISSED':
      return `${fmt(t.dueAt)} 截止，沒有作答記錄。要補做請告訴老師。`;
  }
}

function fmt(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}
