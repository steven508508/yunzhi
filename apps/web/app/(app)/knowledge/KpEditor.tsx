'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { Button } from '@/components/Button';
import { SelectField, TextAreaField, TextField } from '@/components/Field';
import { Empty, Note } from '@/components/Feedback';
import { Form, submitJson } from '@/components/Form';

type Kp = {
  id: string;
  name: string;
  description: string | null;
  questions: number;
  prereqs: string[];
};

export default function KpEditor({
  subjectId,
  subjectName,
  points,
  teachingOrder,
}: {
  subjectId: string;
  subjectName: string;
  points: Kp[];
  teachingOrder: string[] | null;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [prereq, setPrereq] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const byId = useMemo(() => new Map(points.map((p) => [p.id, p])), [points]);
  const current = selected ? byId.get(selected) : null;

  async function addPrereq() {
    if (!current || !prereq || busy) return;
    setBusy(true);
    setLinkError(null);
    try {
      await submitJson(`/api/knowledge-points/${current.id}/prerequisites`, {
        json: { prereqKpId: prereq },
      });
      setPrereq('');
      router.refresh();
    } catch (e) {
      setLinkError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function removePrereq(prereqKpId: string) {
    if (!current || busy) return;
    setBusy(true);
    setLinkError(null);
    try {
      const res = await fetch(
        `/api/knowledge-points/${current.id}/prerequisites?prereq=${prereqKpId}`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? '移除失敗');
      router.refresh();
    } catch (e) {
      setLinkError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="yz-card" style={{ marginBottom: 22 }}>
        <h2 className="yz-card__title">新增知識點</h2>
        <Form
          onSubmit={async () => {
            await submitJson('/api/knowledge-points', {
              json: { subjectId, name, description: desc || undefined },
            });
            setName('');
            setDesc('');
            router.refresh();
          }}
        >
          {({ busy: formBusy }) => (
            <>
              <TextField
                label="名稱"
                required
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                hint="學生會在能力分析上看到這個名稱，所以要寫得像人話：「等差級數的求和」比「數列-2」好。"
              />
              <TextAreaField
                label="說明"
                rows={2}
                value={desc}
                onChange={(e) => setDesc(e.currentTarget.value)}
                hint="給老師與 AI 看的。匯入題本時的自動標註會用它判斷一題該掛哪裡。"
              />
              <div className="yz-actions">
                <span className="yz-actions__spacer" />
                <Button type="submit" variant="primary" busy={formBusy}>
                  新增
                </Button>
              </div>
            </>
          )}
        </Form>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        <section>
          <h2 className="yz-card__title" style={{ borderTop: '1px solid var(--ink)', paddingTop: 14 }}>
            {subjectName}的知識點（{points.length}）
          </h2>
          {points.length === 0 ? (
            <Empty
              title="還沒有知識點"
              hint="沒有知識點的話，匯入題本時的自動標註不會有任何作用，能力分析也無從算起。"
            />
          ) : (
            <ul style={{ listStyle: 'none', fontSize: 13 }}>
              {points.map((p) => (
                <li key={p.id}>
                  <button
                    className={`yz-mark${selected === p.id ? ' yz-mark--current' : ''}`}
                    style={{ width: '100%', textAlign: 'left' }}
                    onClick={() => setSelected(p.id)}
                  >
                    <span style={{ flex: 1 }}>{p.name}</span>
                    <span className="yz-muted">
                      {p.prereqs.length > 0 && `前置 ${p.prereqs.length}`}
                      {p.questions > 0 && `　${p.questions} 題`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="yz-card__title" style={{ borderTop: '1px solid var(--ink)', paddingTop: 14 }}>
            前置關係
          </h2>
          {!current ? (
            <Empty
              title="選一個知識點"
              hint="前置關係決定智慧老師在學生卡住時往回補哪一個觀念，也決定能力分析怎麼把學分往下傳。"
            />
          ) : (
            <>
              <p style={{ fontSize: 13, marginBottom: 10 }}>
                <b>{current.name}</b> 需要先學會：
              </p>
              {linkError && <Note tone="error">{linkError}</Note>}
              {current.prereqs.length === 0 ? (
                <p className="yz-field__hint">還沒有設定前置。</p>
              ) : (
                <ul style={{ listStyle: 'none', fontSize: 13, marginBottom: 12 }}>
                  {current.prereqs.map((id) => (
                    <li key={id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 0' }}>
                      <span style={{ flex: 1 }}>{byId.get(id)?.name ?? id}</span>
                      <Button variant="quiet" onClick={() => removePrereq(id)} disabled={busy}>
                        移除
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <SelectField
                label="加一個前置"
                value={prereq}
                onChange={(e) => setPrereq(e.currentTarget.value)}
              >
                <option value="">選擇…</option>
                {points
                  .filter((p) => p.id !== current.id && !current.prereqs.includes(p.id))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </SelectField>
              <Button variant="primary" onClick={addPrereq} disabled={!prereq} busy={busy}>
                加入
              </Button>
            </>
          )}
        </section>
      </div>

      {teachingOrder && teachingOrder.length > 1 && (
        <section style={{ marginTop: 26 }}>
          <h2 className="yz-card__title" style={{ borderTop: '1px solid var(--ink)', paddingTop: 14 }}>
            推導出來的教學順序
          </h2>
          <p className="yz-field__hint" style={{ marginBottom: 8 }}>
            從最基礎排到最進階。這是前置關係的結果，不是另外設定的——
            順序看起來不對，代表某一條前置關係設錯了。
          </p>
          <p style={{ fontFamily: 'var(--font-doc)', fontSize: 13, lineHeight: 2 }}>
            {teachingOrder.join('　→　')}
          </p>
        </section>
      )}
    </>
  );
}
