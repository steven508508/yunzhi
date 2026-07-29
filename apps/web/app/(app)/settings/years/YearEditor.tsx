'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/Dialog';
import { CheckField, TextField } from '@/components/Field';
import { Empty, Note } from '@/components/Feedback';
import { Form, submitJson, useAction } from '@/components/Form';
import { Table } from '@/components/Table';

export type Year = {
  id: string;
  name: string;
  /** `YYYY-MM-DD`。伺服器端就切好，前端不再碰時區。 */
  startDate: string;
  endDate: string;
  isCurrent: boolean;
  classes: number;
  /** 這一年還有幾個啟用中的班、幾位在籍學生。結算的確認視窗要說得出來。 */
  activeClasses: number;
  activeMembers: number;
};

export default function YearEditor({
  years,
  suggestion,
}: {
  years: Year[];
  suggestion: { name: string; startDate: string; endDate: string };
}) {
  const router = useRouter();
  // 一個學年度都沒有時直接把表單打開：這個畫面存在的唯一理由就是
  // 「還建不了班」，再讓人多按一次「新增」只是多一道關卡。
  const [adding, setAdding] = useState(years.length === 0);
  const [editing, setEditing] = useState<Year | null>(null);
  // 表格裡的動作不走 <Form>，所以錯誤要自己接住並顯示在列表上方。
  const [rowError, setRowError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [closing, setClosing] = useState<Year | null>(null);
  const [typed, setTyped] = useState('');
  const close = useAction();

  async function makeCurrent(year: Year) {
    if (busyId) return;
    setBusyId(year.id);
    setRowError(null);
    try {
      await submitJson(`/api/academic-years/${year.id}`, {
        method: 'PATCH',
        json: { isCurrent: true },
      });
      router.refresh();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      {adding ? (
        <div className="yz-card" style={{ marginBottom: 22 }}>
          <h2 className="yz-card__title">新增學年度</h2>
          <YearForm
            initial={suggestion}
            // 第一個學年度不必問：它一定會成為當前（見 lib/academicYear.ts），
            // 給一個只有一種答案的勾選框只是讓人多讀一行字。
            offerCurrent={years.length > 0}
            submitLabel="建立"
            onSubmit={async (body) => {
              await submitJson('/api/academic-years', { json: body });
              setAdding(false);
              router.refresh();
            }}
            onCancel={years.length === 0 ? undefined : () => setAdding(false)}
          />
        </div>
      ) : (
        <div style={{ marginBottom: 20 }}>
          <Button variant="primary" onClick={() => setAdding(true)}>
            新增學年度
          </Button>
        </div>
      )}

      {editing && (
        <div className="yz-card" style={{ marginBottom: 22 }}>
          <h2 className="yz-card__title">編輯「{editing.name}」</h2>
          <YearForm
            // key 讓換一列編輯時整個表單重建。少了它，React 會沿用同一個
            // 元件實例，而欄位的初始值只在第一次掛載時讀——畫面上是
            // 「編輯 116學年度」，格子裡卻是 115 的資料，存下去就改錯了。
            key={editing.id}
            initial={editing}
            offerCurrent={false}
            submitLabel="儲存"
            onSubmit={async (body) => {
              await submitJson(`/api/academic-years/${editing.id}`, {
                method: 'PATCH',
                json: { name: body.name, startDate: body.startDate, endDate: body.endDate },
              });
              setEditing(null);
              router.refresh();
            }}
            onCancel={() => setEditing(null)}
          />
        </div>
      )}

      {rowError && <Note tone="error">{rowError}</Note>}

      <Table
        caption="學年度一覽"
        columns={[
          {
            key: 'name',
            head: '學年度',
            cell: (y: Year) => (
              <>
                {y.name}
                {y.isCurrent && <span className="yz-muted">（當前）</span>}
              </>
            ),
          },
          { key: 'start', head: '開始', cell: (y: Year) => y.startDate },
          { key: 'end', head: '結束', cell: (y: Year) => y.endDate },
          { key: 'n', head: '班級', numeric: true, cell: (y: Year) => y.classes || '—' },
          {
            key: 'act',
            // 空白表頭在讀螢幕上會被念成一個沒有名字的欄，所以給它一個
            // 只有輔助科技聽得到的標題。
            head: <span className="yz-sr">動作</span>,
            cell: (y: Year) => (
              <span style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Button variant="quiet" onClick={() => setEditing(y)} disabled={Boolean(busyId)}>
                  編輯
                </Button>
                {!y.isCurrent && (
                  <Button
                    onClick={() => makeCurrent(y)}
                    busy={busyId === y.id}
                    busyLabel="切換中…"
                    disabled={Boolean(busyId)}
                  >
                    設為當前
                  </Button>
                )}
                {/* 結算只出現在**不是當前**而且底下還有班的年度上。
                    當前學年度結算掉之後，開班的表單不知道要預選哪一年，
                    而新開的班會掛在一個已經收掉的年度底下——所以順序
                    必須是「先建新的、設為當前，再結算舊的」。
                    伺服器端也擋，這裡不畫是為了不給一顆按下去必定被
                    退回的按鈕。 */}
                {!y.isCurrent && y.classes > 0 && (
                  <Button
                    variant="quiet"
                    onClick={() => {
                      setTyped('');
                      setClosing(y);
                    }}
                    disabled={Boolean(busyId) || close.busy}
                    title="把這一年所有班級的在籍名冊收掉，班級封存"
                  >
                    結算
                  </Button>
                )}
              </span>
            ),
          },
        ]}
        rows={years}
        rowKey={(y) => y.id}
        selectedKey={editing?.id ?? null}
        empty={
          <Empty
            title="還沒有學年度"
            hint="學年度是班級的容器。建好之後才能到「班級」開第一個班、匯入名冊。"
          />
        }
      />

      {/* 結算。這一頁上唯一一個會同時動到兩百列名冊的動作，
          所以與整班重設密碼同一道防線：要打出名稱才確認得了。
          「確定嗎」擋得掉誤觸，擋不掉**按到隔壁那一年**。 */}
      <ConfirmDialog
        open={closing !== null}
        onClose={() => {
          if (close.busy) return;
          close.clearError();
          setTyped('');
          setClosing(null);
        }}
        busy={close.busy}
        title={closing ? `結算「${closing.name}」` : ''}
        confirmLabel={
          closing && typed.trim() === closing.name ? '結算這個學年度' : '請先打出學年度名稱'
        }
        confirmDisabled={!closing || typed.trim() !== closing.name}
        consequence={
          <>
            <p style={{ marginBottom: 12 }}>
              這一年的 <strong>{closing?.activeClasses ?? 0} 個班會被封存</strong>，
              目前還在籍的 <strong>{closing?.activeMembers ?? 0} 位學生會被記上離班日期</strong>
              （用這個學年度的結束日，不是今天——他們不是今天才離開的）。
            </p>
            <p style={{ marginBottom: 12 }}>
              做這件事的理由：不收的話，第二年開學時每一位學生的任務清單會
              <strong>同時回新舊兩年</strong>的作業，班級列表上是十四個班而看的人
              分不出哪七個已經沒有人了，成績與派卷的清單也被兩年份一起佔滿。
            </p>
            <p style={{ marginBottom: 12 }}>
              <strong>成績、作答與名冊本身全部保留。</strong>離班寫的是日期，
              不是刪掉那一列——過去的成績仍然對得回這個班。班級之後也可以重新啟用。
            </p>
            <p style={{ marginBottom: 12 }}>
              有人正在作答的話這個動作會被擋下來，並說出是誰。
            </p>
            <p className="yz-hint" style={{ marginBottom: 12 }}>
              誰在什麼時候結算了哪一年會寫進稽核記錄，行為人是你。
            </p>
            <TextField
              label="請打出學年度名稱以確認"
              value={typed}
              onChange={(e) => setTyped(e.currentTarget.value)}
              hint={`要完全相同：${closing?.name ?? ''}`}
              autoComplete="off"
              disabled={close.busy}
            />
            {close.error && <p className="yz-field__err">{close.error}</p>}
          </>
        }
        onConfirm={() =>
          void (async () => {
            if (!closing) return;
            const ok = await close.run(async () => {
              await submitJson(`/api/academic-years/${closing.id}/close`, {
                json: { confirmName: typed.trim() },
              });
            });
            if (ok) {
              setClosing(null);
              setTyped('');
              router.refresh();
            }
          })()
        }
      />
    </>
  );
}

/**
 * 新增與編輯共用同一組欄位。
 *
 * 分成兩份寫的話，日後加一個欄位一定會有一邊忘記，而症狀是
 * 「新增時填得到、編輯時看不到」——使用者會以為資料不見了。
 */
function YearForm({
  initial,
  offerCurrent,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: { name: string; startDate: string; endDate: string };
  offerCurrent: boolean;
  submitLabel: string;
  onSubmit: (body: {
    name: string;
    startDate: string;
    endDate: string;
    isCurrent?: boolean;
  }) => Promise<void>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [startDate, setStartDate] = useState(initial.startDate);
  const [endDate, setEndDate] = useState(initial.endDate);
  // 預設不勾。勾了會把原本的當前學年度換掉，那是一個會影響整套預設值
  // 的動作，不該是「沒注意到就發生了」。第一個學年度不必勾，
  // 伺服器端本來就會把它設為當前（見 lib/academicYear.ts）。
  const [isCurrent, setIsCurrent] = useState(false);

  return (
    <Form onSubmit={() => onSubmit({ name, startDate, endDate, isCurrent })}>
      {({ busy }) => (
        <>
          <TextField
            label="名稱"
            required
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            hint="用機構裡實際的講法，例如「115學年度」。老師與學生都會看到它。"
            autoFocus
          />
          <div className="yz-row">
            <TextField
              label="開始日期"
              type="date"
              required
              value={startDate}
              onChange={(e) => setStartDate(e.currentTarget.value)}
            />
            <TextField
              label="結束日期"
              type="date"
              required
              value={endDate}
              onChange={(e) => setEndDate(e.currentTarget.value)}
              hint="要晚於開始日期。"
            />
          </div>
          {offerCurrent && (
            <CheckField
              label="設為當前學年度"
              checked={isCurrent}
              onChange={(e) => setIsCurrent(e.currentTarget.checked)}
              hint="原本的當前學年度會自動被取消——同一時間只能有一個。"
            />
          )}
          <div className="yz-actions">
            <span className="yz-actions__spacer" />
            {onCancel && (
              <Button variant="quiet" onClick={onCancel} disabled={busy}>
                取消
              </Button>
            )}
            <Button type="submit" variant="primary" busy={busy} busyLabel="送出中…">
              {submitLabel}
            </Button>
          </div>
        </>
      )}
    </Form>
  );
}
