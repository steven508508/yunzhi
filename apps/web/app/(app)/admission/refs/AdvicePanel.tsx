'use client';

import { useState } from 'react';

import { Button } from '@/components/Button';
import { TextField } from '@/components/Field';
import { Form, submitJson } from '@/components/Form';
import { Note } from '@/components/Feedback';

/**
 * AI 老師那一段。
 *
 * # 這一段介面上最重要的一件事是「說出這是不是 AI 寫的」
 *
 * 閘門三次都擋下來時，系統會退回一段由程式組出來的、只陳述事實的版本
 * （`safeAdvice()`）。那一段讀起來很像 AI 寫的——它有條列、有數字、有
 * 說明。若畫面上不標出來，學生會把它當成 AI 的判斷。
 *
 * 所以 `fellBack` 為真時，這一段的標頭寫的是「系統整理」而不是
 * 「AI 老師」，而且說得出為什麼（模型剛剛想給機率）。
 *
 * # 為什麼要把「擋掉了幾次」給學生看
 *
 * 因為那是這個功能有沒有在做事的唯一證據，而且它是一句對學生有用的話：
 * 「AI 剛剛三次都想給你一個錄取機率，都被擋掉了——那個數字算不出來。」
 * 這比一段沉默的罐頭有教育意義得多。
 *
 * # 為什麼沒有做串流
 *
 * 與智慧老師同一個理由：**閘門要看完整段才判得出假精確度。** 邊生成邊
 * 顯示，等於把一個編出來的百分比先放到學生螢幕上，判定完再收回來——
 * 而他已經看到了。一段建議要到最後一句才知道它有沒有給出結論。
 *
 * # 揭露聲明擺在這裡，不是收在設定裡
 *
 * 規格書 §2.3 與教育部 113 年 12 月 13 日函文要求學生在學習歷程中標註
 * AI 使用。聲明放在**互動發生的地方**，學生才會知道有這件事；收在別的
 * 頁面的話，他要在寫學習歷程的那一天自己想起來去找它。
 */

type Gap = { code: string; text: string; url: string | null };

type Disclosure = {
  count: number;
  first: string | null;
  last: string | null;
  statement: string;
};

type AdviceResult = {
  text: string;
  fellBack: boolean;
  blockedDrafts: number;
  blockedReasons: string[];
};

export default function AdvicePanel({
  year,
  gaps,
  disclosure,
}: {
  year: number;
  gaps: Gap[];
  disclosure: Disclosure;
}) {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<AdviceResult | null>(null);
  const [showDisclosure, setShowDisclosure] = useState(false);

  return (
    <>
      <p className="yz-hint">
        AI 老師看的是<strong>你輸入的那幾筆資料</strong>、你的志願、你的管道資格、
        以及你在繁星的校內序位。它<strong>不會給你錄取機率、不會說「穩」或「有把握」</strong>
        ——那不是還沒做，是<strong>算不出來</strong>：官方公布的只有各校系第一輪
        最後一名錄取者的在校百分比，而第一輪名額常常只有 1 至 3 名，
        也就是每年只有一個極值資料點。任何一個機率都是編的。
      </p>

      {/* 資料缺什麼。**這一段在按下按鈕之前就要看得見**——他可能根本
          還不需要 AI，他需要的是先去查兩年的資料。 */}
      {gaps.length > 0 && (
        <div className="yz-ref__gaps">
          <h3 className="yz-adm__grouphead">先補這幾項會比問 AI 有用</h3>
          <ul>
            {gaps.map((g) => (
              <li key={g.code}>
                {g.text}
                {g.url && (
                  <>
                    {' '}
                    <a href={g.url} target="_blank" rel="noreferrer noopener">
                      去這裡查 ↗
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="yz-card" style={{ marginTop: 14 }}>
        <Form
          onSubmit={async () => {
            const r = (await submitJson('/api/admission/advice', {
              json: { year, question: question || undefined },
            })) as AdviceResult;
            setResult(r);
          }}
        >
          {({ busy }) => (
            <>
              <TextField
                label="想問什麼（可以空著）"
                value={question}
                onChange={(e) => setQuestion(e.currentTarget.value)}
                hint="空著的話，AI 就看你輸入的資料本身。問「我到底上不上得了」它不會回答那個問題——它會告訴你你手上的資料能說到什麼程度。"
              />
              <div className="yz-actions">
                <span className="yz-actions__spacer" />
                <Button type="submit" variant="primary" busy={busy} busyLabel="看資料中…">
                  請 AI 老師看一次
                </Button>
              </div>
            </>
          )}
        </Form>
      </div>

      {result && (
        <div className={`yz-ref__advice ${result.fellBack ? 'yz-ref__advice--fallback' : ''}`}>
          <h3 className="yz-ref__advicehead">
            {result.fellBack ? '系統整理（不是 AI 寫的）' : 'AI 老師'}
          </h3>

          {result.fellBack && (
            <Note tone="warn">
              下面這一段是<strong>系統把你查到的資料整理出來的</strong>，不是 AI 寫的。
              AI 生成了 {result.blockedDrafts} 次，每一次都因為給出機率、斷定語氣、
              或用了一個對不回你資料的數字而被擋下來。
              <strong>那個數字算不出來</strong>，所以這裡給你事實而不是結論。
            </Note>
          )}

          {!result.fellBack && result.blockedDrafts > 0 && (
            <Note tone="info">
              AI 前 {result.blockedDrafts} 次的回答被擋下來了（它想給你一個機率或一句
              「應該沒問題」），這一段是重新生成的。你看到的是通過檢查的那一版。
            </Note>
          )}

          <div className="yz-ref__advicebody">
            {result.text.split('\n').map((line, i) => (
              <p key={i}>{line}</p>
            ))}
          </div>

          {result.blockedReasons.length > 0 && (
            <details className="yz-ref__blocked">
              <summary>被擋下來的理由（{result.blockedReasons.length} 次）</summary>
              <ul>
                {result.blockedReasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
              <p className="yz-hint">
                這裡只列規則與理由，<strong>不會給你被擋掉的那一段文字</strong>——
                它正是因為製造了假的精確度才被擋的。
              </p>
            </details>
          )}
        </div>
      )}

      {/* ── AI 使用揭露 ──────────────────────────────────── */}
      <div className="yz-ref__disclose">
        <h3 className="yz-adm__grouphead">AI 使用揭露</h3>
        <p className="yz-hint">
          教育部 113 年 12 月 13 日的函文要求學生在學習歷程檔案中
          <strong>標註 AI 使用與來源</strong>。系統把你每一次請 AI 老師看資料都記下來
          （目前 {disclosure.count} 次
          {disclosure.count > 0 && disclosure.first ? `，${disclosure.first} 至 ${disclosure.last}` : ''}
          ），下面這一段是依實際紀錄產生的聲明草稿，可以直接貼進學習歷程。
          <strong>你可以改它</strong>——那是你要負責的文件；系統這一側的原始紀錄會留著。
        </p>
        {showDisclosure ? (
          <blockquote className="yz-ref__statement">{disclosure.statement}</blockquote>
        ) : (
          <Button variant="quiet" onClick={() => setShowDisclosure(true)}>
            看聲明草稿
          </Button>
        )}
        {showDisclosure && result && (
          <p className="yz-hint">
            這段草稿是頁面載入時算的。剛剛那一次還沒算進去——重新整理之後就會。
          </p>
        )}
      </div>
    </>
  );
}
