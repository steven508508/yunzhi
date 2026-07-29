/**
 * 名冊匯入的兩段式介面。
 *
 * 先試算再確認，因為**部分匯入之後沒有人知道現在是什麼狀態**。
 * 這件事發生在開學前一天、櫃檯同時在做五件事的時候，
 * 而錯了的代價是有學生登不進去。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { Button } from '@/components/Button';
import { Note } from '@/components/Feedback';

type Problem = { line: number; column?: string; message: string };
type Rename = { line: number; username: string; from: string; to: string };
type Plan = {
  encoding: string;
  rows: { line: number; username: string; displayName: string }[];
  problems: Problem[];
  existing: string[];
  creating: string[];
  consenting: number;
  renames: Rename[];
};
type Credentials = { username: string; displayName: string; password: string }[];
type Result = {
  created: number;
  linked: number;
  consented: number;
  renamed: number;
  credentials: Credentials;
  priorTasks: { total: number; answerable: number };
};

const ENCODING_LABEL: Record<string, string> = {
  'utf-8': 'UTF-8',
  'utf-8-bom': 'UTF-8（含 BOM，已處理）',
  big5: 'Big5（Windows 版 Excel 的預設，已處理）',
  'utf-16le': 'UTF-16',
  'utf-16be': 'UTF-16',
};

export default function RosterImport({
  classId,
  className,
}: {
  classId: string;
  className: string;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [done, setDone] = useState<Result | null>(null);
  // 姓名不同時要不要跟著改。**預設不改**：同名同姓不同人而學號打錯的
  // 那一次，靜靜地跟著改會把另一個人的名字覆蓋掉，而畫面上沒有痕跡。
  const [updateNames, setUpdateNames] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(apply: boolean) {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set('file', file);
      if (apply) {
        fd.set('apply', '1');
        if (updateNames) fd.set('updateNames', '1');
      }
      const res = await fetch(`/api/classes/${classId}/roster`, { method: 'POST', body: fd });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `伺服器回應 ${res.status}`);
      setPlan(data.plan);
      if (apply) {
        setDone(data.result as Result);
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // 匯入完成：把初始密碼列出來。**這是唯一一次拿得到。**
  if (done) {
    const creds = done.credentials;
    return (
      <div className="yz-card" style={{ marginBottom: 22 }}>
        <h2 className="yz-card__title">名冊已匯入</h2>

        {/* 做了什麼要逐項說。只說「匯入成功」的話，同意欄與姓名更新
            這兩件事有沒有生效，看的人分不出來。 */}
        <Note>
          新增 {done.created} 個帳號、{done.linked} 位入班
          {done.consented > 0 && `、${done.consented} 位的家長同意一起登錄好了`}
          {done.renamed > 0 && `、更新了 ${done.renamed} 位的姓名`}。
          {done.consented === 0 && done.created > 0 && (
            <>
              　新帳號<strong>還登不進去</strong>，要先在名冊上登錄家長同意——
              上面那一塊可以整批做。
            </>
          )}
        </Note>

        {/* 插班生會收到這個班從開學以來的每一份任務。這件事在此之前
            沒有任何地方會說，而學生登入第一件事是看到一整排紅字的
            未交紀錄——其中還可能有他現在寫得了、但全班已經檢討過的。 */}
        {done.created > 0 && done.priorTasks.total > 0 && (
          <Note tone="warn">
            這個班先前已經派過 {done.priorTasks.total} 份任務，
            <strong>新加進來的學生會全部看到</strong>：截止日已過的會顯示成未交
            {done.priorTasks.answerable > 0 && (
              <>
                ，而其中 <strong>{done.priorTasks.answerable} 份現在還寫得了</strong>
                ——如果那幾份全班已經檢討過答案，請先到「派卷」把它們的截止時間補上
              </>
            )}
            。要讓他們免除某一份，到那一份任務把派發對象改成個別指定。
          </Note>
        )}

        {creds.length === 0 ? (
          <Note>沒有新增帳號——名冊上的學生都已經有帳號了，只是把他們加進這個班。</Note>
        ) : (
          <>
            <Note tone="warn">
              下面是 {creds.length} 個新帳號的初始密碼。
              <b>離開這一頁之後就取不回來了</b>，請先列印或複製。
              學生第一次登入時會被要求更換密碼。
            </Note>
            <table className="yz-table">
              <thead>
                <tr>
                  <th scope="col">學號</th>
                  <th scope="col">姓名</th>
                  <th scope="col">初始密碼</th>
                </tr>
              </thead>
              <tbody>
                {creds.map((c) => (
                  <tr key={c.username}>
                    <td>{c.username}</td>
                    <td>{c.displayName}</td>
                    <td style={{ fontFamily: 'var(--font-doc)', letterSpacing: '.08em' }}>
                      {c.password}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <div className="yz-actions">
          <span className="yz-actions__spacer" />
          <Button onClick={() => window.print()}>列印這一頁</Button>
          <Button
            variant="primary"
            onClick={() => {
              setDone(null);
              setPlan(null);
              setFile(null);
              if (fileRef.current) fileRef.current.value = '';
            }}
          >
            完成
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="yz-card" style={{ marginBottom: 22 }}>
      <h2 className="yz-card__title">匯入名冊</h2>
      <p className="yz-field__hint" style={{ marginBottom: 12 }}>
        CSV 檔，第一列是欄位標題。至少要有「學號」與「姓名」兩欄，
        欄位名稱不必改成特定的寫法。Excel 存出來的 Big5 直接丟進來就好。
      </p>
      {/* 同意欄要在**上傳之前**就說出來。事後才知道有這一欄的話，
          兩百位的同意已經一位一位按完了——那是半小時。 */}
      <details className="yz-fold" style={{ marginBottom: 12 }}>
        <summary className="yz-fold__head">還讀得懂哪些欄位（含家長同意）</summary>
        <div className="yz-fold__body">
          <p className="yz-hint" style={{ marginBottom: 8 }}>
            除了學號與姓名，這幾欄有填就會一起帶進來：
          </p>
          <ul style={{ marginLeft: 18, fontSize: 12.5, lineHeight: 2 }}>
            <li>
              <b>家長信箱</b>（也認得「家長email」「監護人信箱」）
            </li>
            <li>
              <b>生日</b>（「95/3/2」讀成民國 95 年）
            </li>
            <li>
              <b>家長同意</b>——填「是」或直接寫取得方式（<code>現場</code>／
              <code>紙本</code>／<code>線上</code>）。
              <strong>這一欄有填的人匯進來就登得進去</strong>，不必再一位一位登錄。
              填「否」或留白代表還沒取得。讀不懂的值會擋下整份並指出是第幾列。
            </li>
          </ul>
          <p className="yz-hint" style={{ marginTop: 8 }}>
            一列示範：<code>學號,姓名,家長信箱,生日,家長同意</code> →{' '}
            <code>S1140312,王大明,mom@example.com,95/3/2,紙本</code>
          </p>
        </div>
      </details>

      {error && <Note tone="error">{error}</Note>}

      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv,text/plain"
        className="yz-in"
        onChange={(e) => {
          setFile(e.currentTarget.files?.[0] ?? null);
          setPlan(null);
          setError(null);
        }}
      />

      {plan && (
        <div style={{ marginTop: 14 }}>
          <p className="yz-field__hint">
            編碼判定為 {ENCODING_LABEL[plan.encoding] ?? plan.encoding}。
          </p>
          {plan.problems.length > 0 ? (
            <>
              <Note tone="error">
                有 {plan.problems.length} 個問題，<b>整份都不會匯入</b>。
                修正之後再匯一次——部分匯入之後沒有人知道現在是什麼狀態。
              </Note>
              <ul style={{ marginLeft: 18, fontSize: 12.5, lineHeight: 2 }}>
                {plan.problems.slice(0, 20).map((p, i) => (
                  <li key={i}>
                    第 {p.line} 列{p.column ? `（${p.column}）` : ''}：{p.message}
                  </li>
                ))}
                {plan.problems.length > 20 && <li>…還有 {plan.problems.length - 20} 個</li>}
              </ul>
            </>
          ) : (
            <>
              <Note>
                讀到 {plan.rows.length} 位學生：新增 {plan.creating.length} 個帳號，
                {plan.existing.length} 位已經有帳號（會加進「{className}」，不會重建）。
                {plan.consenting > 0
                  ? `其中 ${plan.consenting} 位的 CSV 帶了家長同意，匯入後直接可以登入。`
                  : '沒有任何一列帶家長同意，所以新帳號匯進來還登不進去。'}
              </Note>

              {/* 姓名不同要列出來，而且要人明確按下去才改。
                  靜靜地跟著改是危險的：同名同姓不同人而學號打錯的那一次，
                  會把另一個人的名字覆蓋掉，而畫面上沒有任何痕跡。 */}
              {plan.renames.length > 0 && (
                <>
                  <Note tone="warn">
                    有 {plan.renames.length} 位的姓名與系統裡現有的不一樣。
                    <b>預設不會改</b>——要改請勾下面那一格。
                  </Note>
                  <ul style={{ marginLeft: 18, fontSize: 12.5, lineHeight: 2 }}>
                    {plan.renames.slice(0, 20).map((r) => (
                      <li key={r.username}>
                        第 {r.line} 列（{r.username}）：{r.from} → <b>{r.to}</b>
                      </li>
                    ))}
                    {plan.renames.length > 20 && (
                      <li>…還有 {plan.renames.length - 20} 位</li>
                    )}
                  </ul>
                  <label className="yz-check">
                    <input
                      type="checkbox"
                      checked={updateNames}
                      onChange={(e) => setUpdateNames(e.currentTarget.checked)}
                    />
                    <span>
                      跟著改掉這 {plan.renames.length} 位的姓名。
                      <span className="yz-hint">
                        　學號打錯的話會覆蓋到另一個人，請先確認上面那份對照。
                      </span>
                    </span>
                  </label>
                </>
              )}
              {/*
                每一個新帳號都要算一次密碼雜湊，那是刻意慢的運算
                （擋暴力破解），約三分之一秒一個。人多的時候按下確認
                之後畫面會停很久，而**看起來像當掉的東西會被重新整理**
                ——重整不會產生重複帳號（同一個學號會走到「已經有帳號」
                那條路），但老師會以為第一次失敗了而開始找人問。
                先說出來，比事後解釋便宜。
              */}
              {plan.creating.length >= 40 && (
                <Note tone="warn">
                  要建 {plan.creating.length} 個新帳號，按下確認之後大約需要{' '}
                  {Math.ceil((plan.creating.length * 0.35) / 5) * 5} 秒才會有結果——
                  系統正在為每一位學生產生初始密碼。這段時間畫面會停著，
                  <b>請不要重新整理或重複按</b>。
                </Note>
              )}
            </>
          )}
        </div>
      )}

      <div className="yz-actions">
        <span className="yz-actions__spacer" />
        <Button onClick={() => send(false)} busy={busy && !plan} disabled={!file}>
          試算
        </Button>
        <Button
          variant="primary"
          onClick={() => send(true)}
          busy={busy && !!plan}
          busyLabel="匯入中…"
          disabled={!plan || plan.problems.length > 0}
        >
          確認匯入
        </Button>
      </div>
    </div>
  );
}
