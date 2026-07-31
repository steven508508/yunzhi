/**
 * 發布與下架。
 *
 * # 為什麼這一顆按鈕值得單獨存在
 *
 * `QuestionStatus` 有四個值，而在這個元件之前 `PUBLISHED` 與 `RETIRED`
 * **永遠到不了**——入庫一律 `PENDING_REVIEW`，沒有任何一行程式改得動它。
 * 組卷那邊因此有一句「這一題已經下架」的錯誤訊息從來不會出現。
 *
 * 兩個狀態對老師的意思很具體：
 *
 *   發布　　這一題我看過了，可以拿去考學生
 *   下架　　以後不要再用（答案有爭議、超綱、課綱改版）
 *
 * 下架**不會**把題目從已經考過的卷子上拿掉，也不動任何一份成績。
 * 這一句要寫在確認視窗裡：老師按下「下架」時想的往往是
 * 「把這題從考試裡拿掉」，而那是另一件事（去卷子上移除）。
 *
 * # 為什麼兩側的前置條件要長得一樣
 *
 * 下架被擋時老師看得到完整原因（被哪幾份卷子用著、怎麼辦），而發布
 * 在這之前**一個條件都沒有**：一題沒有標準答案的單選題按一下就發布，
 * 被組進卷子，全班考完掛在「需人工確認」。伺服器端現在會擋
 * （`lib/questionEdit.mjs` 的 `checkPublish`），但只有伺服器擋是不夠的
 * ——那會變成「按下去才知道」。這裡把同一份判斷先畫出來。
 *
 * 擋（blocking）與提醒（warnings）在畫面上要看得出不同：
 * 前者讓按鈕按不下去，後者只是把話說完。分法的理由寫在 `checkPublish`。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/Dialog';
import { TextField } from '@/components/Field';
import { Note } from '@/components/Feedback';
import { submitJson, useAction } from '@/components/Form';

const STATUS_NOTE: Record<string, string> = {
  DRAFT: '這一題還沒有人校對過，組卷時挑不到它。',
  PENDING_REVIEW: '校對過了，組卷挑得到，但還沒有人明確說「可以拿去考學生」。',
  PUBLISHED: '已發布：這一題可以用了。',
  RETIRED: '已下架：組卷時挑不到它。已經考過的卷子與成績不受影響。',
};

export default function StatusControl({
  questionId,
  status,
  usedBy,
  publishBlocking = [],
  publishWarnings = [],
}: {
  questionId: string;
  status: string;
  /** 還在用的卷子與任務。下架的確認視窗要說得出被誰用著。 */
  usedBy: { title: string; why: string }[];
  /** 現在發布會被伺服器擋下來的理由。有值就不給按。 */
  publishBlocking?: { code: string; detail: string }[];
  /** 發布得了，但有幾件事會少一塊。不擋，但要說。 */
  publishWarnings?: { code: string; detail: string }[];
}) {
  const router = useRouter();
  const { busy, error, clearError, run } = useAction();
  const [retiring, setRetiring] = useState(false);
  const [reason, setReason] = useState('');

  function change(next: string, why?: string) {
    return run(async () => {
      await submitJson(`/api/questions/${questionId}/status`, {
        json: { status: next, reason: why },
      });
      setRetiring(false);
      router.refresh();
    });
  }

  return (
    <div className="yz-qstatus">
      {error && <Note tone="error">{error}</Note>}
      <p className="yz-qstatus__now">{STATUS_NOTE[status] ?? status}</p>

      {/* 發布的前置條件。**畫在按鈕上面**，不是按下去才說：
          老師看到一顆按了必定失敗的按鈕，會以為系統壞了，而他要的
          資訊（缺什麼、去哪裡補）就在這幾行。 */}
      {status !== 'PUBLISHED' && publishBlocking.length > 0 && (
        <Note tone="error">
          <strong>這一題現在不能發布</strong>——發布之後它就會被組進卷子拿去考學生：
          <ul style={{ margin: '6px 0 0 18px' }}>
            {publishBlocking.map((b) => (
              <li key={b.code}>{b.detail}</li>
            ))}
          </ul>
        </Note>
      )}
      {status !== 'PUBLISHED' && publishBlocking.length === 0 && publishWarnings.length > 0 && (
        <Note tone="warn">
          發布得了，但這幾件事會少一塊：
          <ul style={{ margin: '6px 0 0 18px' }}>
            {publishWarnings.map((w) => (
              <li key={w.code}>{w.detail}</li>
            ))}
          </ul>
        </Note>
      )}

      <div className="yz-actions">
        {status !== 'PUBLISHED' && (
          <Button
            variant="primary"
            busy={busy}
            // 現在發布一定會被伺服器擋下來時，連按都不給按——與下架的
            // `confirmDisabled` 同一條規則。
            disabled={publishBlocking.length > 0}
            onClick={() => void change('PUBLISHED')}
          >
            {status === 'RETIRED' ? '重新啟用' : '發布'}
          </Button>
        )}
        {status === 'PUBLISHED' && (
          <Button busy={busy} onClick={() => void change('PENDING_REVIEW')}>
            退回待確認
          </Button>
        )}
        {status !== 'RETIRED' && (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              clearError();
              setRetiring(true);
            }}
          >
            下架
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={retiring}
        busy={busy}
        onClose={() => {
          if (busy) return;
          clearError();
          setRetiring(false);
        }}
        title="下架這一題"
        confirmLabel="下架"
        // 現在下架一定會被伺服器擋下來時，連按都不給按。畫出一顆
        // 按下去必定失敗的按鈕，老師會以為系統壞了——他要的資訊
        // （被誰用著、怎麼辦）就在下面那幾行。
        confirmDisabled={usedBy.length > 0}
        consequence={
          <>
            <p style={{ marginBottom: 10 }}>
              下架之後<strong>組卷時挑不到這一題</strong>。已經考過的卷子、
              學生的作答與成績<strong>全部不受影響</strong>——那些是歷史。
            </p>
            {usedBy.length > 0 ? (
              <>
                <p style={{ marginBottom: 6 }}>
                  但它現在還被這幾份用著，所以<strong>下架會被擋下來</strong>：
                </p>
                <ul style={{ margin: '0 0 10px 18px' }}>
                  {usedBy.map((u) => (
                    <li key={u.title}>
                      {u.title}　<span className="yz-muted">{u.why}</span>
                    </li>
                  ))}
                </ul>
                <p style={{ marginBottom: 10 }}>
                  要現在下架，請先把它從那幾份卷子上移除。
                </p>
              </>
            ) : (
              <p style={{ marginBottom: 10 }}>
                目前沒有還沒結束的卷子用到它。
              </p>
            )}
            <TextField
              label="為什麼下架"
              value={reason}
              onChange={(e) => setReason(e.currentTarget.value)}
              hint="例如「課綱改版，這題已超出範圍」。會寫進稽核，日後有人問起時只剩這一句。"
            />
            {error && <p className="yz-field__err">{error}</p>}
          </>
        }
        onConfirm={() => void change('RETIRED', reason.trim() || undefined)}
      />
    </div>
  );
}
