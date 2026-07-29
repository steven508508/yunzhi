/**
 * 一題的編輯表單。
 *
 * # 兩件事讓這個畫面與其他表單不同
 *
 * **一、改標準答案是一個會改到成績的動作，但它看起來只是打個勾。**
 * 所以只要答案真的變了、而且已經有人考過這一題，儲存前一定會跳出
 * 確認視窗，把「哪幾份任務、幾份作答」連同連結攤開來講。老師按完
 * 儲存之後最常見的誤會是「改完就生效了」——實際上要到那幾份任務
 * 按一次「全班重新計分」。那句話與那幾個連結是這個畫面最重要的內容。
 *
 * **二、選項的增刪在已經有人作答之後是鎖住的。** 學生的作答存的是
 * 選項的**序號**，刪掉中間一個選項會讓「他選了 (3)」指到另一個選項。
 * 伺服器會擋（`checkOptionStructure`），但這裡連按鈕都不畫——
 * 畫了再擋，老師會以為系統壞了。
 *
 * 每一列都記著自己原本是第幾個（`origin`），送上去讓伺服器驗證。
 * 沒有這一欄的話，伺服器分不出「改了第 2 個選項的文字」與
 * 「刪掉第 2 個、把第 3 個往上移」——那兩件事送上來的內容一模一樣。
 */
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/Dialog';
import { CheckField, SelectField, TextAreaField, TextField } from '@/components/Field';
import { Note } from '@/components/Feedback';
import { MathText } from '@/components/MathText';
import { submitJson, useAction } from '@/components/Form';
import { TYPE_LABELS, typeFamily } from '@/lib/questionEdit.mjs';

export type EditorQuestion = {
  id: string;
  type: string;
  content: string;
  score: number;
  options: { order: number; label: string; content: string; assets?: unknown }[];
  answerKeys: number[];
  /**
   * 題幹的附圖。預覽要畫得出來——老師在上面的輸入框裡看到的是
   * `![[a:fig1]]` 這串標記，他要能在下面確認那張圖真的在對的位置。
   */
  contentAssets?: unknown;
  answerText: string | null;
  answerSlots: string[] | null;
  knowledgePointIds: string[];
  explanation: { conclusion: string; steps: string[] } | null;
};

export type EditorImpact = {
  /** 已經計過分的作答份數。0 代表改答案不影響任何既有成績。 */
  graded: number;
  /** 有作答記錄（含進行中）的份數。選項結構的鎖看這個。 */
  attempts: number;
  inProgress: number;
  assignments: { assignmentId: string; title: string; graded: number }[];
};

type Row = {
  key: string;
  /** 原本是第幾個選項。新增的列是 null。 */
  origin: number | null;
  label: string;
  content: string;
  correct: boolean;
};

const TYPES = Object.keys(TYPE_LABELS);

export default function QuestionEditor({
  question,
  impact,
  knowledgePoints,
  canEdit,
}: {
  question: EditorQuestion;
  impact: EditorImpact;
  knowledgePoints: { id: string; name: string }[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const { busy, error, clearError, run } = useAction();

  const [content, setContent] = useState(question.content);
  const [type, setType] = useState(question.type);
  const [score, setScore] = useState(String(question.score));
  const [rows, setRows] = useState<Row[]>(() =>
    question.options.map((o) => ({
      key: `o${o.order}`,
      origin: o.order,
      label: o.label,
      content: o.content,
      correct: question.answerKeys.includes(o.order),
    })),
  );
  const [answerText, setAnswerText] = useState(question.answerText ?? '');
  const [slots, setSlots] = useState((question.answerSlots ?? []).join('、'));
  const [kps, setKps] = useState<string[]>(question.knowledgePointIds);
  const [conclusion, setConclusion] = useState(question.explanation?.conclusion ?? '');
  const [steps, setSteps] = useState((question.explanation?.steps ?? []).join('\n'));
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState<{ changed: string[]; gradingChanged: boolean } | null>(null);

  const family = typeFamily(type);
  const locked = impact.attempts > 0;

  /** 標準答案真的變了嗎。確認視窗要不要跳，看這個。 */
  const answerChanged = useMemo(() => {
    if (family === 'CHOICE') {
      const now = rows
        .map((r, i) => (r.correct ? i + 1 : 0))
        .filter(Boolean)
        .join(',');
      const before = question.answerKeys.join(',');
      // 選項文字改了也算——把 (3) 的內容從「80 元」改成「90 元」，
      // 對已經考過的人來說與換答案是同一件事。
      const textChanged = rows.some(
        (r, i) => r.origin !== null && question.options[i]?.content !== r.content,
      );
      return now !== before || textChanged;
    }
    if (family === 'SLOT') return slots !== (question.answerSlots ?? []).join('、');
    return answerText !== (question.answerText ?? '');
  }, [family, rows, slots, answerText, question]);

  const needsConfirm = answerChanged && impact.graded > 0;

  function setRow(key: string, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function addRow() {
    setRows((rs) => [
      ...rs,
      { key: `n${Date.now()}${rs.length}`, origin: null, label: String(rs.length + 1), content: '', correct: false },
    ]);
  }

  function removeRow(key: string) {
    setRows((rs) => rs.filter((r) => r.key !== key));
  }

  function pick(key: string, checked: boolean) {
    // 單選題勾一個就取消別的。讓它可以勾兩個的話，儲存時才被伺服器
    // 擋下來（「單選題卻有 2 個標準答案」），而老師不知道該取消哪一個。
    if (type === 'SINGLE_CHOICE' || type === 'TRUE_FALSE') {
      setRows((rs) => rs.map((r) => ({ ...r, correct: r.key === key ? checked : false })));
      return;
    }
    setRow(key, { correct: checked });
  }

  async function save() {
    const body: Record<string, unknown> = {
      content,
      type,
      score: Number(score),
      knowledgePointIds: kps,
      explanation: { conclusion, steps },
    };
    if (family === 'CHOICE') {
      body.options = rows.map((r) => ({
        origin: r.origin,
        label: r.label,
        content: r.content,
        correct: r.correct,
      }));
    }
    if (family === 'SLOT') {
      body.answerSlots = slots
        .split(/[,、，]/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (family === 'TEXT') body.answerText = answerText;

    const r = await submitJson<{ changed: string[]; gradingChanged: boolean }>(
      `/api/questions/${question.id}`,
      { method: 'PATCH', json: body },
    );
    setSaved({ changed: r.changed ?? [], gradingChanged: r.gradingChanged === true });
    setConfirming(false);
    router.refresh();
  }

  return (
    <section className="yz-qedit">
      {error && <Note tone="error">{error}</Note>}

      {saved && (
        <Note tone={saved.gradingChanged ? 'warn' : 'info'}>
          {saved.changed.length === 0 ? (
            '沒有任何欄位有變動，所以什麼都沒有寫進去。'
          ) : saved.gradingChanged && impact.assignments.length > 0 ? (
            <>
              已存檔。<strong>這一題的計分依據變了，但已經算出來的成績還是舊的</strong>
              ——到下面這幾份任務按一次「全班重新計分」才會生效：
              {impact.assignments.map((a) => (
                <span key={a.assignmentId}>
                  　<Link href={`/grades/${a.assignmentId}`}>{a.title}</Link>（{a.graded} 份）
                </span>
              ))}
            </>
          ) : (
            '已存檔。'
          )}
        </Note>
      )}

      {/* ── 題幹 ─────────────────────────────────────────────── */}
      <TextAreaField
        label="題幹"
        rows={5}
        value={content}
        disabled={!canEdit}
        onChange={(e) => setContent(e.currentTarget.value)}
        hint="數學式寫在 $…$ 裡（$\frac{3}{4}$），化學式用 $\ce{H2SO4}$。下面是排出來的樣子。"
      />
      <div className="yz-qedit__preview">
        <span className="yz-qedit__previewlabel">預覽</span>
        {/* 附圖跟著題幹的標記走。**這是老師唯一看得到「圖在哪一段」的
            地方**——改題幹時把 `![[a:fig1]]` 挪錯位置，症狀是學生在
            「如右圖」那一句之前就看到了圖，或者反過來。 */}
        <MathText assets={question.contentAssets}>{content}</MathText>
      </div>

      <div className="yz-qedit__pair">
        <SelectField
          label="題型"
          value={type}
          disabled={!canEdit}
          onChange={(e) => setType(e.currentTarget.value)}
          hint={
            locked
              ? '已經有人考過這一題，只能在同一個家族內改（單選↔多選）。'
              : '改題型會換掉計分的方式。'
          }
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABELS[t]}
            </option>
          ))}
        </SelectField>

        <TextField
          label="題庫預設配分"
          type="number"
          step="0.5"
          min="0"
          value={score}
          disabled={!canEdit}
          onChange={(e) => setScore(e.currentTarget.value)}
          // 這一句擋掉的是「改了配分為什麼上禮拜的考試沒變」這通電話。
          hint="只是組卷時的預設值。已經出過的卷子用的是卷上的配分，不受這裡影響。"
        />
      </div>

      {/* ── 選項與標準答案 ───────────────────────────────────── */}
      {family === 'CHOICE' && (
        <fieldset className="yz-qedit__opts">
          <legend className="yz-legend">
            選項與標準答案
            <span className="yz-muted">
              打勾的是標準答案{type === 'MULTI_CHOICE' ? '（多選題可以勾多個）' : ''}
            </span>
          </legend>

          {locked && (
            <p className="yz-hint">
              這一題已經有 {impact.attempts} 份作答，所以<strong>不能增刪或搬動選項</strong>
              ——學生的記錄存的是「選了第幾個」，動了順序他當時選的那一個就會變成別的。
              改文字、改標準答案都可以。
            </p>
          )}

          <ol className="yz-qedit__rows">
            {rows.map((r, i) => (
              <li key={r.key} className={`yz-qedit__row${r.correct ? ' yz-qedit__row--ans' : ''}`}>
                <label className="yz-qedit__pick">
                  <input
                    type="checkbox"
                    checked={r.correct}
                    disabled={!canEdit}
                    onChange={(e) => pick(r.key, e.currentTarget.checked)}
                  />
                  <span className="yz-sr">把第 {i + 1} 個選項設為標準答案</span>
                </label>
                <input
                  className="yz-in yz-qedit__label"
                  value={r.label}
                  disabled={!canEdit}
                  aria-label={`第 ${i + 1} 個選項的代號`}
                  onChange={(e) => setRow(r.key, { label: e.currentTarget.value })}
                />
                <input
                  className="yz-in"
                  value={r.content}
                  disabled={!canEdit}
                  aria-label={`第 ${i + 1} 個選項的內容`}
                  onChange={(e) => setRow(r.key, { content: e.currentTarget.value })}
                />
                {canEdit && !locked && (
                  <Button variant="quiet" onClick={() => removeRow(r.key)}>
                    刪除
                  </Button>
                )}
              </li>
            ))}
          </ol>

          {canEdit && !locked && (
            <Button onClick={addRow}>加一個選項</Button>
          )}
        </fieldset>
      )}

      {family === 'SLOT' && (
        <TextField
          label="標準答案（選填題的格位）"
          value={slots}
          disabled={!canEdit}
          onChange={(e) => setSlots(e.currentTarget.value)}
          hint="一格一個，用頓號或逗號分隔，例如「-、1、2」。整題全對才給分，答錯不倒扣。"
        />
      )}

      {family === 'TEXT' && (
        <TextField
          label="標準答案"
          value={answerText}
          disabled={!canEdit}
          onChange={(e) => setAnswerText(e.currentTarget.value)}
          hint="幾種寫法都算對時用 | 分隔，例如 1/2|0.5。申論與翻譯留空，由老師依評分標準給分。"
        />
      )}

      {/* ── 知識點 ───────────────────────────────────────────── */}
      <fieldset className="yz-qedit__kps">
        <legend className="yz-legend">
          知識點　<span className="yz-muted">能力分析靠它把這一題算進某個章節</span>
        </legend>
        {knowledgePoints.length === 0 ? (
          <p className="yz-hint">
            這一科還沒有知識點。<Link href="/knowledge">先去建幾個</Link>
            ——沒有知識點的題目不會出現在任何一張能力分析上。
          </p>
        ) : (
          <div className="yz-chips">
            {knowledgePoints.map((k) => (
              <CheckField
                key={k.id}
                label={k.name}
                checked={kps.includes(k.id)}
                disabled={!canEdit}
                onChange={(e) =>
                  setKps((now) =>
                    e.currentTarget.checked ? [...now, k.id] : now.filter((x) => x !== k.id),
                  )
                }
              />
            ))}
          </div>
        )}
      </fieldset>

      {/* ── 詳解 ─────────────────────────────────────────────── */}
      <fieldset className="yz-qedit__exp">
        <legend className="yz-legend">
          詳解　<span className="yz-muted">老師自己寫的那一份。學生交卷之後看得到</span>
        </legend>
        <TextField
          label="結論"
          value={conclusion}
          disabled={!canEdit}
          onChange={(e) => setConclusion(e.currentTarget.value)}
          hint="一句話講完答案。學生最先看的就是這一行。"
        />
        <TextAreaField
          label="步驟"
          rows={5}
          value={steps}
          disabled={!canEdit}
          onChange={(e) => setSteps(e.currentTarget.value)}
          hint="一行一步，會照順序編號。留白代表刪掉這一份詳解。"
        />
      </fieldset>

      {canEdit && (
        <div className="yz-actions">
          <span className="yz-actions__spacer" />
          <Button
            variant="primary"
            busy={busy}
            busyLabel="儲存中"
            onClick={() => {
              clearError();
              setSaved(null);
              if (needsConfirm) setConfirming(true);
              else void run(save);
            }}
          >
            儲存
          </Button>
        </div>
      )}

      {/* 改標準答案的確認。**這是這個畫面最重要的一段字**：老師以為
          改完就生效了，而實際上那幾份成績要各自重算。 */}
      <ConfirmDialog
        open={confirming}
        busy={busy}
        onClose={() => {
          if (busy) return;
          clearError();
          setConfirming(false);
        }}
        title="這一題已經考過了"
        confirmLabel="仍要改標準答案"
        consequence={
          <>
            <p style={{ marginBottom: 10 }}>
              這一題已經有 <strong>{impact.graded} 份作答計過分</strong>。
              改了標準答案之後，那些分數<strong>不會自動更新</strong>——
              要到下面這幾份任務按一次「全班重新計分」才會生效。
            </p>
            <ul style={{ margin: '0 0 10px 18px' }}>
              {impact.assignments.map((a) => (
                <li key={a.assignmentId}>
                  <Link href={`/grades/${a.assignmentId}`}>{a.title}</Link>
                  　<span className="yz-muted">{a.graded} 份要重算</span>
                </li>
              ))}
            </ul>
            <p style={{ marginBottom: 10 }}>
              學生當時選了什麼不會被動到——重算只改分數欄位。這次改動連同
              改前的內容會寫進稽核記錄。
            </p>
            {impact.inProgress > 0 && (
              <p className="yz-field__err">
                現在還有 {impact.inProgress} 份作答正在進行中。他們會立刻看到改過的題目。
              </p>
            )}
            {error && <p className="yz-field__err">{error}</p>}
          </>
        }
        onConfirm={() => void run(save)}
      />
    </section>
  );
}
