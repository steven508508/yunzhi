/**
 * 作廢一份作答，以及撤銷作廢。
 *
 * # 這兩顆按鈕在補什麼
 *
 * `AttemptStatus.VOIDED` 全 repo 零個寫入者：計分那一側判它、學生端
 * 的說法也寫好了，就是**沒有任何一條路徑能把一份作答標成 VOIDED**。
 * 抓到作弊、或斷電毀掉一份卷子的時候，老師手上只有兩個選擇——
 * 留著那個分數，或者刪掉整份任務（連同其他三十個人的作答）。
 *
 * # 為什麼理由是必填
 *
 * 因為作廢一個學生的成績會被家長質疑，而三個月後唯一還在的東西就是
 * 稽核裡的那一句。空白的理由等於沒有稽核：記錄上寫著「王老師在 9 月
 * 3 日作廢了這一份」，然後沒有人說得出為什麼。
 *
 * 前端擋的是誤觸，真正的規則在 `lib/attemptVoid.mjs`（純函式、有測試）
 * 而且伺服器端會再判一次——這裡只是讓老師在按下去之前就知道要填。
 *
 * # 為什麼撤銷也要填理由
 *
 * 「為什麼別人的作廢了、我小孩的又救回來」是同一位家長的下一個問題。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/Dialog';
import { TextAreaField } from '@/components/Field';
import { Note } from '@/components/Feedback';
import { submitJson, useAction } from '@/components/Form';
import { MIN_REASON } from '@/lib/attemptVoid.mjs';

/**
 * 作廢。
 *
 * `wasSubmitted` 只影響**說明文字**，不影響動作：一份還沒交卷就被
 * 作廢的作答，學生當下就寫不進去了（`saveAnswer` 會回「這份作答已經
 * 被作廢」），而那是老師按之前必須知道的事——考試進行中按下去等於
 * 當場終止他的考試。
 */
export function VoidOne({
  attemptId,
  who,
  wasSubmitted,
}: {
  attemptId: string;
  who: string;
  wasSubmitted: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const { busy, error, clearError, run } = useAction();

  const enough = reason.trim().length >= MIN_REASON;

  return (
    <>
      <Button variant="quiet" onClick={() => setOpen(true)} disabled={busy}>
        作廢這一份
      </Button>
      {error && <span className="yz-warn yz-grade__sub">{error}</span>}

      <ConfirmDialog
        open={open}
        onClose={() => {
          if (busy) return;
          clearError();
          setOpen(false);
        }}
        busy={busy}
        title={`作廢「${who}」的這一份作答`}
        confirmLabel={enough ? '作廢這一份' : '請先寫下原因'}
        confirmDisabled={!enough}
        consequence={
          <>
            <p style={{ marginBottom: 12 }}>
              這一份<strong>不計分、不進班級統計</strong>：平均、答對率、級分換算
              都不會再算他。學生那邊看到的不是分數，而是
              「這一份作答已經作廢，要知道原因或申請重考，請直接找老師」。
            </p>
            <p style={{ marginBottom: 12 }}>
              作廢<strong>不會佔掉他的作答次數</strong>——如果這份任務容許多次作答，
              他還可以重考一次。這正是斷電或當機時應該用的處置，
              比給他一個只寫了四題的分數合理。
            </p>
            {!wasSubmitted && (
              <Note tone="warn">
                他<strong>還沒有交卷</strong>。作廢會立刻讓他寫不進去——
                如果他此刻正坐在教室裡作答，這個動作就是當場終止他的考試。
              </Note>
            )}
            <p style={{ marginBottom: 12 }}>
              他原本的答案與分數<strong>不會被刪掉</strong>，只是不算數。
              誤判或申訴成立時可以撤銷，撤銷之後分數會原封不動回來。
            </p>
            {error && <p className="yz-field__err">{error}</p>}
            <TextAreaField
              label="作廢的原因"
              required
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.currentTarget.value)}
              hint="例如「監考記錄第 3 條：作答中使用手機」或「教室跳電，這一份只剩前 4 題」。這一句會連同你的姓名寫進稽核，家長問起時它是唯一說得出來的東西。"
            />
          </>
        }
        onConfirm={() => {
          if (!enough) return;
          void run(async () => {
            await submitJson(`/api/attempts/${attemptId}/void`, {
              json: { voided: true, reason: reason.trim() },
            });
            setOpen(false);
            setReason('');
            router.refresh();
          });
        }}
      />
    </>
  );
}

/**
 * 撤銷作廢。
 *
 * `wasSubmitted` 在這裡影響的是**還原目標**，而老師要在按下之前知道
 * 會變成什麼：交過卷的回到「待評分」（按一次重新計分就有分數），
 * 沒交過的回到「進行中」而時鐘早就在走。判定本身在
 * `lib/attemptVoid.mjs` 的 `restoreStatus`，這裡只是把它說成人話。
 */
export function UnvoidOne({
  attemptId,
  who,
  wasSubmitted,
}: {
  attemptId: string;
  who: string;
  wasSubmitted: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const { busy, error, clearError, run } = useAction();

  const enough = reason.trim().length >= MIN_REASON;

  return (
    <>
      <Button variant="quiet" onClick={() => setOpen(true)} disabled={busy}>
        撤銷作廢
      </Button>
      {error && <span className="yz-warn yz-grade__sub">{error}</span>}

      <ConfirmDialog
        open={open}
        onClose={() => {
          if (busy) return;
          clearError();
          setOpen(false);
        }}
        busy={busy}
        title={`撤銷「${who}」這一份的作廢`}
        confirmLabel={enough ? '撤銷作廢' : '請先寫下原因'}
        confirmDisabled={!enough}
        consequence={
          <>
            {wasSubmitted ? (
              <p style={{ marginBottom: 12 }}>
                這一份會回到<strong>待評分</strong>，並且重新算進班級統計。
                他原本的分數還在，但狀態欄會顯示「待評分」——那是在提醒你
                <strong>按一次「重新計分」確認一下</strong>。
                系統不會替你猜他當初改完了沒有：猜錯的那一種，
                是一份含作文的卷子被標成已評分，而那 25 分永遠不會被補上。
              </p>
            ) : (
              <p style={{ marginBottom: 12 }}>
                這一份<strong>沒有交過卷</strong>，所以會回到<strong>進行中</strong>。
                作答的時鐘在作廢期間照樣在走——他可能還進得去，
                也可能一進去就是「時間已到」。如果要讓他重考，
                比較乾淨的做法是留著作廢（作廢不佔次數）並請他重新開始。
              </p>
            )}
            {error && <p className="yz-field__err">{error}</p>}
            <TextAreaField
              label="撤銷的原因"
              required
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.currentTarget.value)}
              hint="例如「調閱監視器後確認是隔壁同學的手機，申訴成立」。與作廢一樣會寫進稽核。"
            />
          </>
        }
        onConfirm={() => {
          if (!enough) return;
          void run(async () => {
            await submitJson(`/api/attempts/${attemptId}/void`, {
              json: { voided: false, reason: reason.trim() },
            });
            setOpen(false);
            setReason('');
            router.refresh();
          });
        }}
      />
    </>
  );
}
