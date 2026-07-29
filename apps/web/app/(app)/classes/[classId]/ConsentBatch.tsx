/**
 * 一次登錄一批家長同意。
 *
 * # 為什麼這一塊非有不可
 *
 * 逐位登錄是「點按鈕 → 對話框開 → 選取得方式 → 送出 → 整頁重繪 →
 * 再找下一位」。200 位以每位 8 秒估是 **27 分鐘的純點擊**，
 * 而在那之前那 200 個帳號一個都登不進去。
 *
 * 名冊匯入 200 人是一分鐘，啟用 200 人是半小時——這是裝機第一天
 * 真正的時間殺手，而且中間不能被櫃檯電話打斷（打斷了要回去找剛剛
 * 做到哪一位，而名冊上沒有「只看未同意」的篩選）。
 *
 * 這一塊只列**還沒有同意紀錄的人**，所以它同時就是那個篩選：
 * 做到一半被打斷，回來時剩下的正好是還沒做的。
 *
 * # 為什麼是一張獨立的卡片，而不是在名冊表格上加一欄勾選
 *
 * 因為名冊表格是伺服器元件（它要印家長信箱與帳號狀態），
 * 加一欄勾選就得把整張表變成 client component，而那會把全班的家長
 * 信箱送進瀏覽器的 JS bundle。這一塊只拿到 id、學號、姓名——
 * 登錄同意需要的就是這三樣。
 *
 * # 預設全選
 *
 * 因為最常見的情境是「櫃檯今天收到一疊回條，全班的都在裡面」。
 * 預設全不選的話，那個情境要按 30 下才回到起點。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/Dialog';
import { SelectField, TextField } from '@/components/Field';
import { Note } from '@/components/Feedback';
import { submitJson, useAction } from '@/components/Form';

export type PendingStudent = { id: string; username: string; displayName: string };

const METHODS = [
  { value: 'IN_PERSON', label: '現場簽署（櫃檯報名時當場簽）' },
  { value: 'PAPER', label: '紙本回條（家長簽名後帶回）' },
  { value: 'ONLINE', label: '線上同意' },
] as const;

export default function ConsentBatch({
  classId,
  className,
  students,
}: {
  classId: string;
  className: string;
  students: PendingStudent[];
}) {
  const router = useRouter();
  // Set 而不是陣列：30 個人的勾選要判斷 30 次「有沒有被勾」，
  // 而 `includes` 是 O(n)——在 200 人的班上那是每次重繪 40 000 次比較。
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(students.map((s) => s.id)),
  );
  const [method, setMethod] = useState<string>('PAPER');
  const [note, setNote] = useState('');
  const [asking, setAsking] = useState(false);
  const { busy, error, clearError, run } = useAction();

  if (students.length === 0) return null;

  const all = picked.size === students.length;

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="yz-card" style={{ marginBottom: 22 }}>
      <h2 className="yz-card__title">登錄家長同意（{students.length} 位待處理）</h2>
      <p className="yz-hint" style={{ marginBottom: 12 }}>
        這些帳號<strong>現在登不進去</strong>。個資法第 15 條要求蒐集未成年人的個人資料
        需法定代理人同意，所以系統預設擋住，取得同意後才開。
        下次匯入名冊時可以直接在 CSV 加一欄「家長同意」，匯入時就一起完成。
      </p>

      {error && <Note tone="error">{error}</Note>}

      <div className="yz-roll__bar">
        <Button
          variant="quiet"
          onClick={() =>
            setPicked(all ? new Set() : new Set(students.map((s) => s.id)))
          }
          disabled={busy}
        >
          {all ? '全部不選' : `全選這 ${students.length} 位`}
        </Button>
        <span className="yz-roll__count">已勾選 {picked.size} 位</span>
      </div>

      <ul className="yz-roll">
        {students.map((s) => (
          <li key={s.id}>
            <label className="yz-roll__item">
              <input
                type="checkbox"
                checked={picked.has(s.id)}
                onChange={() => toggle(s.id)}
                disabled={busy}
              />
              <span className="yz-roll__name">{s.displayName}</span>
              <span className="yz-roll__id">{s.username}</span>
            </label>
          </li>
        ))}
      </ul>

      <div className="yz-actions">
        <span className="yz-actions__spacer" />
        <Button
          variant="primary"
          onClick={() => setAsking(true)}
          disabled={busy || picked.size === 0}
          title={picked.size === 0 ? '先勾選至少一位' : undefined}
        >
          登錄勾選的 {picked.size} 位
        </Button>
      </div>

      <ConfirmDialog
        open={asking}
        onClose={() => {
          if (busy) return;
          clearError();
          setAsking(false);
        }}
        busy={busy}
        title={`登錄「${className}」${picked.size} 位的家長同意`}
        confirmLabel={`登錄並啟用這 ${picked.size} 個帳號`}
        consequence={
          <>
            <p style={{ marginBottom: 12 }}>
              這 {picked.size} 位的帳號登錄之後就可以登入。
              <strong>請確認你真的已經取得這幾位法定代理人的同意</strong>
              ——每一位都會單獨寫一筆稽核記錄，連同你的姓名與時間，日後有爭議時它就是憑據。
            </p>
            <p style={{ marginBottom: 12 }}>
              已經有同意紀錄的人不會被重寫。<strong>同意日期記的是第一次取得的時間</strong>，
              按第二次不會把它改成今天。
            </p>
            {error && <p className="yz-field__err">{error}</p>}
            <SelectField
              label="取得方式"
              value={method}
              onChange={(e) => setMethod(e.currentTarget.value)}
              hint="現場簽署、紙本回條、線上同意的證據力不同，所以要分開記。這一批共用同一種——不同方式的請分批登錄。"
              disabled={busy}
            >
              {METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </SelectField>
            <TextField
              label="備註"
              value={note}
              onChange={(e) => setNote(e.currentTarget.value)}
              hint="例如回條的收件日期。會寫進這一批每一位的稽核記錄裡。可以留空。"
              disabled={busy}
            />
          </>
        }
        onConfirm={() =>
          void (async () => {
            const ok = await run(async () => {
              await submitJson<{ recorded: number; alreadyDone: number }>(
                `/api/classes/${classId}/consent`,
                {
                  json: {
                    method,
                    note: note || undefined,
                    studentIds: [...picked],
                  },
                },
              );
            });
            if (ok) {
              setAsking(false);
              router.refresh();
            }
          })()
        }
      />
    </div>
  );
}
