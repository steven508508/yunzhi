/**
 * 老師看班上的智慧老師對話。**唯讀。**
 *
 * # 為什麼一定要有這一塊
 *
 * 這是未成年人在補習班的系統裡與 AI 的互動。不留監督能力，出事時
 * 沒有人說得出發生過什麼；只留給學生自己看，等於補習班對自己場域內
 * 的 AI 互動沒有任何監督能力。schema 的區塊註解把這件事列為
 * 智慧老師這一批資料表的四個設計決定之一。
 *
 * # 版面就是老師的兩個問題
 *
 * **一、哪幾題最多人問。** 那是明天要重講的題目——而且這個訊號比
 * 答對率更直接：答對率低可能是題目出得爛，但**特地跑去問 AI 的人多，
 * 代表他們真的想弄懂而弄不懂**。所以它排在最上面，依「不同的人數」
 * 排序而不是依段數（一個人問五次不等於五個人不會）。
 *
 * **二、有沒有被擋下來的訊息。** 兩種都要看得到：學生想改寫規則
 * （提示注入），以及模型差一點把答案講出來。第二種特別重要——
 * 它是這個功能真的在做事的唯一證據，而且擋下來的次數突然變多時，
 * 通常代表提示詞或模型換了版本。
 *
 * 逐字稿收在每一段後面要點才展開。規格書文件 01 §12.2 傾向
 * 「老師看摘要不看逐字，保護學生隱私」；這裡折衷：能力要在，
 * 但不要變成預設的瀏覽方式。
 *
 * # 為什麼是純呈現、資料在頁面那一層查
 *
 * 因為 `scopedPage` 建立的租戶脈絡在 render 回傳之後就不存在了。
 * 若把查詢寫在這個 async server component 裡，React 會在脈絡外面
 * 才 await 它——RLS 是 fail closed，結果是**這一塊永遠是空的，
 * 而且不會有任何錯誤訊息**。
 */
import { Table } from '@/components/Table';
import { Empty, Note } from '@/components/Feedback';
import type { TutorDigest, TutorDigestQuestion, TutorDigestSession } from '@/lib/tutor';

/** 給人看的時刻。與這一頁其他地方一樣，一定要指定台北時區。 */
function when(iso: string): string {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

const ROLE_LABEL: Record<string, string> = {
  STUDENT: '學生',
  TUTOR: '智慧老師',
  // 系統餵給模型的脈絡。學生看不到，老師看得到——「它為什麼會這樣講」
  // 只有這一列答得出來。
  CONTEXT: '系統脈絡',
};

export function TutorReview({ digest }: { digest: TutorDigest }) {
  if (digest.total === 0) {
    return (
      <section style={{ marginBottom: 22 }}>
        <h2 className="yz-grade-h">智慧老師</h2>
        <Empty
          title="這份任務還沒有人用過智慧老師"
          hint="學生在檢討頁的每一題底下可以開對話。檢討沒有放行之前，那個入口不會出現。"
        />
      </section>
    );
  }

  return (
    <section style={{ marginBottom: 22 }}>
      <h2 className="yz-grade-h">智慧老師（{digest.total} 段對話）</h2>
      <p className="yz-grade-hint">
        {digest.students} 位學生開過對話。
        <strong>最多人問的那幾題就是要重講的題目</strong>
        ——這個訊號比答對率直接：答對率低可能是題目本身的問題，
        但特地跑來問的人多，代表他們想弄懂而弄不懂。
        <br />
        智慧老師<strong>不會直接給答案</strong>，它做的是提問與引導。
        下面「擋下」那一欄是被安全規則攔住、沒有送給學生的訊息數
        （學生想改寫規則，或模型差一點把答案講出來）。
      </p>

      {digest.blocked > 0 && (
        <Note tone="warn">
          這份任務裡有 {digest.blocked} 則訊息被擋下來。偶爾幾則是正常的
          （閘門本來就會攔），但如果集中在同一位學生身上，值得找他聊一下；
          如果突然變很多，多半是提示詞或模型換了版本。逐字內容在下面每一段裡。
        </Note>
      )}

      <h3 className="yz-tutor__h3">哪幾題最多人問</h3>
      <Table
        caption="各題的智慧老師使用情形"
        columns={[
          {
            key: 'o',
            head: '題號',
            numeric: true,
            cell: (q: TutorDigestQuestion) => q.order ?? '—',
          },
          { key: 's', head: '幾個人問', numeric: true, cell: (q: TutorDigestQuestion) => q.students },
          { key: 'n', head: '幾段對話', numeric: true, cell: (q: TutorDigestQuestion) => q.sessions },
          {
            key: 'r',
            head: '說「我懂了」',
            numeric: true,
            // **不拿它當成效指標。** schema 的欄位註解寫明「沒有按
            // 不代表沒懂」，所以這一欄旁邊一定要有那一句話（見下方）。
            cell: (q: TutorDigestQuestion) => q.resolved,
          },
          {
            key: 'b',
            head: '擋下',
            numeric: true,
            cell: (q: TutorDigestQuestion) =>
              q.blocked ? <span className="yz-warn">{q.blocked}</span> : '',
          },
        ]}
        rows={digest.byQuestion}
        rowKey={(q) => q.questionId}
        empty={<Empty title="沒有資料" />}
      />
      <p className="yz-grade-hint">
        「說我懂了」是學生自己按的。<strong>沒有按不代表沒懂</strong>
        ——很多人是想通了就直接關掉，所以這一欄只能往上看（按的人多代表有效），
        不能往下看（按的人少不代表沒效）。
      </p>

      <h3 className="yz-tutor__h3">每一段對話</h3>
      <p className="yz-grade-hint">
        點開才看得到逐字內容。這是學生與 AI 的對話，
        看它是為了確認系統沒有做錯事，不是為了看他哪裡不會——那個在上面那張表裡。
      </p>
      <ol className="yz-tutorlog">
        {digest.sessions.map((s) => (
          <SessionRow key={s.sessionId} s={s} />
        ))}
      </ol>
    </section>
  );
}

function SessionRow({ s }: { s: TutorDigestSession }) {
  return (
    <li className="yz-tutorlog__item">
      {/* 原生 details：這一頁是 server component，自己做一顆展開鈕
          就要把整頁變成 client component。 */}
      <details>
        <summary className="yz-tutorlog__sum">
          <span className="yz-tutorlog__no">第 {s.questionOrder ?? '?'} 題</span>
          <span className="yz-tutorlog__who">
            {s.studentName}
            {s.username && <span className="yz-muted">（{s.username}）</span>}
          </span>
          <span className="yz-tutorlog__stuck">{s.stuckAt ?? '（還沒說卡在哪）'}</span>
          <span className="yz-muted">
            {s.messageCount} 則　·　{when(s.createdAt)}
          </span>
          {s.resolvedAt && <span className="yz-tutorlog__ok">說我懂了</span>}
          {s.blocked > 0 && <span className="yz-warn">擋下 {s.blocked}</span>}
        </summary>
        <div className="yz-tutorlog__body">
          {s.transcript.map((m, i) => (
            <div
              key={i}
              className={`yz-tutorlog__msg yz-tutorlog__msg--${m.role.toLowerCase()}${
                m.blocked ? ' yz-tutorlog__msg--blocked' : ''
              }`}
            >
              <span className="yz-tutorlog__role">{ROLE_LABEL[m.role] ?? m.role}</span>
              {/* 逐字稿**不排版數學式**，照原樣顯示。
                  老師在這裡看的是「系統做了什麼」，而排過版的字串
                  與資料庫裡的字串不一樣——查事情的時候要看原文。 */}
              <span className="yz-tutorlog__text">{m.content}</span>
              {m.blocked && (
                <span className="yz-tutorlog__why">
                  擋下：{m.blockedReason ?? '（沒有記錄理由）'}
                </span>
              )}
            </div>
          ))}
        </div>
      </details>
    </li>
  );
}
