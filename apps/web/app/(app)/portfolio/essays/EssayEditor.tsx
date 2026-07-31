/**
 * 四份自述的編輯、三種 AI 回饋、以及分享。
 *
 * # 這個元件裡沒有任何一條路徑把回饋搬進 textarea
 *
 * 這是防代寫的**介面層**（規格書 §9.1）。回饋顯示在一個唯讀的區塊裡，
 * 沒有「套用」、沒有「複製」按鈕、也沒有把它塞進 `body` 的
 * `onClick`。學生想照著改要自己打字——而自己打那一遍就是這整個
 * 功能存在的理由。
 *
 * 註解寫在這裡是因為**這是最容易在日後被「順手改善」的地方**：
 * 加一顆複製按鈕看起來像體貼，而它會讓前面兩層設限全部失效。
 *
 * # AI 停用時要說得出是誰決定的
 *
 * 超出班級層級的功能回 403，而訊息是「這是老師事前明定的範圍，
 * 不是系統的限制——想調整的話跟老師談」。學生看到「停用」的第一個
 * 反應是以為系統壞了，然後他會去找一個沒有這層限制的工具。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { Note } from '@/components/Feedback';
import { TextAreaField, TextField } from '@/components/Field';
import { submitJson, useAction } from '@/components/Form';

type Essay = {
  id: string;
  kind: string;
  body: string;
  charCount: number;
  imageCount: number;
  version: number;
  sharedWith: { userId: string; displayName: string }[];
};

type Teacher = { id: string; name: string };

const KINDS = [
  { kind: 'DIVERSE_SUMMARY', label: 'N 多元表現綜整心得' },
  { kind: 'REFLECTION', label: 'O 高中學習歷程反思' },
  { kind: 'MOTIVATION', label: 'P 就讀動機' },
  { kind: 'PLAN', label: 'Q 未來學習計畫與生涯規劃' },
];

const FEATURES = [
  {
    feature: 'WRITING_FEEDBACK',
    label: '看我寫的',
    hint: '具體性、一致性、制度三類各看一遍。它會引用你的句子然後問你問題。',
  },
  {
    feature: 'MATERIAL_HINT',
    label: '幫我想素材',
    hint: '從你自己的成績與作答軌跡提問。它不看你的草稿，這一次的任務是幫你想起經歷。',
  },
  {
    feature: 'SELECTION_DISCUSS',
    label: '討論選件',
    hint: '看你挑的那幾件呈現的是不是同一種能力。它不會幫你選。',
  },
];

export default function EssayEditor({
  essays,
  teachers,
  summaryChars,
  summaryImages,
}: {
  essays: Essay[];
  teachers: Teacher[];
  summaryChars: number;
  summaryImages: number;
}) {
  const router = useRouter();
  const { busy, error, run } = useAction();
  const [kind, setKind] = useState(KINDS[2].kind);
  const current = essays.find((e) => e.kind === kind);
  const [body, setBody] = useState(current?.body ?? '');
  const [images, setImages] = useState(String(current?.imageCount ?? 0));
  const [loadedFor, setLoadedFor] = useState(kind);
  const [feedback, setFeedback] = useState<{
    text: string;
    fellBack: boolean;
    blockedReasons: string[];
  } | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  // 換一份自述時把編輯區換過去。用 render 期間比對而不是 useEffect：
  // useEffect 會先畫一次舊的內容，而那一瞬間學生會看到別份自述的字
  // 出現在這一份的框裡——他會以為自己存錯了。
  if (loadedFor !== kind) {
    setLoadedFor(kind);
    setBody(current?.body ?? '');
    setImages(String(current?.imageCount ?? 0));
    setFeedback(null);
    setAiError(null);
  }

  const chars = Array.from(body.replace(/\s+/g, '')).length;
  const isSummary = kind === 'DIVERSE_SUMMARY';
  const overChars = isSummary && chars > summaryChars;
  const overImages = isSummary && Number(images) > summaryImages;

  const save = () =>
    run(async () => {
      await submitJson('/api/portfolio/essays', {
        json: { kind, body, imageCount: Number(images) || 0 },
      });
      router.refresh();
    });

  /**
   * 整份刪掉，**連同它的每一個舊版本。**
   *
   * 這一區裝的是他的生涯敘事，而寫下來之後想拿掉的理由與素材完全不同：
   * 他可能寫了一段關於家裡的事、或是一段他現在覺得很蠢的話。
   * 「你刪不掉」在這種內容上不是不方便，它會讓他下一次不寫真話。
   *
   * 只刪現行版本的話，舊版本會留在資料庫裡而畫面上永遠看不到——
   * 那不是刪除，那是把它藏起來。
   */
  const drop = () =>
    run(async () => {
      if (!current) return;
      await submitJson(`/api/portfolio/essays/${current.id}`, { method: 'DELETE' });
      setBody('');
      setFeedback(null);
      router.refresh();
    });

  const ask = (feature: string) =>
    run(async () => {
      setAiError(null);
      setFeedback(null);
      try {
        const out = await submitJson<{
          text: string;
          fellBack: boolean;
          blockedReasons: string[];
        }>('/api/portfolio/coach', {
          json: { feature, essayId: current?.id ?? null },
        });
        setFeedback(out);
      } catch (e) {
        // AI 停用（403）與 AI 連不上（503）都走這裡，而兩種的訊息
        // 完全不同——前者是老師的決定，後者是機器的問題。伺服器已經
        // 寫好了兩句不同的人話，直接用。
        setAiError(e instanceof Error ? e.message : '沒有拿到回饋');
      }
    });

  return (
    <section>
      <h2 className="yz-card__title" style={{ marginTop: 26 }}>
        寫
      </h2>

      {error && <Note tone="error">{error}</Note>}

      <p className="yz-pf__kindpick">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            className={`yz-chip${kind === k.kind ? ' yz-chip--on' : ''}`}
            onClick={() => setKind(k.kind)}
          >
            {k.label}
          </button>
        ))}
      </p>

      {isSummary && (
        <Note tone="info">
          綜整心得的上限是 {summaryChars} 字加 {summaryImages} 張圖，
          <strong>但它不計入 10 件多元表現的額度</strong>——不要為了它去刪別的東西。
          這是最多人搞錯的一條。
        </Note>
      )}

      <TextAreaField
        label={KINDS.find((k) => k.kind === kind)?.label ?? ''}
        hint={
          isSummary
            ? `目前 ${chars} 字${overChars ? `，超過 ${chars - summaryChars} 字` : ''}`
            : `目前 ${chars} 字。這一項的上限由各校系自訂，全國沒有統一規定。`
        }
        error={overChars ? `超過 ${summaryChars} 字的明文上限` : null}
        rows={14}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />

      {isSummary && (
        <TextField
          label="圖片張數"
          hint={`上限 ${summaryImages} 張。`}
          error={overImages ? `超過 ${summaryImages} 張` : null}
          inputMode="numeric"
          value={images}
          onChange={(e) => setImages(e.target.value)}
        />
      )}

      <div className="yz-actions">
        <Button variant="primary" busy={busy} onClick={save}>
          存一個新版本
        </Button>
        {current && <span className="yz-pf__meta">目前是第 {current.version} 版</span>}
        {current && (
          <Button
            variant="quiet"
            disabled={busy}
            onClick={drop}
            title="連同每一個舊版本一起刪掉。只刪現行版本的話，舊版本會留在資料庫裡而你永遠看不到。"
          >
            整份刪掉
          </Button>
        )}
      </div>
      <p className="yz-hint">
        舊版本會留著。寫學習歷程的價值有一半在回頭看自己三個月前怎麼想的，
        直接覆蓋的話那一半就沒了。
        <strong>不想留的整份可以刪掉</strong>——連同每一個舊版本，因為留下一份你看不到
        也刪不掉的東西不是保存，是把它藏起來。
      </p>

      {/* ── 回饋 ─────────────────────────────────────────── */}
      <h2 className="yz-card__title" style={{ marginTop: 26 }}>
        回饋
      </h2>
      <div className="yz-pf__asks">
        {FEATURES.map((f) => (
          <span key={f.feature} className="yz-pf__ask">
            <Button busy={busy} onClick={() => ask(f.feature)}>
              {f.label}
            </Button>
            <span className="yz-pf__askhint">{f.hint}</span>
          </span>
        ))}
      </div>

      {aiError && <Note tone="warn">{aiError}</Note>}

      {feedback && (
        <div className="yz-pf__feedback">
          {/*
            唯讀。**沒有套用、沒有複製、沒有任何把它搬進上面那個 textarea
            的路徑。** 見檔頭：那顆按鈕本身就是代寫。
          */}
          <p className="yz-pf__feedbacktext">{feedback.text}</p>
          {feedback.blockedReasons.length > 0 && (
            <p className="yz-pf__blocked">
              AI 有 {feedback.blockedReasons.length} 次的回覆被防代寫閘門擋下來重寫了
              （{feedback.blockedReasons[0]}）。
              <strong>被擋掉的內容不會顯示給你看</strong>——把它顯示出來等於用
              「這段被擋了」這個包裝把代寫送到你眼前。
            </p>
          )}
          {feedback.fellBack && (
            <p className="yz-pf__blocked">
              這一次 AI 三度都想幫你寫，所以上面顯示的是系統自己的制度檢查結果。
              功能沒有壞。
            </p>
          )}
        </div>
      )}

      {/* ── 分享 ─────────────────────────────────────────── */}
      <h2 className="yz-card__title" style={{ marginTop: 26 }}>
        分享給老師徵詢意見
      </h2>
      {!current ? (
        <p className="yz-hint">先存一版，才有東西可以分享。</p>
      ) : (
        <>
          <p className="yz-hint">
            分享之後那位老師看得到這一份的內容。<strong>你隨時可以撤回</strong>，
            撤回的下一秒他就看不到了。你的 AI 對話紀錄不在分享範圍內——
            老師連摘要都看不到。
          </p>
          <p className="yz-pf__teachers">
            {teachers.map((t) => {
              const on = current.sharedWith.some((s) => s.userId === t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  disabled={busy}
                  className={`yz-chip${on ? ' yz-chip--on' : ''}`}
                  onClick={() =>
                    run(async () => {
                      await submitJson(`/api/portfolio/essays/${current.id}`, {
                        method: 'PATCH',
                        json: { teacherId: t.id, share: !on },
                      });
                      router.refresh();
                    })
                  }
                >
                  {t.name}
                  {on ? '（已分享，再按一次撤回）' : ''}
                </button>
              );
            })}
          </p>
        </>
      )}
    </section>
  );
}
