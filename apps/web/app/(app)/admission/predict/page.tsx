/**
 * 級分預測（N1）。
 *
 * # 這一頁上不存在任何一個單一級分的數字
 *
 * 規格書 §6.3 的驗收準則寫得很硬：「介面上不存在任何呈現單一級分數字
 * 的路徑」。理由是「你的數學 A 預估 12 級分」會被學生當成承諾，
 * 而「11 至 13 級分，信心 70%」才是誠實的。
 *
 * 落實方式有三層，這一頁是第三層：`predict.mjs` 不在學生看得到的欄位裡
 * 放點估計、`predictDb.ts` 的 `studentView()` 把 `basis.center` 濾掉、
 * 而這一頁只渲染區間與分布。中心點連傳都沒有傳過來，所以印不出來。
 *
 * # 為什麼區間要畫成一條 0 到 15 的軌道
 *
 * 因為「11 至 13」這三個字讀起來像一個很窄的範圍，而在 16 個級分的
 * 尺度上它是六分之一。把整條尺畫出來，區間的寬度就變成一個看得見的
 * 事實而不是一個要換算的數字——那正是「不確定性必須被看見」在版面上
 * 的意思。
 *
 * # 為什麼四個不確定性來源要畫出來
 *
 * 因為它們對應到**學生做得到的事**。離散程度大 → 沒辦法；級距那一項
 * 大 → 去考一次全模；剩餘時間那一項大 → 那是好事，它會自己變小。
 * 只給一個總寬度的話，這三種完全不同的處境長得一樣。
 *
 * # 圖表是純 CSS
 *
 * 這套系統部署在補習班機房的封閉網段。為了幾條線引入一個要下載的
 * 相依，是把一個離線安裝的問題換一個裝飾。與 `.yz-rate`、能力分析
 * 那一頁同一個決定。
 */
import Link from 'next/link';

import { GRADE_SOURCES, myPredictionHistory, predictTargetOf, predictionsFor } from '@/lib/predictDb';
import { GSAT_SUBJECT_CODES, SUBJECT_LABELS } from '@/lib/placement.mjs';
import { DEFAULT_CONFIDENCE, THIN_MIN_RECORDS } from '@/lib/predict.mjs';
import { mayUse } from '@/lib/nav';
import { scopedPage } from '@/lib/page';
import { Denied, Empty, Note } from '@/components/Feedback';

import { Emph } from '../Emph';
import GradeForm from './GradeForm';
import SnapshotButton from './SnapshotButton';

export const dynamic = 'force-dynamic';

/** 可選的信心水準。**不是讓學生把區間調到好看的** ——見下面的說明。 */
const CONFIDENCES = [0.6, 0.7, 0.8];

const VARIANCE_LABELS: { key: string; label: string; why: string }[] = [
  {
    key: 'disp',
    label: '你自己成績的波動',
    why: '歷次級分散得越開，下一次落在哪裡就越不確定。考試次數少的時候這一項也會偏大。',
  },
  {
    key: 'diff',
    label: '模考與真學測的難度差',
    why: '模考的卷子不是大考中心出的。沒有共同題可以校正，所以這一項只能給一個保守的量。',
  },
  {
    key: 'scale',
    label: '級距本身的不確定',
    why: '級距是「前 1% 考生的平均原始分除以 15」。校內模考人數不足時，前 1% 只有一兩個人。',
  },
  {
    key: 'drift',
    label: '剩下的時間裡會變多少',
    why: '距考試越遠這一項越大，而它是唯一會自己變小的一項——時間過去它就縮。',
  },
];

const pct = (v: number) => `${Math.round(v * 100)}%`;

export default async function PredictPage({
  searchParams,
}: {
  searchParams: Promise<{ confidence?: string }>;
}) {
  return scopedPage(async (user) => {
    // 角色判定走 `lib/nav.ts` 那一份唯一的對照表。自己手寫一份的話，
    // 改角色時沒有人會記得跟著改——而這一區共有六頁。
    if (!mayUse(user.systemRole, '/admission')) {
      return (
        <main className="yz-panel">
          <Denied
            what="級分預測"
            why={
              <>
                這一區是學生與老師的。孩子的成績與作業狀況在
                <Link href="/guardian">孩子的狀況</Link>那一頁。
              </>
            }
          />
        </main>
      );
    }

    // **預測的目標是下一場還沒考的學測**，不是現在這個學年度：學年度
    // 自 8 月起算而學測在 1 月，所以 1/20 到 7/31 之間那兩者差一年。
    const { targetYear, schoolYear, schoolYearExamPassed, schoolYearExamDate } = predictTargetOf();
    const year = targetYear;
    const sp = await searchParams;
    const wanted = Number(sp?.confidence);
    const confidence = CONFIDENCES.includes(wanted) ? wanted : DEFAULT_CONFIDENCE;

    if (user.systemRole !== 'STUDENT') {
      return (
        <main className="yz-panel">
          <div className="yz-panel__head">
            <h1>級分預測</h1>
            <p className="yz-panel__sub">{year} 學年度</p>
          </div>
          <Empty
            title="這一頁是學生輸入自己的模考級分、看自己的預測區間"
            hint="老師要看的是這套預測到底準不準——那在校準報告，它是機構自己的品質報告。"
            action={
              <Link href="/admission/calibration" className="yz-btn yz-btn--primary">
                去校準報告
              </Link>
            }
          />
        </main>
      );
    }

    // 歷史要連**上一場**（可能剛考完）的一起查：那幾份還在等實際成績，
    // 而它們只在這一頁上看得到。少查那一年的話，「去輸入正式級分」
    // 這個動作沒有任何地方提醒得了他。
    const [data, history] = await Promise.all([
      predictionsFor(user.id, year, confidence),
      myPredictionHistory(user.id, [year, schoolYear]),
    ]);
    /** 上一場考完了、而那幾份預測還在等答案。 */
    const waitingForOfficial = schoolYearExamPassed
      ? history.filter((h) => h.targetYear === schoolYear && h.actualGrade === null).length
      : 0;

    const subjects = (GSAT_SUBJECT_CODES as readonly string[]).map((code) => ({
      code,
      label: (SUBJECT_LABELS as Record<string, string>)[code] ?? code,
    }));

    const usable = data.predictions.filter((p) => p.interval);

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>級分預測</h1>
          <p className="yz-panel__sub">
            {year} 學年度學測 ·{' '}
            {data.examDate ? `${data.examDate.slice(0, 10)} 前後` : '日期由大考中心公告'} ·
            預測建立在<strong>你手上那幾張模考成績單</strong>上
          </p>
        </div>

        {/*
          1 月到 7 月之間，「現在的學年度」與「下一場學測」差一年。
          不講清楚的話，剛考完的高三生會以為下面這一份是他那一場的預測。
        */}
        {schoolYearExamPassed && schoolYear !== year && (
          <Note tone="warn">
            <strong>
              {schoolYear} 學年度的學測已經在
              {schoolYearExamDate ? ` ${schoolYearExamDate.slice(0, 10)} ` : '今年 1 月 '}
              考完了。
            </strong>
            下面這一份預測的目標是<strong>下一場</strong>（{year} 學年度）。
            <br />
            如果你剛考完：
            <strong>去上面加一筆級分，「這是哪一種考試」選「真正的學測」</strong>
            ——你之前存下來的預測會補上實際成績，而那是校準曲線唯一的資料來源。
            <strong>系統不會自己去拿那個數字</strong>，成績單只在你手上。
            {waitingForOfficial > 0 && (
              <>
                　你有 <b>{waitingForOfficial}</b> 份 {schoolYear} 學年度的預測正在等這一筆。
              </>
            )}
          </Note>
        )}

        <Note tone="info">
          這裡收的是<strong>模考成績單上印的級分</strong>，不是從你的作答記錄反推的。
          反推要跨兩道換算（原始分 → 難度校正 → 級距），每一道都放大誤差，而級距在校內人數
          不足時本身就不可靠。<strong>成績單上那個數字是直接觀測值，誤差是零。</strong>
          <br />
          輸出永遠是<strong>區間加信心水準</strong>，這一頁上不存在任何一個「你會考幾級分」
          的單一數字——那種數字會被當成承諾。
        </Note>

        {/* ── 一、級分記錄 ─────────────────────────────────── */}
        <h2 className="yz-card__title" style={{ marginTop: 24 }}>
          我的級分記錄（{data.records.length} 筆）
        </h2>
        <p className="yz-hint">
          南模、全模、校內模考都算，一場一科一筆。至少<strong>{THIN_MIN_RECORDS} 次</strong>
          才算得出你自己的成績波動有多大——兩次以下的話這裡只會說「資料不足」，
          不會硬給一個區間。
        </p>
        <GradeForm subjects={subjects} sources={[...GRADE_SOURCES]} records={data.records} />

        {data.withoutRecords.length > 0 && (
          <p className="yz-hint" style={{ marginTop: 10 }}>
            還沒有記錄的科目：
            {data.withoutRecords
              .map((c) => (SUBJECT_LABELS as Record<string, string>)[c] ?? c)
              .join('、')}
            。數學 A 與數學 B 通常只考一科，那是正常的；其餘幾科沒有記錄的話，
            落點模擬用到它們的志願會顯示「無法估計」。
          </p>
        )}

        {/* ── 二、預測 ─────────────────────────────────────── */}
        <h2 className="yz-card__title" style={{ marginTop: 30 }}>
          預測區間
        </h2>

        <div className="yz-pred__conf">
          <span className="yz-pred__conflabel">信心水準</span>
          {CONFIDENCES.map((c) => (
            <Link
              key={c}
              href={`/admission/predict?confidence=${c}`}
              className={`yz-pred__confopt${c === confidence ? ' yz-pred__confopt--on' : ''}`}
            >
              {pct(c)}
            </Link>
          ))}
          <span className="yz-pred__confwhy">
            切換看看。<strong>這不是把區間調到好看用的</strong>——同一份資料在 60% 與 80% 下
            的區間差多少，比任何一句說明都能講清楚不確定性是什麼。
          </span>
        </div>

        {data.predictions.length === 0 ? (
          <p className="yz-hint">
            輸入級分之後這裡才有東西。<strong>不會有一個預設的區間</strong>——
            那個區間會與你這個人無關。
          </p>
        ) : (
          <ul className="yz-pred__list">
            {data.predictions.map((p) => {
              const totalVar = p.basis.variance
                ? Object.values(p.basis.variance).reduce((a, b) => a + b, 0)
                : 0;
              const maxP = p.distribution
                ? Math.max(...p.distribution.map((d) => d.p))
                : 1;

              return (
                <li key={p.subjectCode} className="yz-pred__item">
                  <div className="yz-pred__head">
                    <span className="yz-pred__subject">{p.subjectLabel}</span>
                    {p.interval ? (
                      <>
                        <span className="yz-pred__range">
                          {p.interval.low} 至 {p.interval.high} 級分
                        </span>
                        <span className="yz-pred__conflevel">
                          信心 {pct(p.interval.confidence)}
                        </span>
                      </>
                    ) : (
                      <span className="yz-pred__thin">資料不足，預測不可靠</span>
                    )}
                    <span className="yz-pred__n">
                      {p.basis.records} 次記錄
                      {/*
                        顯示的是**夾過的**剩餘時間，而考完了的那一場直接
                        說「已經考完」。印帶號的那一個再 `Math.max(0, …)`
                        會把「這場考完了」偽裝成「距學測約 0 個月」——
                        讀起來像「就快考了」，方向剛好相反。
                      */}
                      {p.basis.examPassed
                        ? '　這一場已經考完了'
                        : p.basis.monthsAhead !== null &&
                          `　距學測約 ${Math.round(p.basis.monthsAhead)} 個月`}
                    </span>
                  </div>

                  {p.reason && (
                    <p className="yz-pred__why">
                      <Emph text={p.reason} />
                    </p>
                  )}

                  {p.interval && p.distribution && (
                    <>
                      {/* 0 到 15 的整條尺。區間的寬度是一個看得見的事實，
                          不是一個要換算的數字。 */}
                      <div
                        className="yz-pred__track"
                        role="img"
                        aria-label={`${p.subjectLabel} 預估 ${p.interval.low} 至 ${p.interval.high} 級分，信心 ${pct(p.interval.confidence)}`}
                      >
                        {p.distribution.map((d) => {
                          const inRange =
                            d.grade >= p.interval!.low && d.grade <= p.interval!.high;
                          return (
                            <span
                              key={d.grade}
                              className={`yz-pred__cell${inRange ? ' yz-pred__cell--in' : ''}`}
                            >
                              <span
                                className="yz-pred__bar"
                                style={{ height: `${Math.round((d.p / maxP) * 100)}%` }}
                              />
                              <span className="yz-pred__tick">{d.grade}</span>
                            </span>
                          );
                        })}
                      </div>
                      <p className="yz-pred__legend">
                        每一根的高度是<strong>考到那個級分的機率</strong>，粗線標出的那一段是
                        區間。分布往右邊拖得比左邊長是刻意的——距考試越遠，往上的空間就越大，
                        因為學生通常會進步。
                      </p>

                      {/* 四個不確定性來源。它們對應到學生做得到的事。 */}
                      {p.basis.variance && totalVar > 0 && (
                        <div className="yz-pred__var">
                          <span className="yz-pred__varhead">這個寬度是哪裡來的</span>
                          <div className="yz-pred__varbar">
                            {VARIANCE_LABELS.map((v) => {
                              const share =
                                (p.basis.variance as Record<string, number>)[v.key] / totalVar;
                              if (!(share > 0)) return null;
                              return (
                                <span
                                  key={v.key}
                                  className={`yz-pred__varseg yz-pred__varseg--${v.key}`}
                                  style={{ flexGrow: share }}
                                  title={`${v.label}　${pct(share)}`}
                                />
                              );
                            })}
                          </div>
                          <ul className="yz-pred__varlist">
                            {VARIANCE_LABELS.map((v) => {
                              const share =
                                (p.basis.variance as Record<string, number>)[v.key] / totalVar;
                              if (!(share > 0)) return null;
                              return (
                                <li key={v.key}>
                                  <span className={`yz-pred__varkey yz-pred__varkey--${v.key}`} />
                                  <span className="yz-pred__varname">{v.label}</span>
                                  <span className="yz-pred__varshare">{pct(share)}</span>
                                  <span className="yz-pred__varwhy">{v.why}</span>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      )}
                    </>
                  )}

                  {p.basis.sources.length > 0 && (
                    <p className="yz-pred__srcmix">
                      資料來源：
                      {p.basis.sources
                        .map((s) => `${s.label} ${s.count} 次（權重 ${pct(s.share)}）`)
                        .join('、')}
                      。<span className="yz-pred__srchint">越近期的考試權重越高。</span>
                    </p>
                  )}

                  {p.notes.map((n, i) => (
                    <p key={i} className="yz-pred__note">
                      <Emph text={n} />
                    </p>
                  ))}

                  {p.basis.rejected.length > 0 && (
                    <Note tone="warn">
                      有 {p.basis.rejected.length} 筆記錄的級分不在 0 至 15 之間，
                      <strong>沒有被算進去</strong>。多半是把百分制的分數填進級分那一欄了——
                      上面的清單裡找出來改掉。
                    </Note>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {/* ── 三、存一份，供校準 ───────────────────────────── */}
        {usable.length > 0 && (
          <>
            <h2 className="yz-card__title" style={{ marginTop: 30 }}>
              存一份下來
            </h2>
            <SnapshotButton year={year} confidence={confidence} />
          </>
        )}

        {history.length > 0 && (
          <>
            <h3 className="yz-adm__grouphead" style={{ marginTop: 20 }}>
              預測怎麼變的（{history.length} 份）
            </h3>
            <ul className="yz-pred__hist">
              {history.map((h) => (
                <li key={h.id}>
                  <span className="yz-pred__histwhen">{h.predictedAt.slice(0, 10)}</span>
                  <span className="yz-pred__histsub">{h.subjectLabel}</span>
                  {/* 兩個學年度混在同一條時間軸上，所以每一列要說得出
                      它預測的是哪一場。 */}
                  <span className="yz-pred__histsub">{h.targetYear} 學年度</span>
                  <span className="yz-pred__histrange">
                    {h.intervalLow} 至 {h.intervalHigh} 級分
                  </span>
                  <span className="yz-pred__histconf">信心 {pct(h.confidence)}</span>
                  <span className="yz-pred__histn">{h.records} 次記錄</span>
                  {h.actualGrade === null ? (
                    <span className="yz-pred__histpend">
                      {h.targetYear === schoolYear && schoolYearExamPassed
                        ? '等你輸入正式級分'
                        : '等學測成績'}
                    </span>
                  ) : (
                    <span className={`yz-pred__histhit${h.hit ? '' : ' yz-warn'}`}>
                      實際 {h.actualGrade} 級分 · {h.hit ? '落在區間內' : '落在區間外'}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <p className="yz-hint">
              這一份不只是紀錄。學測成績公布之後，全機構所有的預測會被拿來算
              <strong>校準曲線</strong>——所有標著「信心 70%」的區間裡，實際落在區間內的比例
              是不是接近 70%。偏離就代表這套預測過度自信或過度保守，而那是老師端看得到的
              品質訊號。<strong>一個不追蹤自己準確度的預測系統只是在製造好看的數字。</strong>
              <br />
              而「對答案」這一步<strong>需要你回來做一件事</strong>：學測成績公布後，
              把正式級分當成一筆「真正的學測」的成績記錄輸入進來。
              <strong>系統沒有辦法自己去拿那個數字</strong>——它只在你的成績單上。
              <br />
              考完之後才存下來的預測<strong>不會被拿去對答案</strong>：那時候正式級分已經是
              它的輸入，它必然命中，放進曲線等於自己給自己打分數。
            </p>
          </>
        )}

        {/* ── 四、接下去 ───────────────────────────────────── */}
        <h2 className="yz-card__title" style={{ marginTop: 30 }}>
          接下去
        </h2>
        <p className="yz-hint">
          這幾個分布是<strong>個申落點模擬的輸入</strong>——落點用的是整個分布而不是一個
          預估級分，因為用點估計去算落點會嚴重低估風險。
          <Link href="/admission/placement" style={{ marginLeft: 6 }}>
            去個申落點模擬
          </Link>
          。那一頁還需要你查來的<Link href="/admission/refs">歷年篩選門檻</Link>。
        </p>
      </main>
    );
  });
}
