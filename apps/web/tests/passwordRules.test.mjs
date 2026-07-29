/**
 * 密碼規則：什麼樣的密碼收得下，以及臨時密碼長什麼樣。
 *
 * # 這一支測的全部是「不會有錯誤訊息」的失敗
 *
 * 強度規則放寬一個字元不會當機，畫面也不會壞——它只是讓某個帳號變得
 * 好猜。發現的方式只有一種：有人用別人的帳號登入了，而那個帳號裡有
 * 他的成績與家長的聯絡方式。
 *
 * 臨時密碼的字母表更隱蔽：混進 `0` 與 `O` 之後，功能看起來完全正常
 * ——密碼產得出來、也存得進去。壞掉的地方在櫃檯：老師把密碼抄給
 * 學生，學生打不進去，而兩邊都認為對方弄錯了。這件事會在上線第一天
 * 發生兩百次，而且沒有任何一行 log 說得出原因。
 *
 * 所以每一個測試的註解寫的是**錯了會怎樣**。
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

import {
  OTP_ALPHABET,
  OTP_LENGTH,
  checkPasswordStrength,
  oneTimePassword,
} from '../lib/passwordRules.mjs';

/**
 * 正式路徑用的那一組亂數。
 *
 * 與 `lib/roster.ts` 的 `newPassword()` 一模一樣——**這裡就是在測
 * 那一支**。測試若自己編一組假亂數，測到的就不是正式環境跑的東西，
 * 而字母表偏差那一類的問題正好只在真的亂數下才看得出來。
 */
const crypto = () => randomBytes(OTP_LENGTH * 2);

// ─────────────────────────────────────────────────────────────────
// 一、強度
// ─────────────────────────────────────────────────────────────────

test('十個字元以上才收', () => {
  // 錯的話：學生設一組 6 碼的密碼，而學號是連號的——猜開一個帳號
  // 就等於猜開一整班。
  assert.equal(checkPasswordStrength('a'.repeat(8) + 'B'), '密碼至少需要 10 個字元');
  assert.equal(checkPasswordStrength('綠豆湯要加薏仁才好喝'), null);
});

test('長度剛好在邊界上的那一組要收', () => {
  // 邊界寫成 `<= 10` 的話，一組剛好 10 個字的合法密碼會被拒絕，
  // 而錯誤訊息說「至少需要 10 個字元」——使用者會以為系統壞了。
  assert.equal(checkPasswordStrength('abcdefghij'), null);
});

test('密碼不能包含自己的學號', () => {
  // 錯的話：學號 S1130412 的學生設 S1130412abc，而學號印在名冊上、
  // 貼在教室後面、寫在每一張考卷上。那等於沒有密碼。
  assert.equal(checkPasswordStrength('S1130412abc', 'S1130412'), '密碼不能包含帳號');
  // 大小寫不同也要擋——不擋的話 s1130412abc 就過了。
  assert.equal(checkPasswordStrength('s1130412abc', 'S1130412'), '密碼不能包含帳號');
});

test('常見字串擋掉，而且是子字串比對', () => {
  // 「以 password 開頭」這種寫法擋不住 mypassword123，而那是同樣糟的
  // 一組密碼。
  for (const bad of ['mypassword123', 'aaa12345678', 'qwertyuiop', 'yunzhi2026x']) {
    assert.ok(
      checkPasswordStrength(bad),
      `${bad} 應該被擋下來——它出現在每一份外洩密碼字典的前一百名`,
    );
  }
});

test('單一字元重複不算密碼', () => {
  // aaaaaaaaaa 長度過關、不含學號、不在常見清單裡，只有這一條擋得住。
  assert.equal(checkPasswordStrength('aaaaaaaaaa'), '密碼不能是單一字元重複');
  assert.equal(checkPasswordStrength('2222222222'), '密碼不能是單一字元重複');
});

test('太長的擋掉', () => {
  // 不擋的話，一個 100 KB 的字串會被送進 bcrypt。那是一支免費的
  // CPU 耗盡攻擊，而它長得像一次正常的改密碼。
  assert.equal(checkPasswordStrength('a'.repeat(201)), '密碼過長');
});

test('不是字串的一律當成沒填，不能爆掉', () => {
  // API 收的是 JSON，而 JSON 送得進 null、數字與陣列。少了這一道，
  // `null.length` 會炸成 500——而使用者看到的是「系統壞了」，
  // 不是「你沒有輸入密碼」。
  for (const junk of [null, undefined, 123, [], {}]) {
    assert.equal(checkPasswordStrength(junk), '請輸入新密碼');
  }
});

// ─────────────────────────────────────────────────────────────────
// 二、臨時密碼
// ─────────────────────────────────────────────────────────────────

test('臨時密碼不含容易看錯的字元', () => {
  // **這一條是這支測試存在的主要理由。** 這串字會被老師唸出來或抄在
  // 便條紙上，而 0/O、1/l/I 在多數螢幕字型上分不出來。混進去的代價
  // 不是少幾個 bit，是上線第一天兩百通「我打不進去」。
  const ambiguous = ['0', 'O', 'o', '1', 'l', 'I', 'i'];
  for (const ch of ambiguous) {
    assert.ok(
      !OTP_ALPHABET.includes(ch),
      `字母表裡有「${ch}」——它與另一個字元在螢幕上分不出來`,
    );
  }
  // 抽一批出來驗，不是只看字母表常數：實作可能根本沒用到它。
  for (let i = 0; i < 200; i++) {
    for (const ch of oneTimePassword(crypto)) {
      assert.ok(OTP_ALPHABET.includes(ch), `產出了字母表外的字元「${ch}」`);
    }
  }
});

test('臨時密碼固定 10 碼', () => {
  // 長度不穩的話，名冊匯入印出來的那張紙會參差不齊，而更糟的是
  // 短的那幾組沒有人會注意到。
  for (let i = 0; i < 50; i++) {
    assert.equal(oneTimePassword(crypto).length, OTP_LENGTH);
  }
});

test('兩次不會產出同一組', () => {
  // 錯的話（例如某天有人把亂數換成以秒為種子的東西），整批匯入的
  // 學生會拿到同一組初始密碼，而畫面上完全看不出來。
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(oneTimePassword(crypto));
  assert.equal(seen.size, 500, '產生器在重複，亂數來源有問題');
});

test('落在尾巴上的位元組被丟掉，不是取餘數', () => {
  // 256 除不盡 31：直接 `byte % 31` 的話，前 8 個字元的出現機率比
  // 其餘的高約 3.2%。這裡餵一組刻意跨過邊界的位元組來確認。
  //
  // limit = floor(256/31)*31 = 248。所以 248 以上的要被丟掉。
  const bytes = [248, 249, 255, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const got = oneTimePassword(() => Uint8Array.from(bytes));
  // 前三個位元組（248、249、255）被丟掉，所以第一個字元來自 0。
  assert.equal(got[0], OTP_ALPHABET[0]);
  assert.equal(got[1], OTP_ALPHABET[1]);
  assert.equal(got.length, 10);
});

test('沒有給亂數來源就丟例外，不能自己編一個', () => {
  // 這個參數必填是刻意的：給它一個預設值，就等於在某個檔案裡
  // 悄悄決定了「用哪一種亂數」。若那個預設值哪天變成 Math.random，
  // 密碼照樣產得出來、看起來完全正常，而全班的初始密碼變成可預測的。
  assert.throws(() => oneTimePassword(), /亂數來源/);
});

test('亂數來源壞掉時要丟例外，不是無窮迴圈', () => {
  // 全部落在丟棄區的來源會讓 while 迴圈永遠轉下去。那在正式環境
  // 的症狀是一個吃滿一顆 CPU、永遠不回應的請求——比丟例外難查太多。
  assert.throws(
    () => oneTimePassword(() => Uint8Array.from([255, 255, 255, 255])),
    /亂數來源異常/,
  );
});
