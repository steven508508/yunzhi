import Link from 'next/link';
import type { ReactNode } from 'react';

import { Empty } from '@/components/Feedback';
import { listStudentTasks } from '@/lib/attempt';
import { mayUse, ROLE_LABELS } from '@/lib/nav';
import { scopedPage } from '@/lib/page';
import { prisma } from '@/lib/prisma';
import { gradeScopeWhere } from '@/lib/scoring';

export const dynamic = 'force-dynamic';

/**
 * 首頁。
 *
 * 在此之前這一頁是 `redirect('/import')`——不管你是誰，一登入就被丟到
 * 匯入畫面。對管理員來說那是最不重要的一頁，對學生來說那是一個
 * 他不該看到、也看不懂的地方。
 *
 * 這一頁只回答一個問題：**現在該做什麼。** 所以它列的是「還沒做完的
 * 事」，不是儀表板上那種好看的統計。題庫有幾題是背景資訊，
 * 「有三份題本卡在待校對」才是今天要處理的。
 *
 * 排序是刻意的：擋住後面所有事的排最前面（沒有學年度 → 開不了班 →
 * 沒有名冊 → 派不了任務）。
 */
export default async function HomePage() {
  return scopedPage(async (user) => {
    const staff = mayUse(user.systemRole, '/bank');
    const admin = mayUse(user.systemRole, '/settings/years');

    if (user.systemRole === 'GUARDIAN') {
      // 家長端**確實還沒做**。誠實地說，不要給一個空畫面——
      // 空畫面會被讀成「壞了」或「我的資料不見了」，然後變成一通電話。
      return (
        <main className="yz-panel">
          <div className="yz-panel__head">
            <h1>{user.displayName}</h1>
            <p className="yz-panel__sub">{ROLE_LABELS[user.systemRole] ?? user.systemRole}</p>
          </div>
          <Empty
            title="家長端還在開發中"
            hint={
              <>
                你的帳號已經開好了，登入也正常。查看孩子的作業進度與成績
                這些功能還沒有上線，所以現在這裡沒有東西可以做。
                <br />
                需要了解孩子的狀況時請直接找班級老師。
              </>
            }
          />
        </main>
      );
    }

    if (!staff) {
      // 學生。這一頁與老師版問的是同一個問題——現在該做什麼——
      // 只是他的答案是「哪一份要寫」。
      //
      // 這裡刻意不重畫一次 `/take` 的完整清單：首頁只回答「有沒有事」
      // 與「最急的是哪一份」，細節在那一頁。兩個畫面列同一份資料時，
      // 學生會不確定哪一個是準的。
      const tasks = await listStudentTasks(user.id);
      const running = tasks.filter((t) => t.state === 'IN_PROGRESS');
      const open = tasks.filter((t) => t.state === 'OPEN');
      const missed = tasks.filter((t) => t.state === 'MISSED');
      const upcoming = tasks.filter((t) => t.state === 'UPCOMING');

      const todo: TodoItem[] = [];
      if (running.length > 0) {
        // 寫到一半的排最前面而且是唯一的硃砂色：有時限的那幾份正在
        // 倒數，而學生看不到伺服器的時鐘。
        todo.push({
          n: running.length,
          what: '份寫到一半',
          why:
            `${running[0].title}${running.length > 1 ? ' 等' : ''}還沒交。` +
            '有時限的會繼續倒數，時間到了系統會自動收卷。',
          href: running[0].openAttemptId
            ? `/take/${running[0].assignmentId}`
            : '/take',
          label: '繼續作答',
          act: true,
        });
      }
      if (open.length > 0) {
        todo.push({
          n: open.length,
          what: '份可以開始寫',
          why: '按下開始之後才會計時。有時限的作業建議確定有時間再開。',
          href: '/take',
          label: '去看看',
          act: true,
        });
      }
      if (missed.length > 0) {
        todo.push({
          n: missed.length,
          what: '份已經過了截止時間',
          why: '這幾份不能再作答了。想補交或有特殊狀況，直接找班級老師處理。',
          href: '/take',
          label: '看是哪幾份',
          act: false,
        });
      }

      return (
        <main className="yz-panel">
          <div className="yz-panel__head">
            <h1>現在該做什麼</h1>
            <p className="yz-panel__sub">
              {user.displayName}　·　{ROLE_LABELS[user.systemRole] ?? user.systemRole}
            </p>
          </div>

          {todo.length > 0 ? (
            <ul className="yz-todo">
              {todo.map((item) => (
                <li
                  key={item.what}
                  className={`yz-todo__item${item.act ? ' yz-todo__item--act' : ''}`}
                >
                  <span className="yz-todo__n">{item.n || '—'}</span>
                  <span>
                    <span className="yz-todo__what">{item.what}</span>
                    <span className="yz-todo__why">{item.why}</span>
                  </span>
                  <Link href={item.href}>{item.label}</Link>
                </li>
              ))}
            </ul>
          ) : (
            <Empty
              title={tasks.length === 0 ? '現在沒有任務' : '沒有待完成的作業'}
              hint={
                tasks.length === 0
                  ? '老師派新的作業或考試時會出現在這裡。如果你知道有一份但這裡沒有，請告訴班級老師。'
                  : '交出去的都收到了。之後派新的會出現在這裡。'
              }
            />
          )}

          <h2 className="yz-card__title" style={{ marginTop: 30, marginBottom: 6 }}>
            目前的狀況
          </h2>
          <ul className="yz-todo">
            <Stat n={tasks.length} what="份任務（全部）" href="/take" label="看清單" />
            <Stat
              n={tasks.filter((t) => t.state === 'DONE').length}
              what="份已完成"
              href="/take"
              label="看成績"
            />
            <Stat n={upcoming.length} what="份還沒開放" href="/take" label="看時間" />
          </ul>
        </main>
      );
    }

    // 題庫的計數與 /bank 用同一組狀態，否則首頁說 320 題、
    // 點進去看到 287 題，而沒有人說得出哪一個是對的。
    const [questions, reviewJobs, failedJobs, runningJobs, classes, knowledgePoints] =
      await Promise.all([
        prisma.question.count({ where: { status: { in: ['PUBLISHED', 'PENDING_REVIEW'] } } }),
        prisma.importJob.count({ where: { status: 'READY_FOR_REVIEW' } }),
        prisma.importJob.count({ where: { status: 'FAILED' } }),
        prisma.importJob.count({
          where: { status: { notIn: ['READY_FOR_REVIEW', 'FAILED', 'COMMITTED'] } },
        }),
        admin
          ? prisma.class.count({ where: { active: true } })
          : prisma.classMembership.count({ where: { userId: user.id, leftAt: null } }),
        prisma.knowledgePoint.count(),
      ]);

    /**
     * 等老師手動放行的考試。
     *
     * # 為什麼這一項要出現在首頁
     *
     * 因為它是這個系統裡唯一一件「不做也完全不會有人告訴你」的事。
     * `releasePolicy = MANUAL` 的任務，學生交完卷之後看到的是
     * 「老師還沒有開放」，而老師那邊分數都算好了、答對率也畫出來了，
     * 畫面上沒有任何一個地方說「這些學生還看不到」。
     * 唯一的提醒必須主動出現在他每天會看的這一頁。
     *
     * 條件裡的「已經有人交卷」很重要：還沒有人交的任務放行了也沒有
     * 意義，列出來只會變成一件永遠做不完的待辦。
     */
    const gradeScope = await gradeScopeWhere(user);
    const awaitingRelease = await prisma.assignment.count({
      where: {
        ...gradeScope,
        releasePolicy: 'MANUAL',
        releasedAt: null,
        attempts: { some: { status: { in: ['SUBMITTED', 'GRADED'] } } },
      },
    });

    // 管理員專屬的兩項：沒有它們，後面每一步都做不下去。
    const [years, pendingConsent] = admin
      ? await Promise.all([
          prisma.academicYear.count(),
          prisma.user.count({
            where: { systemRole: 'STUDENT', consentAt: null, deletedAt: null },
          }),
        ])
      : [0, 0];

    const todo: TodoItem[] = [];

    if (admin && years === 0) {
      todo.push({
        n: 0,
        what: '還沒有學年度',
        why: '班級要掛在學年度底下。沒有學年度，一個班都開不了，後面的名冊、任務、成績也就都沒有。',
        href: '/settings/years',
        label: '建立學年度',
        act: true,
      });
    }
    if (admin && years > 0 && classes === 0) {
      todo.push({
        n: 0,
        what: '還沒有班級',
        why: '班級是派任務、看成績、算能力分析的單位。學生要先在某個班裡，才收得到任何東西。',
        href: '/classes',
        label: '開一個班',
        act: true,
      });
    }
    if (awaitingRelease > 0) {
      todo.push({
        n: awaitingRelease,
        what: '份考試的成績還沒放行',
        why: '這幾份設定為「老師手動放行」，學生交完卷了但看不到自己的分數，也看不到逐題檢討。放行之前他們的畫面上只有一句「老師還沒有開放」。',
        href: '/grades',
        label: '去放行',
        act: true,
      });
    }
    if (reviewJobs > 0) {
      todo.push({
        n: reviewJobs,
        what: '份題本等你校對',
        why: '校對完才會進題庫。AI 抽出來的題目在確認之前不算數——答案與配分都可能是錯的。',
        href: '/import',
        label: '去校對',
        act: true,
      });
    }
    if (failedJobs > 0) {
      todo.push({
        n: failedJobs,
        what: '份匯入失敗了',
        why: '失敗的匯入不會自己重試。點進去看卡在哪一階段，多數情況重跑就過了。',
        href: '/import',
        label: '看原因',
        act: true,
      });
    }
    if (admin && pendingConsent > 0) {
      todo.push({
        n: pendingConsent,
        what: '位學生還沒有家長同意紀錄',
        why: '這些帳號登不進去。個資法第 15 條要求蒐集未成年人的個人資料需法定代理人同意，所以系統預設擋住，取得同意後才開。',
        href: '/classes',
        label: '去處理',
        act: true,
      });
    }
    if (knowledgePoints === 0) {
      todo.push({
        n: 0,
        what: '知識點圖譜是空的',
        why: '匯入題本時的自動標註會從知識點裡挑候選，這張表空著的話那一階段等於沒有作用，能力分析也算不出東西。',
        href: '/knowledge',
        label: '去建立',
        act: false,
      });
    }

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>現在該做什麼</h1>
          <p className="yz-panel__sub">
            {user.displayName}　·　{ROLE_LABELS[user.systemRole] ?? user.systemRole}
          </p>
        </div>

        {todo.length > 0 ? (
          <ul className="yz-todo">
            {todo.map((item) => (
              <li
                key={item.what}
                className={`yz-todo__item${item.act ? ' yz-todo__item--act' : ''}`}
              >
                <span className="yz-todo__n">{item.n || '—'}</span>
                <span>
                  <span className="yz-todo__what">{item.what}</span>
                  <span className="yz-todo__why">{item.why}</span>
                </span>
                <Link href={item.href}>{item.label}</Link>
              </li>
            ))}
          </ul>
        ) : (
          <Empty
            title="沒有待辦的事"
            hint="題本都校對完了，學生的同意紀錄也齊了。要新增題目就從匯入開始。"
          />
        )}

        <h2 className="yz-card__title" style={{ marginTop: 30, marginBottom: 6 }}>
          目前的狀況
        </h2>
        <ul className="yz-todo">
          <Stat n={questions} what="題在題庫裡" href="/bank" label="看題庫" />
          <Stat
            n={classes}
            what={admin ? '個班級（全校）' : '個班（你帶的）'}
            href="/classes"
            label="看班級"
          />
          <Stat n={runningJobs} what="份匯入還在處理中" href="/import" label="看進度" />
        </ul>
      </main>
    );
  });
}

type TodoItem = {
  /** 0 代表「這件事沒有數量」，例如「還沒有學年度」。畫成破折號。 */
  n: number;
  what: string;
  /** 為什麼要在意。少了這一句，這一列只是一個數字。 */
  why: string;
  href: string;
  label: string;
  /** 今天就要動手的事。只有這些會上硃砂色。 */
  act: boolean;
};

function Stat({
  n,
  what,
  href,
  label,
}: {
  n: number;
  what: string;
  href: string;
  label: ReactNode;
}) {
  return (
    <li className="yz-todo__item">
      <span className="yz-todo__n">{n}</span>
      <span className="yz-todo__what">{what}</span>
      <Link href={href}>{label}</Link>
    </li>
  );
}
