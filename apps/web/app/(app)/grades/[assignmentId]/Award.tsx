/**
 * 各題答對率那張表上的「送分」。
 *
 * # 為什麼這一顆在成績頁上，不在題庫裡
 *
 * 因為老師是在看答對率的時候決定送分的：「第 12 題只有 3% 的人對，
 * 我去看了一下，選項 (3) 印錯了」。要他為此走一趟題庫、找到那一題、
 * 再回來按重新計分，中間有三個地方會走丟。所以這一顆就在那一列上，
 * 按下去做完全部三件事：立旗標、寫稽核、把全班重算。
 *
 * # 為什麼它與「改標準答案」是兩顆不同的按鈕
 *
 * 因為它們是兩個不同的決定。改答案是「原本的答案是錯的，正確答案是
 * (3)」——改完之後答對的人得分、答錯的人不得分。送分是「這一題不算」
 * ——每個人都得分，包括空白卷。把送分做成「把所有選項都設成正解」
 * 的話，題庫裡那一題就永遠壞掉了，而且看不出來曾經發生過什麼。
 *
 * # 送分之後那個「已送分」標記非得留著不可
 *
 * 那一題的答對率會停在 3%，而平均得分率會是 100%。沒有標記的話，
 * 下一個看這一頁的人只會覺得統計壞了。
 */
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/Dialog';
import { TextField } from '@/components/Field';
import { submitJson, useAction } from '@/components/Form';

export type AwardOneResult = {
  awarded: boolean;
  regraded: { attempts: number; changedAttempts: number; failures: number };
  alsoAffects: { assignmentId: string; title: string; graded: number }[];
};

export function AwardOne({
  assignmentId,
  questionId,
  order,
  score,
  awarded,
  affected,
}: {
  assignmentId: string;
  questionId: string;
  /** 題號。確認視窗與稽核都要說得出「第幾題」。 */
  order: number;
  /** 這一題在這份卷子上值幾分。送分之後每個人拿到的就是它。 */
  score: number;
  awarded: boolean;
  /** 會被重算的份數。 */
  affected: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const { busy, error, clearError, run } = useAction();
  const [done, setDone] = useState<AwardOneResult | null>(null);

  function go(award: boolean) {
    return run(async () => {
      const r = await submitJson<AwardOneResult>(`/api/questions/${questionId}/award`, {
        json: { assignmentId, award, reason: reason.trim() },
      });
      setDone(r);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      {awarded ? (
        <span className="yz-rowacts">
          <span className="yz-award">已送分</span>
          <Button
            variant="quiet"
            busy={busy}
            busyLabel="處理中"
            // 取消送分不問「確定嗎」：它把這一題恢復成照標準答案計分，
            // 而那是可以再按一次送分回來的。真正需要確認的是反方向。
            onClick={() => void go(false)}
          >
            取消送分
          </Button>
        </span>
      ) : (
        <Button
          variant="quiet"
          onClick={() => {
            clearError();
            setOpen(true);
          }}
        >
          送分
        </Button>
      )}

      {error && <span className="yz-warn yz-grade__sub">{error}</span>}

      {done && (
        <span className="yz-grade__sub">
          {done.awarded ? '已送分，' : '已取消送分，'}
          重算了 {done.regraded.attempts} 份、{done.regraded.changedAttempts} 份分數有變動。
          {done.regraded.failures > 0 && `　${done.regraded.failures} 份算不出來。`}
          {done.alsoAffects.length > 0 && (
            <>
              　這一題還用在
              {done.alsoAffects.map((a) => (
                <span key={a.assignmentId}>
                  　<Link href={`/grades/${a.assignmentId}`}>{a.title}</Link>
                </span>
              ))}
              　上，那幾份要各自按「全班重新計分」。
            </>
          )}
        </span>
      )}

      <ConfirmDialog
        open={open}
        busy={busy}
        onClose={() => {
          if (busy) return;
          clearError();
          setOpen(false);
        }}
        title={`第 ${order} 題全班送分`}
        confirmLabel={`送分並重算這 ${affected} 份`}
        confirmDisabled={reason.trim().length < 4}
        consequence={
          <>
            <p style={{ marginBottom: 10 }}>
              這 <strong>{affected} 份作答</strong>在第 {order} 題上一律得
              <strong> {score} 分</strong>，包含<strong>沒有作答的人</strong>。
              按下去之後全班的分數立刻更新，不必再按一次重新計分。
            </p>
            <p style={{ marginBottom: 10 }}>
              答對率<strong>不會</strong>變成 100%——它記的是「本來有多少人會」，
              而那是你下一堂課要不要重講的依據。這一列會標成「已送分」，
              平均得分率才會是 100%。
            </p>
            <p style={{ marginBottom: 10 }}>
              送分是記在<strong>這一題</strong>上的（不是記在這一份任務上），所以
              <strong>其他用到這一題的卷子也會跟著送分</strong>。要恢復，
              按同一列的「取消送分」。
            </p>
            {error && <p className="yz-field__err">{error}</p>}
            <TextField
              label="為什麼送分"
              value={reason}
              onChange={(e) => setReason(e.currentTarget.value)}
              hint="例如「選項 (3) 印錯，四個選項都不成立」。家長問起時，這一句是唯一說得出來的東西。"
            />
          </>
        }
        onConfirm={() => void go(true)}
      />
    </>
  );
}
