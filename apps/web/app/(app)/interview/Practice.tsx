/**
 * 挑一題、打回答、看結構回饋。
 *
 * # 為什麼「題目想聽到的幾件事」要標成「系統判斷不了」
 *
 * 因為它真的判斷不了。第一版用字面比對去判「說出卡住的具體那一步」
 * 有沒有被講到，結果每一個好回答都被判成四項全缺——而學生會學到
 * 「這個檢查是壞的」然後忽略整頁，連那些真的判得出來的項目一起忽略。
 *
 * 所以它改成一份**要他自己對**的清單，並且明說系統沒有判它。
 * 這與整個模組的立場一致：資料不足時要承認，不要補值。
 *
 * # 為什麼沒有「範例答案」
 *
 * 同一個理由的另一面。給了範例，他會背起來——而背起來的答案在現場
 * 聽得出來，那正是最常見的失分。這一頁能給的最有用的東西是**問題**，
 * 不是答案。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { Note } from '@/components/Feedback';
import { TextAreaField, TextField } from '@/components/Field';
import { submitJson, useAction } from '@/components/Form';

type Question = { id: string; fieldTag: string; question: string; focusPoints: string[] };

type Feedback = {
  addressed: { ok: boolean; selfCheck: string[]; forms: { want: string; ok: boolean }[]; note: string };
  examples: { ok: boolean; found: string[]; note: string };
  contradictions: { ok: boolean; hits: string[]; note: string };
  length: { chars: number; note: string };
  questions: string[];
};

type Consistency = { ok: boolean; unmatched: string[]; note: string };

type PracticeRow = {
  id: string;
  question: string;
  answerText: string;
  programRef: string | null;
  feedback: unknown;
  consistency: unknown;
  createdAt: string;
};

export default function Practice({
  questions,
  practices,
}: {
  questions: Question[];
  practices: PracticeRow[];
}) {
  const router = useRouter();
  const { busy, error, run } = useAction();
  const [picked, setPicked] = useState<Question | null>(null);
  const [answer, setAnswer] = useState('');
  const [programRef, setProgramRef] = useState('');
  const [result, setResult] = useState<{ feedback: Feedback; consistency: Consistency } | null>(
    null,
  );

  const go = () =>
    run(async () => {
      if (!picked) return;
      const out = await submitJson<{ feedback: Feedback; consistency: Consistency }>(
        '/api/interview/practice',
        { json: { questionId: picked.id, answerText: answer, programRef: programRef || null } },
      );
      setResult(out);
      router.refresh();
    });

  const drop = (id: string) =>
    run(async () => {
      await submitJson(`/api/interview/practice?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      router.refresh();
    });

  // 同一題為每一個系各練一次，三份答案應該長得完全不一樣。平鋪成一條
  // 時間軸的話，面試前一晚要看的「台大那一版」在裡面找不到。
  const groups = [...new Set(practices.map((p) => p.programRef ?? ''))].sort();

  return (
    <>
      <section>
        <h2 className="yz-card__title" style={{ marginTop: 22 }}>
          題庫（{questions.length}）
        </h2>
        <ul className="yz-iv__questions">
          {questions.map((q) => (
            <li key={q.id} className="yz-iv__question">
              <button
                type="button"
                className={`yz-iv__pick${picked?.id === q.id ? ' yz-iv__pick--on' : ''}`}
                onClick={() => {
                  setPicked(q);
                  setAnswer('');
                  setResult(null);
                }}
              >
                {q.question}
              </button>
            </li>
          ))}
        </ul>
      </section>

      {picked && (
        <section>
          <h2 className="yz-card__title" style={{ marginTop: 26 }}>
            練習
          </h2>
          <p className="yz-iv__now">{picked.question}</p>
          {picked.focusPoints.length > 0 && (
            <p className="yz-hint">
              這一題想聽到的是：{picked.focusPoints.join('、')}。
              <strong>這幾項系統判斷不了</strong>——它們是內容不是形式，答完自己對一次。
            </p>
          )}

          <TextField
            label="這一次是為哪一個校系練的（選填）"
            hint="同一題你會為每一個系各練一次，而三份答案應該長得完全不一樣。標了才找得回「台大那一版」。"
            value={programRef}
            onChange={(e) => setProgramRef(e.target.value)}
          />

          <TextAreaField
            label="你的回答"
            hint="用講的那樣打。面試單題通常一到兩分鐘，大約 150 到 400 字。"
            rows={10}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
          <div className="yz-actions">
            <Button variant="primary" busy={busy} disabled={!answer.trim()} onClick={go}>
              看結構回饋
            </Button>
          </div>
        </section>
      )}

      {error && <Note tone="error">{error}</Note>}

      {result && (
        <section>
          <h2 className="yz-card__title" style={{ marginTop: 26 }}>
            結構回饋
          </h2>

          <ul className="yz-iv__checks">
            <li className={`yz-iv__check${result.feedback.addressed.ok ? '' : ' yz-iv__check--bad'}`}>
              <span className="yz-iv__checkname">有沒有回答到問題</span>
              <span className="yz-iv__checknote">{result.feedback.addressed.note}</span>
            </li>
            <li className={`yz-iv__check${result.feedback.examples.ok ? '' : ' yz-iv__check--bad'}`}>
              <span className="yz-iv__checkname">有沒有具體例子</span>
              <span className="yz-iv__checknote">{result.feedback.examples.note}</span>
            </li>
            <li
              className={`yz-iv__check${result.feedback.contradictions.ok ? '' : ' yz-iv__check--bad'}`}
            >
              <span className="yz-iv__checkname">有沒有前後矛盾</span>
              <span className="yz-iv__checknote">{result.feedback.contradictions.note}</span>
            </li>
            <li className="yz-iv__check">
              <span className="yz-iv__checkname">長度</span>
              <span className="yz-iv__checknote">{result.feedback.length.note}</span>
            </li>
          </ul>

          {result.feedback.questions.length > 0 && (
            <>
              <h3 className="yz-card__title" style={{ marginTop: 18 }}>
                再想一下這幾個
              </h3>
              <ul className="yz-iv__asks">
                {result.feedback.questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </>
          )}

          <h3 className="yz-card__title" style={{ marginTop: 18 }}>
            與你的學習歷程對得起來嗎
          </h3>
          <Note tone={result.consistency.ok ? 'info' : 'warn'}>{result.consistency.note}</Note>
          <p className="yz-hint">
            面試最常見的失分是「檔案裡寫的跟口頭講的對不起來」——委員手上就拿著那份檔案，
            而你通常不記得三個月前寫了什麼。這裡只查一個方向（你講了檔案裡沒有的東西）；
            反過來不查，因為檔案裡有而你沒提是取捨，不是矛盾。
          </p>
        </section>
      )}

      {practices.length > 0 && (
        <section>
          <h2 className="yz-card__title" style={{ marginTop: 26 }}>
            練過的（{practices.length}）
          </h2>
          <p className="yz-hint">
            只有你自己看得到。老師沒有任何一條路徑看得到這些。
            <strong>不想留的那一次可以刪掉</strong>——練習框裡本來就會出現講砸的版本。
          </p>
          {groups.map((g) => (
            <section key={g || '（未標校系）'}>
              <h3 className="yz-card__title" style={{ marginTop: 14 }}>
                {g || '沒有標校系'}
              </h3>
              <ul className="yz-iv__history">
                {practices
                  .filter((p) => (p.programRef ?? '') === g)
                  .map((p) => (
                    <li key={p.id} className="yz-iv__past">
                      <span className="yz-pf__meta">{p.createdAt.slice(0, 10)}</span>
                      <span className="yz-iv__pastq">{p.question}</span>
                      <span className="yz-iv__pasta">{p.answerText.slice(0, 80)}…</span>
                      <Button variant="quiet" disabled={busy} onClick={() => drop(p.id)}>
                        刪掉
                      </Button>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </section>
      )}
    </>
  );
}
