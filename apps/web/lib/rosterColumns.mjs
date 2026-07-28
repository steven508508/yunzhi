/**
 * 名冊 CSV 的欄位別名。
 *
 * **不要求櫃檯把標題改成系統認得的名字。** 名冊是既有的檔案，
 * 欄位可能叫「學號」「學生學號」「座號」「student_id」——要求先把
 * 標題改對，等於要求他們先做一次資料整理，而那正是他們想用系統
 * 來避免的事。
 *
 * 單獨一個檔案（而不是放在 roster.ts 裡）是為了讓「讀 CSV」這件事
 * 不相依於資料層：測試載入它時不必連資料庫，也不必有 Prisma 引擎。
 */
export const ROSTER_COLUMNS = {
  username: ['學號', '學生學號', '座號', '編號', 'id', 'student_id', 'sid'],
  displayName: ['姓名', '學生姓名', '名字', 'name', 'student_name'],
  guardianEmail: ['家長email', '家長信箱', '家長電子郵件', '監護人信箱', 'guardian_email'],
  email: ['email', '信箱', '電子郵件', '學生信箱'],
  birthDate: ['生日', '出生日期', 'birth', 'birthdate', 'birth_date'],
};

/**
 * 民國年 → 西元年。
 *
 * 「95/3/2」是民國 95 年（西元 2006），不是西元 95 年。差 1911 年，
 * 而它直接影響「這位學生是不是未成年」——而那決定要不要取得
 * 法定代理人同意（個資法第 15 條）。判錯的不是一個顯示問題。
 */
export function parseBirth(raw) {
  const s = String(raw ?? '').trim().replace(/[／.]/g, '/').replace(/-/g, '/');
  if (!s) return null;
  const m = /^(\d{2,4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (!m) return null;
  let year = Number(m[1]);
  if (year < 200) year += 1911;
  const d = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return null;
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== Number(m[2]) - 1) return null;
  return d;
}
