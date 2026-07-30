/**
 * 查資料清單的呈現。
 *
 * # 兩種網址在畫面上必須長得不一樣
 *
 * **推得出來的**（`star{民國年}`）：給連結，但連結旁邊一定有一句
 * 「這個網址是依學年度推出來的，打不開就從委員會首頁進去」，而首頁的
 * 連結就擺在旁邊。理由是**一個死連結比沒有連結更讓人卡住**——學生點
 * 下去看到 404，他的結論是「這個系統壞了」而不是「我該從首頁進去找」。
 *
 * **推不出來的**（篩選標準一覽表）：只給入口，然後把導覽步驟寫成一串
 * 「首頁 → 申請入學 → 篩選標準一覽表」。**不給深連結**，因為那一頁的
 * 路徑每年重新產生一串亂碼（文件 07 §3.5），寫死的話它明年變成 404，
 * 而畫面上仍然有一個看起來完全正常的連結。這一條在 `admissionSources.mjs`
 * 有測試釘著：回傳值裡不可以出現任何路徑片段。
 *
 * **查不到的**（在校百分比、校內推薦辦法）：`url` 是 null，畫面上顯示的
 * 是一個不能點的標籤加一句「網路上查不到，去教務處」。做成一個灰色的
 * 連結的話，學生會一直點它。
 *
 * # 為什麼這是伺服器元件
 *
 * 因為它沒有互動。清單是純資料，`sourceChecklist()` 在伺服器端算完直接
 * 渲染——沒有理由把一份靜態清單與整個 `admissionSources.mjs` 送到瀏覽器。
 */
import type { ChecklistStep, SourceWhere } from '@/lib/admissionSources.d.mts';

import { Emph } from '../Emph';

/** 外部連結一律新窗開啟。學生正在填的表單不該被一次查資料弄丟。 */
function Out({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="yz-ref__link">
      {children}
      <span aria-hidden="true"> ↗</span>
    </a>
  );
}

function Where({ w }: { w: SourceWhere }) {
  return (
    <li className="yz-ref__where">
      <span className={`yz-ref__urlkind yz-ref__urlkind--${w.urlKind.toLowerCase()}`}>
        {w.urlKind === 'DERIVED' ? '推導出來的網址' : w.urlKind === 'FIXED' ? '查證過的網址' : '沒有固定網址'}
      </span>

      {w.url ? (
        <Out href={w.url}>{w.label}</Out>
      ) : (
        // 不做成連結。做成灰色連結的話，學生會一直點它。
        <span className="yz-ref__nolink">{w.label}</span>
      )}

      {w.navigation && w.navigation.length > 0 && (
        <span className="yz-ref__nav">
          進去之後：{w.navigation.join(' → ')}
        </span>
      )}

      {w.caution && (
        <span className="yz-ref__caution">
          <Emph text={w.caution} />
        </span>
      )}

      {w.fallback && (
        <span className="yz-ref__fallback">
          打不開就走這裡：<Out href={w.fallback}>{w.fallbackLabel ?? w.fallback}</Out>
        </span>
      )}
    </li>
  );
}

export default function SourceGuide({ steps, year }: { steps: ChecklistStep[]; year: number }) {
  return (
    <ol className="yz-ref__steps">
      {steps.map((s, i) => (
        <li key={s.key} className="yz-ref__step">
          <div className="yz-ref__stephead">
            <span className="yz-ref__stepno" aria-hidden="true">
              {i + 1}
            </span>
            <span className="yz-ref__stepwhen">{s.when}</span>
            <span className="yz-ref__steptitle">{s.title}</span>
          </div>

          <p className="yz-ref__what">
            <Emph text={s.what} />
          </p>

          <ul className="yz-ref__wheres">
            {s.where.map((w, j) => (
              <Where key={`${s.key}-${j}`} w={w} />
            ))}
          </ul>

          <p className="yz-ref__record">
            {s.recordAs ? (
              <>
                <span className="yz-ref__recordtag">查到之後 → 填「{s.recordAs.label}」</span>
                <Emph text={s.recordHint} />
              </>
            ) : (
              <>
                <span className="yz-ref__recordtag yz-ref__recordtag--none">不必輸入系統</span>
                <Emph text={s.recordHint} />
              </>
            )}
          </p>
        </li>
      ))}
      <li className="yz-ref__step yz-ref__step--note">
        <p className="yz-hint">
          網址是<strong>給你點的</strong>，不是給程式抓的。{year} 學年度之後這幾個入口可能
          改版——固定入口（委員會首頁、大考中心、招聯會）比逐年的深連結穩定得多，
          所以打不開的時候從入口進去找，而不是等系統修好。
        </p>
      </li>
    </ol>
  );
}
