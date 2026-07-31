/**
 * 老師為班級設定 AI 使用層級。
 *
 * # 為什麼四個層級的說明要整段印出來，不是只印標題
 *
 * 因為老師要做的是一個**法規上的決定**（教育部 113 年 12 月 13 日函文
 * 要求教師事前明定），而他做這個決定的時候手上不會有函文。只印
 * 「第 3 級」四個字，他選的是一個他不知道內容的東西。
 *
 * 每一級底下的「為什麼」也印出來，因為排序的軸線不直觀：**它是
 * 「AI 介入的時點離產出有多近」**，所以選件討論（他還沒決定的當下）
 * 比撰寫回饋（他已經寫完了）更寬。不解釋的話，老師會以為排錯了。
 *
 * # 為什麼「還沒設定」要用紅字而不是留白
 *
 * 因為那一班的學生現在**用不了**任何一個 AI 功能，而他們看到的訊息是
 * 「請老師先設定」。老師這一頁若只是留白，他不會知道有人在等他。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { Note } from '@/components/Feedback';
import { submitJson, useAction } from '@/components/Form';

type Level = { level: number; label: string; summary: string; allows: string[]; why: string };
type ClassRow = {
  classId: string;
  className: string;
  level: number | null;
  note: string | null;
  setAt: string | null;
};

export default function PolicyEditor({
  classes,
  levels,
}: {
  classes: ClassRow[];
  levels: Level[];
}) {
  const router = useRouter();
  const { busy, error, run } = useAction();
  const [expanded, setExpanded] = useState(false);

  const set = (classId: string, level: number) =>
    run(async () => {
      await submitJson('/api/portfolio/policy', { json: { classId, level } });
      router.refresh();
    });

  const unset = classes.filter((c) => c.level === null).length;

  return (
    <section>
      <h2 className="yz-card__title" style={{ marginTop: 26 }}>
        AI 使用層級
      </h2>

      {error && <Note tone="error">{error}</Note>}

      {unset > 0 && (
        <Note tone="warn">
          還有 <strong>{unset}</strong> 個班級沒有設定。教育部函文要求教師
          <strong>事前明定</strong>使用層級，所以沒有設定的班級，學生的 AI 功能
          全部停用（制度檢查與揭露聲明除外，那兩項不呼叫模型）。
          那幾班的學生現在看到的是「請老師先設定」，而且
          <strong>他們在別的班也一起停用</strong>——沒有設定不等於沒有意見。
        </Note>
      )}

      <p className="yz-hint">
        超出層級的功能對該班學生<strong>停用</strong>，不是「可以用但要標註」——
        事前明定的意思就是有些事不准做。學生同時在多個班級時<strong>取最嚴的一級</strong>，
        而<strong>「還沒設定」比第 1 級更嚴</strong>：取最寬的話，他只要另外加入一個
        第 4 級的班，你的決定就整組失效，而你不會知道；把「還沒設定」當成「沒有意見」的話，
        失效的方式一模一樣，只是發生在你還沒動作的那一側。
      </p>

      <p className="yz-hint">
        這裡列的是<strong>你被指派授課的班級</strong>。別班的層級是那一班的老師事前明定的，
        改掉之後他不會知道自己的決定被換掉了——所以這一頁動不了別班的設定。
      </p>

      <button type="button" className="yz-linkish" onClick={() => setExpanded((v) => !v)}>
        {expanded ? '收起四個層級的說明' : '四個層級各自允許什麼'}
      </button>

      {expanded && (
        <ul className="yz-pf__levels">
          {levels.map((l) => (
            <li key={l.level} className="yz-pf__level">
              <strong>{l.label}</strong>
              <p className="yz-pf__levelsum">{l.summary}</p>
              <p className="yz-pf__levelwhy">{l.why}</p>
            </li>
          ))}
        </ul>
      )}

      {classes.length === 0 && (
        <Note tone="info">
          你目前沒有被指派授課的班級，所以這裡沒有可以設定的對象。
          AI 使用層級只有<strong>該班的授課老師</strong>改得動——教育部函文要求的是授課教師
          事前明定，而別班的老師改掉之後，原本那位老師不會知道自己的決定被換掉了。
          需要幫別班設定的話，找教務主任。
        </Note>
      )}

      <ul className="yz-pf__classes">
        {classes.map((c) => (
          <li key={c.classId} className="yz-pf__class">
            <span className="yz-pf__classname">{c.className}</span>
            <span className="yz-pf__classlevels">
              {levels.map((l) => (
                <button
                  key={l.level}
                  type="button"
                  disabled={busy}
                  title={l.summary}
                  className={`yz-chip${c.level === l.level ? ' yz-chip--on' : ''}`}
                  onClick={() => set(c.classId, l.level)}
                >
                  第 {l.level} 級
                </button>
              ))}
            </span>
            {c.level === null ? (
              <span className="yz-pf__unset">
                還沒設定：這一班的學生 AI 功能停用中，在他的其他班級也一起停用
              </span>
            ) : (
              <span className="yz-pf__meta">{c.setAt?.slice(0, 10)}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
