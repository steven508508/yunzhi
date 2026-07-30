/**
 * 通知設定的表單。
 *
 * 兩件事：哪幾類要收，以及免打擾時段。
 *
 * # 為什麼免打擾也適用於「必收」的那幾則
 *
 * 因為「不可關閉」的意思是**一定送到**，不是**一定現在吵你**。
 * 半夜三點的作廢通知延到早上七點出現，學生收到的資訊完全一樣；
 * 而一個「連免打擾都能被某些通知穿過去」的規則，會讓人乾脆不設
 * 免打擾——那時每一則都在半夜三點。實作見 `lib/notify.mjs` 的
 * `scheduleFor`：延後，不是丟掉。
 *
 * # 為什麼停用的核取方塊還是要畫出來
 *
 * 因為使用者要知道「這一類我會收到，而且我改不了」，以及為什麼。
 * 把必收的那幾列整個藏起來的話，他會以為自己已經關掉了所有通知，
 * 然後在收到作廢通知時認為設定沒有生效。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { CheckField, TextField } from '@/components/Field';
import { Note } from '@/components/Feedback';
import { Form } from '@/components/Form';

export type PrefItem = {
  key: string;
  label: string;
  why: string;
  mandatory: boolean;
  wanted: boolean;
};

export type ChannelInfo = {
  id: string;
  label: string;
  ready: boolean;
  why: string;
};

export default function Preferences({
  items,
  quietHours,
  channels,
}: {
  items: PrefItem[];
  quietHours: { start: string; end: string } | null;
  channels: ChannelInfo[];
}) {
  const router = useRouter();
  const [wanted, setWanted] = useState<Record<string, boolean>>(
    Object.fromEntries(items.map((i) => [i.key, i.wanted])),
  );
  const [quietOn, setQuietOn] = useState(quietHours != null);
  const [start, setStart] = useState(quietHours?.start ?? '22:00');
  const [end, setEnd] = useState(quietHours?.end ?? '07:00');
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaved(false);
    const res = await fetch('/api/notifications/preferences', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        wanted,
        quietHours: quietOn ? { start, end } : null,
      }),
    });
    const body = await res.json().catch(() => null);
    // 錯誤訊息由伺服器給：它說得出「開始與結束一樣等於一整天都不打擾」
    // 這種話，而前端重寫一份判斷就是多一次兩邊對不起來的機會。
    if (!res.ok) throw new Error(body?.error ?? '存不進去，請再試一次。');
    setSaved(true);
    router.refresh();
  }

  return (
    <Form onSubmit={save}>
      {({ busy }) => (
        <>
          {saved && <Note tone="info">設定已經儲存。</Note>}

          <h2 className="yz-card__title">要收哪幾類</h2>
          <ul className="yz-prefs">
            {items.map((item) => (
              <li key={item.key} className="yz-prefs__row">
                <CheckField
                  label={
                    <>
                      {item.label}
                      {item.mandatory && <span className="yz-prefs__must">必收</span>}
                    </>
                  }
                  hint={item.why}
                  checked={wanted[item.key] !== false}
                  disabled={item.mandatory}
                  onChange={(e) =>
                    setWanted((w) => ({ ...w, [item.key]: e.currentTarget.checked }))
                  }
                />
              </li>
            ))}
          </ul>

          <h2 className="yz-card__title" style={{ marginTop: 26 }}>
            免打擾時段
          </h2>
          <p className="yz-prefs__note">
            這段時間內產生的通知會延到結束之後才出現，
            <strong>不會消失</strong>
            。必收的那幾類也一樣延後——「不能關掉」的意思是一定送到，
            不是一定現在吵你。時間一律台灣時間。
          </p>
          <CheckField
            label="啟用免打擾時段"
            checked={quietOn}
            onChange={(e) => setQuietOn(e.currentTarget.checked)}
          />
          {quietOn && (
            <div className="yz-prefs__quiet">
              <TextField
                label="從"
                type="time"
                value={start}
                onChange={(e) => setStart(e.currentTarget.value)}
              />
              <TextField
                label="到"
                type="time"
                value={end}
                onChange={(e) => setEnd(e.currentTarget.value)}
                hint="跨過午夜是正常的，例如 22:00 到 07:00。"
              />
            </div>
          )}

          <h2 className="yz-card__title" style={{ marginTop: 26 }}>
            送到哪裡
          </h2>
          {/* **未接的渠道要寫出來。** 藏起來的話，「為什麼家長沒收到
              成績通知」在系統裡沒有任何答案，而老師會假設寄出去了。
              系統內部的處置是建立之後立刻標成 SUPPRESSED 並寫下原因，
              絕不留在佇列裡假裝在排隊——見 lib/notify.mjs。 */}
          <ul className="yz-prefs">
            {channels.map((c) => (
              <li key={c.id} className="yz-prefs__row">
                <span className="yz-prefs__ch">
                  {c.label}
                  {c.ready ? (
                    <span className="yz-prefs__on">使用中</span>
                  ) : (
                    <span className="yz-prefs__off">未接</span>
                  )}
                </span>
                {!c.ready && <span className="yz-prefs__why">{c.why}</span>}
              </li>
            ))}
          </ul>

          <div style={{ marginTop: 20 }}>
            <Button type="submit" variant="primary" busy={busy} busyLabel="儲存中…">
              儲存設定
            </Button>
          </div>
        </>
      )}
    </Form>
  );
}
