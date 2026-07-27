'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 登入。
 *
 * 白牌：畫面上不出現任何機構名稱或標誌（訪談第 32 題）。
 * 標題只用系統名，機構識別由部署方自行決定要不要加。
 */
export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? '登入失敗');
        return;
      }
      router.push(data.mustChangePassword ? '/password?first=1' : '/import');
      router.refresh();
    } catch {
      setError('連線失敗，請確認網路後重試');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 24 }}>
      <form onSubmit={submit} style={{ width: 340 }}>
        <h1
          style={{
            fontFamily: 'var(--font-doc)',
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: '.06em',
            paddingBottom: 10,
            borderBottom: '1px solid var(--ink)',
            marginBottom: 22,
          }}
        >
          雲端智學
        </h1>

        <label style={{ display: 'block', marginBottom: 14 }}>
          <span style={{ fontSize: 11.5, color: 'var(--ink-2)' }}>帳號</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
            style={inputStyle}
          />
        </label>

        <label style={{ display: 'block', marginBottom: 20 }}>
          <span style={{ fontSize: 11.5, color: 'var(--ink-2)' }}>密碼</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            style={inputStyle}
          />
        </label>

        {error && (
          <div className="yz-aside" role="alert" style={{ marginBottom: 16, marginTop: 0 }}>
            {error}
          </div>
        )}

        <button type="submit" className="yz-btn yz-btn--primary" disabled={busy} style={{ width: '100%', padding: '8px 0' }}>
          {busy ? '登入中…' : '登入'}
        </button>

        <p style={{ marginTop: 18, fontSize: 11.5, color: 'var(--ink-3)', lineHeight: 1.8 }}>
          忘記密碼請洽任課老師或系統管理員。
          <br />
          連續 5 次失敗會鎖定 15 分鐘。
        </p>
      </form>
    </main>
  );
}

const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: 4,
  padding: '7px 9px',
  border: '1px solid var(--rule)',
  borderRadius: 'var(--r-sm)',
  background: 'var(--paper-raised)',
  fontSize: 14,
  fontFamily: 'var(--font-ui)',
};
