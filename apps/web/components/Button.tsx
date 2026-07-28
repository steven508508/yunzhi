/**
 * 按鈕。
 *
 * 樣式早就在 globals.css 裡了（`.yz-btn`），這一層加的是**行為**：
 * 送出中的狀態、以及送出中不可重複點擊。
 *
 * 為什麼值得做成元件：目前每一個表單各自用 useState 管 `busy`，
 * 各自決定停用時要不要換文字、換什麼文字。三個畫面時還好，
 * 藍圖裡剩下的批次還有大約三十個畫面，那時候「送出中」會有
 * 三十種寫法，而其中幾種一定忘了停用按鈕——**重複送出在
 * 「派任務」與「交卷」上是真的會出事的**。
 */
'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'default' | 'primary' | 'quiet' | 'danger';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  /** 送出中。會停用按鈕並換上等待文案。 */
  busy?: boolean;
  /** 送出中顯示的字。預設沿用原本的文字加上刪節號。 */
  busyLabel?: string;
  children: ReactNode;
};

export function Button({
  variant = 'default',
  busy = false,
  busyLabel,
  disabled,
  className = '',
  children,
  ...rest
}: ButtonProps) {
  const cls = [
    'yz-btn',
    variant === 'primary' && 'yz-btn--primary',
    variant === 'quiet' && 'yz-btn--quiet',
    variant === 'danger' && 'yz-btn--danger',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      {...rest}
      className={cls}
      disabled={disabled || busy}
      // 讀螢幕的人也要知道現在正在等。只把按鈕變灰是看得見的人才收得到的訊息。
      aria-busy={busy || undefined}
    >
      {busy ? (busyLabel ?? <>{children}…</>) : children}
    </button>
  );
}
