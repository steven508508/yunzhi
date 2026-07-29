/**
 * 手動放行成績與檢討。
 *
 * # 為什麼這顆按鈕非有不可
 *
 * `releasePolicy = MANUAL` 的意思是「等老師說可以」。判斷的那一欄是
 * `Assignment.releasedAt`，而在這顆按鈕出現之前，**整個介面沒有任何
 * 一個地方寫得到它**：後端的 `updateAssignment` 收 `{released: true}`、
 * API 也接，但沒有人呼叫。
 *
 * 結果是一條走進去出不來的路：老師在派卷時選了「老師手動放行」，
 * 學生交完卷之後永遠停在「老師還沒有開放這份考試的成績與檢討」，
 * 而老師這一頁看起來一切正常——分數都算好了、答對率也畫出來了。
 * 沒有錯誤訊息，沒有警告，要等到有學生來問才會發現。
 *
 * # 為什麼「收回」做得出來，而且刻意做得很難按
 *
 * 收回已經被看過的東西沒有意義：學生看過的分數不會忘記，截圖也
 * 已經傳出去了。但**誤按的補救必須有路**——這顆放行鈕就在「全班
 * 重新計分」旁邊，而放行是會被兩百個人立刻看到的動作。沒有退路的話，
 * 老師按錯之後唯一能做的事是打電話請大家不要看。
 *
 * 所以收回存在，但確認視窗要說實話：它擋的是**還沒看到的人**，
 * 不是已經看過的人。真正的用途只有兩種——按錯了，以及「非選題還沒
 * 改完就放行了，先收回來改完再放」。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/Dialog';
import { Note } from '@/components/Feedback';
import { useAction } from '@/components/Form';

export type ReleaseResult = { released: boolean } | { error: string };

export function ReleaseControl({
  action,
  released,
  note,
  affected,
}: {
  action: (release: boolean) => Promise<ReleaseResult>;
  /** 現在放行了沒。判定與學生端的 `maySeeResult` 是同一支純函式。 */
  released: boolean;
  /** 現在的狀態，一句話。老師要先知道現況才知道該不該按。 */
  note: string;
  /**
   * 會立刻受影響的人數：已經交過卷的學生（去重，不是作答份數）。
   * 確認視窗一定要說得出這個數字——「確定要放行嗎」沒有給老師
   * 任何判斷依據，而 37 有。
   */
  affected: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<'release' | 'revoke' | null>(null);
  const { busy, error, clearError, run } = useAction();

  const close = () => {
    if (busy) return;
    clearError();
    setOpen(null);
  };

  const confirm = (release: boolean) =>
    void run(async () => {
      const r = await action(release);
      // server action 的失敗是回傳值而不是例外（它要把訊息帶過網路）。
      // 在這裡轉回例外，錯誤的顯示才有單一路徑。
      if ('error' in r) throw new Error(r.error);
      setOpen(null);
      router.refresh();
    });

  return (
    <div className="yz-card" style={{ marginBottom: 18 }}>
      <h2 className="yz-card__title">成績與檢討的放行</h2>
      <p className="yz-panel__sub" style={{ marginTop: 2 }}>
        這份任務設定為<strong>老師手動放行</strong>。{note}
      </p>

      {/* 還沒放行時給一句警告色的提醒。這一頁其餘部分（分數、答對率）
          在放行前後長得一模一樣，所以「學生還看不到」這件事，
          不主動說出來就沒有人會發現。 */}
      {!released && affected > 0 && (
        <Note tone="warn">
          已經有 {affected} 位學生交卷，但他們現在看不到自己的分數，也看不到逐題檢討。
          在你按下放行之前，他們的畫面上只會顯示「老師還沒有開放」。
        </Note>
      )}
      {error && <Note tone="error">{error}</Note>}

      <div className="yz-actions" style={{ marginTop: 10 }}>
        <span className="yz-actions__spacer" />
        {released ? (
          <Button variant="quiet" onClick={() => setOpen('revoke')} disabled={busy}>
            收回放行
          </Button>
        ) : (
          <Button variant="primary" onClick={() => setOpen('release')} disabled={busy}>
            放行成績與檢討
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={open === 'release'}
        onClose={close}
        busy={busy}
        title="放行這份考試的成績與檢討"
        confirmLabel={affected > 0 ? `放行給這 ${affected} 位學生` : '放行'}
        onConfirm={() => confirm(true)}
        consequence={
          <>
            <p style={{ marginBottom: 12 }}>
              {affected > 0 ? (
                <>
                  這 <strong>{affected} 位學生</strong>會<strong>立刻</strong>
                  看得到自己的分數與逐題檢討，包含每一題的正確答案與解析。
                  他們不必重新登入，重新整理就看到了。
                </>
              ) : (
                <>
                  目前還沒有人交卷，所以按下去不會有人立刻看到東西。
                  但之後每一位交卷的學生，交完就看得到分數與逐題檢討。
                </>
              )}
            </p>
            <p style={{ marginBottom: 12 }}>
              {/* 這一句是這個對話框真正的重點。老師選 MANUAL 的理由，
                  十次有九次是「還有東西沒處理完」。 */}
              放行前請先確認<strong>非選題都改完了、該送分的題目也處理過了</strong>。
              放行後才改分數是可以的（用「全班重新計分」），但學生會看到分數變動。
            </p>
            <p className="yz-hint">
              補考或缺考的學生還沒交卷也沒關係——放行是針對整份任務的，
              他們之後交卷時一樣看得到。
            </p>
          </>
        }
      />

      <ConfirmDialog
        open={open === 'revoke'}
        onClose={close}
        busy={busy}
        title="收回這份考試的放行"
        confirmLabel="收回放行"
        onConfirm={() => confirm(false)}
        consequence={
          <>
            <p style={{ marginBottom: 12 }}>
              收回之後，學生的畫面會回到「老師還沒有開放這份考試的成績與檢討」。
            </p>
            <p style={{ marginBottom: 12 }}>
              <strong>但已經看過的人不會忘記。</strong>
              分數與答案在放行的這段時間裡已經看得到了，截圖也可能傳出去了。
              收回擋得住的只有還沒看到的人。
            </p>
            <p className="yz-hint">
              會用到這個功能的情況通常只有兩種：按錯了，或者非選題還沒改完就放行了，
              要收回來改完再放一次。
            </p>
          </>
        }
      />
    </div>
  );
}
