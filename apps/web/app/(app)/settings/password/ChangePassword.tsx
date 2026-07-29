/**
 * 更換密碼的表單。
 *
 * # 為什麼強度規則在前端也跑一次
 *
 * 伺服器一定會再判一次（`lib/password.ts` 的 `changePassword`），
 * 所以這裡不是安全機制——它是**在使用者按下送出之前就告訴他**。
 *
 * 差別是實際的：一位學生在手機上打了一組 8 個字的密碼、送出、
 * 等一個往返、看到「密碼至少需要 10 個字元」，然後三個欄位裡有兩個
 * 已經被瀏覽器清掉了。前端先判的話，那句話在他打字的當下就在畫面上。
 *
 * 兩邊共用 `lib/passwordRules.mjs` 的同一支函式，所以不會出現
 * 「前端說可以、後端說不行」——那種不一致會讓人以為系統壞了。
 *
 * # 為什麼換完要重新登入
 *
 * `changePassword` 會刪掉這個帳號的**所有** session，包含目前這一個。
 * 那是刻意的：會想換密碼，常見的原因就是密碼被人看到了，而留著
 * 舊 session 等於沒換。代價是自己也要重登一次，那是可以承受的。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { TextField } from '@/components/Field';
import { Note } from '@/components/Feedback';
import { Form, submitJson } from '@/components/Form';
import { checkPasswordStrength } from '@/lib/passwordRules.mjs';

export default function ChangePassword({ username }: { username: string }) {
  const router = useRouter();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');

  // 還沒開始打就先報錯是在罵人。空的時候不判，等他打了東西再說。
  const strength = next ? checkPasswordStrength(next, username) : null;
  const mismatch = again && next !== again ? '兩次輸入的新密碼不一致' : null;

  return (
    <Form
      onSubmit={async () => {
        // 送出前再判一次而不是只靠 disabled：欄位可以被瀏覽器自動填入，
        // 而自動填入不一定會觸發我們判斷用的那個 change 事件。
        if (next !== again) throw new Error('兩次輸入的新密碼不一致');
        const problem = checkPasswordStrength(next, username);
        if (problem) throw new Error(problem);

        await submitJson('/api/auth/password', {
          json: { currentPassword: current, newPassword: next },
        });
        // 所有 session 都被作廢了（包含這一個），cookie 也被清掉。
        // 留在原地的話，下一次操作會是一連串查不到資料的空白區塊。
        router.replace('/login');
        router.refresh();
      }}
    >
      {({ busy }) => (
        <div className="yz-card">
          <Note>
            換好之後<b>所有裝置都會被登出</b>，包含你現在用的這一台，
            要用新密碼重新登入一次。如果你是因為密碼被別人看到才換的，
            這正是你要的——別人那一邊也會被登出。
          </Note>

          <TextField
            label="目前的密碼"
            type="password"
            required
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.currentTarget.value)}
            hint="忘記目前的密碼就沒辦法從這裡換。請跟老師說一聲，他可以當場給你一組新的。"
          />
          <TextField
            label="新密碼"
            type="password"
            required
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.currentTarget.value)}
            error={strength}
            // 不要求大小寫與符號的組合，是照 NIST SP 800-63B：那類規則
            // 只會讓人選出 Password1! 這種可預測的東西。長度才是重點。
            hint="至少 10 個字元。可以是一句你記得住的話，不必混大小寫與符號——長比複雜有用。"
          />
          <TextField
            label="再輸入一次新密碼"
            type="password"
            required
            autoComplete="new-password"
            value={again}
            onChange={(e) => setAgain(e.currentTarget.value)}
            error={mismatch}
          />

          <div className="yz-actions">
            <span className="yz-actions__spacer" />
            <Button
              type="submit"
              variant="primary"
              busy={busy}
              busyLabel="更換中…"
              disabled={!current || !next || !again || strength !== null || mismatch !== null}
            >
              更換並重新登入
            </Button>
          </div>
        </div>
      )}
    </Form>
  );
}
