/**
 * 個人申請落點模擬（N2）。
 *
 * # 這是整個系統裡唯一合法出現機率的地方，而它憑什麼
 *
 * `lib/adviceGuard.mjs` 會擋掉所有機率形式的輸出，而那一層擋的是
 * **AI 產生的文字**——模型沒有辦法保證它寫出來的那個數字是剛剛算出來
 * 的那一個，而一個看起來一樣的數字讀者分不出來。
 *
 * 這一頁的數字不是寫出來的，是**算出來的**：輸入有快照
 * （`SimulationRun.input`）、亂數有固定種子，所以任何一個數字都可以被
 * 重算出一模一樣的值。兩者共存的方式是**分開通道**而不是放寬閘門：
 * 機率只出現在這一頁，而送給 AI 老師的脈絡（`placementAdvicePayload()`）
 * 裡沒有任何機率欄位。完整的推論在 `lib/placement.mjs` §8。
 *
 * # 每一個機率旁邊都必須有它的資料基礎
 *
 * 規格書 §8.4：用了哪幾年的資料、可靠度分數、最後更新日期。這一頁把
 * 那三樣東西放在**機率的同一列**而不是收在展開區——收起來的結果是
 * 畫面上只剩機率，而那就是坊間工具的樣子。
 *
 * # 篩選機制不是百分位門檻
 *
 * 規格書 §8.1 記著它第一版寫錯的地方。簡章裡寫的是篩選科目的順序與
 * 倍率，門檻級分**由當年報名者池內生決定**。所以這一頁的基準是學生
 * 自己查來的歷年實際門檻，而不是把百分比換算成門檻——後者根本沒有
 * 百分比可以換算。這件事要在畫面上說出來，因為學生會問為什麼要他自己查。
 *
 * # 通過第一階段不等於錄取
 *
 * 第二階段的錄取分數沒有全國統一資料，多校不公布，所以本系統
 * **不做任何第二階段的機率預測**（規格書 §14）。這句話要跟著每一個
 * 機率一起出現，不是收在頁尾。
 */
import Link from 'next/link';

import { TIER_LABELS } from '@/lib/placement.mjs';
import { admissionYearOf, latestPlacement, placementRuns } from '@/lib/predictDb';
import { prisma } from '@/lib/prisma';
import { scopedPage } from '@/lib/page';
import { Empty, Note } from '@/components/Feedback';

import { Emph } from '../Emph';
import RunButton from './RunButton';

export const dynamic = 'force-dynamic';

type WishResult = {
  wishId: string | null;
  rank: number | null;
  institutionName: string;
  programName: string | null;
  tier: string;
  tierLabel: string;
  passRate: number | null;
  risk: string | null;
  reliability: {
    score: number;
    tier: string;
    years: number[];
    factors: Record<string, number>;
    lookedUpAt: string | null;
    notes: string[];
  };
  thresholdYears: number[];
  thresholdRefs: {
    year: number;
    subjects: string[];
    grades: number[];
    sourceLabel: string;
    lookedUpAt: string | null;
  }[];
  stages: {
    label: string;
    subjects: string[];
    combo: boolean;
    threshold: number;
    multiple: number | null;
    failRate: number | null;
  }[];
  qualify: { describe: string; grade: number | null }[];
  qualifyFailRate: number | null;
  undecidableQualify: number;
  notes: string[];
  problems: string[];
};

type PlacementResult = {
  year: number;
  computedAt: string;
  dataAsOf: string | null;
  draws: number;
  seed: number;
  correlation: {
    source: string;
    loadings: Record<string, number>;
    note: string;
    pairs:
      | { a: string; b: string; commonExams: number; observed: number | null; used: number; fallback: boolean }[]
      | null;
  };
  missingSubjects: string[];
  wishes: WishResult[];
  combo: {
    estimated: number;
    excluded: number;
    expectedPasses: number;
    atLeastOne: number;
    independentAtLeastOne: number;
    passCountDistribution: { passes: number; p: number }[];
    tiers: { sprint: string[]; steady: string[]; safe: string[] };
    warnings: { code: string; text: string }[];
  };
  stageTwoNote: string;
};

const pct = (v: number) => `${Math.round(v * 100)}%`;

const RISK_LABEL: Record<string, string> = {
  SPRINT: '衝刺',
  STEADY: '穩健',
  SAFE: '保底',
};

const CORR_LABEL: Record<string, string> = {
  OWN: '用你自己的模考殘差估的',
  MIXED: '部分用你自己的，其餘用保守預設',
  DEFAULT: '全部用保守的預設值',
};

export default async function PlacementPage() {
  return scopedPage(async (user) => {
    const year = admissionYearOf() as number;

    if (user.systemRole !== 'STUDENT') {
      return (
        <main className="yz-panel">
          <div className="yz-panel__head">
            <h1>個申落點模擬</h1>
            <p className="yz-panel__sub">{year} 學年度</p>
          </div>
          <Empty
            title="這一頁吃學生自己的級分記錄與他自己查來的歷年門檻"
            hint="老師要看班上的狀況在班級頁的升學總覽。落點的機率是逐人算的，而它的輸入有一半是學生自己去官方網頁查來的。"
            action={<Link href="/admission">回升學規劃</Link>}
          />
        </main>
      );
    }

    const [latest, runs, wishCount] = await Promise.all([
      latestPlacement(user.id, year),
      placementRuns(user.id, year, 8),
      prisma.wish.count({ where: { userId: user.id, year, channel: 'APPLY' } }),
    ]);

    const result = (latest?.result ?? null) as PlacementResult | null;

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>個申落點：通過第一階段的機率</h1>
          <p className="yz-panel__sub">
            {year} 學年度 · 蒙地卡羅抽樣 · 這是<strong>唯一一個</strong>會給你機率的地方，
            而它必須帶著資料基礎一起看
          </p>
        </div>

        <Note tone="warn">
          <strong>先把篩選機制搞清楚。</strong>
          個人申請的篩選標準<strong>不是全國百分位門檻</strong>。簡章分則裡寫的是
          <strong>篩選科目的順序與倍率</strong>（例如「國文 3 倍、英文 2 倍、數學 A 1.5 倍」），
          篩選的作法是依序取「招生名額 × 倍率」的人數。這代表
          <strong>實際的門檻級分是由該校系當年的報名者池決定的</strong>——同一個校系，報名的
          人強，門檻就高。分則裡不存在「數學 A 前 30%」這種欄位，所以也沒有百分比可以換算。
          <br />
          所以這裡的基準是<strong>你自己查來的歷年實際門檻級分</strong>。歷年只是參考，不是保證。
        </Note>

        <RunButton year={year} hasWishes={wishCount > 0} />

        {!result ? (
          <Empty
            title="還沒有跑過模擬"
            hint={
              wishCount === 0
                ? '先去升學規劃填幾個個人申請的志願，再去升學資料查詢輸入那幾個校系的歷年篩選門檻，然後回來按上面那顆按鈕。'
                : '按上面那顆按鈕。它需要兩樣東西：你的級分記錄（級分預測那一頁）與你查來的歷年篩選門檻（升學資料查詢那一頁）。'
            }
            action={
              <>
                <Link href="/admission/predict">級分預測</Link>
                {'　'}
                <Link href="/admission/refs">升學資料查詢</Link>
              </>
            }
          />
        ) : (
          <>
            {/* ── 這一份是什麼時候算的、用的是哪一份資料 ────── */}
            <p className="yz-plc__meta">
              這一份算於 <b>{result.computedAt.slice(0, 16).replace('T', ' ')}</b>
              {result.dataAsOf && (
                <>
                  ，門檻資料最舊的一筆查詢日期是 <b>{result.dataAsOf.slice(0, 10)}</b>
                </>
              )}
              ，抽樣 {result.draws.toLocaleString()} 次，種子 {result.seed}。
              <span className="yz-plc__metahint">
                一份三年前的資料算出來的機率，與上週更新過的，不是同一種東西——
                所以這一行要跟數字擺在一起。種子留著是為了讓任何一次舊的模擬都重跑得出
                一模一樣的數字。
              </span>
            </p>

            {/* ── 組合分析 ────────────────────────────────── */}
            <h2 className="yz-card__title" style={{ marginTop: 26 }}>
              六個志願配起來會怎樣
            </h2>
            <div className="yz-plc__combo">
              <div className="yz-plc__stat">
                <span className="yz-plc__statnum">{result.combo.atLeastOne.toFixed(2)}</span>
                <span className="yz-plc__statlabel">至少通過一個的機率</span>
                <span className="yz-plc__statwhy">
                  <strong>從抽樣直接數出來的</strong>，不是把六個機率相乘。六個志願共用同一組
                  級分——數學考壞的那一天，用到數學的志願會一起失手。假設它們互相獨立會算成{' '}
                  {result.combo.independentAtLeastOne.toFixed(2)}，
                  而那個數字是**高估**。
                </span>
              </div>
              <div className="yz-plc__stat">
                <span className="yz-plc__statnum">{result.combo.expectedPasses.toFixed(2)}</span>
                <span className="yz-plc__statlabel">期望通過數</span>
                <span className="yz-plc__statwhy">
                  只加算得出機率的 {result.combo.estimated} 個志願。
                  {result.combo.excluded > 0 && (
                    <>
                      另外 {result.combo.excluded} 個資料不足，<strong>沒有被算成 0</strong>。
                    </>
                  )}
                </span>
              </div>
              <div className="yz-plc__stat">
                <span className="yz-plc__statnum">
                  {result.combo.tiers.sprint.length}／{result.combo.tiers.steady.length}／
                  {result.combo.tiers.safe.length}
                </span>
                <span className="yz-plc__statlabel">衝刺／穩健／保底</span>
                <span className="yz-plc__statwhy">
                  依通過機率分：低於 30% 是衝刺、30% 至 70% 是穩健、高於 70% 是保底。
                  系統不強制你怎麼配。
                </span>
              </div>
            </div>

            {/* 通過幾個的分布。純 CSS，沒有圖表套件。 */}
            <div className="yz-plc__hist">
              <span className="yz-plc__histhead">會通過幾個</span>
              <div className="yz-plc__histbars">
                {result.combo.passCountDistribution.map((d) => (
                  <span key={d.passes} className="yz-plc__histcol">
                    <span
                      className={`yz-plc__histbar${d.passes === 0 ? ' yz-plc__histbar--zero' : ''}`}
                      style={{ height: `${Math.round(d.p * 100)}%` }}
                    />
                    <span className="yz-plc__histtick">{d.passes}</span>
                    <span className="yz-plc__histp">{pct(d.p)}</span>
                  </span>
                ))}
              </div>
              <span className="yz-plc__histwhy">
                最左邊那一根是<strong>六個都沒過第一階段</strong>的機率。這個數字比「每一個
                志願的機率」更接近你真正要決定的事。
              </span>
            </div>

            {result.combo.warnings.map((w) => (
              <Note key={w.code} tone={w.code === 'EXCLUDED' ? 'info' : 'warn'}>
                <Emph text={w.text} />
              </Note>
            ))}

            {/* ── 逐志願 ──────────────────────────────────── */}
            <h2 className="yz-card__title" style={{ marginTop: 30 }}>
              逐個志願
            </h2>
            <ul className="yz-plc__list">
              {result.wishes.map((w, i) => (
                <li key={w.wishId ?? `${w.institutionName}-${i}`} className="yz-plc__item">
                  <div className="yz-plc__head">
                    <span className="yz-plc__rank">志願 {w.rank ?? i + 1}</span>
                    <span className="yz-plc__name">
                      {w.institutionName}
                      {w.programName ? `　${w.programName}` : ''}
                    </span>
                    {w.passRate === null ? (
                      <span className="yz-plc__none">{TIER_LABELS.NO_ESTIMATE}</span>
                    ) : (
                      <>
                        <span
                          className={`yz-plc__rate${w.tier === 'HIGH_UNCERTAINTY' ? ' yz-plc__rate--soft' : ''}`}
                        >
                          {pct(w.passRate)}
                        </span>
                        <span className={`yz-plc__risk yz-plc__risk--${(w.risk ?? '').toLowerCase()}`}>
                          {RISK_LABEL[w.risk ?? ''] ?? ''}
                        </span>
                      </>
                    )}
                  </div>

                  {w.passRate !== null && (
                    <>
                      <div className="yz-plc__gauge" role="img" aria-label={`通過第一階段的機率 ${pct(w.passRate)}`}>
                        <span className="yz-plc__gaugefill" style={{ width: `${w.passRate * 100}%` }} />
                        <span className="yz-plc__gaugecut" style={{ left: '30%' }} />
                        <span className="yz-plc__gaugecut" style={{ left: '70%' }} />
                      </div>
                      {/* §8.4：每一個機率旁邊都要標示資料基礎。 */}
                      <p className="yz-plc__basis">
                        <span className="yz-plc__basisitem">
                          資料年度 {w.thresholdYears.length > 0 ? w.thresholdYears.join('、') : '無'}
                        </span>
                        <span className="yz-plc__basisitem">可靠度 {w.reliability.score.toFixed(2)}</span>
                        <span className="yz-plc__basisitem">
                          最後查詢 {w.reliability.lookedUpAt?.slice(0, 10) ?? '不明'}
                        </span>
                        <span className="yz-plc__basisitem">
                          相關性 {CORR_LABEL[result.correlation.source] ?? result.correlation.source}
                        </span>
                      </p>
                      {w.tier === 'HIGH_UNCERTAINTY' && (
                        <p className="yz-plc__soft">
                          <strong>估計不確定性較高。</strong>
                          這個志願的資料可靠度是 {w.reliability.score.toFixed(2)}（在 0.4 與 0.7
                          之間），所以這個百分比要當成一個很粗的方向而不是一個數字。
                          可靠度的四個因子：來源 {w.reliability.factors.source?.toFixed(2)}、
                          新鮮度 {w.reliability.factors.freshness?.toFixed(2)}、
                          校系穩定度 {w.reliability.factors.programStability?.toFixed(2)}、
                          跨年度難度校正 {w.reliability.factors.yearCalibration?.toFixed(2)}
                          （這一項是常數，因為那個校正需要大考中心的級分累計表，本系統沒有）。
                        </p>
                      )}
                    </>
                  )}

                  {/* 篩選：順序、門檻、倍率，以及每一關擋掉多少 */}
                  {w.stages.length > 0 && (
                    <ol className="yz-plc__stages">
                      {w.stages.map((s, k) => (
                        <li key={k} className="yz-plc__stage">
                          <span className="yz-plc__stageno">第 {k + 1} 篩</span>
                          <span className="yz-plc__stagesub">{s.label}</span>
                          <span className="yz-plc__stagethr">{s.threshold} 級分以上</span>
                          {s.multiple !== null && (
                            <span className="yz-plc__stagemul">倍率 {s.multiple}</span>
                          )}
                          {s.failRate !== null && (
                            <span className="yz-plc__stagefail">
                              在這一關被擋掉 {pct(s.failRate)}
                            </span>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}

                  {w.qualify.length > 0 && (
                    <p className="yz-plc__qualify">
                      <span className="yz-plc__qualifyhead">檢定標準</span>
                      {w.qualify.map((q) => q.describe).join('、')}
                      {w.qualifyFailRate !== null && (
                        <span className="yz-plc__qualifyfail">
                          　檢定就沒過的機率 {pct(w.qualifyFailRate)}
                        </span>
                      )}
                      {w.undecidableQualify > 0 && (
                        <span className="yz-plc__qualifywarn">
                          　其中 {w.undecidableQualify} 條沒有換算成級分，所以<strong>沒有檢查</strong>
                        </span>
                      )}
                    </p>
                  )}

                  {w.thresholdRefs.length > 0 && (
                    <ul className="yz-plc__refs">
                      {w.thresholdRefs.map((r) => (
                        <li key={r.year}>
                          <span className="yz-plc__refyear">{r.year} 學年度</span>
                          <span className="yz-plc__refval">
                            {r.subjects.map((s, k) => `${s} ${r.grades[k]}`).join('、')}
                          </span>
                          <span className="yz-plc__refsrc">
                            {r.sourceLabel}
                            {r.lookedUpAt ? `　${r.lookedUpAt} 查` : ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {w.notes.map((n, k) => (
                    <p key={k} className="yz-plc__note">
                      <Emph text={n} />
                    </p>
                  ))}
                </li>
              ))}
            </ul>

            {/* ── 相關性 ──────────────────────────────────── */}
            <h2 className="yz-card__title" style={{ marginTop: 30 }}>
              六科之間的相關性
            </h2>
            <p className="yz-hint">
              <Emph text={result.correlation.note} />
            </p>
            <p className="yz-hint">
              為什麼這件事重要：預測給的是<strong>逐科</strong>的分布，而個申的篩選常常用到
              多科總級分。四科獨立時總和的標準差是 2σ，四科完全連動時是 4σ——
              <strong>同一個門檻算出來的通過率會差好幾倍</strong>。獨立抽樣會嚴重低估多科
              組合的變異，而低估的方向會讓機率看起來比它該有的樣子更確定。
            </p>
            {result.correlation.pairs && result.correlation.pairs.length > 0 && (
              <ul className="yz-plc__corr">
                {result.correlation.pairs.map((p) => (
                  <li key={`${p.a}-${p.b}`}>
                    <span className="yz-plc__corrpair">
                      {p.a}／{p.b}
                    </span>
                    <span className="yz-plc__corrval">{p.used.toFixed(2)}</span>
                    <span className="yz-plc__corrsrc">
                      {p.fallback
                        ? `同時有成績的場次只有 ${p.commonExams} 場，用保守預設值`
                        : `由 ${p.commonExams} 場模考的殘差估出`}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {result.missingSubjects.length > 0 && (
              <Note tone="warn">
                {result.missingSubjects.join('、')} 這幾科<strong>還沒有級分分布</strong>
                （模考次數不足），所以用到它們的志願一律顯示「無法估計」。
                <Link href="/admission/predict" style={{ marginLeft: 6 }}>
                  去補級分記錄
                </Link>
              </Note>
            )}

            {latest && latest.unmatched.length > 0 && (
              <Note tone="info">
                有 {latest.unmatched.length} 筆門檻資料對不上你目前的個申志願（
                {latest.unmatched.map((u) => u.institutionName).join('、')}）。
                這通常代表你在比較還沒填成志願的校系——那是好事。也可能是校名打錯了。
              </Note>
            )}

            {/* ── 第二階段：明確的能力邊界 ──────────────────── */}
            <h2 className="yz-card__title" style={{ marginTop: 30 }}>
              第二階段
            </h2>
            <Note tone="warn">
              <Emph text={result.stageTwoNote} />
            </Note>

            {/* ── 這個數字為什麼會變 ─────────────────────────── */}
            {runs.length > 1 && (
              <>
                <h2 className="yz-card__title" style={{ marginTop: 30 }}>
                  這個數字為什麼會變
                </h2>
                <p className="yz-hint">
                  每一次模擬都存了<strong>當時的輸入快照</strong>：那時候的級分分布、那時候
                  採用的門檻（含每一筆的來源與查詢日期）、以及那時候的志願清單。
                  「上週看到的是 60%，現在怎麼變 45%」這個問題答得出來——
                  <strong>不是程式在跳，是輸入不一樣了。</strong>
                </p>
                <ul className="yz-plc__runs">
                  {runs.map((r) => {
                    const res = r.result as unknown as PlacementResult;
                    return (
                      <li key={r.id}>
                        <span className="yz-plc__runwhen">
                          {r.runAt.slice(0, 16).replace('T', ' ')}
                        </span>
                        <span className="yz-plc__runasof">資料至 {r.dataAsOf.slice(0, 10)}</span>
                        <span className="yz-plc__runseed">種子 {r.seed ?? '—'}</span>
                        <span className="yz-plc__runsum">
                          至少通過一個 {res?.combo ? pct(res.combo.atLeastOne) : '—'}
                          {res?.combo ? `　期望 ${res.combo.expectedPasses.toFixed(2)} 個` : ''}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </>
        )}
      </main>
    );
  });
}
