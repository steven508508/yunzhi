"""
題目附圖的偵測與裁切。

## 為什麼需要

講義的幾何題與函數題幾乎每題都有附圖（座標圖、圓與直線的關係圖、
統計圖表）。**沒有圖的幾何題是不能用的題目**——題幹寫著「如右圖」，
而學生看到的是一片空白。

## 難處

這類圖不是內嵌影像。實測那份講義的第 3 頁，`get_images()` 回傳 0 個，
但頁面上有四張座標圖——它們是幾十個獨立的線段、箭頭、圓弧堆出來的
向量圖形。所以不能「把圖片抓出來」，只能**把構成圖的那些筆畫圈起來，
再從頁面影像上裁下那一塊**。

## 做法

1. 收集所有繪圖物件，濾掉頁面家具（整頁寬的底色塊、頁緣的裝飾條）
2. 把彼此靠近的筆畫聚成群
3. 保留「夠大、筆畫夠多」的群 —— 那就是一張圖
4. 把群的範圍往外放一點（座標軸的標籤在筆畫之外），從頁面影像裁下來

裁切是從**已經渲染好的頁面影像**上做的，不是重新渲染：那張影像
在正規化階段就產生了，重用它可以確保圖與頁面的解析度一致，
而且省掉一次渲染。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import fitz

log = logging.getLogger("yunzhi.ai.figures")


# ─────────────────────────────────────────────────────────────────
# 門檻
# ─────────────────────────────────────────────────────────────────

#: 超過頁寬這個比例的填色塊是底色，不是圖。
#: 實測講義的題目框是 518pt 寬（頁寬 595），佔 87%。
_FURNITURE_WIDTH = 0.75
#: 頁緣多少範圍內的東西算裝飾（側邊標籤、書口色塊）。
_MARGIN = 0.04
#: 兩個筆畫的邊界框距離小於這個值就算同一群（點）。
_CLUSTER_GAP = 9.0
#: 一張圖至少要有這麼多筆畫。少於這個數的多半是底線或箭頭裝飾。
_MIN_STROKES = 4
#: 一張圖的最小尺寸（點）。
_MIN_SIZE = 28.0
#: 裁切時往外放的邊界（點）。座標軸的標籤在筆畫之外。
_PAD = 7.0
#: 區域內被本文佔掉的比例上限。超過就不是圖，是「框住文字的框」——
#: 講義的題目框、色塊標籤都是這種。
_TEXT_COVER = 0.22
#: 判定「在版心之外」時，容許超出版心的比例。
_BODY_SLACK = 0.06


@dataclass
class Figure:
    """頁面上的一張圖。座標是 PDF 點，原點在左上。"""

    x0: float
    y0: float
    x1: float
    y1: float
    strokes: int
    #: 圖內的文字（座標軸標籤、點的名稱）。用來判斷它屬於哪一題，
    #: 也給無障礙的替代文字當素材。
    labels: list[str]

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def height(self) -> float:
        return self.y1 - self.y0

    def rect(self, pad: float = _PAD) -> fitz.Rect:
        return fitz.Rect(self.x0 - pad, self.y0 - pad, self.x1 + pad, self.y1 + pad)

    def norm(self, w: float, h: float) -> dict:
        return {
            "x0": max(0.0, (self.x0 - _PAD) / w),
            "y0": max(0.0, (self.y0 - _PAD) / h),
            "x1": min(1.0, (self.x1 + _PAD) / w),
            "y1": min(1.0, (self.y1 + _PAD) / h),
        }


def _is_furniture(rect: fitz.Rect, page: fitz.Rect) -> bool:
    """頁面家具：底色塊、頁緣裝飾、側邊標籤。"""
    if rect.width >= page.width * _FURNITURE_WIDTH:
        return True
    margin = page.width * _MARGIN
    if rect.x0 >= page.width - margin or rect.x1 <= margin:
        return True
    if rect.y1 <= page.height * _MARGIN or rect.y0 >= page.height * (1 - _MARGIN):
        return True
    return False


def _cluster(rects: list[fitz.Rect]) -> list[list[int]]:
    """
    把彼此靠近的框聚成群。

    用最簡單的「反覆合併」而不是正式的聚類演算法：一頁最多幾百個
    筆畫，而這裡要的只是「哪些筆畫屬於同一張圖」。複雜的演算法
    在這個規模上沒有好處，卻多了一堆要調的參數。
    """
    n = len(rects)
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for i in range(n):
        ri = fitz.Rect(rects[i]) + (-_CLUSTER_GAP, -_CLUSTER_GAP, _CLUSTER_GAP, _CLUSTER_GAP)
        for j in range(i + 1, n):
            if ri.intersects(rects[j]):
                union(i, j)

    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    return list(groups.values())


def find_figures(page: fitz.Page) -> list[Figure]:
    """
    找出這一頁上的圖。

    向量圖與內嵌影像都算。內嵌影像直接就是一張圖，向量圖要先把
    筆畫聚起來。
    """
    page_rect = page.rect
    candidates: list[fitz.Rect] = []

    # 內嵌影像。多數講義沒有，但掃描進來的插圖會是。
    for img in page.get_images(full=True):
        for r in page.get_image_rects(img[0]):
            if not _is_furniture(r, page_rect):
                candidates.append(fitz.Rect(r))

    strokes: list[fitz.Rect] = []
    for d in page.get_drawings():
        r = d["rect"]
        if r.width <= 0.5 and r.height <= 0.5:
            continue  # 一個點，不是筆畫
        if _is_furniture(r, page_rect):
            continue
        strokes.append(fitz.Rect(r))

    figures: list[Figure] = []
    for group in _cluster(strokes):
        if len(group) < _MIN_STROKES:
            continue
        box = fitz.Rect(strokes[group[0]])
        for i in group[1:]:
            box |= strokes[i]
        if box.width < _MIN_SIZE or box.height < _MIN_SIZE:
            continue
        figures.append(
            Figure(box.x0, box.y0, box.x1, box.y1, strokes=len(group), labels=[])
        )

    for r in candidates:
        if r.width >= _MIN_SIZE and r.height >= _MIN_SIZE:
            figures.append(Figure(r.x0, r.y0, r.x1, r.y1, strokes=0, labels=[]))

    figures = _merge_overlapping(figures)
    figures = _drop_non_figures(page, figures)
    _attach_labels(page, figures)

    # 由上而下、由左至右，與閱讀順序一致
    figures.sort(key=lambda f: (round(f.y0, 1), f.x0))
    return figures


def _body_box(page: fitz.Page) -> fitz.Rect | None:
    """
    版心：本文實際佔的範圍。

    用來認出頁緣的裝飾（側邊標籤、書口色塊）。那些東西的座標
    離頁緣有多遠不固定（每家出版社不同），但它們一定在版心之外。
    """
    boxes = [
        fitz.Rect(b["bbox"])
        for b in page.get_text("dict").get("blocks", [])
        if b.get("type") == 0
    ]
    if len(boxes) < 3:
        return None
    xs0 = sorted(b.x0 for b in boxes)
    xs1 = sorted(b.x1 for b in boxes)
    # 取分位數而不是極值：頁碼、側邊標籤本身就是離群值
    lo = xs0[len(xs0) // 10]
    hi = xs1[-max(1, len(xs1) // 10)]
    return fitz.Rect(lo, page.rect.y0, hi, page.rect.y1)


def _drop_non_figures(page: fitz.Page, figures: list[Figure]) -> list[Figure]:
    """
    濾掉「不是圖」的區域。

    兩種常見的假圖：
      · 框住文字的框（題目色塊、標籤底色）——區域內幾乎都是本文
      · 頁緣的裝飾條（側邊的「教師用」標籤）——在版心之外
    """
    body = _body_box(page)
    text_boxes = []
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                if span.get("text", "").strip():
                    text_boxes.append(fitz.Rect(span["bbox"]))

    kept: list[Figure] = []
    for f in figures:
        box = fitz.Rect(f.x0, f.y0, f.x1, f.y1)
        area = box.get_area()
        if area <= 0:
            continue

        if body is not None:
            slack = body.width * _BODY_SLACK
            outside = box.x0 >= body.x1 - slack or box.x1 <= body.x0 + slack
            if outside:
                continue

        covered = 0.0
        for t in text_boxes:
            inter = box & t
            if not inter.is_empty:
                covered += inter.get_area()
        if covered / area > _TEXT_COVER:
            continue

        kept.append(f)
    return kept


def _merge_overlapping(figures: list[Figure]) -> list[Figure]:
    """
    重疊的圖併成一張。

    座標圖的軸線與資料曲線有時候會被聚成兩群（中間隔了一段空白），
    但它們在版面上是同一張圖。重疊就合併。
    """
    merged: list[Figure] = []
    for f in sorted(figures, key=lambda f: -(f.width * f.height)):
        box = fitz.Rect(f.x0, f.y0, f.x1, f.y1)
        for m in merged:
            if box.intersects(fitz.Rect(m.x0, m.y0, m.x1, m.y1)):
                m.x0, m.y0 = min(m.x0, f.x0), min(m.y0, f.y0)
                m.x1, m.y1 = max(m.x1, f.x1), max(m.y1, f.y1)
                m.strokes += f.strokes
                break
        else:
            merged.append(f)
    return merged


def _attach_labels(page: fitz.Page, figures: list[Figure]) -> None:
    """把落在圖範圍內的文字收集起來（座標軸標籤、點名）。"""
    if not figures:
        return
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                text = span.get("text", "").strip()
                if not text:
                    continue
                cx = (span["bbox"][0] + span["bbox"][2]) / 2
                cy = (span["bbox"][1] + span["bbox"][3]) / 2
                for f in figures:
                    if f.x0 <= cx <= f.x1 and f.y0 <= cy <= f.y1:
                        f.labels.append(text)
                        break


def crop(page: fitz.Page, fig: Figure, dpi: int = 300) -> bytes:
    """從頁面裁下一張圖，回傳 PNG。"""
    zoom = dpi / 72.0
    rect = fig.rect() & page.rect  # 不要裁到頁面外
    pix = page.get_pixmap(clip=rect, matrix=fitz.Matrix(zoom, zoom), alpha=False)
    return pix.tobytes("png")


# ─────────────────────────────────────────────────────────────────
# 與題目的關聯
# ─────────────────────────────────────────────────────────────────


def assign_to_regions(
    figures: list[Figure],
    regions: list[tuple[str, float, float]],
    page_height: float,
) -> dict[str, list[int]]:
    """
    把圖分派給題目。

    regions 是 [(題目識別, y0, y1)]，座標與 figures 同一套（PDF 點）。
    回傳 {題目識別: [圖的索引]}。

    判準是**垂直重疊**而不是距離：講義的圖都放在題目的右側，
    與題幹同高。用距離的話，兩題之間的圖會被分給上一題的最後一行
    ——而那一行常常是詳解，不是題幹。

    重疊不到就退而找最近的題目，但只在半頁的範圍內找；
    找不到就不分派，讓它成為「這一頁的圖」由校對者處理。
    寧可不分派，也不要分錯——分錯的圖比沒有圖更容易誤導學生。
    """
    out: dict[str, list[int]] = {}
    for i, f in enumerate(figures):
        best = None
        best_overlap = 0.0
        for key, y0, y1 in regions:
            overlap = min(f.y1, y1) - max(f.y0, y0)
            if overlap > best_overlap:
                best, best_overlap = key, overlap

        if best is None:
            # 沒有重疊：找垂直距離最近的，但不能太遠
            nearest = None
            nearest_dist = page_height * 0.5
            fc = (f.y0 + f.y1) / 2
            for key, y0, y1 in regions:
                dist = min(abs(fc - y0), abs(fc - y1))
                if dist < nearest_dist:
                    nearest, nearest_dist = key, dist
            best = nearest

        if best is not None:
            out.setdefault(best, []).append(i)
    return out
