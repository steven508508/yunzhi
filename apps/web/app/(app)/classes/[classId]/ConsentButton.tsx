/**
 * 記錄法定代理人的同意。
 *
 * # 為什麼這顆按鈕非有不可
 *
 * 名冊匯入建出來的學生帳號是 `PENDING_CONSENT`，**登不進去**——
 * 那是刻意的（個資法第 15 條：蒐集未成年人的個人資料需法定代理人
 * 同意）。但在此之前，後端的 `recordConsent` 與 API 路由都寫好了，
 * 而**介面上沒有任何地方會呼叫它**。
 *
 * 結果是一條死路：櫃檯匯入 32 人的名冊，隔天沒有一個學生登得進來，
 * 而系統裡沒有任何方式可以解決。名冊頁只是把「未取得」三個字印出來。
 *
 * # 為什麼要選取得方式
 *
 * 現場簽名、線上勾選、紙本回條的證據力不同。日後真的出事時，
 * 「什麼時候、用什麼方式取得的」才是能拿出來的東西——只記一個
 * 時間戳說明不了任何事。這個值寫進稽核記錄。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/Dialog';
import { SelectField, TextField } from '@/components/Field';
import { submitJson } from '@/components/Form';

const METHODS = [
  { value: 'IN_PERSON', label: '現場簽署（櫃檯報名時當場簽）' },
  { value: 'PAPER', label: '紙本回條（家長簽名後帶回）' },
  { value: 'ONLINE', label: '線上同意' },
] as const;

export default function ConsentButton({
  studentId,
  studentName,
}: {
  studentId: string;
  studentName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<string>('IN_PERSON');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <Button variant="quiet" onClick={() => setOpen(true)}>
        登錄同意
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => !busy && setOpen(false)}
        busy={busy}
        title={`登錄「${studentName}」的家長同意`}
        confirmLabel="登錄並啟用帳號"
        consequence={
          <>
            {/* JSX 不解析 Markdown，所以 `**…**` 會有四個星號原樣印在
                畫面上——而這裡是整個系統唯一一個講個資法責任的對話框，
                最不該看起來像沒做完的地方。 */}
            <p style={{ marginBottom: 12 }}>
              登錄之後這個帳號就可以登入。
              <strong>請確認你真的已經取得法定代理人的同意</strong>
              ——這筆記錄會連同你的姓名與時間寫進稽核，日後有爭議時它就是憑據。
            </p>
            {error && <p className="yz-field__err">{error}</p>}
            <SelectField
              label="取得方式"
              value={method}
              onChange={(e) => setMethod(e.currentTarget.value)}
              hint="現場簽署、紙本回條、線上同意的證據力不同，所以要分開記。"
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
              hint="例如回條的收件日期、或是誰代為確認的。可以留空。"
            />
          </>
        }
        onConfirm={async () => {
          setBusy(true);
          setError(null);
          try {
            await submitJson(`/api/students/${studentId}/consent`, {
              json: { method, note: note || undefined },
            });
            setOpen(false);
            router.refresh();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
}
