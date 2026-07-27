/**
 * 權利聲明。
 *
 * 訪談第 7 題：「都有（不過會確保放進來之前都向原作者／著作權人
 * 處理好版權了）」。這句話是使用者的承諾，不是系統的保證 ——
 * 系統要做的是**讓那個承諾留下記錄，並讓它決定題目日後的用途**。
 *
 * 所以每一次匯入都必須回答三件事：
 *   1. 這批題目從哪裡來（sourceType）
 *   2. 你憑什麼可以用（rightsBasis）
 *   3. 因此它可以流通到多遠（licenseScope）
 *
 * 第三項不是自由填的 —— 它由前兩項推導出上限。這一層與
 * 資料庫的 CHECK 約束是同一組規則，寫兩遍是刻意的：
 * 應用層給得出人看得懂的理由，資料庫層擋得住繞過應用層的寫入。
 */

export const SOURCE_TYPES = [
  'OFFICIAL_PAST',
  'TEACHER_ORIGINAL',
  'SCHOOL_EXAM',
  'PUBLISHER_SCAN',
  'AI_GENERATED',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const LICENSE_SCOPES = [
  'PUBLIC',
  'TENANT_EXPORTABLE',
  'TENANT_NO_EXPORT',
  'INTERNAL_USE_ONLY',
] as const;
export type LicenseScope = (typeof LICENSE_SCOPES)[number];

export const RIGHTS_BASES = ['OWNED', 'LICENSED', 'OFFICIAL_PUBLIC', 'UNVERIFIED'] as const;
export type RightsBasis = (typeof RIGHTS_BASES)[number];

/** 給介面用的說明。用老師的語言，不是法律的語言。 */
export const SOURCE_TYPE_LABELS: Record<SourceType, { label: string; hint: string }> = {
  OFFICIAL_PAST: {
    label: '歷屆試題',
    hint: '學測、指考、分科測驗的正式試題。依著作權法第 9 條，考試試題不受著作權保護。',
  },
  TEACHER_ORIGINAL: {
    label: '老師自編',
    hint: '本班老師自己出的題目。著作權屬於補習班或該位老師。',
  },
  SCHOOL_EXAM: {
    label: '學校段考卷',
    hint: '合作學校提供的段考、複習考題本。需要學校同意才能建檔。',
  },
  PUBLISHER_SCAN: {
    label: '出版社講義',
    hint: '參考書、講義、題本的掃描或翻拍。一律限本補習班內部使用，不可匯出。',
  },
  AI_GENERATED: {
    label: 'AI 生成',
    hint: '由系統依知識點生成的題目。需經老師審閱後才會發布。',
  },
};

export const RIGHTS_BASIS_LABELS: Record<RightsBasis, string> = {
  OWNED: '本補習班或本校老師自有',
  LICENSED: '已取得著作權人書面同意',
  OFFICIAL_PUBLIC: '官方公開資料，不受著作權保護',
  UNVERIFIED: '尚未確認（僅供內部參考，解析一律改寫）',
};

/**
 * 某個來源允許的最大流通範圍。
 *
 * 「允許」的意思是上限而非預設 —— 使用者可以選更保守的範圍，
 * 但不能選更寬的。
 */
export function allowedScopes(source: SourceType): LicenseScope[] {
  switch (source) {
    case 'OFFICIAL_PAST':
      // 唯一可以 PUBLIC 的來源。
      return ['PUBLIC', 'TENANT_EXPORTABLE', 'TENANT_NO_EXPORT', 'INTERNAL_USE_ONLY'];
    case 'PUBLISHER_SCAN':
      // 出版社內容一律不可匯出。這是資料庫 CHECK 約束
      // questions_license_matches_source 的同一條規則。
      return ['TENANT_NO_EXPORT', 'INTERNAL_USE_ONLY'];
    default:
      return ['TENANT_EXPORTABLE', 'TENANT_NO_EXPORT', 'INTERNAL_USE_ONLY'];
  }
}

export function defaultScope(source: SourceType): LicenseScope {
  return source === 'PUBLISHER_SCAN' ? 'TENANT_NO_EXPORT' : 'TENANT_EXPORTABLE';
}

export type RightsDeclaration = {
  sourceType: SourceType;
  licenseScope: LicenseScope;
  rightsBasis: RightsBasis;
  rightsNote?: string;
};

/**
 * 驗證聲明是否自洽。回傳錯誤訊息，或 null 代表通過。
 *
 * 這裡的檢查刻意在**上傳時**而不是入庫時做。理由是流程成本：
 * 老師花 20 分鐘校完 50 題之後才被告知「這批不能存」，
 * 是對他時間最不尊重的失敗方式。
 */
export function validateDeclaration(d: RightsDeclaration): string | null {
  if (!allowedScopes(d.sourceType).includes(d.licenseScope)) {
    if (d.sourceType === 'PUBLISHER_SCAN') {
      return '出版社講義一律限本補習班內部使用、不可匯出。請把「流通範圍」改為「僅本補習班（不可匯出）」。';
    }
    if (d.licenseScope === 'PUBLIC') {
      return '只有歷屆試題可以設為公開。其他來源請選擇補習班內部的流通範圍。';
    }
    return `來源「${SOURCE_TYPE_LABELS[d.sourceType].label}」不允許此流通範圍。`;
  }

  if (d.sourceType === 'OFFICIAL_PAST' && d.rightsBasis === 'UNVERIFIED') {
    return '歷屆試題的權利基礎請選「官方公開資料」。';
  }

  if (d.rightsBasis === 'LICENSED' && !d.rightsNote?.trim()) {
    return '選擇「已取得書面同意」時，請在備註寫明同意的來源與日期，日後查核才有依據。';
  }

  if (d.sourceType === 'PUBLISHER_SCAN' && d.rightsBasis === 'OFFICIAL_PUBLIC') {
    return '出版社講義不是官方公開資料。請改選「已取得書面同意」或「尚未確認」。';
  }

  return null;
}

/**
 * 權利基礎會不會影響解析的處理方式。
 *
 * UNVERIFIED 的解析不得原文呈現，一律要 AI 改寫 —— 這是資料庫
 * CHECK 約束 explanations_unverified_must_rewrite 的規則。
 * 在上傳時就告訴老師，比在解析頁面上出現一句看不懂的錯誤好。
 */
export function explanationPolicy(basis: RightsBasis): string {
  return basis === 'UNVERIFIED'
    ? '這批題目的詳解不會原文收錄，系統會依原文重新撰寫後才呈現給學生。'
    : '這批題目的詳解可以原文收錄。';
}
