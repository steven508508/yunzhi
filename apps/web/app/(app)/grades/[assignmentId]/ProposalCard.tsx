/**
 * 一題非選題的 AI 建議 ＋ 老師的輸入框。
 *
 * # 輸入框永遠在，就算一則建議都沒有
 *
 * 這一塊在批次閱卷頁上是**整列唯一的給分入口**（答案卷那一頁旁邊還有
 * 一個 `ScoreOne`，批次頁沒有）。v0.26.0 以前輸入框整塊掛在
 * `proposal !== null` 底下，於是 AI 服務掛掉時三十列全部只剩一顆
 * 「請 AI 評這一份」——而畫面上的錯誤訊息寫著「可以直接用旁邊的輸入框
 * 給分」，那個輸入框在這一頁不存在。老師只能逐份點「看整份」開三十個
 * 分頁。同一條死路也發生在「這一題我不想花九十次模型呼叫，直接自己改」
 * 的正常情況——而那是一個完全合理的選擇。
 *
 * 沒有建議時給分走的是 `/api/attempts/[attemptId]/score`（`setManualScore`），
 * 與答案卷那一頁的 `ScoreOne` 同一支、同一筆稽核、同一個「重新計分不會
 * 蓋掉」的記號。**不是**去 `/api/proposals/decide` 生一筆空建議：
 * 那張表記的是「老師對 AI 的某一個建議做了什麼決定」，沒有建議的時候
 * 那一列是假的，而採用率與平均誤差都會被它汙染。
 *
 * 代價：答案卷那一頁旁邊本來就有一個 `ScoreOne`，所以那一頁會出現兩個
 * 作用相同的輸入框。那是可以接受的——**有建議的時候它本來就是兩個**
 * （那一頁刻意兩塊都畫），而反過來用一個旗標關掉這一塊的話，
 * 下一個忘記傳旗標的呼叫端就會回到「這一頁沒有給分的入口」。
 * 一個多出來的輸入框看得見，一個不存在的輸入框看不見。
 *
 * # 版面上最重要的一件事：輸入框是空的
 *
 * AI 的建議與輸入框並列，但**建議不會被填進去**。
 *
 * 這一條看起來只是介面細節，它其實是整個功能的成敗。預填的話，老師
 * 會直接按確認——三十份都按完，那三十個分數是誰給的？沒有人給的。
 * 而畫面上完全看不出差別：每一列都有分數，每一列都有一位老師的名字。
 *
 * 所以要他自己打，或者按一下「採用建議」。**「採用」是一個明確的動作**，
 * 它與「什麼都不做就送出」在稽核上是兩件事——後者根本不存在。
 *
 * # 為什麼「不採用」也要填理由
 *
 * 因為被否決的建議是唯一看得出「AI 的閱卷準不準」的資料，而「為什麼
 * 被否決」是唯一改得動提示詞的素材。資料庫的 CHECK 也擋著，這裡先擋
 * 一次，讓老師看到的是一句人話而不是約束名稱。
 *
 * # 為什麼理由裡不放 AI 的原文
 *
 * 送出時寫進 `AttemptAnswer.scoreNote` 的那一句由伺服器組（見
 * `teacherNote`），**不含 AI 的理由原文**——它可能引用規準的描述文字，
 * 而規準是 `internalOnly`，`scoreNote` 學生看得到。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { submitJson, useAction } from '@/components/Form';
import { Note } from '@/components/Feedback';
import type { ProposalView } from '@/lib/gradingProposalDb';

const STATE_LABEL: Record<string, string> = {
  PENDING: '等你決定',
  ACCEPTED: '照建議給分',
  ADJUSTED: '老師改了分數',
  REJECTED: '老師沒有採用',
  BLOCKED: '安全規則擋下',
};

/** 分數一律去掉沒有意義的小數。12.00 印成 12。 */
const fmt = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : String(Math.round(n * 100) / 100);

function when(iso: string | null): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/** 信心的文字說法。**只給區間，不給小數點後兩位** ——那是假的精確度。 */
function confidenceLabel(c: number | null): string {
  if (c === null) return '沒有回報信心';
  if (c >= 0.7) return '信心較高';
  if (c >= 0.45) return '信心中等';
  return '信心低';
}

export function ProposalCard({
  attemptId,
  questionId,
  max,
  current,
  manual,
  proposal,
  rubricDimensions,
  compact,
}: {
  attemptId: string;
  questionId: string;
  /** 這一題的配分（版面快照）。 */
  max: number;
  /** 現在的分數。**不會被拿來預填輸入框。** */
  current: number | null;
  manual: boolean;
  proposal: ProposalView | null;
  /** 規準的面向名稱，給「哪一個面向評不準」的勾選用。 */
  rubricDimensions: string[];
  /** 批次頁上一次畫三十張，所以說明文字收起來。 */
  compact?: boolean;
}) {
  const router = useRouter();
  // **一律是空字串。** 不是 `current`、更不是 `proposal.suggestedScore`。
  const [score, setScore] = useState('');
  const [note, setNote] = useState('');
  const [weak, setWeak] = useState<string[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  const suggested = proposal && proposal.state !== 'BLOCKED' ? proposal.suggestedScore : null;
  const decided =
    proposal !== null && proposal.state !== 'PENDING' && proposal.state !== 'BLOCKED';

  function decide(finalScore: number, dismissed: boolean) {
    setLocalError(null);
    // 與伺服器同一條規則（`checkDecision`）。先在這裡擋一次，是為了不要
    // 讓老師打完一段理由之後才被退回來。
    const changed = suggested === null || Math.abs(finalScore - suggested) > 0.01;
    if ((dismissed || changed) && note.trim() === '' && weak.length === 0) {
      setLocalError(
        dismissed
          ? '不採用要寫一句為什麼，或勾一個評不準的面向。那是唯一看得出 AI 哪裡不行的資料。'
          : '改了 AI 的分數要寫一句為什麼，或勾一個評不準的面向。',
      );
      return;
    }
    void run(async () => {
      setDone(null);
      await submitJson('/api/proposals/decide', {
        json: {
          attemptId,
          questionId,
          finalScore,
          dismissed,
          note: note.trim() || null,
          weakDimensions: weak,
        },
      });
      setDone(`已給 ${fmt(finalScore)} 分`);
      setScore('');
      router.refresh();
    });
  }

  /**
   * 沒有 AI 建議時的給分。走人工給分那一支，不碰建議那張表。
   *
   * 理由是不留下一筆假的「決定」：`AnswerGradeProposal` 的每一列都是
   * 「AI 提了什麼、老師怎麼決定」的證據，而這裡根本沒有人提過建議。
   * 混進去的話，「這個功能到底準不準」那一塊算出來的採用率會是假的。
   */
  function scoreDirect(finalScore: number) {
    setLocalError(null);
    void run(async () => {
      setDone(null);
      await submitJson(`/api/attempts/${attemptId}/score`, {
        json: { questionId, score: finalScore, note: note.trim() || null },
      });
      setDone(`已給 ${fmt(finalScore)} 分`);
      setScore('');
      router.refresh();
    });
  }

  function propose() {
    void run(async () => {
      setDone(null);
      const res = await submitJson<{ state?: string; blockedReason?: string | null }>(
        '/api/proposals',
        { json: { attemptId, questionId } },
      );
      setDone(res?.state === 'BLOCKED' ? 'AI 的建議被安全規則擋下了' : 'AI 給了建議');
      router.refresh();
    });
  }

  return (
    <div className={`yz-prop${proposal?.unstable ? ' yz-prop--unstable' : ''}`}>
      {proposal === null ? (
        <div className="yz-prop__ask">
          <span className="yz-prop__asktext">
            這一題還沒有 AI 建議，<b>可以直接在下面給分</b>。
            {!compact && '建議只是第一稿——分數還是你按下去才成立。'}
          </span>
          <Button variant="quiet" busy={busy} busyLabel="AI 正在讀" onClick={propose}>
            請 AI 評這一份
          </Button>
        </div>
      ) : (
        <>
          <div className="yz-prop__head">
            <span className="yz-prop__badge">AI 建議</span>
            {proposal.state === 'BLOCKED' ? (
              <span className="yz-warn yz-prop__score">沒有可用的建議</span>
            ) : (
              <span className="yz-prop__score">
                {fmt(proposal.suggestedScore)} / {fmt(max)} 分
              </span>
            )}
            <span className="yz-prop__conf">{confidenceLabel(proposal.confidence)}</span>
            <span className="yz-prop__state">{STATE_LABEL[proposal.state] ?? proposal.state}</span>
            {proposal.modelUsed && (
              <span className="yz-muted yz-prop__meta">
                {proposal.modelUsed}
                {proposal.promptVersion && `　提示詞 ${proposal.promptVersion}`}
              </span>
            )}
          </div>

          {proposal.unstable && (
            <p className="yz-prop__unstable">
              <strong>AI 判斷不穩，請人工細看。</strong>
              {proposal.stabilityNote}
            </p>
          )}

          {proposal.state === 'BLOCKED' ? (
            <div className="yz-prop__blocked">
              <p>
                AI 產生的評分沒有通過安全檢查，所以<strong>這一份沒有建議</strong>
                ——請直接給分。被擋下的原因留著，那是唯一看得出它哪裡不行的資料：
              </p>
              <p className="yz-prop__why">{proposal.blockedReason ?? '（沒有記錄理由）'}</p>
            </div>
          ) : (
            <>
              {proposal.dimensions.length > 0 ? (
                <ul className="yz-prop__dims">
                  {proposal.dimensions.map((d, i) => (
                    <li key={`${d.dimensionId}-${i}`} className="yz-prop__dim">
                      <span className="yz-prop__dimname">{d.name}</span>
                      <span className="yz-prop__dimscore">
                        {fmt(d.score)} / {fmt(d.max)}
                      </span>
                      <span className="yz-prop__dimwhy">{d.reason || '（沒有寫理由）'}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="yz-prop__norubric">
                  這一題<strong>沒有評分規準</strong>，所以沒有逐面向的分數，
                  而整體建議的可信度低得多。要讓 AI 幫得上忙，先在題庫那一題上建一份規準。
                </p>
              )}

              <p className="yz-prop__why">{proposal.rationale}</p>
            </>
          )}

          {decided ? (
            <p className="yz-prop__decided">
              {STATE_LABEL[proposal.state]}：<strong>{fmt(proposal.finalScore)} 分</strong>
              {proposal.decidedByName && `　${proposal.decidedByName}`}
              {proposal.decidedAt && `　${when(proposal.decidedAt)}`}
              {proposal.decisionNote && <span className="yz-prop__note">{proposal.decisionNote}</span>}
              {proposal.weakDimensions.length > 0 && (
                <span className="yz-prop__note">
                  評不準的面向：{proposal.weakDimensions.join('、')}
                </span>
              )}
            </p>
          ) : null}
        </>
      )}

      {/* 老師這一側。**沒有建議時照樣畫**（那時它是這一列唯一的給分
          入口，見檔頭），已決定的也留著——老師會改主意，而改主意要走
          同一條路（重新走一次 decide，狀態與誤差跟著更新）。 */}
      <div className="yz-prop__acts">
        <label className="yz-prop__lab" htmlFor={`prop-score-${questionId}-${attemptId}`}>
          你給幾分
        </label>
        <input
          id={`prop-score-${questionId}-${attemptId}`}
          className="yz-in yz-score__in"
          type="number"
          min={0}
          max={max}
          step="0.5"
          value={score}
          disabled={busy}
          placeholder="—"
          onChange={(e) => setScore(e.currentTarget.value)}
        />
        <span className="yz-score__max">／ {fmt(max)} 分</span>

        <input
          className="yz-in yz-prop__notein"
          type="text"
          value={note}
          disabled={busy}
          placeholder={
            proposal === null
              ? '為什麼是這個分數（家長問起時只剩這一句）'
              : suggested === null
                ? '為什麼是這個分數'
                : '改分或不採用時，寫一句為什麼'
          }
          onChange={(e) => setNote(e.currentTarget.value)}
        />

        <Button
          variant="quiet"
          busy={busy}
          busyLabel="存檔中"
          disabled={score.trim() === ''}
          // 沒有建議就沒有「決定」可記，走人工給分那一支。
          onClick={() =>
            proposal === null ? scoreDirect(Number(score)) : decide(Number(score), false)
          }
        >
          給分
        </Button>

        {suggested !== null && (
          <Button
            variant="quiet"
            disabled={busy}
            onClick={() => decide(suggested, false)}
            title="照 AI 的建議給分。這是一個明確的動作，會記在稽核裡。"
          >
            採用 {fmt(suggested)} 分
          </Button>
        )}

        {/* 「不採用」與「哪個面向評不準」都是**對一則建議**的回應，
            沒有建議時它們沒有指涉對象——畫出來只會讓老師以為自己
            漏看了什麼。 */}
        {proposal !== null && (
          <Button
            variant="quiet"
            disabled={busy || score.trim() === ''}
            onClick={() => decide(Number(score), true)}
            title="用你自己的分數，並記下「這個建議沒有參考價值」"
          >
            不採用
          </Button>
        )}

        {proposal !== null && rubricDimensions.length > 0 && (
          <div className="yz-prop__tags">
            <span className="yz-prop__lab">哪個面向評不準</span>
            {rubricDimensions.map((d) => (
              <label key={d} className="yz-prop__tag">
                <input
                  type="checkbox"
                  checked={weak.includes(d)}
                  disabled={busy}
                  onChange={(e) =>
                    setWeak((prev) =>
                      e.currentTarget.checked ? [...prev, d] : prev.filter((x) => x !== d),
                    )
                  }
                />
                {d}
              </label>
            ))}
          </div>
        )}
      </div>

      {current !== null && (
        <p className="yz-grade__sub">
          現在的分數：{fmt(current)} 分
          {manual && '（人給的，「全班重新計分」不會改掉它）'}
        </p>
      )}
      {done && <span className="yz-grade__sub">{done}</span>}
      {(localError || error) && (
        <Note tone="error">{localError ?? error}</Note>
      )}
    </div>
  );
}
