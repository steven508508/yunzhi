/**
 * 表單欄位：標籤、控制項、說明、錯誤，四件事綁在一起。
 *
 * # 為什麼不讓每個畫面自己組
 *
 * 因為每個畫面自己組的時候，被省掉的一定是同樣那幾樣：
 *
 *   · `<label htmlFor>` 與 `id` 沒接起來 —— 讀螢幕的人聽不到這格
 *     是要填什麼；點標籤也不會 focus 到輸入框
 *   · 錯誤訊息只是紅字，沒有 `aria-describedby` —— 讀螢幕的人
 *     只知道「無效」，不知道為什麼
 *   · 沒有 `aria-invalid` —— 輔助科技無從得知這一格有問題
 *
 * 這三件事在 WCAG 2.1 AA 是必要條件（規格書文件 01 §16），
 * 而且每一個都是「不做也看不出來」的那種——直到有學生真的需要它。
 *
 * 綁成一個元件之後，接下來的三十個畫面自動就是對的。
 */
'use client';

import { useId } from 'react';
import type { ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import type { InputHTMLAttributes } from 'react';

type Common = {
  label: ReactNode;
  /** 欄位下方的說明。填寫規則寫在這裡，不要寫在 placeholder。 */
  hint?: ReactNode;
  /** 錯誤訊息。有值時整格進入錯誤狀態。 */
  error?: string | null;
  required?: boolean;
};

function Shell({
  label,
  hint,
  error,
  required,
  id,
  children,
}: Common & { id: string; children: (ids: { describedBy?: string }) => ReactNode }) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={`yz-field${error ? ' yz-field--error' : ''}`}>
      <label className="yz-label" htmlFor={id}>
        {label}
        {required && (
          <>
            <span aria-hidden="true" className="yz-label__req">
              ＊
            </span>
            <span className="yz-sr">（必填）</span>
          </>
        )}
      </label>
      {children({ describedBy })}
      {hint && (
        <p className="yz-field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        // role="alert" 讓錯誤在出現的當下被讀出來，而不是等使用者
        // 自己 tab 回去才發現。
        <p className="yz-field__err" id={errId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export type TextFieldProps = Common &
  Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>;

export function TextField({ label, hint, error, required, ...rest }: TextFieldProps) {
  const id = useId();
  return (
    <Shell label={label} hint={hint} error={error} required={required} id={id}>
      {({ describedBy }) => (
        <input
          {...rest}
          id={id}
          className="yz-in"
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
        />
      )}
    </Shell>
  );
}

export type SelectFieldProps = Common &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> & { children: ReactNode };

export function SelectField({
  label,
  hint,
  error,
  required,
  children,
  ...rest
}: SelectFieldProps) {
  const id = useId();
  return (
    <Shell label={label} hint={hint} error={error} required={required} id={id}>
      {({ describedBy }) => (
        <select
          {...rest}
          id={id}
          className="yz-in"
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
        >
          {children}
        </select>
      )}
    </Shell>
  );
}

export type TextAreaFieldProps = Common &
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'>;

export function TextAreaField({
  label,
  hint,
  error,
  required,
  rows = 4,
  ...rest
}: TextAreaFieldProps) {
  const id = useId();
  return (
    <Shell label={label} hint={hint} error={error} required={required} id={id}>
      {({ describedBy }) => (
        <textarea
          {...rest}
          id={id}
          rows={rows}
          className="yz-in"
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
        />
      )}
    </Shell>
  );
}

/**
 * 勾選框。
 *
 * 刻意讓整段文字都可以點——權利聲明那類的勾選項文字很長，
 * 只有 13px 的方框可以點是很差的體驗，在平板上尤其。
 */
export function CheckField({
  label,
  hint,
  error,
  ...rest
}: Common & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type'>) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  return (
    <div className={`yz-check${error ? ' yz-field--error' : ''}`}>
      <input
        {...rest}
        id={id}
        type="checkbox"
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errId].filter(Boolean).join(' ') || undefined}
      />
      <label htmlFor={id}>
        {label}
        {hint && (
          <span className="yz-field__hint" id={hintId}>
            {hint}
          </span>
        )}
        {error && (
          <span className="yz-field__err" id={errId} role="alert">
            {error}
          </span>
        )}
      </label>
    </div>
  );
}
