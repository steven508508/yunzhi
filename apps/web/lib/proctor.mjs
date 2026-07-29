/**
 * 考試行為的合併與去抖動。
 *
 * # 為什麼這一段必須離開瀏覽器
 *
 * 這裡處理的是**噪音**。瀏覽器給的原始訊號幾乎沒有一個是乾淨的：
 *
 *   · 手機切輸入法會送出 blur 然後 focus，中間 0.3 到 0.8 秒
 *   · 通知橫幅落下來、螢幕旋轉、來電，全部都是 blur
 *   · 切到別的分頁同時送出 blur 與 visibilitychange，那是一件事不是兩件
 *   · iPad 上進出全螢幕偶爾會多送一次 fullscreenchange
 *
 * 照單全收的結果是一場 60 分鐘的考試留下四百筆記錄，而老師要在那裡面
 * 找出真的有意義的那三筆。**噪音不是無害的，噪音會讓訊號看不見**——
 * 而看不見的訊號等於沒有這個功能。
 *
 * 這些情況在開發機上一個都重現不出來（桌機不切輸入法、不轉螢幕、
 * 不會有來電），所以合併規則必須是可以在測試裡直接餵時間序列的純函式。
 * 這個檔案不碰 DOM、不碰網路、不讀系統時間——時間一律由呼叫端傳進來。
 *
 * # 一次離開只留一列
 *
 * 「切走」與「切回來」是同一件事的兩端，存成兩列的話，老師要自己把
 * 相鄰的兩列配對起來才讀得出「他離開了多久」，而中間插著別人的事件時
 * 配不起來。所以**一段離開只產生一列**：
 *
 *   · 回來了 → 記在回來的那一刻（TAB_VISIBLE／WINDOW_FOCUS／
 *     LONG_ABSENCE），帶 `durationMs`。離開的時刻是 `at − durationMs`。
 *   · 沒回來（分頁關掉了）→ 記在離開的那一刻（TAB_HIDDEN／WINDOW_BLUR），
 *     `durationMs` 是 **null**。我們不知道他離開了多久，而寫 0 是在說
 *     一件我們不知道的事。
 *
 * 這個安排與 schema.prisma 在 `ProctorEvent.durationMs` 上寫的
 * 「TAB_VISIBLE／WINDOW_FOCUS 才有值」是同一件事。
 *
 * # 分頁與視窗是同一個狀態，不是兩個
 *
 * 切到別的分頁時 `blur` 與 `visibilitychange` 都會來。分開記的話同一個
 * 動作會變成兩列，而且兩列的時間幾乎一樣——老師會以為他切走了兩次。
 *
 * 所以這裡只有**一個**「不在考卷上」的狀態：任一個訊號說他走了就算走了，
 * 兩個訊號都說他回來了才算回來。期間只要看過一次 `hidden`，這一段就
 * 升級成分頁層級（TAB_*）——那是比較具體的那一種說法。
 *
 * # 這裡不判斷作弊
 *
 * 這個檔案算出來的每一個數字都是事實：切走幾次、多久、在第幾題。
 * **沒有任何一個函式回傳「可疑」。** 理由在 schema.prisma 的
 * `ProctorEvent` 註解裡：瀏覽器層的偵測一定有偽陽性，而自動判定的代價
 * 是一個沒有作弊的學生被踢出考場。判斷是老師的事，這裡只負責讓他
 * 看得見。
 */

// ─────────────────────────────────────────────────────────────────
// 參數
// ─────────────────────────────────────────────────────────────────

/**
 * 合併與去抖動的門檻。每一個數字都是在「漏掉真的」與「淹沒在假的裡面」
 * 之間選的位置，所以每一個都要說得出上下界。
 */
export const PROCTOR = {
  /**
   * 短於這個長度的離開直接丟掉（毫秒）。
   *
   * 往下：Android 切輸入法約 0.3–0.8 秒、通知橫幅約 0.5 秒、螢幕旋轉
   * 約 0.5 秒。門檻設在 0.5 秒的話，一個用手機打字的學生每按一次
   * 切換鍵就留一列，一場考試幾百列。
   *
   * 往上：真的去看一眼別的東西至少要兩三秒，但「瞄一眼公式」可能只有
   * 兩秒。設到 5 秒就會漏掉那一種，而那正是要看的那一種。
   *
   * 1.5 秒在所有已知的機械性抖動之上、在任何有意識的動作之下。
   */
  MIN_AWAY_MS: 1500,

  /**
   * 回來之後這麼久之內又離開，算**同一段**（毫秒）。
   *
   * 手機切輸入法常常是 blur/focus/blur/focus 連續四五次，那是一個動作
   * 而不是三次離開。桌機上拖曳視窗、點一下工具列再點回來也一樣。
   *
   * 不設到更大是因為次數本身是資訊：老師要分得出「切走 14 次」與
   * 「切走 3 次」，而 10 秒的合併窗會把前者變成後者。
   */
  MERGE_GAP_MS: 2000,

  /**
   * 超過這個長度的離開換一個事件類型（毫秒）。
   *
   * 30 秒以上的離開與 3 秒的離開在意義上是兩件事：後者可能是通知，
   * 前者他人已經不在螢幕前了。分類型是為了讓老師端排序時不必自己
   * 訂一個門檻——但**這個門檻不代表判定**，只代表「這一段值得先看」。
   */
  LONG_ABSENCE_MS: 30_000,

  /**
   * 送出去之前先攢多久（毫秒）。
   *
   * 比作答存檔的 1.2 秒長：這些是輔助資料，晚幾秒到達沒有任何代價，
   * 而每一次往返都在跟學生的答案搶同一條爛網路。
   */
  FLUSH_DEBOUNCE_MS: 4000,

  /** 一次最多送幾筆。與伺服器端的上限一致。 */
  MAX_BATCH: 40,

  /**
   * 佇列最多留幾筆。
   *
   * 佇列只有在送不出去的時候才會長，而那時候這個分頁裡真正重要的東西
   * 是學生的答案。行為記錄不可以把記憶體吃光——**它是輔助資料**，
   * 滿了就不再收新的，並記下丟掉幾筆。
   */
  MAX_QUEUE: 200,

  /** 送出時允許的最大回溯（毫秒）。伺服器端也會再夾一次。 */
  MAX_OFFSET_MS: 6 * 60 * 60 * 1000,

  // ── 老師端：「全班都這樣」與「與全班明顯不同」的門檻 ────────
  //
  // 這幾個數字**只影響畫面上先看哪一列**，不影響任何資料的寫入，
  // 也不構成判定。命名與畫面上的說法一一對應，改了數字就要改說法。

  /** 一位學生要有這麼多次離開才算進「全班普遍如此」的分子。 */
  WIDESPREAD_MIN_COUNT: 3,
  /** 少於這個人數不談「全班」——3 個人裡有 2 個不叫全班。 */
  WIDESPREAD_MIN_STUDENTS: 5,
  /** 低於這個次數不標記。1 次離開什麼都不是。 */
  STANDOUT_MIN_COUNT: 3,
  /** 單次離開超過這麼久就值得先看一眼（毫秒）。 */
  STANDOUT_LONG_MS: 2 * 60 * 1000,
};

/** 這個模組會產生的事件類型。與 schema.prisma 的 ProctorEventType 一致。 */
export const PROCTOR_TYPES = [
  'TAB_HIDDEN',
  'TAB_VISIBLE',
  'WINDOW_BLUR',
  'WINDOW_FOCUS',
  'FULLSCREEN_EXIT',
  'FULLSCREEN_ENTER',
  'PASTE',
  'LONG_ABSENCE',
];

// ─────────────────────────────────────────────────────────────────
// 追蹤器
// ─────────────────────────────────────────────────────────────────

/**
 * 從一串原始瀏覽器事件產生合併後的記錄。
 *
 * 時間全部由呼叫端傳進來，而且應該傳**單調時鐘**（`performance.now()`）：
 * `Date.now()` 會被使用者改系統時間影響，而改系統時間正是這個功能會
 * 遇到的事。時鐘真的往回跳時，這裡一律把長度夾成 0（於是那一段會因為
 * 太短而被丟掉），不會產生負的持續時間。
 *
 * 用法：
 *
 * ```js
 * const t = createProctorTracker();
 * t.setQuestion(7);
 * t.hidden(now());     // 切走
 * t.visible(now());    // 切回來 → 產生一列
 * const batch = t.drain(now());
 * ```
 */
export function createProctorTracker({ questionOrder = null } = {}) {
  /** 已經合併完成、等著送出去的記錄。 */
  let queue = [];
  /** 因為佇列滿了而丟掉幾筆。只用於自我診斷，不送出去。 */
  let dropped = 0;
  /** 目前在第幾題。事件發生的當下抓一次，之後換題不影響已經記下的。 */
  let order = normalizeOrder(questionOrder);

  // ── 離開（分頁 + 視窗合成一個狀態）─────────────────────────
  let hiddenNow = false;
  let focusedNow = true;
  /** 目前這一段離開。null 代表人在考卷上。 */
  let away = null;
  /**
   * 剛結束的那一段，留著等 MERGE_GAP_MS。期間又離開的話把它接回去，
   * 而不是開新的一段。`record` 是它在佇列裡的那一列（可能是 null：
   * 太短而沒有留下記錄，或者已經被送出去了）。
   */
  let justBack = null;

  // ── 全螢幕（獨立的一組狀態）───────────────────────────────
  let fullNow = false;
  /** 目前這一段「不在全螢幕」。 */
  let fsOut = null;

  // ── 貼上 ───────────────────────────────────────────────────
  /** 剛記下的那一筆貼上，用於合併連續的貼上。 */
  let lastPaste = null;

  function push(record) {
    if (queue.length >= PROCTOR.MAX_QUEUE) {
      dropped += 1;
      return null;
    }
    queue.push(record);
    return record;
  }

  /** 從佇列裡撤回一列。只有還沒送出去的撤得回來。 */
  function retract(record) {
    if (!record) return false;
    const i = queue.indexOf(record);
    if (i < 0) return false;
    queue.splice(i, 1);
    return true;
  }

  /** 人現在不在考卷上嗎。兩個訊號任一個成立就算。 */
  function isAway() {
    return hiddenNow || !focusedNow;
  }

  function openAway(at) {
    if (away) {
      // 已經在離開狀態，只是另一個訊號也跟著來了（切分頁會同時送出
      // blur 與 visibilitychange）。**不開新的一段**，只把層級升上去。
      if (hiddenNow) away.sawHidden = true;
      return;
    }
    if (justBack && at - justBack.endedAt <= PROCTOR.MERGE_GAP_MS && at >= justBack.endedAt) {
      // 剛回來又走了。同一個動作的餘波（切輸入法的連續抖動最常見），
      // 把上一段接回來繼續算，而不是留下兩列各兩秒。
      retract(justBack.record);
      away = {
        start: justBack.start,
        sawHidden: justBack.sawHidden || hiddenNow,
        order: justBack.order,
        bursts: justBack.bursts + 1,
        reported: false,
      };
      justBack = null;
      return;
    }
    away = { start: at, sawHidden: hiddenNow, order, bursts: 1, reported: false };
    justBack = null;
  }

  function closeAway(at) {
    if (!away) return;
    const seg = away;
    away = null;
    // 時鐘往回跳時夾成 0。負的持續時間會讓老師端算出「離開 −4 分鐘」，
    // 而那個畫面沒有人看得懂。
    const durationMs = Math.max(0, at - seg.start);

    if (seg.reported) {
      // 分頁關閉時已經以「未結束」的形式送出去過了（見 close），
      // 之後又活過來（bfcache 復原）。再記一次就是同一段離開留下兩列。
      justBack = null;
      return;
    }
    if (durationMs < PROCTOR.MIN_AWAY_MS) {
      // 太短：輸入法、通知、旋轉螢幕。丟掉記錄，但**保留合併窗**——
      // 連續抖動的每一次單獨看都太短，接起來才是真的離開。
      justBack = { ...seg, endedAt: at, record: null };
      return;
    }
    const record = push({
      type:
        durationMs >= PROCTOR.LONG_ABSENCE_MS
          ? 'LONG_ABSENCE'
          : seg.sawHidden
            ? 'TAB_VISIBLE'
            : 'WINDOW_FOCUS',
      at,
      durationMs,
      questionOrder: seg.order,
      meta: seg.bursts > 1 ? { bursts: seg.bursts } : null,
    });
    justBack = { ...seg, endedAt: at, record };
  }

  function sync(at) {
    if (isAway()) openAway(at);
    else closeAway(at);
  }

  return {
    /** 現在在第幾題。之後發生的事件記這個題號。 */
    setQuestion(next) {
      order = normalizeOrder(next);
    },

    /** 分頁被切走。 */
    hidden(at) {
      hiddenNow = true;
      sync(at);
    },

    /** 分頁切回來。**視窗焦點沒回來就還不算回來。** */
    visible(at) {
      hiddenNow = false;
      sync(at);
    },

    /** 視窗失去焦點：切到別的應用程式，或開了另一個視窗。 */
    blur(at) {
      focusedNow = false;
      sync(at);
    },

    focus(at) {
      focusedNow = true;
      sync(at);
    },

    /**
     * 進出全螢幕。
     *
     * 與離開不同，**退出全螢幕當下就記一列**（不等他回來）。因為多數
     * 學生退出之後就不會再進去了，而等回來才記的話那一列只能靠分頁
     * 關閉時的 beacon 送出去——那是這條路上最不可靠的一次傳輸，
     * 而「他離開了全螢幕」是這裡最該送到的一件事。
     *
     * 代價是一次進出留下兩列。全螢幕的切換一場考試不會超過幾次，
     * 兩列讀得完；而離開分頁一場可能有幾十次，那才需要合併成一列。
     */
    fullscreen(isFull, at) {
      if (isFull === fullNow) return;
      fullNow = isFull;
      if (!isFull) {
        fsOut = {
          start: at,
          order,
          record: push({
            type: 'FULLSCREEN_EXIT',
            at,
            durationMs: null,
            questionOrder: order,
            meta: null,
          }),
        };
        return;
      }
      const out = fsOut;
      fsOut = null;
      if (!out) {
        // 第一次進全螢幕（考試開始時建議的那一次）。記下來，否則
        // 老師分不出「這台裝置進不了全螢幕」與「他進去之後一直待著」。
        push({
          type: 'FULLSCREEN_ENTER',
          at,
          durationMs: null,
          questionOrder: order,
          meta: null,
        });
        return;
      }
      const outMs = Math.max(0, at - out.start);
      if (outMs < PROCTOR.MIN_AWAY_MS && retract(out.record)) {
        // 進去又立刻被彈出來再進去——iPad 上真的會這樣。那不是行為，
        // 是瀏覽器。撤回剛才那一列，兩邊都不記。
        return;
      }
      push({
        type: 'FULLSCREEN_ENTER',
        at,
        durationMs: outMs,
        questionOrder: out.order,
        meta: null,
      });
    },

    /**
     * 貼上。
     *
     * **只記字元數，不記內容。** 貼上的可能是學生自己在別處打的草稿，
     * 而把它存下來就是在蒐集他的作答內容——那是另一個問題，而且是
     * 一個沒有人同意過的問題。
     */
    paste(chars, at) {
      const n = Math.max(0, Math.floor(Number(chars) || 0));
      if (lastPaste && at - lastPaste.at <= PROCTOR.MERGE_GAP_MS && queue.includes(lastPaste)) {
        // 連按兩次貼上、或一次貼上被瀏覽器拆成兩個事件。
        lastPaste.at = at;
        lastPaste.meta = {
          chars: (lastPaste.meta?.chars ?? 0) + n,
          count: (lastPaste.meta?.count ?? 1) + 1,
        };
        return;
      }
      lastPaste = push({
        type: 'PASTE',
        at,
        durationMs: null,
        questionOrder: order,
        meta: { chars: n, count: 1 },
      });
    },

    /**
     * 分頁要關掉了（pagehide／元件卸載）。
     *
     * 把還沒結束的那一段離開以「不知道多久」的形式留下來。這是唯一會
     * 產生 TAB_HIDDEN／WINDOW_BLUR 的地方——正常回來的那些都變成
     * 一列帶長度的記錄了。
     *
     * 標記成已回報而不是清掉，因為分頁可能只是進了 bfcache 然後又回來，
     * 那時 `closeAway` 不可以再記一次。
     */
    close(at) {
      // `at` 收下但不使用：這一列記的是**離開的時刻**（`away.start`），
      // 不是分頁關閉的時刻——那兩個差幾分鐘，而老師端畫時間軸時用的
      // 是前者。參數留著是為了與其他進入點一致；少一個參數的那一個
      // 遲早會被人漏傳時間。
      void at;
      if (away && !away.reported) {
        away.reported = true;
        push({
          type: away.sawHidden ? 'TAB_HIDDEN' : 'WINDOW_BLUR',
          at: away.start,
          durationMs: null,
          questionOrder: away.order,
          meta: away.bursts > 1 ? { bursts: away.bursts } : null,
        });
      }
      // 合併窗到此為止：送出去之後就接不回來了。
      justBack = null;
    },

    /**
     * 取出並清空已經合併完成的記錄。
     *
     * **已經送出去的那一段要關掉合併窗。** 不關的話，「剛回來又走了」
     * 會從原本的起點重新算一段——而那一段涵蓋的時間已經有一列在
     * 伺服器上了，於是同一段離開被記了兩次，而且第二次比較長。
     *
     * 太短而沒有留下記錄的那一種**要保留**：它什麼都還沒送出去，
     * 而手機切輸入法的連續抖動正是靠它才接得起來。
     */
    drain() {
      const out = queue;
      queue = [];
      if (justBack && justBack.record) justBack = null;
      lastPaste = null;
      return out;
    },

    /** 還有幾筆沒送出去。 */
    pending() {
      return queue.length;
    },

    /** 自我診斷用。**不送出去**——它是這個模組自己的狀態，不是證據。 */
    stats() {
      return { pending: queue.length, dropped, away: away != null, fullscreen: fullNow };
    },
  };
}

function normalizeOrder(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

// ─────────────────────────────────────────────────────────────────
// 送出去的形狀
// ─────────────────────────────────────────────────────────────────

/**
 * 把記錄轉成要送給伺服器的東西。
 *
 * **送的是「幾毫秒之前」而不是時刻。** 前端的時鐘不可信（使用者改得動
 * 系統時間，而這一整頁的倒數就是為了這件事才以伺服器為準），但
 * 「距離現在多久」用單調時鐘算得出來而且改系統時間不影響。伺服器收到
 * 之後用自己的現在減掉這個差，時刻就落在正確的位置上。
 *
 * 時鐘真的往回跳、或者記錄比現在還新時一律夾成 0（＝就是現在），
 * 不送負數。
 */
export function toProctorPayload(records, now) {
  const list = Array.isArray(records) ? records : [];
  return list.slice(0, PROCTOR.MAX_BATCH).map((r) => ({
    type: r.type,
    atOffsetMs: clamp(Math.round(now - r.at), 0, PROCTOR.MAX_OFFSET_MS),
    durationMs:
      r.durationMs == null ? null : clamp(Math.round(r.durationMs), 0, PROCTOR.MAX_OFFSET_MS),
    questionOrder: r.questionOrder ?? null,
    meta: r.meta ?? null,
  }));
}

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

// ─────────────────────────────────────────────────────────────────
// 老師端：把事件整理成事實
// ─────────────────────────────────────────────────────────────────

/** 哪幾種類型算「離開考卷」。全螢幕與貼上分開算，它們是不同的事。 */
const AWAY_TYPES = new Set([
  'TAB_VISIBLE',
  'WINDOW_FOCUS',
  'LONG_ABSENCE',
  'TAB_HIDDEN',
  'WINDOW_BLUR',
]);

/**
 * 一位學生這一場的整理結果。
 *
 * **每一個欄位都是事實，沒有一個是判斷。** 「切走 14 次、最長一次
 * 4 分鐘」是事實；「疑似作弊」是判斷，而判斷是老師的事——理由在
 * schema.prisma 的 `ProctorEvent` 註解裡。
 */
export function summarizeEvents(events) {
  const list = Array.isArray(events) ? events : [];
  let awayCount = 0;
  let awayMs = 0;
  let longestMs = 0;
  let unfinished = 0;
  let fullscreenExits = 0;
  let pastes = 0;
  let pasteChars = 0;

  for (const e of list) {
    if (!e || typeof e.type !== 'string') continue;
    if (AWAY_TYPES.has(e.type)) {
      awayCount += 1;
      if (typeof e.durationMs === 'number' && e.durationMs > 0) {
        awayMs += e.durationMs;
        if (e.durationMs > longestMs) longestMs = e.durationMs;
      } else {
        // 沒有長度的那幾列是「切走之後沒有再回來」。**不可以當成 0 秒**
        // ——那是這一整份記錄裡最長的一次離開，只是我們量不到。
        unfinished += 1;
      }
    } else if (e.type === 'FULLSCREEN_EXIT') {
      fullscreenExits += 1;
    } else if (e.type === 'PASTE') {
      pastes += 1;
      pasteChars += Number(e.meta?.chars) || 0;
    }
  }

  return { awayCount, awayMs, longestMs, unfinished, fullscreenExits, pastes, pasteChars, total: list.length };
}

/**
 * 全班的基準線。
 *
 * # 為什麼一定要有這一段
 *
 * 「這位學生切走了 12 次」單獨看起來很多。但如果全班 28 個人裡有 24 個
 * 都切走了十幾次，那多半是**環境**——同一個熱點斷斷續續、學校的
 * MDM 每十分鐘跳一次通知、某個瀏覽器版本在捲動時會誤送 blur。
 *
 * 少了這個對照，老師會照著一個看起來很高的數字去找一個學生談話，
 * 而真正的原因在機房。所以這一支的輸出要能讓畫面說出「全班都這樣」。
 */
export function classBaseline(summaries) {
  const rows = (Array.isArray(summaries) ? summaries : []).filter(Boolean);
  const counts = rows.map((r) => r.awayCount ?? 0).sort((a, b) => a - b);
  const students = rows.length;
  const withEvents = counts.filter((c) => c > 0).length;
  const busy = counts.filter((c) => c >= PROCTOR.WIDESPREAD_MIN_COUNT).length;
  return {
    students,
    withEvents,
    medianCount: median(counts),
    maxCount: counts.length ? counts[counts.length - 1] : 0,
    /**
     * 多數人都有一定數量的事件。這是一個**關於全班的事實**，不是對
     * 任何一位學生的判斷——它要說的是「先去看環境，不要先看人」。
     */
    widespread: students >= PROCTOR.WIDESPREAD_MIN_STUDENTS && busy / students >= 0.6,
    busy,
  };
}

/**
 * 排序並標出「與全班明顯不同」的那幾位。
 *
 * # 這裡刻意只做兩件事
 *
 * 排序（多的在前）與**說出理由**。理由一律是可以驗證的比較句：
 * 「切走 14 次，全班中位數 2 次」。沒有分數、沒有等級、沒有「可疑」——
 * 一個 0 到 100 的「風險分數」會被當成系統的結論，而系統沒有結論。
 *
 * 全班普遍都有事件時**不標任何人**：那時候突出的那一位只是網路比較差
 * 的那一位，而把他標出來就是在製造一個冤案。
 */
export function rankStudents(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  const base = classBaseline(list.map((r) => r.summary ?? r));

  const ranked = list
    .map((r) => {
      const s = r.summary ?? r;
      const why = [];
      if (!base.widespread) {
        if (
          s.awayCount >= PROCTOR.STANDOUT_MIN_COUNT &&
          s.awayCount >= Math.max(2 * base.medianCount, PROCTOR.STANDOUT_MIN_COUNT)
        ) {
          why.push(`切走 ${s.awayCount} 次，全班中位數 ${base.medianCount} 次`);
        }
        if (s.longestMs >= PROCTOR.STANDOUT_LONG_MS) {
          why.push(`最長一次離開 ${Math.round(s.longestMs / 60000)} 分鐘`);
        }
        if (s.unfinished > 0) {
          why.push(`有 ${s.unfinished} 次切走之後沒有回到這個畫面`);
        }
      }
      return { ...r, summary: s, standsOut: why.length > 0, why };
    })
    // 多的在前；次數相同時看總時間。老師的視線從上往下，所以最需要
    // 先看的要在上面——但**上面不代表有問題**，畫面上要寫清楚。
    .sort(
      (a, b) =>
        b.summary.awayCount - a.summary.awayCount ||
        b.summary.awayMs - a.summary.awayMs ||
        b.summary.total - a.summary.total,
    );

  return { rows: ranked, baseline: base };
}

function median(sorted) {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// ─────────────────────────────────────────────────────────────────
// 給人看的說法
// ─────────────────────────────────────────────────────────────────

/**
 * 一段長度的中文說法。
 *
 * 一律說得出單位，而且不四捨五入到看不出差別：「4 分 12 秒」與
 * 「4 分鐘」在老師判斷時是不同的資訊量。
 */
export function durationText(ms) {
  if (ms == null) return '不知道多久';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m} 分 ${rest} 秒` : `${m} 分鐘`;
  const h = Math.floor(m / 60);
  return `${h} 小時 ${m % 60} 分`;
}

/**
 * 一列事件的中文說法。
 *
 * **描述動作，不描述動機。** 「切到別的分頁，47 秒後回來」是描述；
 * 「離開考卷去查資料」是動機，而我們不知道他去做了什麼。
 */
export function eventText(e) {
  if (!e || typeof e.type !== 'string') return '';
  switch (e.type) {
    case 'TAB_VISIBLE':
      return `切到別的分頁或應用程式，${durationText(e.durationMs)}後回來`;
    case 'WINDOW_FOCUS':
      return `這個視窗失去焦點（另一個視窗蓋在上面），${durationText(e.durationMs)}後回來`;
    case 'LONG_ABSENCE':
      return `離開這個畫面 ${durationText(e.durationMs)}後回來`;
    case 'TAB_HIDDEN':
      return '切到別的分頁或應用程式，之後沒有再回到這個畫面';
    case 'WINDOW_BLUR':
      return '這個視窗失去焦點，之後沒有再回到這個畫面';
    case 'FULLSCREEN_EXIT':
      return '離開全螢幕';
    case 'FULLSCREEN_ENTER':
      return e.durationMs == null
        ? '進入全螢幕'
        : `回到全螢幕（離開了 ${durationText(e.durationMs)}）`;
    case 'PASTE': {
      const chars = Number(e.meta?.chars) || 0;
      const count = Number(e.meta?.count) || 1;
      const times = count > 1 ? `${count} 次貼上，` : '';
      // 內容不存，所以說不出貼了什麼——而那正是刻意的。
      return `${times}共 ${chars} 個字（系統不記錄貼上的內容）`;
    }
    default:
      return e.type;
  }
}
