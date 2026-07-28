/**
 * 對話框。
 *
 * 用原生的 `<dialog>` 而不是自己疊一層 div，理由全部是實際的：
 * 焦點鎖定、Esc 關閉、頂層堆疊（不會被 overflow: hidden 切掉）、
 * 背景不可捲動——這四件事瀏覽器都做好了，自己刻的版本通常會漏掉
 * 其中兩三件，而漏掉焦點鎖定的對話框對只能用鍵盤的人等於不存在。
 *
 * 額外處理的是「確認之後才會發生的破壞性動作」，因為這個系統裡
 * 那類動作不少：刪掉一個班、把一份題本作廢、把學生移出班級。
 */
'use client';

import { useCallback, useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';

import { Button } from '@/components/Button';

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  // Esc 走瀏覽器原生的 cancel 事件，不必自己監聽 keydown。
  const onCancel = useCallback(
    (e: React.SyntheticEvent<HTMLDialogElement>) => {
      e.preventDefault();
      onClose();
    },
    [onClose],
  );

  return (
    <dialog
      ref={ref}
      className="yz-dialog"
      aria-labelledby={titleId}
      onCancel={onCancel}
      onClose={onClose}
      // 點背景關閉。判斷方式是「點在 dialog 元素本身」——
      // 內容區是子元素，所以點內容不會誤觸。
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="yz-dialog__body">
        <h2 className="yz-dialog__title" id={titleId}>
          {title}
        </h2>
        <div className="yz-dialog__content">{children}</div>
        {footer && <div className="yz-dialog__foot">{footer}</div>}
      </div>
    </dialog>
  );
}

/**
 * 破壞性動作的確認。
 *
 * 兩個刻意的設計：
 *
 * **確認鈕不是預設焦點。** 原生 dialog 會把焦點放在第一個可聚焦
 * 元素上，所以取消鈕排在前面。連按兩次 Enter 不該刪掉一個班。
 *
 * **要說出後果，不只是問「確定嗎」。** 「確定要刪除嗎」沒有給出
 * 任何判斷依據；「這個班有 32 位學生，刪除後他們的作答記錄會保留
 * 但不再屬於任何班級」才有。所以 `consequence` 是必填。
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  consequence,
  confirmLabel = '確認',
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  consequence: ReactNode;
  confirmLabel?: string;
  busy?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="danger" onClick={onConfirm} busy={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {consequence}
    </Dialog>
  );
}
