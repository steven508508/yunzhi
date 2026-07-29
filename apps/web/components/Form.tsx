/**
 * 表單外殼：送出、等待、錯誤、防重複送出。
 *
 * # 這是元件庫裡最值得存在的一個
 *
 * 每一個既有的表單都自己寫了同一段：
 *
 * ```ts
 * const [busy, setBusy] = useState(false);
 * const [err, setErr] = useState<string|null>(null);
 * async function submit(e) {
 *   e.preventDefault();
 *   setBusy(true); setErr(null);
 *   try { ... } catch (e) { setErr(String(e)) } finally { setBusy(false) }
 * }
 * ```
 *
 * 十行樣板，而**其中兩件事漏掉不會有任何症狀，直到出事**：
 *
 *   · 送出中沒有停用按鈕 → 連點兩下就派了兩次任務、交了兩次卷
 *   · 錯誤只 console.error → 使用者看到的是「按了沒反應」，
 *     然後再按一次
 *
 * 藍圖裡剩下的批次還有大約三十個表單。與其寫三十次，
 * 不如讓正確的行為是預設的。
 */
'use client';

import { useCallback, useRef, useState } from 'react';
import type { FormHTMLAttributes, ReactNode } from 'react';

import { Note } from '@/components/Feedback';

export type FormProps = Omit<FormHTMLAttributes<HTMLFormElement>, 'onSubmit' | 'children'> & {
  /**
   * 送出時做什麼。丟出的錯誤會被接住並顯示在表單頂端。
   * 回傳值忽略——要導頁就在裡面自己導。
   */
  onSubmit: () => Promise<void>;
  /** 表單頂端的錯誤。由 onSubmit 丟出的錯誤自動填入。 */
  children: (state: { busy: boolean }) => ReactNode;
};

export function Form({ onSubmit, children, ...rest }: FormProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 用 ref 而不是只靠 state：setState 是非同步的，快速連點兩次
  // 有可能兩次都讀到 busy=false。ref 是同步的，擋得住。
  const inFlight = useRef(false);
  const errRef = useRef<HTMLDivElement>(null);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setError(null);
      try {
        await onSubmit();
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : typeof err === 'string' ? err : '送出失敗';
        setError(msg);
        // 錯誤出現在表單頂端，而使用者的視線在底部的送出鈕上。
        // 捲過去，否則他會以為按了沒反應。
        requestAnimationFrame(() => {
          errRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        });
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [onSubmit],
  );

  return (
    <form {...rest} onSubmit={submit} noValidate>
      <div ref={errRef}>{error && <Note tone="error">{error}</Note>}</div>
      {children({ busy })}
    </form>
  );
}

/**
 * 沒有欄位、只有一顆按鈕的動作：加一題、改狀態、重新計分、移除。
 *
 * # 為什麼不是各自寫三行 useState
 *
 * 因為那三行裡有一行**很容易寫成沒有作用的樣子**：
 *
 * ```ts
 * const [busy, setBusy] = useState(false);
 * async function go() {
 *   if (busy) return;          // ← 這一行擋不住連點兩下
 *   setBusy(true); ...
 * }
 * ```
 *
 * `setBusy` 是非同步的，兩次點擊之間若沒有經過一次 render，
 * 兩次都會讀到 `busy === false`。看起來有防護，實際上沒有。
 * `Form` 用 ref 解決同一件事（見上面的註解），這裡是同一個解法，
 * 給沒有表單可以包的那些按鈕用。
 *
 * 症狀都不是當場的錯誤訊息，而是事後才看得出來的髒資料：兩份
 * 一模一樣的卷子、同一批成績被重算兩次而稽核上有兩筆紀錄。
 */
export function useAction(): {
  busy: boolean;
  error: string | null;
  clearError: () => void;
  /** 成功回 true；失敗時錯誤已經放進 `error`，回 false。 */
  run: (fn: () => Promise<void>) => Promise<boolean>;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const run = useCallback(async (fn: () => Promise<void>) => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      // 伺服器回的 `{error}` 已經是一句人話（見 submitJson），直接用。
      setError(e instanceof Error ? e.message : typeof e === 'string' ? e : '沒有存起來');
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);
  return { busy, error, clearError, run };
}

/**
 * 把 fetch 的回應轉成「成功就回資料、失敗就丟出看得懂的錯誤」。
 *
 * 各個畫面自己處理回應時，最常見的兩種錯是：把 4xx 當成成功
 * （因為 fetch 不會對 4xx 丟錯），以及把伺服器回的 `{error}` 丟掉
 * 只顯示 HTTP 狀態碼。後者尤其糟——伺服器已經寫好了一句給人看的
 * 說明，前端卻顯示「400」。
 */
export async function submitJson<T = unknown>(
  url: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    method: 'POST',
    ...rest,
    headers: {
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...(rest.headers ?? {}),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    const d = data as { error?: string; detail?: string[] } | null;
    const detail = Array.isArray(d?.detail) ? `：${d.detail.join('、')}` : '';
    throw new Error(
      (d?.error ?? `伺服器回應 ${res.status}`) + detail,
    );
  }
  return data as T;
}
