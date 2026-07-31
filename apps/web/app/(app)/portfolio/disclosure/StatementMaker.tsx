/**
 * 產生揭露聲明，並讓學生編輯。
 *
 * # 這裡的「複製」按鈕是可以有的，而回饋那一頁的不行
 *
 * 這個差別值得寫下來，因為它看起來不一致。
 *
 * 回饋那一頁沒有複製按鈕，是因為那段文字是**對他的觀察與提問**——
 * 複製它到自己的檔案裡就是代寫。這一頁的聲明**本來就是要被貼進檔案
 * 的**，那是它唯一的用途。差別不在按鈕，在那段文字是誰的話：
 * 聲明是他自己對招生單位說的話（他具名負責），回饋是別人對他說的話。
 *
 * # 為什麼原始版本與編輯後的版本都留著
 *
 * 前者是系統依記錄說了什麼，後者是他決定要說什麼。兩者都留著，
 * 因為如果日後有人問起「系統有沒有幫他掩飾」，答案要查得出來。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { Note } from '@/components/Feedback';
import { TextAreaField } from '@/components/Field';
import { submitJson, useAction } from '@/components/Form';

type Statement = {
  id: string;
  generated: string;
  edited: string | null;
  createdAt: string;
};

export default function StatementMaker({
  statements,
  counts,
  total,
}: {
  statements: Statement[];
  counts: Record<string, number>;
  total: number;
}) {
  const router = useRouter();
  const { busy, error, run } = useAction();
  const latest = statements[0];
  const [draft, setDraft] = useState(latest?.edited ?? latest?.generated ?? '');
  const [loadedFor, setLoadedFor] = useState(latest?.id ?? '');
  const [blocked, setBlocked] = useState<string[]>([]);
  const [fellBack, setFellBack] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);

  if (loadedFor !== (latest?.id ?? '')) {
    setLoadedFor(latest?.id ?? '');
    setDraft(latest?.edited ?? latest?.generated ?? '');
  }

  const make = () =>
    run(async () => {
      const out = await submitJson<{
        made: { generated: string; fellBack: boolean; blockedReasons: string[] };
      }>('/api/portfolio/disclosure', { json: {} });
      setDraft(out.made.generated);
      setBlocked(out.made.blockedReasons);
      setFellBack(out.made.fellBack);
      router.refresh();
    });

  const save = () =>
    run(async () => {
      if (!latest) return;
      // 存不進去的時候（改過的版本與記錄對不起來）伺服器回 400，
      // `submitJson` 會把那句說明丟成錯誤，畫面上顯示在 `error` 那一格。
      const out = await submitJson<{ warnings?: string[] }>('/api/portfolio/disclosure', {
        json: { statementId: latest.id, edited: draft },
      });
      setWarnings(out.warnings ?? []);
      router.refresh();
    });

  return (
    <section>
      <h2 className="yz-card__title" style={{ marginTop: 26 }}>
        揭露聲明
      </h2>

      {error && <Note tone="error">{error}</Note>}

      <p className="yz-hint">
        依你的實際記錄產生（{total === 0 ? '目前一次互動都沒有' : `目前 ${total} 次互動`}
        {Object.keys(counts).length > 0 &&
          `：${Object.entries(counts)
            .map(([k, v]) => `${k} ${v} 次`)
            .join('、')}`}
        ）。<strong>不是固定樣板</strong>——用得多與用得少的聲明長得不一樣，
        而招生委員一眼就看得出哪一份是套版的。
      </p>

      <div className="yz-actions">
        <Button variant="primary" busy={busy} onClick={make}>
          {latest ? '依現在的記錄重新產生' : '產生一份'}
        </Button>
      </div>

      {blocked.length > 0 && (
        <Note tone="warn">
          有 {blocked.length} 次的草稿因為<strong>與你的實際記錄對不起來</strong>被擋下來重寫了
          （{blocked[0]}）。這一條檢查與防代寫的那一條不同：聲明本來就要用第一人稱寫，
          所以它走的是另一組規則——比對聲明說的話與記錄裡真正發生過的事。
        </Note>
      )}

      {fellBack && (
        <Note tone="warn">
          模型三次都寫出與記錄不符的聲明，所以上面這一份是系統直接依記錄組出來的。
          它讀起來比較像樣板，你可以自己改得像你講話的樣子——但不要刪掉任何一類
          真的發生過的互動。
        </Note>
      )}

      {latest && (
        <>
          <TextAreaField
            label="這一份會貼進你的檔案"
            hint="你可以改成像你講話的樣子。系統會同時保留原始的版本——前者是系統依記錄說了什麼，後者是你決定要說什麼。改過的版本一樣要對得回你的使用記錄。"
            rows={5}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />

          {warnings.length > 0 && (
            <Note tone="warn">
              存起來了，但有 {warnings.length} 件事值得再看一眼（{warnings.join('；')}）。
              這幾項不影響它與記錄相不相符，只是體例——
              <strong>「構思與撰寫由本人完成」是這份聲明最重要的一句</strong>，
              揭露的重點不是用了什麼工具，是這份文件仍然是你的。
            </Note>
          )}
          <div className="yz-actions">
            <Button variant="primary" busy={busy} onClick={save}>
              存我改過的版本
            </Button>
            <Button
              variant="quiet"
              onClick={() => navigator.clipboard?.writeText(draft)}
              title="這一段本來就是要貼進檔案的，那是它唯一的用途"
            >
              複製
            </Button>
          </div>

          {latest.edited && latest.edited !== latest.generated && (
            <p className="yz-hint">
              系統原本產生的是：「{latest.generated}」
            </p>
          )}
        </>
      )}

      {statements.length > 1 && (
        <p className="yz-hint">
          過去產生過 {statements.length} 份。每一份都留著——重新產生不會蓋掉舊的。
        </p>
      )}
    </section>
  );
}
