/**
 * 一題非選題的評分規準編輯器。
 *
 * # 為什麼規準掛在題目上而不是掛在卷子上
 *
 * 因為評分標準是題目的一部分。同一題出現在三份卷子上時，那三次的
 * 評分標準應該一樣——掛在卷子上的話，老師得建三次，而三份裡總有一份
 * 是舊的。`Rubric.questionId` 從第一版就是這個形狀。
 *
 * # 為什麼有範本，以及為什麼範本的文字是自己寫的
 *
 * 學測國文寫作的等第結構（知性題／情意題、A+ 到 0、各 25 分）是公開的
 * 制度事實，照著建不會有問題。但**每一級的描述文字受著作權保護**
 * （文件 16 §3），所以範本裡那幾段是照結構自己寫的白話版——它的用途
 * 是讓老師不必從零建，然後照他手上那一份改。
 *
 * # 為什麼「內部使用」預設是勾起來的，而且旁邊要寫後果
 *
 * `Rubric.internalOnly` 預設為真。取消它是一個有法律後果的動作
 * （評分原則的授權範圍是機構內部閱卷，不含散布），所以那一格旁邊
 * 直接寫出來，而不是收在說明文件裡。
 *
 * # 為什麼每一格都可以先存起來再慢慢改
 *
 * 因為建一份 25 分七個等第的規準要打七段描述，而老師是在下課的十分鐘
 * 裡做這件事。存檔的驗證只擋「會讓 AI 每一份建議都被判成加總不對」的
 * 那幾種錯（面向加起來不等於總分、分數帶重疊、最高等第接不到滿分），
 * 不擋「描述還沒寫完」——那一種存起來也不會壞掉任何東西。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { Note } from '@/components/Feedback';
import { submitJson, useAction } from '@/components/Form';
import { MODE_LABELS, RUBRIC_MODES, checkRubricDraft } from '@/lib/gradingProposal.mjs';

type DimRow = { name: string; nameEn: string; maxScore: string; descriptor: string };
type BandRow = { grade: string; scoreMin: string; scoreMax: string; descriptor: string };

export type RubricEditorProps = {
  questionId: string;
  /** 這一題在題庫裡的配分。規準總分與它不同時要提醒。 */
  questionScore: number;
  existing: {
    name: string;
    totalScore: number;
    mode: string;
    sourceRef: string | null;
    internalOnly: boolean;
    dimensions: { name: string; nameEn: string | null; maxScore: number; descriptor: string | null }[];
    bands: { grade: string; scoreMin: number; scoreMax: number; descriptor: string }[];
  } | null;
  templates: {
    key: string;
    label: string;
    hint: string;
    draft: {
      name: string;
      totalScore: number;
      mode: string;
      dimensions: { name: string; nameEn?: string | null; maxScore: number; descriptor?: string | null }[];
      bands: { grade: string; scoreMin: number; scoreMax: number; descriptor: string }[];
    };
  }[];
};

const s = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));

export function RubricEditor({ questionId, questionScore, existing, templates }: RubricEditorProps) {
  const router = useRouter();
  const [name, setName] = useState(existing?.name ?? '');
  const [total, setTotal] = useState(s(existing?.totalScore ?? questionScore));
  const [mode, setMode] = useState(existing?.mode ?? 'BAND');
  const [sourceRef, setSourceRef] = useState(existing?.sourceRef ?? '');
  const [internalOnly, setInternalOnly] = useState(existing?.internalOnly ?? true);
  const [dims, setDims] = useState<DimRow[]>(
    (existing?.dimensions ?? []).map((d) => ({
      name: d.name,
      nameEn: d.nameEn ?? '',
      maxScore: s(d.maxScore),
      descriptor: d.descriptor ?? '',
    })),
  );
  const [bands, setBands] = useState<BandRow[]>(
    (existing?.bands ?? []).map((b) => ({
      grade: b.grade,
      scoreMin: s(b.scoreMin),
      scoreMax: s(b.scoreMax),
      descriptor: b.descriptor,
    })),
  );
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  const draft = {
    name,
    totalScore: Number(total),
    mode,
    sourceRef: sourceRef || null,
    internalOnly,
    dimensions: dims.map((d, i) => ({
      name: d.name,
      nameEn: d.nameEn || null,
      maxScore: Number(d.maxScore),
      descriptor: d.descriptor || null,
      order: i,
    })),
    bands: bands.map((b, i) => ({
      grade: b.grade,
      scoreMin: Number(b.scoreMin),
      scoreMax: Number(b.scoreMax),
      descriptor: b.descriptor,
      order: i,
    })),
  };

  // **與伺服器同一支驗證**（`checkRubricDraft`，純函式、有單元測試）。
  // 在這裡先跑一次，是為了讓老師在打字的時候就看到「加起來差 3 分」，
  // 而不是打完七段描述之後按存檔才被退回來。
  const check = checkRubricDraft(draft);

  function save() {
    void run(async () => {
      setDone(null);
      await submitJson(`/api/rubrics/${questionId}`, { method: 'PUT', json: draft });
      setDone('規準存好了');
      router.refresh();
    });
  }

  function remove() {
    void run(async () => {
      setDone(null);
      await submitJson(`/api/rubrics/${questionId}`, { method: 'DELETE' });
      setDone('規準刪掉了（已經產生的 AI 建議還在，採用率才算得出來）');
      router.refresh();
    });
  }

  function applyTemplate(key: string) {
    const t = templates.find((x) => x.key === key);
    if (!t) return;
    setName(t.draft.name);
    setTotal(String(t.draft.totalScore));
    setMode(t.draft.mode);
    setInternalOnly(true);
    setDims(
      t.draft.dimensions.map((d) => ({
        name: d.name,
        nameEn: d.nameEn ?? '',
        maxScore: String(d.maxScore),
        descriptor: d.descriptor ?? '',
      })),
    );
    setBands(
      t.draft.bands.map((b) => ({
        grade: b.grade,
        scoreMin: String(b.scoreMin),
        scoreMax: String(b.scoreMax),
        descriptor: b.descriptor,
      })),
    );
    setDone(`套用了「${t.label}」。${t.hint}`);
  }

  return (
    <section className="yz-rubric">
      <h2 className="yz-grade-h">評分規準</h2>
      <p className="yz-grade-hint">
        非選題有規準時，AI 的評分建議才給得出逐面向的分數；沒有規準也評得出來，
        但<strong>可信度低得多</strong>。分數永遠是老師按下去才成立——
        規準只是讓建議與老師講同一套標準。
      </p>

      <div className="yz-rubric__templates">
        <span className="yz-prop__lab">從範本開始</span>
        {templates.map((t) => (
          <Button key={t.key} variant="quiet" disabled={busy} onClick={() => applyTemplate(t.key)}>
            {t.label}
          </Button>
        ))}
      </div>
      <p className="yz-grade-hint">
        範本的<strong>結構</strong>照公開的制度（等第與配分），
        <strong>描述文字是系統自己寫的白話版</strong>——出版社與大考中心的評分原則文字受著作權
        保護，不會內建在系統裡。套用之後請照你手上那一份改。
      </p>

      <div className="yz-rubric__head">
        <label className="yz-prop__lab" htmlFor="rubric-name">
          名稱
        </label>
        <input
          id="rubric-name"
          className="yz-in"
          value={name}
          disabled={busy}
          placeholder="115 國寫知性題評分原則"
          onChange={(e) => setName(e.currentTarget.value)}
        />

        <label className="yz-prop__lab" htmlFor="rubric-total">
          總分
        </label>
        <input
          id="rubric-total"
          className="yz-in yz-score__in"
          type="number"
          min={0}
          step="0.5"
          value={total}
          disabled={busy}
          onChange={(e) => setTotal(e.currentTarget.value)}
        />

        <label className="yz-prop__lab" htmlFor="rubric-mode">
          模式
        </label>
        <select
          id="rubric-mode"
          className="yz-in"
          value={mode}
          disabled={busy}
          onChange={(e) => setMode(e.currentTarget.value)}
        >
          {(RUBRIC_MODES as string[]).map((m) => (
            <option key={m} value={m}>
              {(MODE_LABELS as Record<string, string>)[m] ?? m}
            </option>
          ))}
        </select>

        <label className="yz-prop__lab" htmlFor="rubric-src">
          來源
        </label>
        <input
          id="rubric-src"
          className="yz-in"
          value={sourceRef}
          disabled={busy}
          placeholder="大考中心 115 學年度非選擇題評分原則（自己抄哪一份要記下來）"
          onChange={(e) => setSourceRef(e.currentTarget.value)}
        />
      </div>

      {Number(total) !== questionScore && (
        <Note tone="warn">
          規準總分是 {total} 分，而這一題在題庫裡的配分是 {questionScore} 分。
          兩者不同時，AI 的建議會照卷面配分被判成「超過配分」而全部擋下來——
          除非這一題在卷子上的配分真的與題庫不同（那是允許的）。
        </Note>
      )}

      {/* ── 面向 ─────────────────────────────────────── */}
      <h3 className="yz-tutor__h3">面向（英文作文這一類；國寫可以留空）</h3>
      <ul className="yz-rubric__rows">
        {dims.map((d, i) => (
          <li key={i} className="yz-rubric__row">
            <input
              className="yz-in yz-rubric__name"
              value={d.name}
              disabled={busy}
              placeholder="內容"
              aria-label={`第 ${i + 1} 個面向的名稱`}
              onChange={(e) => setDims(patch(dims, i, { name: e.currentTarget.value }))}
            />
            <input
              className="yz-in yz-score__in"
              type="number"
              min={0}
              step="0.5"
              value={d.maxScore}
              disabled={busy}
              aria-label={`第 ${i + 1} 個面向的滿分`}
              onChange={(e) => setDims(patch(dims, i, { maxScore: e.currentTarget.value }))}
            />
            <textarea
              className="yz-in yz-rubric__desc"
              rows={2}
              value={d.descriptor}
              disabled={busy}
              placeholder="這個面向在看什麼（用你自己的話寫）"
              aria-label={`第 ${i + 1} 個面向的說明`}
              onChange={(e) => setDims(patch(dims, i, { descriptor: e.currentTarget.value }))}
            />
            <Button variant="quiet" disabled={busy} onClick={() => setDims(drop(dims, i))}>
              移除
            </Button>
          </li>
        ))}
      </ul>
      <Button
        variant="quiet"
        disabled={busy}
        onClick={() => setDims([...dims, { name: '', nameEn: '', maxScore: '', descriptor: '' }])}
      >
        加一個面向
      </Button>

      {/* ── 等第 ─────────────────────────────────────── */}
      <h3 className="yz-tutor__h3">等第（國寫這一類；分數帶要連續、最低那一級從 0 起算）</h3>
      <ul className="yz-rubric__rows">
        {bands.map((b, i) => (
          <li key={i} className="yz-rubric__row">
            <input
              className="yz-in yz-rubric__grade"
              value={b.grade}
              disabled={busy}
              placeholder="A+"
              aria-label={`第 ${i + 1} 級的代號`}
              onChange={(e) => setBands(patch(bands, i, { grade: e.currentTarget.value }))}
            />
            <input
              className="yz-in yz-score__in"
              type="number"
              step="0.5"
              value={b.scoreMin}
              disabled={busy}
              aria-label={`第 ${i + 1} 級的下限`}
              onChange={(e) => setBands(patch(bands, i, { scoreMin: e.currentTarget.value }))}
            />
            <input
              className="yz-in yz-score__in"
              type="number"
              step="0.5"
              value={b.scoreMax}
              disabled={busy}
              aria-label={`第 ${i + 1} 級的上限`}
              onChange={(e) => setBands(patch(bands, i, { scoreMax: e.currentTarget.value }))}
            />
            <textarea
              className="yz-in yz-rubric__desc"
              rows={2}
              value={b.descriptor}
              disabled={busy}
              placeholder="這一級的作答長什麼樣子（用你自己的話寫）"
              aria-label={`第 ${i + 1} 級的描述`}
              onChange={(e) => setBands(patch(bands, i, { descriptor: e.currentTarget.value }))}
            />
            <Button variant="quiet" disabled={busy} onClick={() => setBands(drop(bands, i))}>
              移除
            </Button>
          </li>
        ))}
      </ul>
      <Button
        variant="quiet"
        disabled={busy}
        onClick={() =>
          setBands([...bands, { grade: '', scoreMin: '', scoreMax: '', descriptor: '' }])
        }
      >
        加一級
      </Button>

      {/* ── 授權 ─────────────────────────────────────── */}
      <div className="yz-rubric__license">
        <label className="yz-check">
          <input
            type="checkbox"
            checked={internalOnly}
            disabled={busy}
            onChange={(e) => setInternalOnly(e.currentTarget.checked)}
          />
          <span>
            內部使用（預設勾起來）
            <span className="yz-field__hint">
              評分原則的描述文字受著作權保護，授權範圍是<strong>機構內部閱卷</strong>。
              勾起來時：學生看不到規準內容、不會被匯出、也不會印在給學生的東西上；
              AI 的評分理由若照抄了規準原文也會被擋下來。
              <strong>取消它是一個有法律後果的動作</strong>——只有在這份規準是你自己寫的
              （不是抄出版社或大考中心的）時候才取消。
            </span>
          </span>
        </label>
      </div>

      {!check.ok && (
        <Note tone="warn">
          <strong>還不能存：</strong>
          <br />
          {check.errors.map((e: string) => (
            <span key={e}>
              · {e}
              <br />
            </span>
          ))}
        </Note>
      )}

      <div className="yz-grade-act">
        <Button variant="primary" busy={busy} busyLabel="存檔中" disabled={!check.ok} onClick={save}>
          {existing ? '更新規準' : '建立規準'}
        </Button>
        {existing && (
          <Button variant="danger" disabled={busy} onClick={remove}>
            刪掉規準
          </Button>
        )}
        {done && <span className="yz-grade__sub">{done}</span>}
      </div>
      {error && <Note tone="error">{error}</Note>}
    </section>
  );
}

function patch<T>(rows: T[], i: number, over: Partial<T>): T[] {
  return rows.map((r, j) => (j === i ? { ...r, ...over } : r));
}

function drop<T>(rows: T[], i: number): T[] {
  return rows.filter((_, j) => j !== i);
}
