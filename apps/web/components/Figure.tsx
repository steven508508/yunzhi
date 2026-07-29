/**
 * 題目附圖。
 *
 * # 為什麼這一支是 client component，而 MathText 不是
 *
 * 因為它要回答一個只有瀏覽器知道的問題：**這張圖到底載進來了沒有。**
 *
 * 考試中一題「如右圖」的幾何題，圖沒載出來時畫面上是一段空白。學生
 * 會以為題目就長這樣，然後在一題他其實答不了的題目上耗掉五分鐘——
 * 而監考老師完全不會知道。所以載入失敗必須**說出來**，而且要說得
 * 讓他知道下一步是舉手，不是重新整理（重整會重跑一次計時器的校時，
 * 在網路不穩的教室裡只會更糟）。
 *
 * `onError` 只有在瀏覽器端才有意義，所以這一小塊得是 client component。
 * MathText 本身刻意留在兩邊都能用的狀態（見它的檔頭）——把整支改成
 * client 的話，題庫、組卷、檢討三個頁面會從「零 JavaScript 的伺服器
 * 渲染」變成整棵樹都要 hydration，而它們大部分的題目根本沒有圖。
 *
 * # 為什麼放大要用對話框而不是開新分頁
 *
 * 手機上 390px 寬的畫面放一張座標圖，刻度根本看不清楚，所以一定要
 * 能放大。但**作答中的學生不可以被帶去新分頁**：離開作答頁一次就是
 * 一次防作弊事件（文件 04），而學生只是想看清楚第 7 題的圖。
 * 原生 `<dialog>`（走既有的 components/Dialog）留在同一頁，
 * 焦點鎖定與 Esc 關閉是瀏覽器做好的，也不必多裝一個 lightbox 套件。
 */
'use client';

import { useCallback, useState } from 'react';

import { Dialog } from '@/components/Dialog';

export type FigureProps = {
  /** 已經接好權限的網址。**不是物件儲存的簽名 URL**，見 app/api/assets。 */
  src: string;
  /** 替代文字。**呼叫端保證非空**（見 lib/math.mjs 的 figureAlt）。 */
  alt: string;
  /** 裁圖時量到的像素尺寸。給了才不會在載入完成時把整段文字推下去。 */
  width?: number | null;
  height?: number | null;
  /** 行內（混在題幹的文字裡）或獨立成塊。 */
  inline?: boolean;
  /**
   * `eager` 給**要印出來的畫面**用。
   *
   * 瀏覽器在列印前理應把 `lazy` 的圖補載完，但那是「理應」——
   * 實測過的失敗方式是列印預覽跑得比補載快，於是那幾張圖印成空白，
   * 而老師是在把考卷發下去之後才看到的。整卷預覽這種一次呈現全部
   * 題目、而且注定要進印表機的畫面一律 eager。
   */
  loading?: 'lazy' | 'eager';
};

export function Figure({
  src,
  alt,
  width,
  height,
  inline = false,
  loading = 'lazy',
}: FigureProps) {
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(false);

  /**
   * 圖有可能在 hydration 完成**之前**就載失敗了——那時候 React 還沒有
   * 掛上 onError，事件就這樣掉了，畫面上留下一個永遠的空框。所以掛上
   * 的那一刻補問一次：已經載完（complete）但沒有寬度（naturalWidth 為 0）
   * 就是失敗。這是這個元件唯一會漏掉的情況，而它在慢速網路下很常見。
   */
  const check = useCallback((el: HTMLImageElement | null) => {
    if (el && el.complete && el.naturalWidth === 0) setFailed(true);
  }, []);

  if (failed) {
    return (
      <span className={`yz-fig yz-fig--failed${inline ? ' yz-fig--inline' : ''}`} role="alert">
        <span className="yz-fig__failmark" aria-hidden="true">
          ×
        </span>
        <span className="yz-fig__failtext">
          這一題有一張附圖沒有載出來（{alt}）。
          <strong>考試中請舉手告訴監考老師</strong>，不要重新整理。
        </span>
      </span>
    );
  }

  return (
    <span className={`yz-fig${inline ? ' yz-fig--inline' : ''}`}>
      {/* 用 button 而不是 a：它不會離開這一頁，而且鍵盤操作（Enter／空白）
          與讀螢幕時報出的角色都對得上。
          eslint-disable-next-line @next/next/no-img-element —— next/image
          的最佳化整條路是關掉的（見 next.config.mjs 的 CVE 說明）。 */}
      <button
        type="button"
        className="yz-fig__open"
        onClick={() => setZoom(true)}
        aria-label={`放大檢視：${alt}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={check}
          src={src}
          alt={alt}
          width={width ?? undefined}
          height={height ?? undefined}
          onError={() => setFailed(true)}
          // 附圖在畫面外的機率很高（檢討頁一次列 25 題，視窗裡只有兩題），
          // 而考場的頻寬是整班共用的。要印的畫面另外指定 eager。
          loading={loading}
          decoding="async"
        />
      </button>

      {/* **只在放大時才掛出 `<dialog>`。** 它是 flow content，而題幹經常
          被包在 `<span>` 甚至 `<p>` 裡——HTML 剖析器遇到 `<dialog>` 會把
          外層的 `<p>` 就地關掉，於是伺服器送出的 DOM 與 React 預期的
          對不起來，整段題幹在 hydration 時原地消失。放大是使用者按了
          才會發生的事，那時候是 React 自己插進 DOM，不經過剖析器。 */}
      {zoom && (
        <Dialog open onClose={() => setZoom(false)} title={alt}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="yz-fig__zoom" src={src} alt={alt} />
        </Dialog>
      )}
    </span>
  );
}
