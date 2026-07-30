/**
 * 級分預測的校準報告（規格書 §6.2）。**給老師看的。**
 *
 * # 這一頁存在的理由，是這整個功能能不能被信任的條件
 *
 * 「預測系統若不追蹤自己的準確度，就只是在製造好看的數字。」
 *
 * 它回答一個很具體的問題：**所有被預測為「信心 70%」的區間裡，實際
 * 落在區間內的比例是不是接近 70%？** 低於太多代表過度自信（區間開太
 * 窄），而那時學生畫面上每一個區間都在騙人，卻沒有任何症狀——沒有
 * 錯誤訊息、沒有當機、沒有人來反映。
 *
 * # 為什麼要區分「偏離」與「樣本太少」
 *
 * 因為第一屆只有十幾筆資料，而點估計會在 0.4 與 0.9 之間亂跳。若這一頁
 * 天天亮紅字，那個告警會被關掉——而它是這整套東西唯一的品質訊號。
 * 所以判斷用的是 Wilson 區間而不是點估計，而樣本不足的組明確標成
 * 「還下不了結論」，不是標成「正常」。
 *
 * # 為什麼逐科也要算一份
 *
 * 因為偏離往往集中在某一科（例如那一科全班只有校內模考，級距本身就
 * 不可靠），而整體的曲線會把它平掉。平掉之後沒有人知道該修哪裡。
 *
 * # 圖表是純 CSS
 *
 * 封閉網段，不引入圖表套件。校準曲線的形狀就是「宣稱 vs 實際」兩根
 * 對照的線，用兩條 div 的寬度就畫得出來。
 */
import Link from 'next/link';

import { CALIB_ALERT_MARGIN, CALIB_MIN_N } from '@/lib/predict.mjs';
import { calibrationReport, canSeeCalibration } from '@/lib/predictDb';
import { scopedPage } from '@/lib/page';
import { Empty, Note } from '@/components/Feedback';

export const dynamic = 'force-dynamic';

type Band = {
  label: string;
  n: number;
  hit: number;
  hitRate: number | null;
  expected: number | null;
  gap: number | null;
  wilsonLow: number;
  wilsonHigh: number;
  thin: boolean;
  alert: { severity: string; text: string } | null;
};

type Curve = {
  scored: number;
  pending: number;
  malformed: number;
  totals: { n: number; hit: number; hitRate: number | null; expected: number | null; gap: number | null };
  bands: Band[];
  alerts: { band: string; severity: string; text: string }[];
  verdict: string;
};

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);

/** 一組的兩根線：宣稱的信心，與實際的命中率。 */
function BandRow({ b }: { b: Band }) {
  return (
    <li className={`yz-calib__band${b.thin ? ' yz-calib__band--thin' : ''}`}>
      <div className="yz-calib__bandhead">
        <span className="yz-calib__bandname">{b.label}</span>
        <span className="yz-calib__bandn">
          {b.n} 筆{b.n > 0 && `（命中 ${b.hit}）`}
        </span>
        {b.thin ? (
          <span className="yz-calib__bandthin">樣本太少，還下不了結論</span>
        ) : b.alert ? (
          <span
            className={`yz-calib__bandflag yz-calib__bandflag--${b.alert.severity.toLowerCase()}`}
          >
            {b.alert.severity === 'OVERCONFIDENT' ? '過度自信' : '過度保守'}
          </span>
        ) : (
          <span className="yz-calib__bandok">沒有明顯偏離</span>
        )}
      </div>

      {b.n > 0 && (
        <div className="yz-calib__pair">
          <div className="yz-calib__line">
            <span className="yz-calib__linelabel">宣稱</span>
            <span className="yz-calib__track">
              <span
                className="yz-calib__fill yz-calib__fill--claim"
                style={{ width: `${(b.expected ?? 0) * 100}%` }}
              />
            </span>
            <span className="yz-calib__linenum">{pct(b.expected)}</span>
          </div>
          <div className="yz-calib__line">
            <span className="yz-calib__linelabel">實際</span>
            <span className="yz-calib__track">
              <span
                className={`yz-calib__fill yz-calib__fill--actual${b.alert?.severity === 'OVERCONFIDENT' ? ' yz-calib__fill--bad' : ''}`}
                style={{ width: `${(b.hitRate ?? 0) * 100}%` }}
              />
              {/* 95% 的不確定範圍。少了它，一組 10 筆與一組 400 筆的
                  「實際 45%」在畫面上長得一樣。 */}
              <span
                className="yz-calib__ci"
                style={{
                  left: `${b.wilsonLow * 100}%`,
                  width: `${Math.max(0.5, (b.wilsonHigh - b.wilsonLow) * 100)}%`,
                }}
              />
            </span>
            <span className="yz-calib__linenum">{pct(b.hitRate)}</span>
          </div>
        </div>
      )}

      {b.n > 0 && (
        <p className="yz-calib__bandci">
          實際命中率的 95% 範圍是 {pct(b.wilsonLow)} 至 {pct(b.wilsonHigh)}。
          {b.thin
            ? '樣本這麼少的時候，這個範圍寬到什麼結論都下不了——所以不告警。'
            : b.alert
              ? '這個範圍的上界已經低於宣稱的信心，所以偏離不是統計噪音。'
              : '宣稱的信心落在這個範圍裡，所以看不出偏離。'}
        </p>
      )}

      {b.alert && <Note tone="warn">{b.alert.text}</Note>}
    </li>
  );
}

export default async function CalibrationPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>;
}) {
  return scopedPage(async (user) => {
    if (!canSeeCalibration(user)) {
      return (
        <main className="yz-panel">
          <div className="yz-panel__head">
            <h1>級分預測的校準</h1>
          </div>
          <Empty
            title="這一份是機構自己的品質報告"
            hint={
              '「我們的 70% 區間其實只準 45%」這句話需要的脈絡（樣本數、哪一屆、' +
              '偏離是不是統計噪音）不在學生手上，而合理的反應會是不再相信任何一個區間。' +
              '你自己的預測與它們事後準不準，在級分預測那一頁看得到。'
            }
            action={<Link href="/admission/predict">去我的級分預測</Link>}
          />
        </main>
      );
    }

    const sp = await searchParams;
    const wanted = Number(sp?.year);
    const report = await calibrationReport(Number.isFinite(wanted) && wanted > 0 ? wanted : null);
    const overall = report.overall as unknown as Curve;

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>級分預測的校準</h1>
          <p className="yz-panel__sub">
            {report.year === null ? '全部學年度' : `${report.year} 學年度`} ·
            已回填 {overall.scored} 筆 · 等成績 {overall.pending} 筆
          </p>
        </div>

        <Note tone="info">
          這一頁量的是一件事：<strong>所有被預測為「信心 70%」的區間裡，實際落在區間內的
          比例是不是接近 70%</strong>。低於太多代表區間開太窄（過度自信），高於太多代表開
          太寬（等於什麼都沒說）。
          <br />
          <strong>一個不追蹤自己準確度的預測系統只是在製造好看的數字。</strong>
          這份資料按年度累積，用了三屆之後這套預測會明顯比第一屆準，而且準確度是可以被
          證明的。
        </Note>

        {report.years.length > 1 && (
          <div className="yz-calib__years">
            <Link
              href="/admission/calibration"
              className={`yz-calib__year${report.year === null ? ' yz-calib__year--on' : ''}`}
            >
              全部
            </Link>
            {report.years.map((y) => (
              <Link
                key={y}
                href={`/admission/calibration?year=${y}`}
                className={`yz-calib__year${report.year === y ? ' yz-calib__year--on' : ''}`}
              >
                {y} 學年度
              </Link>
            ))}
            <span className="yz-calib__yearhint">
              第一年一定要看「全部」——單一學年度的樣本量還不足以下結論。
            </span>
          </div>
        )}

        <p className="yz-calib__verdict">{overall.verdict}</p>

        {overall.scored === 0 ? (
          <Empty
            title="還沒有可以對答案的預測"
            hint={
              overall.pending > 0
                ? `已經有 ${overall.pending} 份預測存下來了，但還沒有任何一份回填實際成績。` +
                  '回填是自動的：學生把真正的學測級分當成一筆 source = 真正的學測 的成績記錄' +
                  '輸入之後，同一科的歷次預測就會補上實際級分。'
                : '學生要先在級分預測那一頁按「把現在的預測存一份」。沒有存下來的預測沒有辦法事後對答案。'
            }
          />
        ) : (
          <>
            {overall.alerts.length > 0 && (
              <Note tone="warn">
                <strong>有 {overall.alerts.length} 組明顯偏離。</strong>
                偏離不是 bug，是模型的參數需要調——`lib/predict.mjs` 的
                `SOURCE_UNCERTAINTY` 與 `DRIFT_SD_PER_SQRT_MONTH` 是先驗值，而這一頁就是
                用來驗它們訂得對不對的。調整之前先確認樣本數夠：門檻是一組 {CALIB_MIN_N} 筆，
                而判斷偏離用的是 Wilson 區間而不是點估計。
              </Note>
            )}

            <h2 className="yz-card__title" style={{ marginTop: 24 }}>
              整體
            </h2>
            <p className="yz-calib__summary">
              {overall.totals.n} 筆已回填，實際命中 {overall.totals.hit} 筆（
              {pct(overall.totals.hitRate)}），宣稱的平均信心 {pct(overall.totals.expected)}，
              差距 {overall.totals.gap === null ? '—' : `${(overall.totals.gap * 100).toFixed(1)} 個百分點`}。
              {overall.malformed > 0 && (
                <strong>
                  　另有 {overall.malformed} 筆的區間或信心壞掉了——資料庫有 CHECK 擋這件事，
                  所以這個數字不是 0 就要查。
                </strong>
              )}
            </p>

            <h2 className="yz-card__title" style={{ marginTop: 26 }}>
              依宣稱的信心分組
            </h2>
            <p className="yz-hint">
              告警的條件是<strong>兩個都成立</strong>：命中率低於宣稱信心
              {' '}{Math.round(CALIB_ALERT_MARGIN * 100)} 個百分點以上（規格書的例子：70% 對
              55%），<strong>而且</strong>命中率 95% 範圍的上界仍然低於宣稱的信心。
              第二個條件是為了讓小樣本不告警——少了它，第一屆會天天紅字，然後這個告警會被關掉。
            </p>
            <ul className="yz-calib__bands">
              {overall.bands.map((b) => (
                <BandRow key={b.label} b={b} />
              ))}
            </ul>

            <h2 className="yz-card__title" style={{ marginTop: 30 }}>
              逐科
            </h2>
            <p className="yz-hint">
              偏離往往集中在某一科（例如那一科的學生全部只有校內模考，而級距本身就不可靠），
              而整體的曲線會把它平掉——平掉之後沒有人知道該修哪裡。
            </p>
            <ul className="yz-calib__subjects">
              {report.bySubject.map((s) => {
                const c = s.curve as unknown as Curve;
                const bad = c.alerts.filter((a) => a.severity === 'OVERCONFIDENT').length;
                return (
                  <li key={s.subjectCode} className="yz-calib__subject">
                    <span className="yz-calib__subjname">{s.subjectLabel}</span>
                    <span className="yz-calib__subjn">{c.scored} 筆已回填</span>
                    <span className="yz-calib__subjrate">
                      實際 {pct(c.totals.hitRate)} · 宣稱 {pct(c.totals.expected)}
                    </span>
                    {c.scored < CALIB_MIN_N ? (
                      <span className="yz-calib__bandthin">樣本太少</span>
                    ) : bad > 0 ? (
                      <span className="yz-calib__bandflag yz-calib__bandflag--overconfident">
                        {bad} 組過度自信
                      </span>
                    ) : (
                      <span className="yz-calib__bandok">沒有明顯偏離</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </main>
    );
  });
}
