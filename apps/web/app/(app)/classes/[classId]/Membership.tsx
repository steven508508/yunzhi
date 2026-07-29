/**
 * 移出班級與復原。
 *
 * # 這兩顆按鈕在補什麼
 *
 * `ClassMembership.leftAt` 從第一天就有，而且到處都在被讀——
 * 誰收得到任務、應交幾人、學生看得到哪幾份任務，全部照它過濾。
 * **但沒有任何一個介面寫過它。** 於是轉班或退補的學生仍然收得到
 * 考卷、仍然算進應交人數，而老師只能看著一個已經不在的人永遠不交。
 *
 * # 為什麼移出要確認、復原不用
 *
 * 移出是破壞性的：他從此收不到這個班的新任務，而老師不見得會立刻
 * 發現按錯了——名冊上少一個人不像少了一份成績那麼顯眼。
 *
 * 復原不是。它把一個人放回名冊，按錯的代價是再按一次移出，而且
 * 復原鈕只出現在「已經移出」那一段裡，本來就是刻意去找才看得到的。
 * 每個動作都問「確定嗎」的介面，結果是每個「確定嗎」都被無視。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/Dialog';
import { submitJson, useAction } from '@/components/Form';

/** 移出。破壞性，要確認，而且後果要說得具體。 */
export function LeaveClass({
  classId,
  className,
  studentId,
  studentName,
}: {
  classId: string;
  className: string;
  studentId: string;
  studentName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { busy, error, clearError, run } = useAction();

  return (
    <>
      <Button variant="quiet" onClick={() => setOpen(true)} disabled={busy}>
        移出班級
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
        title={`把「${studentName}」移出${className}`}
        confirmLabel="移出名冊"
        consequence={
          <>
            <p style={{ marginBottom: 12 }}>
              他<strong>不會再收到這個班的新任務</strong>，也不會再算進應交人數與催繳名單。
              <strong>已經交過的成績會保留</strong>——過去的作答、分數與能力分析都還在，
              全班統計照樣算他那幾份，你在成績頁上仍然看得到他。
            </p>
            <p style={{ marginBottom: 12 }}>
              他自己那邊會少掉這個班的任務清單：已經考完的那幾份不會在他的清單上
              再出現。他的帳號本身不受影響，如果他同時在別的班，那邊照常。
            </p>
            <p style={{ marginBottom: 12 }}>
              有作答進行中的話這個動作會被擋下來——考試中把人移出班級，
              他重新整理之後就回不去那份考卷了。
            </p>
            <p className="yz-hint">
              按錯了可以復原（名冊下方「已移出的學生」那一段），
              而且復原之後他當初的入班日期不會被改掉。
            </p>
            {error && <p className="yz-field__err">{error}</p>}
          </>
        }
        onConfirm={() =>
          void run(async () => {
            await submitJson(`/api/classes/${classId}/members/${studentId}`, {
              json: { left: true },
            });
            setOpen(false);
            router.refresh();
          })
        }
      />
    </>
  );
}

/** 復原。不問「確定嗎」，理由見檔頭。 */
export function RejoinClass({
  classId,
  studentId,
}: {
  classId: string;
  studentId: string;
}) {
  const router = useRouter();
  const { busy, error, run } = useAction();

  return (
    <>
      <Button
        variant="quiet"
        busy={busy}
        busyLabel="復原中"
        onClick={() =>
          void run(async () => {
            await submitJson(`/api/classes/${classId}/members/${studentId}`, {
              json: { left: false },
            });
            router.refresh();
          })
        }
      >
        放回名冊
      </Button>
      {error && <span className="yz-warn yz-grade__sub">{error}</span>}
    </>
  );
}
