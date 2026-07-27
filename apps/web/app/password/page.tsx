'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

/**
 * 更換密碼。
 *
 * 首次登入強制更換，因為初始密碼寫在 .env 裡也寫進備份，
 * 不該長期作為有效憑證（見 gen-secrets.sh 的提示）。
 */
function Form() {
  const router = useRouter();
  const first = useSearchParams().get('first') === '1';
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== again) { setError('兩次輸入的新密碼不一致'); return; }
    setBusy(true); setError(null);
    const res = await fetch('/api/auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: cur, newPassword: next }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) { setError(data.error ?? '更換失敗'); return; }
    router.push('/login');
  }

  const fields: [string, string, (v: string) => void, string][] = [
    ['目前的密碼', cur, setCur, 'current-password'],
    ['新密碼（至少 10 個字元）', next, setNext, 'new-password'],
    ['再輸入一次新密碼', again, setAgain, 'new-password'],
  ];

  return (
    <form onSubmit={submit} style={{ width: 360 }}>
      <h1 style={{ fontFamily: 'var(--font-doc)', fontSize: 19, fontWeight: 600,
                   paddingBottom: 9, borderBottom: '1px solid var(--ink)', marginBottom: 18 }}>
        {first ? '首次登入，請更換密碼' : '更換密碼'}
      </h1>

      {first && (
        <div className="yz-aside" style={{ marginTop: 0, marginBottom: 18 }}>
          初始密碼記載於系統設定檔中，也會出現在備份裡，因此不適合長期使用。
          請設定一組只有你知道的密碼。
        </div>
      )}

      {fields.map(([label, val, set, ac]) => (
        <label key={label} style={{ display: 'block', marginBottom: 13 }}>
          <span style={{ fontSize: 11.5, color: 'var(--ink-2)' }}>{label}</span>
          <input
            type="password" value={val} onChange={(e) => set(e.target.value)}
            autoComplete={ac} required
            style={{ display: 'block', width: '100%', marginTop: 4, padding: '7px 9px',
                     border: '1px solid var(--rule)', borderRadius: 'var(--r-sm)',
                     background: 'var(--paper-raised)', fontSize: 14 }}
          />
        </label>
      ))}

      {error && <div className="yz-aside" role="alert" style={{ marginBottom: 14 }}>{error}</div>}

      <button type="submit" className="yz-btn yz-btn--primary" disabled={busy}
              style={{ width: '100%', padding: '8px 0' }}>
        {busy ? '更換中…' : '更換並重新登入'}
      </button>

      <p style={{ marginTop: 14, fontSize: 11.5, color: 'var(--ink-3)', lineHeight: 1.8 }}>
        更換後所有裝置都會被登出，需要重新登入。
      </p>
    </form>
  );
}

export default function PasswordPage() {
  return (
    <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 24 }}>
      <Suspense fallback={null}><Form /></Suspense>
    </main>
  );
}
