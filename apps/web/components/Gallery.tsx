/**
 * 元件庫的樣張。
 *
 * 存在的理由不是「展示」，是**校對**：把所有零件排在一頁上，
 * 對不齊的間距、不一致的字級、以及「這兩個狀態長得太像」
 * 這類問題，在一頁上一眼就看得出來，分散在三十個畫面裡則永遠
 * 看不出來。印刷業的做法就是這樣——先出一張校樣。
 *
 * `tools/build-gallery.mjs` 會把這一頁靜態渲染成一個 HTML 檔，
 * 所以不必起開發伺服器就看得到。
 */
import { Button } from '@/components/Button';
import { CheckField, SelectField, TextField } from '@/components/Field';
import { Table } from '@/components/Table';
import { Denied, Empty, ErrorBox, Loading, Note } from '@/components/Feedback';

type Row = { id: string; name: string; students: number; rate: number };

const ROWS: Row[] = [
  { id: 'a', name: '三年甲班', students: 32, rate: 0.71 },
  { id: 'b', name: '三年乙班', students: 9, rate: 0.58 },
  { id: 'c', name: '高二數學先修', students: 124, rate: 0.83 },
];

function Block({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 38 }}>
      <h2
        style={{
          fontFamily: 'var(--font-doc)',
          fontSize: 13,
          fontWeight: 600,
          paddingBottom: 6,
          marginBottom: 14,
          borderBottom: '1px solid var(--ink)',
        }}
      >
        {title}
        {note && (
          <span style={{ fontWeight: 400, color: 'var(--ink-3)', marginLeft: 10, fontSize: 11.5 }}>
            {note}
          </span>
        )}
      </h2>
      {children}
    </section>
  );
}

/** 靜態樣張。刻意不用 client component——樣張要能被伺服器渲染成 HTML。 */
export function Gallery() {
  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '32px 24px 80px' }}>
      <header style={{ marginBottom: 34 }}>
        <h1 style={{ fontFamily: 'var(--font-doc)', fontSize: 19, fontWeight: 600 }}>
          雲端智學 — 元件校樣
        </h1>
        <p style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 6, lineHeight: 1.8 }}>
          B0.2 建立的通用零件。接下來三十個畫面（班級、知識點、組卷、
          作答、成績、錯題、家長端）都用這一組，所以它們的間距、字級、
          與無障礙行為在這裡一次決定完。
        </p>
      </header>

      <Block title="按鈕" note="四種語意，沒有更多">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button variant="primary">建立班級</Button>
          <Button>匯入名冊</Button>
          <Button variant="quiet">取消</Button>
          <Button variant="danger">刪除這個班</Button>
          <Button disabled>停用中</Button>
          <Button variant="primary" busy>
            送出中
          </Button>
        </div>
      </Block>

      <Block title="表單欄位" note="標籤、說明、錯誤，三件事綁在一起">
        <div className="yz-row">
          <TextField
            label="班級名稱"
            required
            defaultValue="三年甲班"
            hint="學生在自己的畫面上會看到這個名稱。"
          />
          <TextField
            label="班級代碼"
            required
            defaultValue="3A"
            error="這個代碼已經被「三年甲班（舊）」用了。"
          />
        </div>
        <SelectField label="學年度" defaultValue="115">
          <option value="115">115 學年度</option>
          <option value="114">114 學年度</option>
        </SelectField>
        <CheckField
          label="我確認已取得這份講義的使用授權"
          defaultChecked
          hint="聲明者會被記錄下來。這一項決定解析可以原文呈現還是必須 AI 改寫。"
        />
        <div className="yz-actions">
          <span style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>＊ 為必填</span>
          <span className="yz-actions__spacer" />
          <Button variant="quiet">取消</Button>
          <Button variant="primary">建立</Button>
        </div>
      </Block>

      <Block title="提醒" note="三種語氣，刻意沒有「成功」">
        <Note>本學年度尚未設定為當前學年，學生看不到新派的任務。</Note>
        <Note tone="warn">這個班有 3 位學生沒有綁定家長帳號，家長收不到週報。</Note>
        <Note tone="error">名冊第 7 列的學號與既有帳號重複，整份都沒有匯入。</Note>
      </Block>

      <Block title="資料表" note="數字欄靠右、等寬，方便上下掃視">
        <Table
          columns={[
            { key: 'n', head: '班級', cell: (r: Row) => r.name },
            { key: 's', head: '人數', numeric: true, cell: (r: Row) => r.students },
            {
              key: 'r',
              head: '本月平均答對率',
              numeric: true,
              cell: (r: Row) => `${(r.rate * 100).toFixed(0)}%`,
            },
          ]}
          rows={ROWS}
          rowKey={(r) => r.id}
          selectedKey="b"
          empty={<Empty title="還沒有班級" />}
          caption="班級一覽"
        />
      </Block>

      <Block title="四種沒有內容的狀態" note="把「出錯」畫成「空的」是最貴的一種偷懶">
        <div style={{ display: 'grid', gap: 14 }}>
          <Loading what="正在讀取班級" />
          <Empty
            title="這個班還沒有學生"
            hint="可以一位一位新增，或用 CSV 一次匯入整份名冊。"
            action={<button className="yz-btn yz-btn--primary">匯入名冊</button>}
          />
          <ErrorBox
            detail="讀取班級時資料庫沒有回應。這通常是暫時的。"
            action={<button className="yz-btn">重新讀取</button>}
          />
          <Denied
            what="編輯這個班級"
            why="你不是「三年甲班」的導師。要調整名冊請找該班導師或管理員。"
          />
        </div>
      </Block>

      <Block title="對話框" note="破壞性動作要說出後果，不只問「確定嗎」">
        <div className="yz-dialog" style={{ position: 'static', display: 'block', boxShadow: 'none' }}>
          <div className="yz-dialog__body">
            <h2 className="yz-dialog__title">刪除「三年甲班」</h2>
            <div className="yz-dialog__content">
              這個班目前有 32 位學生。刪除之後他們的作答記錄與錯題都會保留，
              但不再屬於任何班級，也收不到派給這個班的任務。
              <br />
              <br />
              這個動作無法復原。
            </div>
            <div className="yz-dialog__foot">
              <button className="yz-btn yz-btn--quiet">取消</button>
              <button className="yz-btn yz-btn--danger">刪除班級</button>
            </div>
          </div>
        </div>
      </Block>
    </div>
  );
}
