/** 型別宣告。實作在 passwordRules.mjs——純判斷，不碰資料庫，所以測得動。 */
export declare function checkPasswordStrength(
  pw: string,
  username?: string,
): string | null;

export declare const OTP_ALPHABET: string;
export declare const OTP_LENGTH: number;

/** `draw` 必填，理由見 passwordRules.mjs 的檔頭與參數註解。 */
export declare function oneTimePassword(draw: () => Uint8Array): string;
