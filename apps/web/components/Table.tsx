/**
 * 資料表。
 *
 * `.yz-table` 的樣式早就有了，這一層加的是**三件每次都會被漏掉的事**：
 *
 *   一、**空狀態。** 一個只有表頭、底下什麼都沒有的表格，看起來
 *       像壞掉而不是「沒有資料」。
 *   二、**數字欄靠右、等寬。** 成績、題數、答對率排在一起要能掃視，
 *       而預設的靠左＋比例數字讓「9」與「120」對不齊。
 *   三、**表頭的 scope。** 讀螢幕的人靠它知道現在這一格屬於哪一欄。
 *
 * 刻意**不做**排序、分頁、篩選。那三樣每個畫面的需求都不同，
 * 做成通用元件只會變成一堆設定參數，而呼叫端還是要自己想。
 * 需要的時候在該畫面自己做，資料在伺服器端就處理好。
 */
import type { ReactNode } from 'react';

export type Column<T> = {
  key: string;
  head: ReactNode;
  /** 數字欄。靠右、等寬，方便上下掃視。 */
  numeric?: boolean;
  cell: (row: T, index: number) => ReactNode;
};

export function Table<T>({
  columns,
  rows,
  rowKey,
  empty,
  caption,
  selectedKey,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  /** 沒有資料時顯示什麼。**必填**——空表格看起來像壞掉。 */
  empty: ReactNode;
  /** 給讀螢幕的人的表格說明。視覺上隱藏。 */
  caption?: string;
  selectedKey?: string | null;
}) {
  if (rows.length === 0) {
    return <>{empty}</>;
  }
  return (
    <table className="yz-table">
      {caption && <caption className="yz-sr">{caption}</caption>}
      <thead>
        <tr>
          {columns.map((c) => (
            <th
              key={c.key}
              scope="col"
              className={c.numeric ? 'yz-table__num' : undefined}
            >
              {c.head}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => {
          const key = rowKey(row, i);
          return (
            <tr
              key={key}
              aria-selected={selectedKey === key ? true : undefined}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={c.numeric ? 'yz-table__num' : undefined}
                >
                  {c.cell(row, i)}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
