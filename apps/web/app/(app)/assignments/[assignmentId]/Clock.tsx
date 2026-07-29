/**
 * 考試當天的兩顆按鈕：延長作答時間、立刻結束這場考試。
 *
 * # 為什麼它們必須在同一個地方
 *
 * 因為監考老師走到這一頁的時候，他要處理的事只有一件——**現在還在
 * 寫的那幾個人怎麼辦**。往後推（全班斷網十分鐘）或者收掉（時間到了
 * 還有人在拖），兩個方向的按鈕分開放在兩頁上，他會在最忙的三分鐘裡
 * 找不到其中一顆。
 *
 * # 為什麼延長不問「確定嗎」，結束要問
 *
 * 延長是可以再按一次的：多按了五分鐘就結束一次，或者少延了再延。
 * 立刻結束不是——按下去的那一秒，所有正在寫的人下一次自動存檔就會
 * 被拒絕，而他們的畫面上不會有任何預告。所以那一顆走 `ConfirmDialog`，
 * 而且 `consequence` 要說出**現在有幾個人正在寫**。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/Dialog';
import { TextField } from '@/components/Field';
import { Note } from '@/components/Feedback';
import { submitJson, useAction } from '@/components/Form';

type ClockResult = {
  changed: number;
  reopened: number;
  skipped: number;
  expiresAt: string | null;
};

/** 台北時間的時刻。伺服器多半跑在 UTC，直接印會差八小時。 */
function when(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

/**
 * 整份任務的時鐘：全部延長 N 分鐘，或立刻結束。
 *
 * @param inProgress 現在還掛在進行中的份數。兩顆按鈕的文案都要用它。
 */
export function AssignmentClock({
  assignmentId,
  inProgress,
}: {
  assignmentId: string;
  inProgress: number;
}) {
  const router = useRouter();
  const [minutes, setMinutes] = useState('10');
  const [ending, setEnding] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, clearError, run } = useAction();

  async function post(json: unknown) {
    return submitJson<{ result: ClockResult }>(`/api/assignments/${assignmentId}/clock`, { json });
  }

  return (
    <div className="yz-clock">
      <div className="yz-clock__row">
        <TextField
          label="延長作答時間（分鐘）"
          type="number"
          min={1}
          max={600}
          value={minutes}
          onChange={(e) => setMinutes(e.currentTarget.value)}
          hint="每個人各自往後推這麼多分鐘，先開始與後開始的人拿到的總時間一樣。"
        />
        <Button
          variant="primary"
          busy={busy}
          busyLabel="處理中"
          disabled={inProgress === 0}
          onClick={() =>
            void run(async () => {
              clearError();
              const r = await post({ action: 'extend', minutes: Number(minutes) || 0 });
              setDone(
                `${r.result.changed} 份作答各延長了 ${minutes} 分鐘` +
                  (r.result.reopened > 0
                    ? `，其中 ${r.result.reopened} 份本來已經寫不進去，現在又可以寫了。`
                    : '。') +
                  (r.result.skipped > 0
                    ? `　另外 ${r.result.skipped} 份沒有動到（已交卷、或本來就沒有時間限制）。`
                    : ''),
              );
              router.refresh();
            })
          }
        >
          全部延長
        </Button>
        <Button
          variant="quiet"
          disabled={busy || inProgress === 0}
          onClick={() => {
            clearError();
            setEnding(true);
          }}
        >
          立刻結束這場考試
        </Button>
      </div>

      <p className="yz-group__note">
        延長只動<strong>還在進行中</strong>的作答，已經交卷的分數不會改變。
        學生的倒數每 30 秒跟伺服器對一次時，所以按下去之後最多半分鐘他們就看得到。
        <strong>已經因為時間到而自動交卷的人不會被拉回來</strong>——那幾份要用「作廢」再讓他重考。
      </p>

      {error && <Note tone="error">{error}</Note>}
      {done && <Note tone="info">{done}</Note>}

      <ConfirmDialog
        open={ending}
        busy={busy}
        onClose={() => {
          if (busy) return;
          clearError();
          setEnding(false);
        }}
        title="立刻結束這場考試"
        confirmLabel={`結束這 ${inProgress} 份`}
        onConfirm={() =>
          void run(async () => {
            const r = await post({ action: 'end' });
            setDone(
              `已經結束 ${r.result.changed} 份作答（${when(r.result.expiresAt)}）。` +
                '他們的答案都還在，接下來在下面按「代為結算」就會計分。',
            );
            setEnding(false);
            router.refresh();
          }).then((ok) => {
            // 失敗時關掉對話框，錯誤才看得見——原生 <dialog> 是頂層堆疊。
            if (!ok) setEnding(false);
          })
        }
        consequence={
          <>
            <p style={{ marginBottom: 12 }}>
              現在有 <strong>{inProgress} 位學生正在作答</strong>。按下去之後伺服器立刻
              不再收他們的答案——<strong>他們的畫面上不會有任何預告</strong>，
              要到下一次自動存檔（最多 8 秒）才會跳出「作答時間已經結束」。
            </p>
            <p style={{ marginBottom: 12 }}>
              已經寫下的答案<strong>不會不見</strong>。結束之後那幾份會出現「代為結算」，
              按下去就照一般流程計分，沒寫到的題目算 0 分。
            </p>
            <p className="yz-hint">
              把任務的截止時間改成現在<strong>停不掉正在寫的人</strong>——那只擋得住
              還沒開始的人。要停現在這一場，就是這一顆。這個動作會記在稽核裡。
            </p>
          </>
        }
      />
    </div>
  );
}

/**
 * 只延長某一位。遲到的、有特殊需求的、或者剛剛換了一台機器的那一個。
 *
 * 不做確認視窗：多給一位學生五分鐘是可以再按一次改回來的動作
 * （按負數不行，但按「立刻結束」可以把他收掉），而它出現的時機
 * 是老師站在那位學生旁邊。
 */
export function ExtendOne({
  assignmentId,
  attemptId,
  who,
  minutes = 10,
}: {
  assignmentId: string;
  attemptId: string;
  who: string;
  /** 一次加幾分鐘。與上面那一格分開，因為這一顆是站著按的。 */
  minutes?: number;
}) {
  const router = useRouter();
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  return (
    <>
      <Button
        variant="quiet"
        busy={busy}
        busyLabel="處理中"
        onClick={() =>
          void run(async () => {
            const r = await submitJson<{ result: ClockResult }>(
              `/api/assignments/${assignmentId}/clock`,
              { json: { action: 'extend', minutes, attemptId, reason: `個別延長：${who}` } },
            );
            setDone(
              r.result.expiresAt
                ? `延長到 ${when(r.result.expiresAt)}`
                : `已延長 ${minutes} 分鐘`,
            );
            router.refresh();
          })
        }
      >
        +{minutes} 分
      </Button>
      {done && <span className="yz-grade__sub">{done}</span>}
      {error && <span className="yz-warn yz-grade__sub">{error}</span>}
    </>
  );
}
