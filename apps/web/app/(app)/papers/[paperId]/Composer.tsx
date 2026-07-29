'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/Dialog';
import { Empty, Note } from '@/components/Feedback';
import { submitJson, useAction } from '@/components/Form';
import { roundScore } from '@/lib/grading.mjs';

export type Item = {
  id: string;
  order: number;
  score: number;
  /**
   * 題幹，**已經在伺服器端排好版**（見 page.tsx 傳進來的 `<MathText>`）。
   *
   * 這裡不自己排的理由是體積：這一頁是 client component，只要它匯入
   * MathText，KaTeX 就整包進瀏覽器——約 90 kB，而這一欄的內容從頭到尾
   * 不會在瀏覽器端變（調順序與改配分都不動題幹）。伺服器已經替左欄的
   * 題庫排過一次了，右欄跟著在同一次排完，瀏覽器一行 JavaScript 都不必多載。
   */
  content: ReactNode;
  type: string;
};

/**
 * 卷子上的題目：順序與配分。
 *
 * # 為什麼是上下移動而不是拖曳
 *
 * 拖曳在觸控裝置上與捲動衝突（老師常用平板），而且對只能用鍵盤的人
 * 等於不存在。上下移動兩顆按鈕在三種輸入方式下都能用，代價只是
 * 移動很多格時要按很多次——而那件事可以之後再補一個「移到第幾題」。
 *
 * # 為什麼移動一格要送整份順序
 *
 * 因為伺服器端的重排是整批的（見 lib/paper.ts）：整批送才有辦法
 * 檢查「題目集合對不對」，那就是同時有人在改同一份卷子的唯一線索。
 *
 * # 配分在離開欄位時才送
 *
 * 每按一個鍵就送一次的話，打「12.5」會送出 1、12、12.、12.5 四次，
 * 而中間那幾個都是合法的分數，會真的被寫進去。
 */
export default function Composer({
  paperId,
  items,
  totalScore,
  mayEdit,
}: {
  paperId: string;
  items: Item[];
  totalScore: number;
  mayEdit: boolean;
}) {
  const router = useRouter();
  const [list, setList] = useState(items);
  const { busy, error, run } = useAction();
  /** 正在確認要移除的那一題。null 代表沒有對話框開著。 */
  const [removing, setRemoving] = useState<Item | null>(null);

  // 伺服器端重新整理之後把本地的順序丟掉，改用它送來的。
  // 依 id／順序／配分組出來的字串當相依，而不是陣列本身——
  // 陣列每次 render 都是新的參考，用它會每次都重設一遍。
  const signature = items.map((i) => `${i.id}:${i.order}:${i.score}`).join('|');
  useEffect(() => {
    setList(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  async function send(fn: () => Promise<unknown>) {
    const ok = await run(async () => {
      await fn();
      router.refresh();
    });
    // 失敗時把畫面退回伺服器的版本，否則使用者看到的順序
    // 與資料庫裡的不一樣，而他不會知道。
    if (!ok) setList(items);
  }

  function move(from: number, to: number) {
    if (to < 0 || to >= list.length) return;
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setList(next);
    void send(() =>
      submitJson(`/api/papers/${paperId}/items`, {
        method: 'PATCH',
        json: { order: next.map((i) => i.id) },
      }),
    );
  }

  if (list.length === 0) {
    return (
      <Empty
        title="這份卷子還沒有題目"
        hint="從左邊的題庫點「加入」。加進來的題目會照加入的順序排，之後可以再調整。"
      />
    );
  }

  return (
    <>
      {error && <Note tone="error">{error}</Note>}

      <ul className="yz-pick">
        {list.map((item, i) => (
          <li key={item.id} className="yz-pick__row">
            <span className="yz-pick__no">{i + 1}</span>
            <span>
              <span className="yz-pick__text">{item.content}</span>
              <span className="yz-pick__meta">{item.type}</span>
            </span>
            <span className="yz-pick__act">
              {mayEdit ? (
                <>
                  <label className="yz-sr" htmlFor={`sc-${item.id}`}>
                    第 {i + 1} 題的配分
                  </label>
                  <input
                    id={`sc-${item.id}`}
                    className="yz-score"
                    type="number"
                    min={0}
                    step="0.5"
                    defaultValue={item.score}
                    disabled={busy}
                    onBlur={(e) => {
                      const score = Number(e.currentTarget.value);
                      if (!Number.isFinite(score) || score === item.score) return;
                      void send(() =>
                        submitJson(`/api/papers/${paperId}/items`, {
                          method: 'PATCH',
                          json: { itemId: item.id, score },
                        }),
                      );
                    }}
                  />
                  <Button
                    variant="quiet"
                    disabled={busy || i === 0}
                    aria-label={`把第 ${i + 1} 題往前移`}
                    onClick={() => move(i, i - 1)}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={busy || i === list.length - 1}
                    aria-label={`把第 ${i + 1} 題往後移`}
                    onClick={() => move(i, i + 1)}
                  >
                    ↓
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={busy}
                    aria-label={`把第 ${i + 1} 題移出卷子`}
                    // 先問一次。移除會改掉總分，而總分是「這份卷子對不對」
                    // 的第一個檢查點——按錯了不會有任何提示，只有卷頭上
                    // 少了幾分，而那件事要到印出來才看得見。
                    onClick={() => setRemoving(item)}
                  >
                    移除
                  </Button>
                </>
              ) : (
                <span className="yz-pick__in">{item.score} 分</span>
              )}
            </span>
          </li>
        ))}
      </ul>

      <p className="yz-total">
        <span>總分</span>
        <span className="yz-total__n">{totalScore}</span>
        {totalScore === 0 && (
          <span className="yz-warn">每一題都是 0 分，交出來每個人都是滿分。</span>
        )}
      </p>

      <ConfirmDialog
        open={removing !== null}
        onClose={() => !busy && setRemoving(null)}
        busy={busy}
        title="把這一題移出卷子"
        confirmLabel="移出卷子"
        consequence={
          removing && (
            <>
              第 {list.findIndex((x) => x.id === removing.id) + 1} 題（{removing.type}，
              {removing.score} 分）會從這份卷子上移除，
              {/* 配分是浮點數，100 減掉 2.5 有可能算出 97.49999999999999。
                  用與計分同一支收尾函式，而不是直接把減出來的數字印上去。 */}
              <strong>後面的題目往前遞補，總分變成 {roundScore(totalScore - removing.score)} 分</strong>
              。題目本身留在題庫裡，不會被刪掉，之後還可以再加回來。
            </>
          )
        }
        onConfirm={() => {
          const target = removing;
          if (!target) return;
          setRemoving(null);
          void send(() =>
            submitJson(`/api/papers/${paperId}/items?item=${target.id}`, { method: 'DELETE' }),
          );
        }}
      />
    </>
  );
}
