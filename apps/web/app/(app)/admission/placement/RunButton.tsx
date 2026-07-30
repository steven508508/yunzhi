'use client';

import { useRouter } from 'next/navigation';

import { Button } from '@/components/Button';
import { Form, submitJson } from '@/components/Form';

/**
 * 「重新跑一次模擬」。
 *
 * # 為什麼跑模擬是一個按鈕而不是打開頁面就跑
 *
 * 因為每一次模擬都會寫一列 `SimulationRun`（含輸入快照），而那張表存在
 * 的理由是回答「這個數字是什麼時候算的、用的是哪一份資料」。每次進
 * 頁面都跑的話，它會塞滿一模一樣的列，然後那個問題就答不出來了。
 *
 * 而且**這也是「同樣的輸入給同樣的結果」在使用者眼裡的樣子**：頁面上
 * 顯示的是上一次的結果與它的計算時間，重整不會讓數字跳動。學生按了
 * 重跑而數字沒變，那才是對的——資料沒變，結果就不該變。
 */
export default function RunButton({ year, hasWishes }: { year: number; hasWishes: boolean }) {
  const router = useRouter();
  return (
    <Form
      onSubmit={async () => {
        await submitJson('/api/admission/placement', { json: { year } });
        router.refresh();
      }}
    >
      {({ busy }) => (
        <div className="yz-actions" style={{ justifyContent: 'flex-start' }}>
          <Button type="submit" variant="primary" busy={busy} busyLabel="抽樣中…" disabled={!hasWishes}>
            重新跑一次模擬
          </Button>
          <span className="yz-hint" style={{ margin: 0 }}>
            {hasWishes ? (
              <>
                抽樣 10000 次。<strong>同樣的輸入會給同樣的結果</strong>——亂數用的是由輸入
                本身推出來的固定種子，所以重整頁面不會讓數字跳動。數字變了就是輸入變了，
                而下面的每一次紀錄都留著它當時用的資料。
              </>
            ) : (
              <>先在升學規劃那一頁填幾個個人申請的志願，這裡才有東西可以模擬。</>
            )}
          </span>
        </div>
      )}
    </Form>
  );
}
