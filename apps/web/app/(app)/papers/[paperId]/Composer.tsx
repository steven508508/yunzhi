'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/Dialog';
import { Empty, Note } from '@/components/Feedback';
import { submitJson, useAction } from '@/components/Form';
import { moveTo, spreadScores, sumScores, uniformScores } from '@/lib/paperPlan.mjs';

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
  /** 展開之後看到的：選項與標準答案。同樣是伺服器端排好的。 */
  detail: ReactNode;
  type: string;
};

/**
 * 卷子上的題目：順序與配分。
 *
 * # 為什麼是上下移動而不是拖曳
 *
 * 拖曳在觸控裝置上與捲動衝突（老師常用平板），而且對只能用鍵盤的人
 * 等於不存在。上下移動兩顆按鈕在三種輸入方式下都能用，代價只是
 * 移動很多格時要按很多次——所以每一列還有一個「移到第幾題」的輸入框，
 * 打一個數字按 Enter 就到位。那是 Composer 原本的註解裡答應要補的東西。
 *
 * # 為什麼移動一格要送整份順序
 *
 * 因為伺服器端的重排是整批的（見 lib/paper.ts）：整批送才有辦法
 * 檢查「題目集合對不對」，那就是同時有人在改同一份卷子的唯一線索。
 *
 * # 配分改成三件事一起做
 *
 * **一、批次。** 25 題各送一次是 25 次往返、100 次點擊，而它佔掉出一份
 * 卷子全部操作成本的四成。上面那一排把它變成 3 次點擊 1 次往返。
 *
 * **二、不停用其他欄位。** 原本 `disabled={busy}` 綁的是整個元件共用的
 * 一個 busy，所以任何一題在存檔，25 個框一起變灰、焦點掉光——Tab 連打
 * 不可能。現在單題存檔完全不擋別的框。
 *
 * **三、受控輸入 ＋ 逐列的錯誤。** 原本是 `defaultValue`（不受控），
 * 存檔失敗時畫面上留著你打的數字、資料庫是舊值，而唯一的線索是最上面
 * 那個總分沒有動。最容易觸發的失敗正是「有人已經開始作答」——老師在
 * 辦公室調配分，每一次都失敗、每一次都看起來成功了。
 *
 * # 為什麼單題存檔不再 router.refresh()
 *
 * 因為那是一次整頁 RSC 重繪（三個查詢 ＋ 最多 60 題題幹的伺服器端
 * KaTeX 排版），而它唯一更新的東西是總分——總分在這裡算得出來。
 * 順序與題目集合變了才要重新拿伺服器的版本。
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
  /** 排序與移除共用：這兩件事會改變整份清單，做到一半不能再按。 */
  const { busy, error, run } = useAction();
  /** 正在確認要移除的那一題。null 代表沒有對話框開著。 */
  const [removing, setRemoving] = useState<Item | null>(null);

  /** 每一格輸入框現在的字。受控——失敗時才還原得回伺服器的值。 */
  const [draft, setDraft] = useState<Record<string, string>>(() => asDraft(items));
  /** 這一列正在存檔。只擋這一列，不擋別人。 */
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  /** 這一列的錯誤。貼在那一列旁邊，不是整份清單的頂端。 */
  const [rowErr, setRowErr] = useState<Record<string, string>>({});
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkNote, setBulkNote] = useState<string | null>(null);
  const [each, setEach] = useState('4');
  const [target, setTarget] = useState('100');

  // 伺服器端重新整理之後把本地的順序丟掉，改用它送來的。
  // 依 id／順序／配分組出來的字串當相依，而不是陣列本身——
  // 陣列每次 render 都是新的參考，用它會每次都重設一遍。
  const signature = items.map((i) => `${i.id}:${i.order}:${i.score}`).join('|');
  useEffect(() => {
    setList(items);
    setDraft(asDraft(items));
    setRowErr({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  /**
   * 畫面上的總分**由這裡的數字算出來**，不是伺服器傳來的那一個。
   *
   * 因為單題存檔不再整頁重繪，伺服器的 `totalScore` 會停在上一次
   * 重繪時的值。存檔失敗的那一列會被還原成伺服器的配分，所以這個
   * 加總永遠等於「資料庫裡的樣子」——除非有人同時在改同一份卷子，
   * 而那件事下一次重新整理就會對回來。
   */
  const total = sumScores(list.map((i) => scoreOf(draft[i.id], i.score)));

  async function send(fn: () => Promise<unknown>) {
    const ok = await run(async () => {
      await fn();
      router.refresh();
    });
    // 失敗時把畫面退回伺服器的版本，否則使用者看到的順序
    // 與資料庫裡的不一樣，而他不會知道。
    if (!ok) setList(items);
    return ok;
  }

  function move(from: number, to: number) {
    if (to === from || to < 0 || to >= list.length) return;
    const ids = moveTo(
      list.map((i) => i.id),
      from,
      to,
    );
    setList(ids.map((id) => list.find((i) => i.id === id)!));
    void send(() =>
      submitJson(`/api/papers/${paperId}/items`, {
        method: 'PATCH',
        json: { order: ids },
      }),
    );
  }

  /** 一題的配分。離開欄位時才送——見下面 onBlur 的理由。 */
  async function saveScore(item: Item) {
    const value = Number(draft[item.id]);
    if (!Number.isFinite(value) || value < 0) {
      setDraft((d) => ({ ...d, [item.id]: String(item.score) }));
      setRowErr((e) => ({ ...e, [item.id]: '配分要是 0 或正數，已經還原' }));
      return;
    }
    if (value === item.score) return;

    setSaving((s) => ({ ...s, [item.id]: true }));
    setRowErr((e) => {
      const { [item.id]: _drop, ...rest } = e;
      return rest;
    });
    try {
      await submitJson(`/api/papers/${paperId}/items`, {
        method: 'PATCH',
        json: { itemId: item.id, score: value },
      });
      // 本地的 item.score 也要跟上，否則下一次 blur 會再送一次同樣的值。
      setList((l) => l.map((x) => (x.id === item.id ? { ...x, score: value } : x)));
    } catch (e) {
      // **真的還原**。原本是不受控的輸入框，失敗時畫面上留著你打的數字、
      // 資料庫裡是舊值，而那件事沒有任何症狀。
      setDraft((d) => ({ ...d, [item.id]: String(item.score) }));
      setRowErr((err) => ({
        ...err,
        [item.id]: e instanceof Error ? e.message : '沒有存起來',
      }));
    } finally {
      setSaving((s) => {
        const { [item.id]: _drop, ...rest } = s;
        return rest;
      });
    }
  }

  /** 整批套用。一次交易、一次往返、一次重繪。 */
  async function applyAll(next: number[], what: string) {
    const entries = list
      .map((it, i) => ({ itemId: it.id, score: next[i] }))
      .filter((e, i) => e.score !== list[i].score);
    if (entries.length === 0) {
      setBulkNote(`每一題已經是${what}了，沒有要改的。`);
      return;
    }
    setBulkBusy(true);
    setBulkNote(null);
    setRowErr({});
    try {
      await submitJson(`/api/papers/${paperId}/items`, {
        method: 'PATCH',
        json: { scores: entries },
      });
      setBulkNote(`${entries.length} 題的配分改成${what}，總分 ${sumScores(next)} 分。`);
      router.refresh();
    } catch (e) {
      setBulkNote(e instanceof Error ? e.message : '沒有存起來');
    } finally {
      setBulkBusy(false);
    }
  }

  if (list.length === 0) {
    return (
      <Empty
        title="這份卷子還沒有題目"
        hint="從左邊的題庫點「加入」。加進來的題目會照加入的順序排，之後可以再調整。"
      />
    );
  }

  // 負數與打到一半的字都夾成 0。`spreadScores` 對負的總分會丟錯，
  // 而它是在 render 裡算的——一個減號就會把整頁換成錯誤畫面。
  const evenly = spreadScores(list.length, positive(target));

  return (
    <>
      {error && <Note tone="error">{error}</Note>}

      {mayEdit && (
        <div className="yz-bulk">
          <label className="yz-bulk__lab" htmlFor="bulk-each">
            每題
          </label>
          <input
            id="bulk-each"
            className="yz-bulk__in"
            type="number"
            min={0}
            step="0.5"
            value={each}
            onChange={(e) => setEach(e.currentTarget.value)}
          />
          <span className="yz-bulk__lab">分</span>
          <Button
            busy={bulkBusy}
            onClick={() =>
              void applyAll(
                uniformScores(list.length, positive(each)),
                `每題 ${positive(each)} 分`,
              )
            }
          >
            全部套用
          </Button>

          <span style={{ width: 12 }} />

          <label className="yz-bulk__lab" htmlFor="bulk-total">
            平均分配到
          </label>
          <input
            id="bulk-total"
            className="yz-bulk__in"
            type="number"
            min={0}
            step="0.5"
            value={target}
            onChange={(e) => setTarget(e.currentTarget.value)}
          />
          <span className="yz-bulk__lab">分</span>
          <Button
            busy={bulkBusy}
            onClick={() => void applyAll(evenly, `平均分配到 ${positive(target)} 分`)}
          >
            平均分配
          </Button>

          <p className="yz-bulk__note">
            {/* 按下去之前先說出結果。除不盡時餘數落在最後幾題，而老師
                要能在卷頭寫出「前 N 題各 X 分」。 */}
            平均分配會變成：{describe(evenly)}。
            題號右邊的小框可以直接打新的題號按 Enter，把這一題移過去。
            {bulkNote && <> 　·　{bulkNote}</>}
          </p>
        </div>
      )}

      <ul className="yz-pick">
        {list.map((item, i) => (
          <li key={item.id} className="yz-pick__row">
            <span className="yz-pick__no">{i + 1}</span>
            <details className="yz-pick__q">
              <summary className="yz-pick__sum">
                <span className="yz-pick__text">{item.content}</span>
                <span className="yz-pick__meta">{item.type}</span>
                <span className="yz-pick__toggle" />
              </summary>
              <div className="yz-pick__full">{item.detail}</div>
            </details>
            <span className="yz-pick__act">
              {mayEdit ? (
                <>
                  <label className="yz-sr" htmlFor={`sc-${item.id}`}>
                    第 {i + 1} 題的配分
                  </label>
                  <input
                    id={`sc-${item.id}`}
                    className={`yz-score${rowErr[item.id] ? ' yz-score--bad' : ''}${
                      saving[item.id] ? ' yz-score--saving' : ''
                    }`}
                    type="number"
                    min={0}
                    step="0.5"
                    value={draft[item.id] ?? ''}
                    // **不停用**。停用會讓 Tab 連打不可能，而配分是冪等的：
                    // 重複送同一個值不會壞。
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, [item.id]: e.currentTarget.value }))
                    }
                    // 離開欄位時才送。每按一個鍵就送的話，打「12.5」會送出
                    // 1、12、12.、12.5 四次，而中間那幾個都是合法的分數。
                    onBlur={() => void saveScore(item)}
                    aria-invalid={rowErr[item.id] ? true : undefined}
                  />
                  <label className="yz-sr" htmlFor={`mv-${item.id}`}>
                    把第 {i + 1} 題移到第幾題
                  </label>
                  <input
                    // key 帶著位置：移動之後這個框要重新拿到新的預設值，
                    // 否則它會一直顯示移動前的題號。
                    key={`mv-${item.id}-${i}`}
                    id={`mv-${item.id}`}
                    className="yz-moveto"
                    type="number"
                    min={1}
                    max={list.length}
                    defaultValue={i + 1}
                    title="打一個題號按 Enter，這一題就移到那個位置"
                    disabled={busy}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return;
                      e.preventDefault();
                      const to = Number(e.currentTarget.value) - 1;
                      if (Number.isFinite(to)) move(i, Math.min(Math.max(to, 0), list.length - 1));
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
                  {rowErr[item.id] && (
                    <span className="yz-pick__err" role="alert">
                      {rowErr[item.id]}
                    </span>
                  )}
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
        <span className="yz-total__n">{total}</span>
        {total === 0 && (
          <span className="yz-warn">每一題都是 0 分，交出來每個人都是滿分。</span>
        )}
        {total !== totalScore && total !== 0 && (
          // 伺服器上一次重繪時的總分。兩個對不上代表有配分還沒存進去，
          // 或者有人同時在改同一份卷子——兩件事老師都該知道。
          <span className="yz-muted">伺服器上的總分是 {totalScore}，重新整理會對齊</span>
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
              {scoreOf(draft[removing.id], removing.score)} 分）會從這份卷子上移除，
              {/* 配分是浮點數，100 減掉 2.5 有可能算出 97.49999999999999。
                  用與計分同一支收尾函式，而不是直接把減出來的數字印上去。 */}
              <strong>
                後面的題目往前遞補，總分變成{' '}
                {sumScores(
                  list
                    .filter((x) => x.id !== removing.id)
                    .map((x) => scoreOf(draft[x.id], x.score)),
                )}{' '}
                分
              </strong>
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

function asDraft(items: readonly Item[]): Record<string, string> {
  return Object.fromEntries(items.map((i) => [i.id, String(i.score)]));
}

/** 輸入框裡的字換成一個不會讓計算丟錯的分數。空白、亂打、負數都是 0。 */
function positive(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 輸入框裡的字換成數字。打到一半（空字串、只有一個負號）時用伺服器的值。 */
function scoreOf(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * 「25 題各 4 分」或「前 20 題各 4 分、後 4 題各 5 分」。
 *
 * 這句話老師要抄到卷頭上，所以它的形狀就照著卷頭上的寫法。
 */
function describe(scores: readonly number[]): string {
  if (scores.length === 0) return '沒有題目';
  const first = scores[0];
  const cut = scores.findIndex((s) => s !== first);
  if (cut < 0) return `${scores.length} 題各 ${first} 分`;
  return `前 ${cut} 題各 ${first} 分、後 ${scores.length - cut} 題各 ${scores[cut]} 分`;
}
