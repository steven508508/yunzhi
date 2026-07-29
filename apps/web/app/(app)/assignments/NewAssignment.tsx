'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { Button } from '@/components/Button';
import { CheckField, SelectField, TextField } from '@/components/Field';
import { Form, submitJson } from '@/components/Form';
import { Note } from '@/components/Feedback';

type Paper = {
  id: string;
  title: string;
  subject: string;
  items: number;
  totalScore: number;
  /** 同一份卷子上**還沒結束**的任務。跨班洩題的警告靠它。 */
  openTasks: { title: string; dueAt: string | null }[];
};
type Klass = { id: string; name: string; members: number };
type Student = { id: string; username: string; displayName: string };

/** 台北時間。伺服器多半跑在 UTC，直接印會差八小時。 */
function when(iso: string | null): string {
  if (!iso) return '沒有設截止時間';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

/**
 * 派一個任務。
 *
 * # 時間欄位為什麼是 datetime-local 而不是自己刻的選擇器
 *
 * 因為老師輸入的是「這禮拜五晚上八點」，而瀏覽器與作業系統的原生
 * 選擇器已經處理好日期格式、時區、鍵盤輸入與螢幕閱讀器。自己刻的
 * 版本通常只在滑鼠上可用。
 *
 * 空字串要送 `null` 而不是空字串：伺服器端用 `z.coerce.date()` 解析，
 * 空字串會變成 Invalid Date，錯誤訊息是一句沒有人看得懂的 zod 抱怨。
 *
 * # 個別指定為什麼是打學號而不是一份長長的清單
 *
 * 個別指定的實際用途是「整班加上補考的那兩位」。在 500 人的下拉選單裡
 * 找那兩位，比打兩個學號慢得多。
 */
export default function NewAssignment({
  papers,
  classes,
  students,
  me,
}: {
  papers: Paper[];
  classes: Klass[];
  students: Student[];
  /** 現在登入的這位老師。「也派給我自己（試考）」用它。 */
  me: { id: string; displayName: string };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const [paperId, setPaperId] = useState(papers[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<'EXAM' | 'PRACTICE'>('EXAM');
  const [openAt, setOpenAt] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [timeLimit, setTimeLimit] = useState('');
  const [allowLate, setAllowLate] = useState(false);
  const [maxAttempts, setMaxAttempts] = useState('1');
  // **正式測驗預設打開兩個隨機。**
  //
  // 監考 Client 還不存在，所以題序隨機與選項隨機是這套系統目前
  // **僅有的兩個防弊手段**（那一行提示自己就說了「坐隔壁抄不了」），
  // 而它們一旦有人開始作答就凍結、`AssignmentTools` 連畫都不畫。
  // 忘記勾的話，那場考試就沒有防弊，而且事後補不回來。
  // 練習模式維持關閉：那時題號一致反而方便老師與學生對答案。
  const [shuffleQuestions, setShuffleQuestions] = useState(true);
  const [shuffleOptions, setShuffleOptions] = useState(true);
  const [releasePolicy, setReleasePolicy] = useState('ON_DUE');
  const [classIds, setClassIds] = useState<string[]>([]);
  const [picked, setPicked] = useState<Student[]>([]);
  const [studentInput, setStudentInput] = useState('');
  const [pickError, setPickError] = useState<string | null>(null);
  const [trial, setTrial] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const paper = papers.find((p) => p.id === paperId);
  const byUsername = useMemo(
    () => new Map(students.map((s) => [s.username.toLowerCase(), s])),
    [students],
  );

  // 這只是給老師看的上限估計：班上的人數含老師與助教，而實際名單
  // 由伺服器的 resolveRecipients 算。**兩邊不一致時以伺服器為準**，
  // 所以這裡的文案說的是「最多」。
  const roughMax =
    classes.filter((c) => classIds.includes(c.id)).reduce((n, c) => n + c.members, 0) +
    picked.length;

  function addStudent() {
    const key = studentInput.trim().toLowerCase();
    if (!key) return;
    const hit = byUsername.get(key);
    if (!hit) {
      setPickError(`找不到學號 ${studentInput.trim()}`);
      return;
    }
    setPickError(null);
    setStudentInput('');
    setPicked((prev) => (prev.some((p) => p.id === hit.id) ? prev : [...prev, hit]));
  }

  if (!open) {
    return (
      <div style={{ marginBottom: 20 }}>
        {done && <Note tone={done.includes('沒有任何人') ? 'warn' : 'info'}>{done}</Note>}
        <Button variant="primary" onClick={() => setOpen(true)}>
          派一個新任務
        </Button>
      </div>
    );
  }

  return (
    <div className="yz-card" style={{ marginBottom: 24 }}>
      <Form
        onSubmit={async () => {
          const r = await submitJson<{ recipients: number }>('/api/assignments', {
            json: {
              paperId,
              title,
              mode,
              // 空的時間欄位要送 null。見檔案開頭。
              openAt: openAt ? new Date(openAt).toISOString() : null,
              dueAt: dueAt ? new Date(dueAt).toISOString() : null,
              timeLimitMin: timeLimit ? Number(timeLimit) : null,
              allowLate,
              maxAttempts: Number(maxAttempts) || 1,
              shuffleQuestions,
              shuffleOptions,
              releasePolicy,
              targets: {
                classIds,
                userIds: [...picked.map((p) => p.id), ...(trial ? [me.id] : [])],
              },
            },
          });
          setOpen(false);
          setTitle('');
          setClassIds([]);
          setPicked([]);
          // **時間欄位一定要跟著清掉。**
          //
          // 以前只重設名稱與班級，於是派完忠班再派孝班時，開放與截止
          // 時間看起來「已經填好了」——而它們是忠班那一場的時間。
          // 建立時只擋「截止已過」，週三晚上派週五的時間照單全收，
          // 沒有任何警告。結果是週六早上孝仁兩班 58 個人開卷，
          // 看到「這份任務已經在 7/31 15:00 截止了」。
          //
          // 被清掉的本來是安全的欄位，被留下來的是危險的欄位。倒過來。
          setOpenAt('');
          setDueAt('');
          setTimeLimit('');
          // 派出去之後最需要確認的就是「幾個人收到」，而那個數字
          // 只有伺服器算得出來（班上有幾位已離班、有幾位是助教）。
          // 它留在畫面上而不是跳一個對話框——老師接著要做的事
          // 通常是再派下一個。
          setDone(
            r.recipients === 0
              ? '任務建好了，但實際上沒有任何人收到。選到的班可能還沒匯入名冊。'
              : `已派給 ${r.recipients} 位學生。時間欄位已經清空，下一份要重新填。`,
          );
          router.refresh();
        }}
      >
        {({ busy }) => (
          <>
            <div className="yz-row">
              <SelectField
                label="試卷"
                required
                value={paperId}
                onChange={(e) => setPaperId(e.currentTarget.value)}
                hint={
                  paper
                    ? `${paper.subject}　${paper.items} 題　共 ${paper.totalScore} 分`
                    : '只列出標記為「可派發」的卷子'
                }
              >
                {papers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}（{p.subject}）
                  </option>
                ))}
              </SelectField>
              {/* 同一份卷子還被別的任務用著。**這句話以前不存在**，
                  而它是跨班洩題唯一的預警。 */}
              {paper && paper.openTasks.length > 0 && (
                <Note tone="warn">
                  這份卷子還有 {paper.openTasks.length} 個任務沒有結束（
                  {paper.openTasks.map((t) => `${t.title}／${when(t.dueAt)}`).join('、')}）。
                  {releasePolicy === 'ON_DUE'
                    ? '選「截止後」的話，這一班的答案與詳解會在自己的截止時間對這一班公開——' +
                      '而那幾個班可能還沒考。要避開，把這幾份都改成「老師手動放行」，' +
                      '等最後一班考完再一起放行。'
                    : '同一份卷子分幾個時段考的話，最保險的是「老師手動放行」：' +
                      '等最後一班考完再一起開放。'}
                </Note>
              )}
              <TextField
                label="任務名稱"
                required
                value={title}
                onChange={(e) => setTitle(e.currentTarget.value)}
                hint="學生在自己的任務清單上看到的就是它。"
              />
            </div>

            <div className="yz-group">
              <p className="yz-group__title">派給誰</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 18px' }}>
                {classes.map((c) => (
                  <CheckField
                    key={c.id}
                    label={`${c.name}（${c.members} 人）`}
                    checked={classIds.includes(c.id)}
                    onChange={(e) =>
                      setClassIds((prev) =>
                        e.currentTarget.checked
                          ? [...prev, c.id]
                          : prev.filter((x) => x !== c.id),
                      )
                    }
                  />
                ))}
              </div>

              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 10 }}>
                <div className="yz-field yz-filters__grow" style={{ maxWidth: 220 }}>
                  <label className="yz-label" htmlFor="pick-student">
                    再加個別學生（例如補考）
                  </label>
                  <input
                    id="pick-student"
                    className="yz-in"
                    list="yz-students"
                    value={studentInput}
                    placeholder="輸入學號"
                    onChange={(e) => setStudentInput(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        // 這裡不讓 Enter 送出整張表單——老師打完學號
                        // 按 Enter 的意思是「加這一位」，不是「派出去」。
                        e.preventDefault();
                        addStudent();
                      }
                    }}
                  />
                  <datalist id="yz-students">
                    {students.map((s) => (
                      <option key={s.id} value={s.username}>
                        {s.displayName}
                      </option>
                    ))}
                  </datalist>
                </div>
                <Button onClick={addStudent} disabled={busy}>
                  加入
                </Button>
              </div>
              {pickError && <Note tone="error">{pickError}</Note>}
              {picked.length > 0 && (
                <div className="yz-chips">
                  {picked.map((s) => (
                    <span key={s.id} className="yz-chip">
                      {s.displayName}
                      <span className="yz-muted">{s.username}</span>
                      <button
                        type="button"
                        aria-label={`不要派給 ${s.displayName}`}
                        onClick={() => setPicked((prev) => prev.filter((p) => p.id !== s.id))}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <p className="yz-group__note">
                {classIds.length === 0 && picked.length === 0
                  ? '還沒有選任何對象。沒有對象的任務不會有任何人收到。'
                  : `最多 ${roughMax} 人。實際人數以送出後的結果為準——` +
                    '已離班、以及名冊裡的老師與助教不算在內。'}
              </p>
              {/* 老師自己試考。
                  在此之前，出卷的人沒有任何辦法從頭到尾看過自己出的卷子
                  ——沒有整卷預覽、印不出來，而唯一看得到學生畫面的路徑
                  （開始作答）被「不是學生帳號」擋著。結果是**第一個看過
                  那份卷子的人是考試當天的學生**。 */}
              <CheckField
                label="也派給我自己（試考一遍）"
                checked={trial}
                onChange={(e) => setTrial(e.currentTarget.checked)}
                hint="派出去之後從導覽列以外的網址 /take 進去就寫得到。試考不算進應交人數，也不進成績統計。"
              />
              {/* 少了這一句，找不到某個班的老師會以為系統壞了。
                  清單是依「自己授課或帶班」過濾的，不是全校。 */}
              <p className="yz-group__note">
                只列出你授課或擔任導師的班級。要派給其他班，請該班的老師或學科召集人派。
              </p>
            </div>

            <div className="yz-group">
              <p className="yz-group__title">時間</p>
              <div className="yz-row">
                <TextField
                  label="開放時間"
                  type="datetime-local"
                  value={openAt}
                  onChange={(e) => setOpenAt(e.currentTarget.value)}
                  hint="留白代表立刻開放。"
                />
                <TextField
                  label="截止時間"
                  type="datetime-local"
                  value={dueAt}
                  onChange={(e) => setDueAt(e.currentTarget.value)}
                  hint="留白代表不設截止。"
                />
              </div>
              <div className="yz-row">
                <TextField
                  label="作答時限（分鐘）"
                  type="number"
                  min={1}
                  max={600}
                  value={timeLimit}
                  onChange={(e) => setTimeLimit(e.currentTarget.value)}
                  hint="從學生按下開始作答起算，由伺服器計時。留白代表不限時。"
                />
                <TextField
                  label="可作答次數"
                  type="number"
                  min={1}
                  max={50}
                  value={maxAttempts}
                  onChange={(e) => setMaxAttempts(e.currentTarget.value)}
                  hint="練習模式常設成多次。"
                />
              </div>
              <CheckField
                label="截止後仍可作答（會標記為遲交）"
                checked={allowLate}
                onChange={(e) => setAllowLate(e.currentTarget.checked)}
              />
            </div>

            <div className="yz-group">
              <p className="yz-group__title">規則</p>
              <div className="yz-row">
                <SelectField
                  label="模式"
                  value={mode}
                  onChange={(e) => {
                    const next = e.currentTarget.value as 'EXAM' | 'PRACTICE';
                    setMode(next);
                    // 隨機是防弊，而防弊只有正式測驗需要。切到練習時關掉，
                    // 切回正式測驗時開回來——這兩個開關開考後就凍結，
                    // 忘記勾的代價是一整場沒有防弊的考試。
                    setShuffleQuestions(next === 'EXAM');
                    setShuffleOptions(next === 'EXAM');
                  }}
                  hint="正式測驗計時、成績計入分析；練習可重做、可即時看解析。"
                >
                  <option value="EXAM">正式測驗</option>
                  <option value="PRACTICE">練習</option>
                </SelectField>
                <SelectField
                  label="成績與解析什麼時候給看"
                  value={releasePolicy}
                  onChange={(e) => setReleasePolicy(e.currentTarget.value)}
                  // 舊的提示是「正式考試選『截止後』，全班同時看到，
                  // 先寫完的人不會洩題」。那句話在**一個班之內**是對的，
                  // 而它是唯一在場的指引——同一份卷子分兩天考兩個班時，
                  // 照著它做就是洩題。跨班的部分現在由上面那一塊警告說，
                  // 這裡只說得出這一格自己管的事。
                  hint={
                    releasePolicy === 'MANUAL' || releasePolicy === 'NEVER'
                      ? '學生交完卷之後連分數都看不到——這一格管的不只是解析。'
                      : '「截止後」＝ 全班同時開放，先交卷的人在截止前拿不到答案。'
                  }
                >
                  <option value="IMMEDIATE">每題作答後</option>
                  <option value="ON_SUBMIT">交卷後</option>
                  <option value="ON_DUE">截止後</option>
                  <option value="MANUAL">老師手動放行</option>
                  <option value="NEVER">不開放</option>
                </SelectField>
              </div>
              <CheckField
                label="題目順序隨機"
                checked={shuffleQuestions}
                onChange={(e) => setShuffleQuestions(e.currentTarget.checked)}
                hint="每個人的題號不同，坐隔壁抄不了。不需要學生裝任何東西。"
              />
              <CheckField
                label="選項順序隨機"
                checked={shuffleOptions}
                onChange={(e) => setShuffleOptions(e.currentTarget.checked)}
              />
              <p className="yz-group__note">
                模式、時限與這兩個隨機設定，在有人開始作答之後就不能再改——
                改了會讓已經開始的人與還沒開始的人拿到不同的考試。
              </p>
            </div>

            <div className="yz-actions">
              <span className="yz-actions__spacer" />
              <Button variant="quiet" onClick={() => setOpen(false)} disabled={busy}>
                取消
              </Button>
              <Button type="submit" variant="primary" busy={busy} busyLabel="派發中…">
                派出去
              </Button>
            </div>
          </>
        )}
      </Form>
    </div>
  );
}
