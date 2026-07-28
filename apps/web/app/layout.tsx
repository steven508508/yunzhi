import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '雲端智學',
  description: '學測線上學習與評量系統',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      {/*
        字型刻意**不從 Google 載**。
        
        原本這裡有 fonts.googleapis.com 的 preconnect 與 stylesheet。
        問題是這套系統要部署在補習班的機房，而訪談時明確提過「資料
        不能離開校內」這件事——一個每次開頁面都往外連的字型請求，
        既違反那個前提，也在封閉網段直接失效（實測每次載入都是
        `net::ERR_TUNNEL_CONNECTION_FAILED`）。
        
        失效的方式還特別糟：不會報錯，只是整套排版靜靜地退回系統
        預設字型，而中文排版的品質正是這個介面的差異化重點
        （文件 15 §1.1）。
        
        globals.css 的字型堆疊本來就把台灣三大平台實際安裝的字型
        排在前面（Windows 的微軟正黑體、macOS 的蘋方、Linux 的
        Noto Sans CJK），所以拿掉外部請求之後三個平台都仍然正確。
        真的要用 Noto，正確做法是把字型檔放進映像自架，而不是
        每一次開頁面都出去要一次。
      */}
      <body>{children}</body>
    </html>
  );
}
