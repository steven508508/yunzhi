"""
題目附圖偵測的測試。

講義的座標圖不是內嵌影像——實測那份講義第 3 頁 `get_images()` 回傳 0，
但頁面上有四張圖，它們是幾十個線段與箭頭堆出來的。所以測的是
「把筆畫聚成圖」以及「不要把框住文字的框當成圖」。

幾何座標照抄自真實講義。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import fitz  # noqa: E402

from pipeline.figures import Figure, find_figures  # noqa: E402


def make_page(strokes, texts=(), width=595, height=842):
    """造一頁：strokes 是線段的矩形，texts 是 (文字, x, y)。"""
    doc = fitz.open()
    page = doc.new_page(width=width, height=height)
    for x0, y0, x1, y1 in strokes:
        page.draw_line((x0, y0), (x1, y1), width=0.8)
    for t, x, y in texts:
        page.insert_text((x, y), t, fontsize=10, fontname="china-t")
    # 重新開啟：get_drawings 讀的是已寫入的內容流
    data = doc.tobytes()
    doc.close()
    return fitz.open(stream=data, filetype="pdf")[0]


def coordinate_figure(cx, cy, size=70):
    """一張座標圖：兩條軸、兩個箭頭、一條斜線、幾個刻度。"""
    h = size / 2
    return [
        (cx - h, cy, cx + h, cy),           # x 軸
        (cx, cy - h, cx, cy + h),           # y 軸
        (cx + h - 5, cy - 3, cx + h, cy),   # 箭頭
        (cx + h - 5, cy + 3, cx + h, cy),
        (cx - h + 8, cy + h - 8, cx + h - 8, cy - h + 8),  # 斜線
        (cx - 10, cy - 2, cx - 10, cy + 2),  # 刻度
        (cx + 10, cy - 2, cx + 10, cy + 2),
    ]


def test_vector_diagram_is_found():
    page = make_page(coordinate_figure(200, 400))
    figs = find_figures(page)
    assert len(figs) == 1, [f"{f.width:.0f}x{f.height:.0f}" for f in figs]
    assert figs[0].width >= 60


def test_multiple_diagrams_stay_separate():
    """
    同一行的四張圖不可以被聚成一張。實測那份講義的第 3 頁
    就是四張並排的座標圖。
    """
    strokes = []
    for cx in (150, 260, 370, 480):
        strokes += coordinate_figure(cx, 400, size=70)
    figs = find_figures(make_page(strokes))
    assert len(figs) == 4, [f"({f.x0:.0f},{f.y0:.0f}) {f.width:.0f}x{f.height:.0f}" for f in figs]


def test_box_around_text_is_not_a_figure():
    """
    講義的題目色塊是一個框，框裡全是本文。它的尺寸與筆畫數
    都像一張圖，唯一的差別是**裡面幾乎都是字**。
    """
    box = [
        (60, 100, 500, 100),
        (60, 200, 500, 200),
        (60, 100, 60, 200),
        (500, 100, 500, 200),
        (60, 150, 500, 150),
    ]
    texts = [(f"這是第 {i} 行的題幹文字內容，佔滿整個框。", 70, 115 + i * 18) for i in range(5)]
    figs = find_figures(make_page(box, texts))
    assert figs == [] or all(f.width < 400 for f in figs), (
        f"框住文字的框被當成圖了：{[(f.width, f.height) for f in figs]}"
    )


def test_tiny_decoration_is_ignored():
    """箭頭、項目符號這種小裝飾不是圖。"""
    figs = find_figures(make_page([(100, 100, 108, 104), (100, 104, 108, 100)]))
    assert figs == []


def test_labels_inside_the_figure_are_collected():
    """
    座標軸的標籤要跟著圖走：它們是圖的一部分，也是替代文字的素材。
    """
    page = make_page(
        coordinate_figure(300, 400, size=120),
        texts=[("A", 305, 360), ("O", 292, 412), ("x", 358, 398)],
    )
    figs = find_figures(page)
    assert len(figs) == 1
    assert set(figs[0].labels) >= {"A", "O"}, figs[0].labels


def test_crop_rect_extends_past_the_strokes():
    """
    裁切範圍要比筆畫大一點——座標軸的標籤畫在筆畫之外，
    貼齊筆畫裁的話標籤會被切掉。
    """
    f = Figure(100, 100, 200, 200, strokes=8, labels=[])
    r = f.rect()
    assert r.x0 < 100 and r.y0 < 100 and r.x1 > 200 and r.y1 > 200


def test_normalized_bbox_is_within_bounds():
    f = Figure(0, 0, 595, 842, strokes=8, labels=[])
    b = f.norm(595, 842)
    assert all(0.0 <= v <= 1.0 for v in b.values()), b


if __name__ == "__main__":
    import traceback

    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"  ✓ {fn.__name__}")
        except Exception:
            failed += 1
            print(f"  ✗ {fn.__name__}")
            traceback.print_exc(limit=2)
    print(f"\n{len(fns) - failed}/{len(fns)} 通過")
    sys.exit(1 if failed else 0)
