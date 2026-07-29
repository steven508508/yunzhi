/**
 * 科目的新增、改名與停用。
 *
 * # 為什麼停用要問，改名不用
 *
 * 改名是可逆的，而且改錯了畫面上立刻看得出來（下拉裡的字不對）。
 *
 * 停用不是：那一科會從題庫、匯入、組卷、知識點的科目清單裡**整個消失**，
 * 而底下的東西沒有被刪掉——它們只是再也沒有入口。伺服器端擋住了
 * 「還有題目或卷子」的情況（見 lib/subject.ts），但擋不住「這一科底下
 * 有 40 個知識點與 3 位授課老師」這種——那不會弄壞東西，但那 3 位老師
 * 明天就看不到這一科的成績了。所以確認視窗要把數字唸出來。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/Dialog';
import { SelectField, TextField } from '@/components/Field';
import { Empty, Note } from '@/components/Feedback';
import { Form, submitJson, useAction } from '@/components/Form';
import { Table } from '@/components/Table';

export type Subject = {
  id: string;
  code: string;
  name: string;
  parentCode: string | null;
  parentName: string | null;
  gsatFullScore: number | null;
  active: boolean;
  /** 安裝時附的學測標準科目。刪不掉也不該鼓勵停用。 */
  standard: boolean;
  questions: number;
  papers: number;
  knowledgePoints: number;
  teachers: number;
};

export default function SubjectEditor({
  subjects,
  parents,
}: {
  subjects: Subject[];
  parents: { code: string; name: string }[];
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(subjects.length === 0);
  const [editing, setEditing] = useState<Subject | null>(null);
  const [disabling, setDisabling] = useState<Subject | null>(null);
  // 表格裡的動作不走 <Form>，所以錯誤要自己接住並顯示在列表上方。
  const [rowError, setRowError] = useState<string | null>(null);
  const { busy, error, clearError, run } = useAction();

  async function setActive(subject: Subject, active: boolean) {
    setRowError(null);
    const ok = await run(async () => {
      await submitJson(`/api/subjects/${subject.id}`, {
        method: 'PATCH',
        json: { active },
      });
    });
    if (ok) {
      setDisabling(null);
      router.refresh();
    }
  }

  return (
    <>
      {adding ? (
        <div className="yz-card" style={{ marginBottom: 22 }}>
          <h2 className="yz-card__title">新增科目</h2>
          <NewSubjectForm
            parents={parents}
            onDone={() => {
              setAdding(false);
              router.refresh();
            }}
            onCancel={subjects.length === 0 ? undefined : () => setAdding(false)}
          />
        </div>
      ) : (
        <div style={{ marginBottom: 20 }}>
          <Button variant="primary" onClick={() => setAdding(true)}>
            新增科目
          </Button>
        </div>
      )}

      {editing && (
        <div className="yz-card" style={{ marginBottom: 22 }}>
          <h2 className="yz-card__title">
            編輯「{editing.name}」（{editing.code}）
          </h2>
          <RenameForm
            // key 讓換一列編輯時整個表單重建。少了它，React 會沿用同一個
            // 元件實例，而欄位的初始值只在第一次掛載時讀——畫面上是
            // 「編輯 化學」，格子裡卻是物理的名字，存下去就改錯了。
            key={editing.id}
            subject={editing}
            onDone={() => {
              setEditing(null);
              router.refresh();
            }}
            onCancel={() => setEditing(null)}
          />
        </div>
      )}

      {rowError && <Note tone="error">{rowError}</Note>}

      <Table
        caption="科目一覽"
        columns={[
          {
            key: 'name',
            head: '科目',
            cell: (s: Subject) => (
              <>
                {s.name}
                {!s.active && <span className="yz-muted">（已停用）</span>}
                {s.parentName && <span className="yz-muted">屬於{s.parentName}</span>}
              </>
            ),
          },
          {
            key: 'code',
            head: '代碼',
            // 代碼是匯入管線用的鍵，改不了——用等寬的宋體標出它與
            // 名稱不是同一類東西，免得有人以為那一欄也可以編輯。
            cell: (s: Subject) => <code className="yz-code">{s.code}</code>,
          },
          {
            key: 'full',
            head: '學測滿分',
            numeric: true,
            cell: (s: Subject) => s.gsatFullScore ?? <span className="yz-muted">—</span>,
          },
          { key: 'q', head: '題目', numeric: true, cell: (s: Subject) => s.questions || '—' },
          { key: 'p', head: '卷子', numeric: true, cell: (s: Subject) => s.papers || '—' },
          {
            key: 'act',
            // 空白表頭在讀螢幕上會被念成一個沒有名字的欄，所以給它一個
            // 只有輔助科技聽得到的標題。
            head: <span className="yz-sr">動作</span>,
            cell: (s: Subject) => (
              <span className="yz-rowacts" style={{ justifyContent: 'flex-end' }}>
                <Button variant="quiet" onClick={() => setEditing(s)} disabled={busy}>
                  改名
                </Button>
                {s.active ? (
                  <Button variant="quiet" onClick={() => setDisabling(s)} disabled={busy}>
                    停用
                  </Button>
                ) : (
                  <Button onClick={() => void setActive(s, true)} disabled={busy}>
                    重新啟用
                  </Button>
                )}
              </span>
            ),
          },
        ]}
        rows={subjects}
        rowKey={(s) => s.id}
        selectedKey={editing?.id ?? null}
        empty={
          <Empty
            title="還沒有科目"
            hint="沒有科目就匯不了題、也建不了卷子。先建一科，才走得到下一步。"
          />
        }
      />

      <ConfirmDialog
        open={disabling !== null}
        onClose={() => {
          if (busy) return;
          clearError();
          setDisabling(null);
        }}
        busy={busy}
        title={disabling ? `停用「${disabling.name}」` : ''}
        confirmLabel="停用這一科"
        consequence={
          <>
            <p style={{ marginBottom: 12 }}>
              停用之後，這一科<strong>不會再出現在匯入、組卷、題庫與知識點的科目選單裡</strong>。
              已經存在的資料不會被刪掉，但畫面上也沒有任何入口可以走到它們。
            </p>
            {disabling && (disabling.knowledgePoints > 0 || disabling.teachers > 0) && (
              <p style={{ marginBottom: 12 }}>
                這一科底下目前有
                {disabling.knowledgePoints > 0 && (
                  <>
                    {' '}
                    <strong>{disabling.knowledgePoints} 個知識點</strong>
                  </>
                )}
                {disabling.knowledgePoints > 0 && disabling.teachers > 0 && '、'}
                {disabling.teachers > 0 && (
                  <>
                    {' '}
                    <strong>{disabling.teachers} 筆授課老師指派</strong>
                  </>
                )}
                。那些老師會看不到這一科的成績，也派不了這一科的卷子。
              </p>
            )}
            {disabling?.standard && (
              <p style={{ marginBottom: 12 }} className="yz-hint">
                這是學測的標準考科。停用它通常是因為貴機構不開這一科——
                如果只是這學期沒開，之後隨時可以重新啟用，資料都還在。
              </p>
            )}
            <p className="yz-hint">隨時可以重新啟用，停用不會刪掉任何東西。</p>
            {error && <p className="yz-field__err">{error}</p>}
          </>
        }
        onConfirm={() => disabling && void setActive(disabling, false)}
      />
    </>
  );
}

/**
 * 新增。**代碼只在這裡填得到**——建立之後就固定了（見 lib/subject.ts），
 * 所以這個表單與改名的表單不共用，欄位本來就不一樣。
 */
function NewSubjectForm({
  parents,
  onDone,
  onCancel,
}: {
  parents: { code: string; name: string }[];
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [parentCode, setParentCode] = useState('');
  const [fullScore, setFullScore] = useState('');

  return (
    <Form
      onSubmit={async () => {
        await submitJson('/api/subjects', {
          json: {
            code: code.trim().toUpperCase(),
            name: name.trim(),
            parentCode: parentCode || null,
            // 分科沒有自己的學測滿分，伺服器端也會再擋一次。
            gsatFullScore: parentCode || !fullScore ? null : Number(fullScore),
          },
        });
        onDone();
      }}
    >
      {({ busy }) => (
        <>
          <div className="yz-row">
            <TextField
              label="代碼"
              required
              value={code}
              onChange={(e) => setCode(e.currentTarget.value.toUpperCase())}
              hint="大寫英數與底線，例如 COMPOSITION。這是 AI 匯入管線用來分科的鍵，建立之後就改不了了。"
              autoComplete="off"
              autoFocus
            />
            <TextField
              label="名稱"
              required
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              hint="老師與學生看到的字，例如「作文班」。之後隨時可以改。"
            />
          </div>
          <SelectField
            label="屬於哪一個學測考科"
            value={parentCode}
            onChange={(e) => setParentCode(e.currentTarget.value)}
            hint="像化學屬於自然那樣。這一科本身就是學測考科（或與學測無關）的話，選「不屬於任何考科」。"
          >
            <option value="">不屬於任何考科</option>
            {parents.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name}（{p.code}）
              </option>
            ))}
          </SelectField>
          {!parentCode && (
            <TextField
              label="學測滿分"
              type="number"
              min={1}
              value={fullScore}
              onChange={(e) => setFullScore(e.currentTarget.value)}
              hint="國英數 100、自然 128、社會 144。與學測無關的科目留空——留空時成績頁不會顯示級分，那比顯示一個算錯的級分好。"
            />
          )}
          <div className="yz-actions">
            <span className="yz-actions__spacer" />
            {onCancel && (
              <Button variant="quiet" onClick={onCancel} disabled={busy}>
                取消
              </Button>
            )}
            <Button type="submit" variant="primary" busy={busy} busyLabel="建立中…">
              建立
            </Button>
          </div>
        </>
      )}
    </Form>
  );
}

/** 改名。代碼、上層考科與滿分都不在這裡——理由見 lib/subject.ts 的檔頭。 */
function RenameForm({
  subject,
  onDone,
  onCancel,
}: {
  subject: Subject;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(subject.name);

  return (
    <Form
      onSubmit={async () => {
        await submitJson(`/api/subjects/${subject.id}`, {
          method: 'PATCH',
          json: { name: name.trim() },
        });
        onDone();
      }}
    >
      {({ busy }) => (
        <>
          <TextField
            label="名稱"
            required
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            hint={
              `代碼 ${subject.code} 不會跟著改——它是 AI 匯入管線用來分科的鍵，` +
              '改了之後管線送回來的題目會對不上任何一科。'
            }
            autoFocus
          />
          <div className="yz-actions">
            <span className="yz-actions__spacer" />
            <Button variant="quiet" onClick={onCancel} disabled={busy}>
              取消
            </Button>
            <Button type="submit" variant="primary" busy={busy} busyLabel="儲存中…">
              儲存
            </Button>
          </div>
        </>
      )}
    </Form>
  );
}
