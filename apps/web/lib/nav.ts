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

/**
 * 家長。**只有家長**，而且只有一區。
 *
 * 老師不在裡面：老師要看一位學生的完整狀況走
 * `/classes/[classId]/students/[studentId]`，那一頁有帶班的判定，
 * 而且看得到的東西完全不同（逐份成績、知識點掌握度、作答的連結）。
 * 家長那一頁是**學生自己那份資料的投影**，欄位只減不加——
 * 兩頁共用一條路徑的話，遲早會有人在其中一頁加一欄，
 * 而加錯邊的方向是家長看到了逐題作答。
 */
const GUARDIAN = ['GUARDIAN'] as const;

/** 行政決定：開班、學年度結構這類會影響全校資料範圍的事。 */
const ADMIN = ['SCHOOL_ADMIN', 'SYS_ADMIN'] as const;

/**
 * 作答的人。**只有學生**——家長看得到孩子的成績是另一件事，
 * 走的是另一組路徑，不是同一個畫面加一個「唯讀」旗標。
 *
 * 老師不在裡面，但 `/take` 這一頁本身不擋老師：老師偶爾會被指定為
 * 作答對象（自己先試考一份再派出去），那時他直接開網址就進得去。
 * 導覽列不畫，是因為那是例外而不是他每天的工作。
 */
const LEARNER = ['STUDENT'] as const;

export type NavItem = {
  href: string;
  label: string;
  /** 誰看得到。沒列進來的角色，連結不畫、頁面也擋。 */
  roles: readonly string[];
};

export const NAV_ITEMS: readonly NavItem[] = [
  // 學生只有一項，排最前面。他一天要點它好幾次，老師一週點一次
  // 學年度——導覽列的順序應該照「誰用得最兇」排，不是照系統結構排。
  { href: '/take', label: '我的任務', roles: LEARNER },

  // 家長也只有一項。他一個月看兩次，而且多半在手機上——導覽列上
  // 多一個字，就是他在小螢幕上要多讀一次才知道該點哪裡。
  { href: '/guardian', label: '孩子的狀況', roles: GUARDIAN },

  // 老師的動線就是這個順序：題目進來（匯入）→ 挑題組卷（考卷）→
  // 派出去（派卷）→ 收回來看（成績）。導覽列照這個順序排，
  // 是因為第一次用的人會照著左到右點，而那樣點是對的。
  { href: '/bank', label: '題庫', roles: STAFF },
  { href: '/import', label: '匯入', roles: STAFF },
  { href: '/papers', label: '考卷', roles: STAFF },
  { href: '/assignments', label: '派卷', roles: STAFF },
  { href: '/grades', label: '成績', roles: STAFF },
  { href: '/classes', label: '班級', roles: STAFF },
  { href: '/knowledge', label: '知識點', roles: STAFF },
  // 這三項排在最後而且只有管理員看得到：它們一年只碰一兩次，
  // 但少了任何一項，前面那幾項就都動不了，所以不能只留在資料庫裡。
  //
  //   學年度  沒有它就一個班都建不了
  //   科目    沒有它就匯不了題、也建不了卷子
  //   教職員  沒有它就只有安裝時那一個管理員帳號，老師連登入都沒有
  //
  // 順序照「裝好之後要照著做的順序」排，而不是照字面：先有學年度與
  // 科目，才輪得到把老師放進去。
  { href: '/settings/years', label: '學年度', roles: ADMIN },
  { href: '/settings/subjects', label: '科目', roles: ADMIN },
  { href: '/settings/staff', label: '教職員', roles: ADMIN },
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
