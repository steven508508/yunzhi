/**
 * 升學管道的制度規則引擎（N0），以及補救清單的排序（N6）。
 *
 * # 為什麼這一段要獨立成一個檔案，而且是純函式
 *
 * 因為升學制度的規則是**外部給定、每年會變、而且錯了會有實質後果**的。
 * 判定錯誤的症狀不是當機，是一個學生照著畫面上的「可以報名」去填了
 * 一個他根本沒有資格的管道，然後在放榜那天才知道。那時已經沒有補救
 * 的餘地——個人申請的放棄期限只有四天，錯過就整年重來。
 *
 * 所以會算錯的東西全部集中在這裡：沒有 import、不碰資料庫、每一條
 * 規則都可以用一個物件叫出來測。資料層（`lib/admissionDb.ts`）只負責
 * 讀出來丟給它算。**新的規則要加在這裡而不是那裡**——那裡沒有測試
 * 保護，因為它需要資料庫。
 *
 * # 管道狀態必須用兩個正交欄位，不能用單一列舉
 *
 * 這是整個模組最容易踩的坑，而且它很隱蔽。如果把繁星的狀態寫成
 * 「未錄取／第 1-7 類錄取／第 8 類錄取／已放棄」這樣的單一列舉，
 * 學生一旦放棄，**類別資訊就消失了**——系統再也分不出這位「已放棄」
 * 的學生原本是第 3 類（應永久封鎖個申）還是第 8 類（可報名但不可
 * 登記志願序）。兩者的後果完全相反，而畫面上長得一模一樣。
 *
 * 所以每個管道都是一組兩個欄位（schema 已經照這樣建好）：
 *
 *     特選：  specialAdmitted            specialWaived
 *     繁星：  starCategory ∈ {NONE, GROUP_1_7, GROUP_8}   starWaived
 *     個申：  applyAdmitted              applyWaived
 *
 * `starCategory` **一經錄取即固定，不因放棄而改變或清空**。
 *
 * # 三條規則的述詞形式各不相同，這正是它們容易被寫錯的原因
 *
 *   · 繁星對個申用的是**錄取類別**——與有沒有放棄完全無關。
 *   · 繁星第 8 類只封鎖「登記志願序」這**一個動作**，不封鎖報名，
 *     也不封鎖參加第二階段甄試。
 *   · 所有管道對分發用的都是**錄取且未放棄**——放棄後就解除。
 *
 * 三種形式各寫各的，不要試圖抽出一個「通用的管道封鎖」函式：那個
 * 抽象一定會把「與放棄無關」壓成「與放棄有關」，因為後者是三條裡的
 * 多數。多數決在這裡是錯的。
 *
 * # 為什麼判定的單位是「動作」而不是「管道」
 *
 * 因為第 8 類的存在。「可以報名個人申請」與「可以登記個申志願序」
 * 對他是兩個不同的答案，而把個申當成一個布林值就表達不出來——
 * 系統會在「不能報名」與「可以錄取」之間二選一，兩個都是錯的。
 *
 * # 系統不做自動阻擋
 *
 * 偵測到不可能的組合時，只說明後果，**不擋下來**。學生仍然可以規劃
 * 他想規劃的，系統只負責讓後果透明。這與文件 04 防作弊的「記錄而非
 * 中斷」是同一種立場：判斷錯的時候，「多說了一句話」是可以被回報的
 * 症狀，「不讓他存」不是——他只會換一張紙寫。
 */

// ═════════════════════════════════════════════════════════════════
// §1 狀態
// ═════════════════════════════════════════════════════════════════

/** 未錄取繁星。 */
export const STAR_NONE = 'NONE';
/** 繁星第 1 至 7 類：錄取後**永久**封鎖個人申請，放棄也沒用。 */
export const STAR_GROUP_1_7 = 'GROUP_1_7';
/** 繁星第 8 類（醫牙）：可報名個申、可考二階，但不可登記志願序。 */
export const STAR_GROUP_8 = 'GROUP_8';

/** 對應 schema 的 `StarCategory`。順序即測試笛卡兒積的順序。 */
export const STAR_CATEGORIES = [STAR_NONE, STAR_GROUP_1_7, STAR_GROUP_8];

/** 繁星學群 1 至 8。`Wish.starGroup` 收的就是這個。 */
export const STAR_GROUPS = [1, 2, 3, 4, 5, 6, 7, 8];

/** 個人申請的志願上限。 */
export const APPLY_WISH_LIMIT = 6;

/**
 * 由繁星**學群**推出繁星**錄取類別**。
 *
 * 這兩件事在資料模型上是分開的（`Wish.starGroup` 是學生想推的學群，
 * `AdmissionProfile.starCategory` 是他實際錄取的類別），但制度上
 * 第 8 類就是第 8 學群，所以規劃階段可以由前者推出後者的後果。
 */
export function categoryOfGroup(group) {
  const n = Number(group);
  if (n === 8) return STAR_GROUP_8;
  if (n >= 1 && n <= 7) return STAR_GROUP_1_7;
  return STAR_NONE;
}

/**
 * 補上 schema 的預設值，並把任何非布林值收斂成布林。
 *
 * 存在的理由是 `sameSchoolAll` 的預設是 **true**（其餘都是 false）：
 * `p.sameSchoolAll === true` 這種寫法會讓一列還沒填的資料被判成
 * 「不是全程同校」，於是整批學生的繁星資格被靜靜關掉。預設值只有
 * 一個地方知道，就是這裡。
 */
export function normalizeProfile(p = {}) {
  return {
    isRepeater: p.isRepeater === true,
    sameSchoolAll: p.sameSchoolAll !== false,
    specialAdmitted: p.specialAdmitted === true,
    specialWaived: p.specialWaived === true,
    starCategory: STAR_CATEGORIES.includes(p.starCategory) ? p.starCategory : STAR_NONE,
    starWaived: p.starWaived === true,
    applyAdmitted: p.applyAdmitted === true,
    applyWaived: p.applyWaived === true,
  };
}

// ═════════════════════════════════════════════════════════════════
// §2 三個共用述詞
//
// 刻意寫成三個各自獨立的函式而不是一個帶參數的通用版本。理由見檔頭：
// 它們的形式本來就不一樣，共用會把差異磨掉。
// ═════════════════════════════════════════════════════════════════

/**
 * 特選錄取且未放棄。
 *
 * 特選在**學測前**放榜，所以錄取且未放棄者會封鎖後續**全部三個管道**，
 * 包含繁星——繁星常被漏掉，因為直覺上會以為「在校成績」與「特選」
 * 是兩條互不相干的路。
 */
export function specialHolds(p) {
  return p.specialAdmitted && !p.specialWaived;
}

/**
 * 繁星錄取且未放棄。**只有分發那一條用得到它。**
 *
 * 個申那兩條用的是 `starCategory` 而不是這一個——寫錯成這一個的話，
 * 「繁星第 3 類已錄取且已放棄」的學生會被判成可以報名個人申請，
 * 而那是本模組最關鍵的一個錯誤。
 */
export function starHolds(p) {
  return p.starCategory !== STAR_NONE && !p.starWaived;
}

/** 個申分發錄取且未放棄。 */
export function applyHolds(p) {
  return p.applyAdmitted && !p.applyWaived;
}

// ═════════════════════════════════════════════════════════════════
// §3 五個動作的資格判定
//
// 每一條都直接對應規格書 §5.2 的一行，逐字對照得起來。
// ═════════════════════════════════════════════════════════════════

/** 可報名特殊選才 = 恆真（時序最早，前面沒有任何管道能封鎖它）。 */
export function canApplySpecial() {
  return true;
}

/**
 * 可報名繁星推薦 =
 *     NOT (特選.錄取 AND NOT 特選.已放棄)
 *     AND 應屆 AND 全程同校
 *
 * 規格書原文還有「五學期百分比達標 AND 通過學測檢定」兩項，但那兩項
 * 是**逐校系**的門檻（各校系自訂），而這一階段沒有校系資料庫（歷年
 * 篩選與檢定資料禁止爬取，見規格書 §1）。所以這裡只判管道層級的資格，
 * 校系層級的門檻在畫面上明說「本系統無法判定」而不是靜默當成通過。
 */
export function canApplyStar(p) {
  return !specialHolds(p) && !p.isRepeater && p.sameSchoolAll;
}

/**
 * 可報名個人申請 =
 *     繁星.錄取類別 ≠ 第1-7類          ← 放棄也沒用，永久封鎖
 *     AND NOT (特選.錄取 AND NOT 特選.已放棄)
 *
 * 第一條**沒有** `&& !p.starWaived`。這不是漏寫，是規格。
 */
export function canApplyApply(p) {
  return p.starCategory !== STAR_GROUP_1_7 && !specialHolds(p);
}

/**
 * 可登記個申志願序 =
 *     可報名個人申請
 *     AND 繁星.錄取類別 ≠ 第8類         ← 可報名可考二階，但不可登記志願序
 *
 * 同樣與放棄無關。
 */
export function canRegisterApplyPreference(p) {
  return canApplyApply(p) && p.starCategory !== STAR_GROUP_8;
}

/**
 * 可登記分發入學 =
 *     NOT (特選.錄取 AND NOT 特選.已放棄)
 *     AND NOT (繁星.錄取類別 ≠ 無 AND NOT 繁星.已放棄)
 *     AND NOT (個申.分發錄取 AND NOT 個申.已放棄)
 *
 * 三條都是「錄取且未放棄」——這是唯一一個放棄之後真的會解除的地方。
 */
export function canRegisterPlacement(p) {
  return !specialHolds(p) && !starHolds(p) && !applyHolds(p);
}

// ═════════════════════════════════════════════════════════════════
// §4 為什麼不行：把判定變成一句能唸出來的話
//
// 只回一個布林值是不夠的。學生看到「不可報名個人申請」的第一個反應
// 是「那我放棄繁星不就好了」，而那正是本模組最貴的一個誤解。
// 每一個封鎖都必須帶著「放不放棄有沒有用」一起出現。
// ═════════════════════════════════════════════════════════════════

/**
 * 解除方式。**這一欄才是輔導價值所在。**
 *
 *   WAIVE_*  放棄那個管道就解除
 *   NONE     放棄也沒用（或本來就不是放棄能改的事，例如非應屆）
 */
export const REMEDY = {
  WAIVE_SPECIAL: 'WAIVE_SPECIAL',
  WAIVE_STAR: 'WAIVE_STAR',
  WAIVE_APPLY: 'WAIVE_APPLY',
  NONE: 'NONE',
};

const SPECIAL_BLOCK = {
  code: 'SPECIAL_ADMITTED',
  remedy: REMEDY.WAIVE_SPECIAL,
  text:
    '特殊選才已錄取且尚未放棄。特選在學測前放榜，錄取後會封鎖後續全部三個管道，' +
    '包含繁星推薦在內。完成放棄之後，這三個管道的資格都會回來。',
};

/**
 * 這位學生做不了某個動作的原因。空陣列代表可以做。
 *
 * @param {string} action ACTIONS 之一
 * @param {object} profile 未正規化的 `AdmissionProfile` 形狀
 * @returns {{code: string, remedy: string, text: string}[]}
 */
export function blockersFor(action, profile) {
  const p = normalizeProfile(profile);
  const out = [];

  switch (action) {
    case 'SPECIAL_APPLY':
      // 恆真。時序最早，前面沒有東西能封鎖它。
      return out;

    case 'STAR_APPLY':
      if (specialHolds(p)) out.push(SPECIAL_BLOCK);
      if (p.isRepeater) {
        out.push({
          code: 'NOT_FRESH_GRADUATE',
          remedy: REMEDY.NONE,
          text: '繁星推薦限應屆畢業生。這一項不是放棄任何管道能改變的。',
        });
      }
      if (!p.sameSchoolAll) {
        out.push({
          code: 'NOT_SAME_SCHOOL',
          remedy: REMEDY.NONE,
          text: '繁星推薦要求高中在學期間全程就讀同一所學校未轉學。這一項無法補救。',
        });
      }
      return out;

    case 'APPLY_APPLY':
      if (p.starCategory === STAR_GROUP_1_7) {
        out.push({
          code: 'STAR_1_7_ADMITTED',
          remedy: REMEDY.NONE,
          text:
            '繁星推薦第 1 至 7 類已錄取。這一條看的是**錄取類別**而不是有沒有放棄——' +
            '就算完成放棄，個人申請的資格也不會恢復。',
        });
      }
      if (specialHolds(p)) out.push(SPECIAL_BLOCK);
      return out;

    case 'APPLY_PREFERENCE': {
      // 先繼承「可報名個人申請」的全部原因，順序才對得起來：
      // 不能報名的人當然也不能登記志願序，而那時該顯示的是前一個原因。
      out.push(...blockersFor('APPLY_APPLY', profile));
      if (p.starCategory === STAR_GROUP_8) {
        out.push({
          code: 'STAR_8_ADMITTED',
          remedy: REMEDY.NONE,
          text:
            '繁星推薦第 8 類（醫學、牙醫）已錄取。你**仍然可以報名個人申請、也可以參加' +
            '第二階段甄試**，但不能登記志願序——也就是實際上無法透過個人申請錄取。' +
            '這一條同樣與有沒有放棄無關。',
        });
      }
      return out;
    }

    case 'PLACEMENT_REGISTER':
      if (specialHolds(p)) out.push(SPECIAL_BLOCK);
      if (starHolds(p)) {
        out.push({
          code: 'STAR_ADMITTED',
          remedy: REMEDY.WAIVE_STAR,
          text:
            `繁星推薦${p.starCategory === STAR_GROUP_8 ? '第 8 類' : '第 1 至 7 類'}` +
            '已錄取且尚未放棄。與個人申請那一條不同，**這一條放棄之後就解除**。',
        });
      }
      if (applyHolds(p)) {
        out.push({
          code: 'APPLY_ADMITTED',
          remedy: REMEDY.WAIVE_APPLY,
          text:
            '個人申請已分發錄取且尚未放棄。放棄之後分發入學的資格就恢復，' +
            '但**放棄有期限（每年 6 月中的四天）**，錯過就再也不能參加分發。',
        });
      }
      return out;

    default:
      throw new Error(`未知的升學動作：${action}`);
  }
}

/**
 * 五個動作，含標題與「為什麼不行」。
 *
 * 順序是**時序**（特選 → 繁星 → 個申報名 → 個申志願序 → 分發），
 * 不是重要性。學生的規劃順序就是這個順序，而前面的每一步都會影響
 * 後面——照時序排，畫面本身就在講這件事。
 */
export const ACTIONS = [
  {
    key: 'SPECIAL_APPLY',
    label: '報名特殊選才',
    channel: 'SPECIAL',
    when: '高三上（學測前）',
  },
  {
    key: 'STAR_APPLY',
    label: '報名繁星推薦',
    channel: 'STAR',
    when: '學測後，3 月中放榜',
  },
  {
    key: 'APPLY_APPLY',
    label: '報名個人申請（含參加第二階段甄試）',
    channel: 'APPLY',
    when: '3 月報名，5 月放榜',
  },
  {
    key: 'APPLY_PREFERENCE',
    label: '登記個人申請志願序',
    channel: 'APPLY',
    when: '5 月中，統一分發前',
  },
  {
    key: 'PLACEMENT_REGISTER',
    label: '登記分發入學',
    channel: 'PLACEMENT',
    when: '7 月分科測驗後',
  },
];

/**
 * 一位學生的完整資格表。畫面直接照這個渲染。
 *
 * @returns {{key:string,label:string,channel:string,when:string,ok:boolean,
 *   blockers:{code:string,remedy:string,text:string}[]}[]}
 */
export function eligibility(profile) {
  return ACTIONS.map((a) => {
    const blockers = blockersFor(a.key, profile);
    return { ...a, ok: blockers.length === 0, blockers };
  });
}

/**
 * 判定與述詞的交叉檢查。**這是防止兩邊分家的唯一機制。**
 *
 * `blockersFor` 是給人看的（帶說明文字、帶解除方式），§3 那五條是
 * 規格的逐字翻譯。兩份實作遲早會分岐——有人改了文案順手改了條件，
 * 或有人加了新規則只加在其中一邊。這個函式把它們釘在一起，而且它在
 * 完整笛卡兒積的測試裡被叫過每一種組合。
 */
export function agreesWithPredicates(profile) {
  const p = normalizeProfile(profile);
  const expected = {
    SPECIAL_APPLY: canApplySpecial(),
    STAR_APPLY: canApplyStar(p),
    APPLY_APPLY: canApplyApply(p),
    APPLY_PREFERENCE: canRegisterApplyPreference(p),
    PLACEMENT_REGISTER: canRegisterPlacement(p),
  };
  return ACTIONS.every((a) => (blockersFor(a.key, p).length === 0) === expected[a.key]);
}

// ═════════════════════════════════════════════════════════════════
// §5 規劃階段的不可能組合
//
// 資格判定看的是**已經發生的事**。這一節看的是**還沒發生但已經注定
// 的事**——學生同時填了繁星第 3 類與六個個申志願時，這兩件事現在
// 都還沒有結果，但其中一種結果會讓另外六個志願全部作廢，而學生多半
// 不知道。這是本模組輔導價值最高的一塊。
//
// **一律不阻擋。** 只說明後果。
// ═════════════════════════════════════════════════════════════════

/** 嚴重度。BLOCK 是現在就不成立，FUTURE 是將來會互斥，INFO 是提醒。 */
export const SEVERITY = { BLOCK: 'BLOCK', FUTURE: 'FUTURE', INFO: 'INFO' };

const CHANNEL_LABEL = {
  SPECIAL: '特殊選才',
  STAR: '繁星推薦',
  APPLY: '個人申請',
  PLACEMENT: '分發入學',
};

/**
 * 這一份志願規劃裡有哪些組合是不可能同時成立的。
 *
 * @param {object} profile
 * @param {{id?:string, channel:string, rank?:number, starGroup?:number|null,
 *   institutionName?:string, programName?:string|null}[]} wishes
 * @returns {{code:string, severity:string, text:string, wishIds:string[]}[]}
 */
export function planConflicts(profile, wishes = []) {
  const p = normalizeProfile(profile);
  const out = [];
  const of = (ch) => wishes.filter((w) => w.channel === ch);
  const ids = (list) => list.map((w) => w.id).filter((v) => typeof v === 'string');

  const special = of('SPECIAL');
  const star = of('STAR');
  const apply = of('APPLY');
  const placement = of('PLACEMENT');

  // ── 一、將來會互斥的組合（都還沒發生，但注定二選一）──────────

  const star17 = star.filter((w) => categoryOfGroup(w.starGroup) === STAR_GROUP_1_7);
  const star8 = star.filter((w) => categoryOfGroup(w.starGroup) === STAR_GROUP_8);

  if (star17.length > 0 && apply.length > 0) {
    out.push({
      code: 'STAR_1_7_KILLS_APPLY',
      severity: SEVERITY.FUTURE,
      text:
        `你的繁星志願落在第 ${star17.map((w) => w.starGroup).join('、')} 類，` +
        `同時規劃了 ${apply.length} 個個人申請志願。` +
        `**若繁星錄取，這 ${apply.length} 個個申志願將全部失效，而且放棄繁星也無法挽回**——` +
        '個申的封鎖看的是繁星的錄取類別，不是有沒有放棄。' +
        '這樣規劃是可以的，但你要知道繁星一旦上了就是定案。',
      wishIds: ids([...star17, ...apply]),
    });
  }

  if (star8.length > 0 && apply.length > 0) {
    out.push({
      code: 'STAR_8_KILLS_APPLY_PREFERENCE',
      severity: SEVERITY.FUTURE,
      text:
        `你的繁星志願是第 8 類（醫學、牙醫），同時規劃了 ${apply.length} 個個人申請志願。` +
        '若繁星第 8 類錄取，你**仍然可以報名個申、也可以去考第二階段**，' +
        '但不能登記志願序——也就是考完了也不會被分發到。' +
        '這一條同樣不會因為放棄繁星而解除。',
      wishIds: ids([...star8, ...apply]),
    });
  }

  if (placement.length > 0 && (star.length > 0 || apply.length > 0)) {
    const src = [];
    if (star.length > 0) src.push('繁星');
    if (apply.length > 0) src.push('個人申請');
    out.push({
      code: 'EARLIER_CHANNEL_KILLS_PLACEMENT',
      severity: SEVERITY.FUTURE,
      text:
        `你規劃了 ${placement.length} 個分發入學志願。若${src.join('或')}錄取而你不放棄，` +
        '分發入學就不能登記。**這一條與前面兩條不同：放棄之後就解除。**' +
        '但個人申請的放棄有期限（每年 6 月中的四天），錯過就不能走分發。',
      wishIds: ids([...placement, ...star, ...apply]),
    });
  }

  if (special.length > 0 && (star.length > 0 || apply.length > 0 || placement.length > 0)) {
    out.push({
      code: 'SPECIAL_KILLS_EVERYTHING',
      severity: SEVERITY.FUTURE,
      text:
        '你規劃了特殊選才。特選在學測前放榜，一旦錄取而不放棄，' +
        '**後續三個管道（繁星、個人申請、分發入學）全部不能報名**。' +
        '放棄之後三個都會回來，所以真正要決定的是放榜那幾天要不要放棄。',
      wishIds: ids([...special]),
    });
  }

  // ── 二、依目前狀態，已經不成立的志願 ────────────────────────

  for (const [channel, action] of [
    ['STAR', 'STAR_APPLY'],
    ['APPLY', 'APPLY_APPLY'],
    ['PLACEMENT', 'PLACEMENT_REGISTER'],
  ]) {
    const list = of(channel);
    if (list.length === 0) continue;
    const blockers = blockersFor(action, p);
    if (blockers.length === 0) continue;
    out.push({
      code: `ALREADY_BLOCKED_${channel}`,
      severity: SEVERITY.BLOCK,
      text:
        `依你目前的狀態，${CHANNEL_LABEL[channel]}已經不能報名，` +
        `而這裡還有 ${list.length} 個${CHANNEL_LABEL[channel]}志願。` +
        blockers.map((b) => b.text).join(' '),
      wishIds: ids(list),
    });
  }

  // 個申已經可以報名但不能登記志願序（第 8 類）——這是唯一一個
  // 「志願還在、報名也還在、但注定分發不到」的狀態，特別容易被誤讀
  // 成一切正常。
  if (
    apply.length > 0 &&
    blockersFor('APPLY_APPLY', p).length === 0 &&
    blockersFor('APPLY_PREFERENCE', p).length > 0
  ) {
    out.push({
      code: 'APPLY_PREFERENCE_BLOCKED',
      severity: SEVERITY.BLOCK,
      text:
        `你可以報名這 ${apply.length} 個個人申請志願、也可以去考第二階段，` +
        '但**不能登記志願序**，所以不會被分發到任何一個。' +
        blockersFor('APPLY_PREFERENCE', p)
          .map((b) => b.text)
          .join(' '),
      wishIds: ids(apply),
    });
  }

  // ── 三、志願本身的數量與制度限制 ────────────────────────────

  if (apply.length > APPLY_WISH_LIMIT) {
    out.push({
      code: 'APPLY_OVER_LIMIT',
      severity: SEVERITY.BLOCK,
      text:
        `個人申請至多 ${APPLY_WISH_LIMIT} 個志願，這裡有 ${apply.length} 個。` +
        '系統不會替你砍掉多的那幾個，但報名時只能送出 ' +
        `${APPLY_WISH_LIMIT} 個。`,
      wishIds: ids(apply),
    });
  }

  // 每生限被推薦至一所大學的一個學群。多填的那些不是「備選」——
  // 它們根本不會被送出，而學生很容易以為填了兩個就是多一次機會。
  const positions = new Set(star.map((w) => `${w.institutionName}${w.starGroup}`));
  if (positions.size > 1) {
    out.push({
      code: 'STAR_MULTI_POSITION',
      severity: SEVERITY.BLOCK,
      text:
        `繁星推薦**每位學生只能被推薦到一所大學的一個學群**，而這裡有 ${positions.size} ` +
        '個不同的「大學 × 學群」。實際送出的只會是志願序最前面的那一個，' +
        '後面幾個不是備選，是不存在。',
      wishIds: ids(star),
    });
  }

  return out;
}

// ═════════════════════════════════════════════════════════════════
// §6 明確不做的事
//
// 寫成資料而不是散在各頁的 JSX，因為它必須在**每一個學生會期待看到
// 這些功能的地方**都出現同一句話。少寫一處的後果不是版面不一致，
// 是學生以為系統沒給是因為還沒算完，然後一直等。
//
// 每一條都要說得出「為什麼不做」，而且理由必須是事實而不是「暫不
// 支援」。坊間工具給得出數字，學生會問為什麼這裡沒有。
// ═════════════════════════════════════════════════════════════════

export const NOT_OFFERED = [
  {
    key: 'APPLY_ODDS',
    title: '個人申請落點機率',
    body:
      '本系統不做落點機率預測，因為歷年篩選標準無法合法取得——招聯會全站的 ' +
      'robots.txt 禁止爬取，也沒有批次下載。沒有歷年門檻就沒有可以站得住的估計，' +
      '而給一個沒有根據的百分比比不給更糟：你會照著它決定要不要填。',
  },
  {
    key: 'GRADE_PREDICTION',
    title: '學測級分預測',
    body:
      '不做。要由作答記錄推估級分需要 IRT 能力估計（把題目難度與學生能力放在' +
      '同一把尺上），核心系統目前沒有這一段。用答對率硬換級分算得出數字，' +
      '但那個數字與你實際會考幾級分沒有關係。',
  },
  {
    key: 'SECOND_STAGE',
    title: '第二階段（面試、筆試）錄取機率',
    body:
      '不做，因為資料不存在。個人申請第二階段的錄取分數沒有全國統一表，' +
      '臺大、政大等校根本不公布。通過第一階段只是取得面試資格，' +
      '不等於錄取——這兩件事的機率不能混為一談。',
  },
  {
    key: 'STAR_ODDS',
    title: '繁星全國錄取機率',
    body:
      '校內的競爭位置這裡算得出來（那份資料只有學校自己有），但**全國**的比序不行。' +
      '官方公布的只有各校系最後一名錄取者的在校百分比，而繁星校系第一輪的名額常常' +
      '只有 1 至 3 名——每年只有一個極值資料點。用三年的極值推出「有幾成把握」，' +
      '那個數字的誤差比它本身還大。',
  },
  {
    key: 'PORTFOLIO',
    title: '學習歷程檔案輔助、面試準備',
    body: '這一階段還沒做。它需要另一批資料表（素材、草稿、AI 使用揭露記錄），不是把現有畫面改一改就有的。',
  },
];

// ═════════════════════════════════════════════════════════════════
// §7 N6 補救清單：接上能力分析
//
// 「距離目標還差多少」這一段做不了——那需要由目標校系的檢定與篩選
// 標準反推所需級分，而校系資料庫不存在（同 §6 第一條）。
//
// 做得了的是另外半段，而且它才是學生會反覆回來用的那一半：
// **在他已經知道自己弱在哪的前提下，哪幾塊最值得先補。**
// 排序依據是弱點程度乘上學測權重——一個掌握度 0.9 但權重 2.0 的
// 知識點，補起來的價值是 0.2；一個 0.3 但權重 1.0 的是 0.7。
// 直覺會挑前者（因為權重高），而那是錯的。
// ═════════════════════════════════════════════════════════════════

/** 補救價值：還沒學會的部分 × 它在學測上佔多少。 */
export function remediationValue(point) {
  const mastery = Number.isFinite(point.mastery) ? point.mastery : 0;
  const weight = Number.isFinite(point.gsatWeight) ? point.gsatWeight : 1;
  return (1 - mastery) * weight;
}

const pct = (v) => `${Math.round(v * 100)}%`;

/**
 * 一句**具體行動**。不是「加油」，不是「這一塊要加強」。
 *
 * 判斷順序沿用 `lib/ability.mjs` 的 `nextStep`（那一段有自己的測試），
 * 這裡只把它接到升學的語境：加上題數、掌握度與學測權重，讓學生看得出
 * 這一條為什麼排在第一。**沒有數字的建議不會被照做。**
 */
export function remediationAction(point) {
  const wrong = point.total - point.correct;
  const kind = point.step?.kind;
  const prereqName = point.step?.prereq?.name;

  const head =
    kind === 'STUCK'
      ? `找老師把「${point.name}」講一次——你在它上面連續錯了 ${point.streakWrong} 題，再多練也是連錯`
      : kind === 'PREREQ' && prereqName
        ? `先補前置「${prereqName}」，再回頭練「${point.name}」`
        : `練「${point.name}」`;

  return (
    `${head}。目前 ${point.total} 題錯 ${wrong} 題（掌握度 ${pct(point.mastery)}），` +
    `學測權重 ${point.gsatWeight}。`
  );
}

/**
 * 補救清單。
 *
 * @param {{points: object[], limit?: number}} input
 *   `points` 是 `lib/abilityDb.ts` 的 `studentAbility()` 那一份，
 *   外加 `gsatWeight`。**資料不足的知識點不進清單**——兩題算出來的
 *   掌握度看起來與二十題的一樣精確，而學生會照著它決定先補哪一塊。
 */
export function remediationPlan({ points = [], limit = 8 } = {}) {
  const scored = points
    .filter((p) => p.reliable)
    .map((p) => ({
      id: p.id,
      name: p.name,
      subjectId: p.subjectId,
      subjectName: p.subjectName,
      mastery: p.mastery,
      correct: p.correct,
      total: p.total,
      gsatWeight: Number.isFinite(p.gsatWeight) ? p.gsatWeight : 1,
      value: remediationValue(p),
      action: remediationAction({
        ...p,
        gsatWeight: Number.isFinite(p.gsatWeight) ? p.gsatWeight : 1,
      }),
    }))
    .sort((a, b) => {
      if (b.value !== a.value) return b.value - a.value;
      // 同分時題數多的排前面：同樣的補救價值，做過 20 題的那一個
      // 比做過 6 題的那一個更確定。與 ability.mjs 的 weakestFirst 同一條。
      return b.total - a.total;
    });

  return {
    items: scored.slice(0, limit),
    /** 資料不足、還下不了結論的。列出來但**不給掌握度**。 */
    thin: points
      .filter((p) => !p.reliable)
      .map((p) => ({
        id: p.id,
        name: p.name,
        subjectName: p.subjectName,
        correct: p.correct,
        total: p.total,
      })),
    total: scored.length,
  };
}

// ═════════════════════════════════════════════════════════════════
// §8 學年度
//
// `AdmissionProfile.year` 等三張表用的是**民國學年度**（115），不是
// 西元年，也不是 `AcademicYear` 的主鍵。理由是升學制度是以學年度為
// 單位公告的（「115 學年度繁星推薦招生簡章」），而補習班的班級學年度
// 是自己開的——兩者對不上時，要對上的是簡章那一邊。
// ═════════════════════════════════════════════════════════════════

/**
 * 現在是民國幾學年度。學年度自 8 月起算。
 *
 * 差一年的後果不是顯示錯誤：學生的志願會被寫到隔一個學年度去，
 * 而繁星模擬只看同一學年度的資料，於是他在畫面上看到「你沒有填
 * 繁星志願」——他明明剛剛才填完。
 */
export function admissionYearOf(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const roc = d.getFullYear() - 1911;
  return d.getMonth() + 1 >= 8 ? roc : roc - 1;
}

// ═════════════════════════════════════════════════════════════════
// §9 在校成績百分比的 CSV
//
// 這一份是教務處給的，所以**不要求他們把標題改成系統認得的名字**。
// 理由與名冊匯入（`lib/rosterColumns.mjs`）相同：要求先整理一次資料，
// 等於要求他們先做那件他們想用系統來避免的事。
// ═════════════════════════════════════════════════════════════════

export const RANK_COLUMNS = {
  username: ['學號', '學生學號', '座號', '編號', 'id', 'student_id', 'sid'],
  percentile: [
    '百分比',
    '全校百分比',
    '在校成績百分比',
    '排名百分比',
    '百分位',
    'percentile',
    'pr',
  ],
  semesters: ['學期數', '採計學期數', '學期', 'semesters'],
};

/**
 * 一列一列讀出「學號 + 百分比」，讀不懂的列**留下來報給人看**。
 *
 * 靜靜跳過讀不懂的列是這類匯入最常見的錯：教務處匯了 300 列、
 * 系統收了 287 列，而畫面上寫著「匯入成功」。那 13 位學生的繁星
 * 模擬會顯示「還沒有你的在校成績」，而沒有人知道為什麼。
 *
 * @param {string[][]} table `parseCsv` 的輸出，第一列是標題
 * @param {Record<string, number>} cols `matchColumns` 的輸出
 */
export function parseRankRows(table, cols) {
  const rows = [];
  const problems = [];
  const seen = new Map();

  for (let i = 1; i < table.length; i++) {
    const line = i + 1; // 給人看的列號，含標題列
    const cell = (k) => (cols[k] !== undefined ? (table[i][cols[k]] ?? '') : '').trim();

    const username = cell('username');
    const raw = cell('percentile');
    if (!username && !raw) continue; // 空列

    if (!username) {
      problems.push({ line, message: '沒有學號' });
      continue;
    }
    if (seen.has(username)) {
      problems.push({ line, message: `學號 ${username} 與第 ${seen.get(username)} 列重複` });
      continue;
    }
    // 百分比可能寫成「3.5」「3.5%」「０３．５」。全形與百分號都要吃掉，
    // 否則 Number() 會回 NaN 而那一列被靜靜丟掉。
    const cleaned = raw
      .replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/%|％/g, '')
      .trim();
    const percentile = Number(cleaned);
    if (!cleaned || !Number.isFinite(percentile)) {
      problems.push({ line, message: `學號 ${username} 的百分比「${raw}」讀不懂` });
      continue;
    }
    // 繁星的在校百分比是 0 到 100（越小越好）。超出範圍多半是把
    // 「班排名」或「PR 值」放進來了，那兩個的方向與尺度都不一樣。
    if (percentile < 0 || percentile > 100) {
      problems.push({
        line,
        message: `學號 ${username} 的百分比 ${percentile} 不在 0 至 100 之間（越小越好）`,
      });
      continue;
    }

    const semRaw = cell('semesters');
    const semesters = semRaw && Number.isFinite(Number(semRaw)) ? Number(semRaw) : 5;

    seen.set(username, line);
    rows.push({ line, username, percentile, semesters });
  }

  return { rows, problems };
}
