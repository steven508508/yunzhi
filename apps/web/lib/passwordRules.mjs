/**
 * 密碼的兩條規則：什麼樣的密碼收得下，以及臨時密碼長什麼樣。
 *
 * # 為什麼從 lib/password.ts 搬出來
 *
 * 因為那個檔案第一行就 import 了 bcryptjs 與 prisma，而**光是載入它
 * 就要跑一次 bcrypt**（見那邊 `DUMMY_HASH` 的註解，約 300 ms）。
 * 結果是這兩支純判斷完全測不到——測試檔沒有資料庫可以連。
 *
 * 而它們正是需要被測的那一種：兩支都**寫錯不會有任何錯誤訊息**。
 *
 *   · 強度規則放寬一個字元 → 沒有人會發現，直到某個學生的帳號被
 *     猜開，而那個帳號裡有他的成績與家長的聯絡方式。
 *   · 臨時密碼的字母表混進 `0` 與 `O` → 老師在櫃檯把密碼抄給學生，
 *     學生打不進去，而兩邊都認為對方弄錯了。這件事會在上線第一天
 *     發生兩百次。
 *
 * 與 `lib/scope.mjs`、`lib/grading.mjs` 同一個分工：**會出錯而且看不
 * 出來的判斷，要能在沒有資料庫的情況下驗。**
 *
 * # 這個檔案不可以 import `node:*`
 *
 * 強度檢查同時被瀏覽器端用（更換密碼的表單要在按下送出之前就告訴
 * 使用者哪裡不合格），而 client component 的相依會被打包進瀏覽器。
 * 一行 `import { randomBytes } from 'node:crypto'` 就會讓 `next build`
 * 直接失敗（UnhandledSchemeError），而錯誤訊息指的是那個表單檔案，
 * 完全看不出是這裡造成的。
 *
 * 所以亂數**由呼叫端傳進來**，見 `oneTimePassword` 的參數。
 */

/**
 * 密碼強度。刻意不強制大小寫與特殊符號的組合規則——
 * NIST SP 800-63B 已指出那類規則會讓使用者選出可預測的密碼
 * （Password1!）。改為要求長度並排除明顯不安全的選擇。
 *
 * @param {string} pw
 * @param {string} [username] 有值時擋掉「密碼裡含自己的學號」。
 *   補習班的學號是連號的，而學生最常設的密碼就是自己的學號加生日。
 * @returns {string|null} 不合格時回一句給人看的話，合格回 null
 */
export function checkPasswordStrength(pw, username) {
  // 型別不是字串就一律當成沒填。呼叫端有兩種（表單與 JSON API），
  // 而 JSON 送得進 null 與數字——`null.length` 會炸成 500，
  // 而 500 在使用者眼裡是「系統壞了」，不是「你沒填密碼」。
  if (typeof pw !== 'string') return '請輸入新密碼';
  if (pw.length < 10) return '密碼至少需要 10 個字元';
  if (pw.length > 200) return '密碼過長';
  if (username && pw.toLowerCase().includes(String(username).toLowerCase())) {
    return '密碼不能包含帳號';
  }
  const common = ['password', '12345678', 'qwerty', 'abc123', '00000000', 'yunzhi'];
  const lower = pw.toLowerCase();
  if (common.some((c) => lower.includes(c))) return '密碼包含過於常見的字串';
  if (/^(.)\1+$/.test(pw)) return '密碼不能是單一字元重複';
  return null;
}

/**
 * 一次性密碼的字母表。**刻意少了 `0 O o 1 l I i`。**
 *
 * 這串字的生命週期是：老師唸出來或抄在便條紙上 → 學生在手機或
 * 教室電腦上打進去。`0` 與 `O` 在多數螢幕字型上分不出來，`1`、`l`、
 * `I` 更糟。分不出來的代價不是少幾個 bit，是一通「我打不進去」的
 * 電話，而那通電話會在上線第一天打兩百次。
 *
 * 熵補在長度上：31 個字元、10 碼，約 49 bit，而且是一次性的
 * （`mustChangePassword`，第一次登入就會被要求換掉）。
 */
export const OTP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export const OTP_LENGTH = 10;

/**
 * 產生一組臨時密碼：名冊匯入時的初始密碼，以及老師重設密碼時給的那一串。
 *
 * **兩個用途共用同一支，是刻意的。** 分成兩份實作的話，兩邊的字母表
 * 遲早會分岐——而分岐的那一天，老師會發現「匯入的密碼打得進去、
 * 重設的打不進去」，然後懷疑是重設功能壞了。
 *
 * # 為什麼是 rejection sampling 而不是 `byte % 31`
 *
 * 256 除不盡 31：取餘數的話前 8 個字元（`a`–`h`）出現的機率比其餘的
 * 高約 3.2%。這不會讓任何一組密碼被猜開，但它是**免費就能修掉的
 * 偏差**——而密碼產生器裡的「反正影響不大」是一種會被繼承下去的
 * 壞習慣。丟掉落在尾巴上的位元組，重抽。
 *
 * @param {() => Uint8Array} draw 一次抓一批亂數位元組。**必填**，
 *   而且必填是刻意的：給它一個 `node:crypto` 的預設值會讓這個檔案
 *   不能被瀏覽器端引用（見檔頭），而給它一個 `Math.random` 的預設值
 *   是災難——那串字是兩百個帳號當天唯一的憑證，而 `Math.random`
 *   可預測。沒有預設值，呼叫端就非得想一次不可。
 * @returns {string}
 */
export function oneTimePassword(draw) {
  if (typeof draw !== 'function') {
    throw new Error('oneTimePassword 需要一個亂數來源');
  }
  const n = OTP_ALPHABET.length;
  // 256 以內最大的 n 的倍數。落在它之後的位元組一律丟掉。
  const limit = Math.floor(256 / n) * n;

  let out = '';
  let guard = 0;
  while (out.length < OTP_LENGTH) {
    // 理論上不會轉太多次（每一輪丟掉的機率是 4/256），但迴圈的
    // 終止條件不該只靠機率——來源若壞掉（例如測試傳了一個永遠
    // 回傳 0xFF 的假亂數），這裡會變成一個吃滿 CPU 的無窮迴圈。
    if (++guard > 64) throw new Error('亂數來源異常，產不出臨時密碼');
    for (const b of draw()) {
      if (b >= limit) continue;
      out += OTP_ALPHABET[b % n];
      if (out.length === OTP_LENGTH) break;
    }
  }
  return out;
}
