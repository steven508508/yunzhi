/**
 * 校對介面的幾條判斷：選項編輯、存檔佇列、校對用時。
 *
 * # 為什麼這幾條要離開元件
 *
 * 它們的共同點是**判斷錯了畫面不會壞，只會安靜地把錯的東西寫進題庫**：
 *
 *   · 刪掉一個選項之後答案鍵沒跟著搬 —— 每個答對的學生都被判錯
 *   · 存檔連續失敗而標頭還寫「已儲存」 —— 老師關掉分頁，20 分鐘沒了
 *   · 校對用時算不出來 —— 業主驗收要看的那個數字沒有資料
 *
 * 三種都不會讓任何一支端對端測試變紅，所以它們必須在這裡被釘住
 * （`tests/reviewState.test.mjs`）。元件那邊只負責把狀態餵進來、
 * 把回傳畫出去，不再自己做判斷。
 *
 * 寫成 .mjs 而不是 .ts：與 `takeState.mjs` 同樣的理由——測試直接跑在
 * node 上，少一個建置步驟就少一個「忘了重新編譯」的失敗模式。
 * 型別由同名的 .d.mts 提供。
 */
import { normalizeOptions } from './questionShape.mjs';

// ─────────────────────────────────────────────────────────────────
// 一、選項編輯
// ─────────────────────────────────────────────────────────────────

/**
 * 剛按下「新增選項」、還沒打字的那一列的暫代內容。
 *
 * `normalizeOptions` 會把內容空白的選項丟掉（那是入庫時該有的行為），
 * 但**編輯途中不可以**：老師按了「新增選項」、游標還沒移過去，那一列
 * 就消失了。所以送進 `normalizeOptions` 之前先把空的換成一個絕不會
 * 出現在題本裡的字元，回來之後再換回空字串。
 *
 * 用 U+0000 而不是空白字串或「（空）」：前者會被 trim 掉，後者是老師
 * 真的可能打出來的字。
 */
const DRAFT = '\u0000';

function withDraftMarks(options) {
  return (Array.isArray(options) ? options : []).map((o, i) => {
    const content = String(o?.content ?? '');
    return {
      order: Number(o?.order) || i + 1,
      label: String(o?.label ?? '') || String(i + 1),
      content: content.trim() === '' ? DRAFT : content,
    };
  });
}

function stripDraftMarks(options) {
  return options.map((o) => (o.content === DRAFT ? { ...o, content: '' } : o));
}

/**
 * 重新編號並把答案鍵一起對映過去。
 *
 * **對映一律交給 `normalizeOptions`**，不在這裡自己算。入庫時走的是
 * 同一支（`lib/commit.ts`），兩邊分歧的症狀是「校對介面看起來對、
 * 入庫之後答案跑掉」——那種 bug 沒有人查得出來。
 */
function renumber(options, answerKeys) {
  const r = normalizeOptions(withDraftMarks(options), [...(answerKeys ?? [])]);
  return {
    options: stripDraftMarks(r.options),
    answerKeys: r.answerKeys,
    dropped: r.dropped,
  };
}

/**
 * 下一個選項的標籤。
 *
 * 題本上的標籤有三種寫法（1234／ABCD／甲乙丙丁），而老師新增的那一列
 * 要接得上前面幾列——標籤不一致的選項在答案卡上對不起來。
 */
export function nextOptionLabel(options) {
  const labels = (Array.isArray(options) ? options : [])
    .map((o) => String(o?.label ?? '').trim())
    .filter(Boolean);
  const n = labels.length;
  if (n === 0) return '1';
  if (labels.every((l) => /^\d+$/.test(l))) {
    return String(Math.max(...labels.map(Number)) + 1);
  }
  if (labels.every((l) => /^[A-Z]$/.test(l))) {
    const last = Math.max(...labels.map((l) => l.charCodeAt(0)));
    // Z 之後沒有下一個字母，退回用數字而不是產生 '['
    return last >= 90 ? String(n + 1) : String.fromCharCode(last + 1);
  }
  const CJK = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'];
  if (labels.every((l) => CJK.includes(l))) return CJK[n] ?? String(n + 1);
  return String(n + 1);
}

/** 新增一個空選項。內容留空，老師打完字才有意義。 */
export function addOption(options, answerKeys) {
  const base = renumber(options, answerKeys);
  return {
    options: [
      ...base.options,
      { order: base.options.length + 1, label: nextOptionLabel(base.options), content: '' },
    ],
    answerKeys: base.answerKeys,
    dropped: base.dropped,
  };
}

/**
 * 刪掉一個選項。
 *
 * 答案剛好指著被刪掉的那一個時，`dropped` 會帶回那個序號——呼叫端
 * 要說出來。安靜地把答案清掉，老師會以為自己還設過答案。
 */
export function removeOption(options, answerKeys, order) {
  const kept = (Array.isArray(options) ? options : []).filter(
    (o) => Number(o?.order) !== Number(order),
  );
  return renumber(kept, answerKeys);
}

/** 改一個選項的內容。序號不動，所以答案鍵也不會動。 */
export function setOptionContent(options, answerKeys, order, content) {
  const next = (Array.isArray(options) ? options : []).map((o) =>
    Number(o?.order) === Number(order) ? { ...o, content: String(content ?? '') } : o,
  );
  return renumber(next, answerKeys);
}

/**
 * 把一個選項往上／往下移一格。
 *
 * **搬的是內容，不是序號。** 標籤與序號屬於位置——答案卡上的 (A)
 * 永遠是第一格；換的是印在那一格裡的字。所以這裡交換兩格的內容，
 * 並把答案跟著搬到內容現在所在的那一格。
 *
 * 反過來做（交換 order）會踩到一個很難查的坑：`normalizeOptions`
 * 依 order 排序，排完之後 order 又被重編成 1..n，於是交換等於沒做，
 * 而答案鍵指著的位置卻已經變了。
 */
export function moveOption(options, answerKeys, order, delta) {
  const list = [...(Array.isArray(options) ? options : [])];
  const i = list.findIndex((o) => Number(o?.order) === Number(order));
  const j = i + Number(delta);
  if (i < 0 || j < 0 || j >= list.length) return renumber(list, answerKeys);

  const a = list[i];
  const b = list[j];
  list[i] = { ...a, content: b.content };
  list[j] = { ...b, content: a.content };

  // 答案跟著內容走。兩格都是答案或都不是的時候不必動。
  const keys = new Set((answerKeys ?? []).map(Number));
  const hasA = keys.has(Number(a.order));
  const hasB = keys.has(Number(b.order));
  if (hasA !== hasB) {
    keys.delete(Number(a.order));
    keys.delete(Number(b.order));
    keys.add(hasA ? Number(b.order) : Number(a.order));
  }

  return renumber(list, [...keys].sort((x, y) => x - y));
}

/**
 * 換題型時的答案鍵。
 *
 * 多選改單選只留第一個：多選的 `[1,3]` 直接留在單選題上，入庫之後
 * 那一題有兩個「唯一解」，而計分是照第一個算的——畫面上完全看不出來。
 * 非選擇題一律清空，因為那些題型的答案在 `answerText`／`answerSlots`。
 */
export const CHOICE_TYPES = ['SINGLE_CHOICE', 'MULTI_CHOICE', 'TRUE_FALSE'];

export function answerKeysForType(type, answerKeys) {
  const keys = [...(answerKeys ?? [])].sort((a, b) => a - b);
  if (!CHOICE_TYPES.includes(type)) return [];
  if (type === 'MULTI_CHOICE') return keys;
  return keys.slice(0, 1);
}

/** 點一個選項（或按數字鍵）之後的答案鍵。 */
export function toggleAnswerKey(type, answerKeys, order) {
  const n = Number(order);
  if (type !== 'MULTI_CHOICE') return [n];
  const keys = new Set((answerKeys ?? []).map(Number));
  if (keys.has(n)) keys.delete(n);
  else keys.add(n);
  return [...keys].sort((a, b) => a - b);
}

/**
 * 這一題現在有什麼毛病。
 *
 * 全部是**入庫時會讓這一題被退回**的情況（見 `lib/commit.ts`）。
 * 那些檢查寫得很好，但它們發生在老師按下「寫進題庫」之後——
 * 那時他已經翻過去了。在編輯當下就說，成本是零。
 */
export function optionIssues(options, answerKeys, type) {
  const list = Array.isArray(options) ? options : [];
  const out = [];
  if (!list.length) return out;

  const blank = list.filter((o) => String(o?.content ?? '').trim() === '');
  if (blank.length) {
    out.push({
      code: 'blank_option',
      detail: `選項 ${blank.map((o) => `(${o.label})`).join('')} 還沒有內容，入庫時會被丟掉。`,
    });
  }

  const seen = new Map();
  for (const o of list) {
    const key = String(o?.content ?? '').trim().replace(/\s+/g, ' ');
    if (!key) continue;
    if (seen.has(key)) {
      out.push({
        code: 'duplicate_option',
        detail:
          `選項 (${seen.get(key)}) 與 (${o.label}) 的內容完全一樣，這一題沒有唯一解。` +
          `多半是有東西被讀掉了——向量的箭頭、指數的上標、負號、單位。`,
      });
    } else seen.set(key, o.label);
  }

  const orders = new Set(list.map((o) => Number(o?.order)));
  const orphan = (answerKeys ?? []).filter((k) => !orders.has(Number(k)));
  if (orphan.length) {
    out.push({
      code: 'answer_orphan',
      detail: `答案 (${orphan.join(')(')}) 找不到對應的選項，本題共 ${list.length} 個選項。`,
    });
  }

  if (CHOICE_TYPES.includes(type) && !(answerKeys ?? []).length) {
    // **這裡曾經寫「入庫後學生一律會被判錯」，而那是假的。**
    // `lib/grading.mjs` 的 `gradeSingleChoice` 對空的 correctKeys 回的是
    // `review('這一題沒有標準答案')`——不判錯，掛在需人工確認。方向是
    // 安全的（沒有人被誤判），但老師是照著這句話決定「這一題現在要不要
    // 花時間補答案」的：以為會被判錯就會停下來補；知道只是「之後要一份
    // 一份看」，就分不出這其實是全班 40 份的工作。說得比實際嚴重，
    // 下一次他就不信這一欄了。
    out.push({
      code: 'no_answer',
      detail:
        '這一題還沒有設定答案。入庫後學生不會被判錯，' +
        '但每一份作答都會掛在「需人工確認」，要老師一份一份看。',
    });
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────
// 二、待存佇列的狀態機
// ─────────────────────────────────────────────────────────────────

/**
 * 一批最多送幾筆。
 *
 * `saveReviews` 是**單一交易**：一筆壞資料（例如一個後端不收的欄位）
 * 會讓整批回滾，於是每 8 秒一次的儲存從此全部失敗，而畫面上一個字
 * 都不會變——20 分鐘的校對可以完全靜默地消失。
 *
 * 所以連續失敗時把批次切小，最後一筆一筆送：壞的那一筆會自己被隔離
 * 出來（它一直失敗），其餘的存得進去。這是「損失一筆」與「損失全部」
 * 的差別。
 */
export function saveBatchSize(failures = 0) {
  if (failures <= 0) return 100;
  if (failures === 1) return 20;
  if (failures === 2) return 5;
  return 1;
}

/** 下一次重試等多久。連續失敗時往後退，不要每 8 秒撞一次伺服器。 */
export const SAVE_RETRY_MS = [8_000, 8_000, 15_000, 30_000, 60_000];

export function saveRetryDelay(failures = 0) {
  const i = Math.max(0, Math.min(failures, SAVE_RETRY_MS.length - 1));
  return SAVE_RETRY_MS[i];
}

/**
 * 標頭那一小塊現在該說什麼。
 *
 * v0.21.0 之前只有兩種狀態（儲存中／已儲存），而失敗那條路徑
 * **一個 UI 狀態都沒有**：`savedAt` 保持上一次成功的值，所以網路斷掉
 * 之後畫面繼續寫著「已儲存」。那句話是假的，而老師會照著它決定要不要
 * 關掉分頁。
 *
 * 四種狀態要長得完全不一樣，因為它們要老師做的事不一樣：
 * 前三種是「什麼都不必做」，第四種是「不要關掉這一頁」。
 */
export function saveIndicator({
  inFlight = false,
  pendingCount = 0,
  failures = 0,
  savedAtLabel = null,
  lastStatus = null,
} = {}) {
  if (failures > 0) {
    // 佇列理論上不會是空的（送失敗的會被放回去），但真的是空的時候
    // 也不能說「未儲存 0 題」，那句話讀起來像沒事。
    const n = Math.max(pendingCount, 1);
    const detail =
      lastStatus === 401
        ? `登入過期了。你的校對還在這個分頁裡（${n} 題未儲存），` +
          '請在另一個分頁重新登入，回來之後會自動補送。不要關掉這一頁。'
        : lastStatus === 403
          ? `伺服器不接受這些修改（${n} 題未儲存）：你可能已經不是這一科的授課老師。` +
            '請不要關掉這一頁，先找管理員確認。'
          : `有 ${n} 題還沒存到伺服器（已重試 ${failures} 次）。` +
            '修改還在這台裝置上，系統會一直重試，也可以按「立刻重試」。' +
            '請不要關掉或重新整理這一頁。';
    return { kind: 'failing', urgent: true, label: `未儲存 ${n} 題`, detail };
  }
  if (inFlight || pendingCount > 0) {
    return { kind: 'saving', urgent: false, label: '儲存中…', detail: null };
  }
  if (savedAtLabel) {
    // 帶上時刻。只寫「已儲存」的話，四十分鐘前存的與三秒前存的
    // 在畫面上一模一樣。
    return { kind: 'saved', urgent: false, label: `已儲存 ${savedAtLabel}`, detail: null };
  }
  return { kind: 'idle', urgent: false, label: '', detail: null };
}

/**
 * 現在可不可以按「寫進題庫」。
 *
 * 存檔失敗時入庫等於**把還沒存上去的那幾題丟掉**——入庫讀的是資料庫，
 * 不是這個分頁。連續失敗兩次就擋住，並說明為什麼。
 */
export function commitBlocked({ failures = 0, pendingCount = 0, ready = 0 } = {}) {
  if (failures >= 2) {
    return {
      blocked: true,
      reason: `有 ${Math.max(pendingCount, 1)} 題的修改還沒存到伺服器。現在入庫會用到舊的內容，先把它存起來。`,
    };
  }
  if (ready <= 0) {
    return { blocked: true, reason: '把題目標成「校畢」之後才能寫進題庫。' };
  }
  return { blocked: false, reason: null };
}

// ─────────────────────────────────────────────────────────────────
// 三、校對用時
// ─────────────────────────────────────────────────────────────────

/**
 * 這一次要回報幾秒。
 *
 * 送**增量**而不是「本次開頁到現在」，因為老師會分好幾次校完一份題本，
 * 而伺服器要的是總和。增量在伺服器端直接累加，跨場次自然接得起來。
 *
 * 上限是必要的：分頁在背景掛著一整晚，隔天早上第一次存檔會回報
 * 四萬秒，而那個數字正好是業主驗收要看的那一個。`cap` 之外的部分
 * 當成「人不在電腦前」而丟掉。
 */
export function reviewSecondsDelta(reportedSec, currentSec, cap = 900) {
  const prev = Number.isFinite(reportedSec) ? Math.max(0, Math.floor(reportedSec)) : 0;
  const now = Number.isFinite(currentSec) ? Math.max(0, Math.floor(currentSec)) : 0;
  const d = now - prev;
  if (d <= 0) return 0;
  return Math.min(d, Math.max(0, Math.floor(cap)));
}

/**
 * 依本次工作階段的節奏推估。
 *
 * **分子與分母一定要來自同一個工作階段。** 舊版的 `done` 帶著上一次
 * 的成果（昨天校完的 30 題）而 `elapsed` 從今天開頁算起，於是第二次
 * 進來時推估被稀釋成幾乎 0——「32 秒校完剩下 20 題」。反方向也一樣壞：
 * 第一題花 90 秒讀完，推估就跳出「75:00」把人嚇跑。
 *
 * 樣本少於 `minSamples` 時回 null（不顯示），因為那時候的數字只會誤導。
 */
export function paceEstimate({
  doneNow = 0,
  doneAtMount = 0,
  elapsedSec = 0,
  total = 0,
  targetSec = 1200,
  minSamples = 5,
} = {}) {
  const n = doneNow - doneAtMount;
  if (n < minSamples || elapsedSec <= 0 || total <= 0) return null;
  const per = elapsedSec / n;
  const est = per * total;
  return {
    per,
    est,
    remaining: per * Math.max(0, total - doneNow),
    ok: est <= targetSec,
  };
}

/**
 * 校對完成後給業主看的那一句話。
 *
 * 驗收標準是「50 題 20 分鐘」，所以這裡一定要同時說出題數與用時——
 * 只說用時的話，一份 12 題的題本花 10 分鐘看起來像超標。
 */
export function reviewSummary({ total = 0, seconds = 0 } = {}) {
  if (!total || seconds <= 0) return null;
  const per = seconds / total;
  const mins = seconds / 60;
  return {
    perQuestion: per,
    minutes: mins,
    text:
      `這份題本 ${total} 題，校對用時 ${fmtDuration(seconds)}（平均每題 ${per.toFixed(0)} 秒）。`,
    // 換算成 50 題要多久，直接對上驗收標準。
    projectedFifty: per * 50,
  };
}

export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  if (m === 0) return `${s} 秒`;
  const r = s % 60;
  return r === 0 ? `${m} 分` : `${m} 分 ${r} 秒`;
}
