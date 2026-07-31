/**
 * 型別宣告。實作在 admissionRef.mjs——純函式，不碰資料庫，所以測得動。
 *
 * **副檔名是 `.d.mts` 而不是 `.d.ts`。** TypeScript 為 `./x.mjs` 找宣告檔
 * 時只看 `./x.d.mts`；放成 `x.d.ts` 它會安靜地略過，改用 `allowJs` 從實作
 * 推論——而 `references = []` 這種預設值推出來的是 `any[]`，於是
 * `{ ...ref, trust }` 展開之後**原本的欄位全部消失**，資料層讀 `ref.year`
 * 會被判成錯誤，而錯誤訊息指的地方跟原因差很遠。
 * 同一段說明見 takeState.d.mts 與 proctor.d.mts。
 */

export type SourceKindValue =
  | 'OFFICIAL_DOC'
  | 'SCHOOL_OFFICE'
  | 'CRAM_TEACHER'
  | 'STUDENT_NOTE'
  | 'HEARSAY';

export type RefKindValue =
  | 'STAR_ROUND1'
  | 'STAR_ROUND2'
  | 'STAR_VACANCY'
  | 'SIEVE_THRESHOLD'
  | 'QUALIFY'
  | 'MY_PERCENTILE'
  | 'NOTE';

export type SourceKindMeta = {
  value: string;
  label: string;
  hint: string;
  trust: number;
};

export type RefKindMeta = {
  value: string;
  label: string;
  shape: 'percentile' | 'count' | 'sieve' | 'rules' | 'text';
  threshold: boolean;
  unit: string;
  hint: string;
  selfOnly?: boolean;
};

export declare const SOURCE_KINDS: SourceKindMeta[];
export declare const REF_KINDS: RefKindMeta[];
export declare const STALE_DAYS: number;

export declare const TRUST_SOLID: 'SOLID';
export declare const TRUST_WORKABLE: 'WORKABLE';
export declare const TRUST_WEAK: 'WEAK';
export type TrustLevel = 'SOLID' | 'WORKABLE' | 'WEAK';
export declare const TRUST_LABELS: Record<TrustLevel, string>;

export declare function sourceTrustOf(sourceKind: unknown): SourceKindMeta;
export declare function refKindOf(kind: unknown): RefKindMeta | null;

export declare function buildRefValue(
  kind: string,
  input?: Record<string, unknown>,
): { ok: boolean; value: Record<string, unknown> | null; error: string };

export declare function describeRefValue(kind: string, value: unknown): string;
export declare function numbersIn(kind: string, value: unknown): string[];

export type Staleness = {
  stale: boolean;
  staleBy: number;
  ageDays: number | null;
  old: boolean;
};

export declare function stalenessOf(
  ref: { year?: number; staleAfterYear?: number | null; lookedUpAt?: Date | string | null },
  ctx?: { currentYear?: number; now?: Date },
): Staleness;

export type Trust = Staleness & {
  level: TrustLevel;
  label: string;
  sourceLabel: string;
  sourceTrust: number;
  notes: string[];
};

export declare function trustOf(
  ref: {
    sourceKind?: string | null;
    year?: number;
    staleAfterYear?: number | null;
    lookedUpAt?: Date | string | null;
  },
  ctx?: { currentYear?: number; now?: Date },
): Trust;

/**
 * 繁星校內賽局的參賽名單。**兩份輸入都收，只用教務處那一份。**
 *
 * `references` 收進來只為了把自填百分比列進 `ignoredSelfEntered` 報出去，
 * 它一筆都不會影響排序——理由與測試見 admissionRef.mjs 的 §5。
 */
export declare function starParticipants(input?: {
  wishes?: {
    userId: string;
    institutionName: string;
    starGroup: number;
    wishRank?: number;
  }[];
  officialRanks?: { userId: string; percentile: number }[];
  references?: {
    userId: string;
    kind: string;
    value?: { percentile?: number } | null;
    forSelfOnly?: boolean;
  }[];
}): {
  participants: {
    userId: string;
    percentile: number | null;
    institutionName: string;
    starGroup: number;
    wishRank?: number;
  }[];
  ignoredSelfEntered: { userId: string; percentile: number; reason: string }[];
};

/**
 * 一筆參考資料算完信任度之後的樣子。
 *
 * `sourceRef` 與 `lookedUpAt` **不是選填**。它們在 schema 是 NOT NULL，
 * 而理由寫在 AdmissionReference 的註解裡：一個沒有來源的數字，三個月後
 * 與一個有來源的長得一模一樣。宣告成選填的話，建議那一側讀
 * `r.lookedUpAt.slice(...)` 就得先判 undefined，於是很容易寫成
 * 「沒有日期就不顯示日期」——而那正好是這張表要防的事。
 */
export type ScoredReference = {
  id: string;
  year: number;
  channel: string;
  kind: string;
  kindLabel: string;
  institutionName: string;
  programName: string | null;
  starGroup: number | null;
  /** 形狀由 `kind` 決定（見 `RefKindMeta.shape`），所以是幾種的聯集。 */
  value: RefValue;
  sourceKind: string;
  sourceRef: string;
  lookedUpAt: string;
  staleAfterYear: number;
  forSelfOnly: boolean;
  note: string | null;
  describe: string;
  trust: Trust;
};

/** `AdmissionReference.value` 的幾種形狀，一起宣告。 */
export type RefValue = {
  percentile?: number;
  count?: number;
  subjects?: string[];
  grades?: number[];
  rules?: string;
  text?: string;
};

export type AdviceGap = {
  code: string;
  text: string;
  /** 這一項該去哪裡查（`AdmissionReference.kind`）。 */
  lookFor?: string;
};

export type AdviceBasis = {
  year: number;
  references: ScoredReference[];
  thresholds: ScoredReference[];
  /** 教務處匯入的那一份。**這一份才是模擬用的。** */
  officialPercentile: number | null;
  /** 學生自己輸入的。只用於他自己的建議。 */
  selfPercentile: number | null;
  selfPercentileRef: ScoredReference | null;
  starWishes: unknown[];
  gaps: AdviceGap[];
  /** 全部門檻資料涵蓋的年份（跨校系合計）。**不要拿它驗「近三年」。** */
  yearsWithThreshold: number[];
  /** 逐校系的年份。「近三年」講的一定是其中一個校系。 */
  targets: {
    key: string;
    institutionName: string;
    programName: string | null;
    starGroup: number | null;
    label: string;
    years: number[];
  }[];
  /** 任何**單一校系**最多有幾年。 */
  maxYearsPerTarget: number;
  numbers: string[];
  hasOfficialDoc: boolean;
  hasSchoolOffice: boolean;
};

export declare function adviceBasis(input?: {
  references?: ScoredReference[];
  officialPercentile?: number | null;
  wishes?: { channel: string; [k: string]: unknown }[];
  year: number;
  now?: Date;
}): AdviceBasis;
