/**
 * 導覽：誰看得到哪一區。
 *
 * # 為什麼是一份清單，而不是在版面裡直接寫幾個 <Link>
 *
 * 因為「看不到連結」與「進不去」是兩件事，而它們必須是同一份規則。
 * 只把連結藏起來的話，學生把網址列的 `/import` 改成 `/bank` 就看得到
 * 整個題庫——那不是不方便，那是把答案本放在考場門口。
 *
 * 所以這裡是唯一一份「角色 ↔ 區域」對照表：版面用 `navFor()` 決定畫
 * 哪幾個連結，頁面用 `mayUse()` 決定要不要擋。分成兩份寫，就是多一次
 * 兩邊對不起來的機會，而對不起來的那一次不會有任何錯誤訊息。
 *
 * 這個檔案刻意不碰資料庫，也不 import 任何伺服器專用的東西——
 * 導覽列是 client component（要讀網址才知道現在在哪一頁），
 * 而角色過濾必須在伺服器端做完再傳過去。
 */

/**
 * 職員：帶班、出題、校對的人。
 *
 * 學生與家長不在裡面，而且**不是因為還沒做學生端**——就算做好了，
 * 題庫、匯入、知識點這三區是老師的工作區，學生看到的應該是自己的
 * 任務與成績，那會是另一組路徑。
 */
const STAFF = ['TEACHER', 'SUBJECT_LEAD', 'SCHOOL_ADMIN', 'SYS_ADMIN'] as const;

/** 行政決定：開班、學年度結構這類會影響全校資料範圍的事。 */
const ADMIN = ['SCHOOL_ADMIN', 'SYS_ADMIN'] as const;

export type NavItem = {
  href: string;
  label: string;
  /** 誰看得到。沒列進來的角色，連結不畫、頁面也擋。 */
  roles: readonly string[];
};

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/bank', label: '題庫', roles: STAFF },
  { href: '/import', label: '匯入', roles: STAFF },
  { href: '/classes', label: '班級', roles: STAFF },
  { href: '/knowledge', label: '知識點', roles: STAFF },
  // 學年度排在最後而且只有管理員看得到：它一年只碰一兩次，
  // 但沒有它就一個班都建不了，所以不能只留在資料庫裡。
  { href: '/settings/years', label: '學年度', roles: ADMIN },
];

/** 這個角色的導覽列。在伺服器端呼叫，client 只會拿到他該看的那幾項。 */
export function navFor(systemRole: string): NavItem[] {
  return NAV_ITEMS.filter((item) => item.roles.includes(systemRole));
}

/**
 * 這個角色能不能使用某一區。`href` 傳導覽項的路徑（例如 `'/bank'`）。
 *
 * 不認得的路徑一律回 false。權限判斷寫錯時，「進不去」是可以被回報的
 * 症狀，「進得去」不是。
 */
export function mayUse(systemRole: string, href: string): boolean {
  const item = NAV_ITEMS.find((i) => i.href === href);
  return item ? item.roles.includes(systemRole) : false;
}

/**
 * 現在這個網址屬於哪一項。`/import/new` 與 `/import/xxx` 都算 `/import`。
 *
 * 由長到短比對，否則 `/settings/years` 會被任何較短的前綴先攔走。
 */
export function activeHref(pathname: string): string | null {
  const hit = [...NAV_ITEMS]
    .sort((a, b) => b.href.length - a.href.length)
    .find((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
  return hit?.href ?? null;
}

/** 角色的中文稱呼。導覽列上顯示，讓人知道自己現在是用哪個身分在看。 */
export const ROLE_LABELS: Record<string, string> = {
  STUDENT: '學生',
  GUARDIAN: '家長',
  TEACHER: '老師',
  SUBJECT_LEAD: '學科召集人',
  SCHOOL_ADMIN: '校務管理員',
  SYS_ADMIN: '系統管理員',
};
