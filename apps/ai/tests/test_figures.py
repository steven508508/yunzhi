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

from pipeline.figures import MAX_PX, Figure, crop, display_size, find_figures  # noqa: E402


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


# ─────────────────────────────────────────────────────────────────
# 裁切
#
# 這一組守的是「學生手上那張圖」。三種壞法都不會有錯誤訊息：
#   · 裁出一片空白 → 看得見的空白比缺圖更難查
#   · 裁出整頁 → 手機上要捲兩個螢幕才看得到選項
#   · 沒有尺寸 → 圖載進來的那一刻整段題幹往下跳
# ─────────────────────────────────────────────────────────────────


def png_size(data: bytes) -> tuple[int, int]:
    """從 PNG 的 IHDR 讀出寬高。不引入額外的相依。"""
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "不是 PNG"
    return (
        int.from_bytes(data[16:20], "big"),
        int.from_bytes(data[20:24], "big"),
    )


def test_crop_reports_the_real_pixel_size():
    """
    回報的尺寸要與 PNG 裡真的那張圖一致。

    對不上的話，前端會用一個錯的長寬比先把位置留出來——症狀比
    完全沒有尺寸更糟：版面先跳一次，圖到了再跳回來。
    """
    page = make_page(coordinate_figure(300, 400, size=120))
    figs = find_figures(page)
    assert len(figs) == 1
    shot = crop(page, figs[0])
    assert (shot.width, shot.height) == png_size(shot.png)
    assert shot.width > 0 and shot.height > 0


def test_display_size_is_not_the_pixel_count():
    """
    **`<img width height>` 要填的是「畫多大」，不是「有幾個像素」。**

    我們用 300 DPI 裁圖（座標軸的刻度標籤要看得清楚），所以一張在
    原稿上 33 mm 寬的圖有 396 個像素。照著填 width 的話瀏覽器會把它
    畫成 396 CSS 像素，也就是 105 mm——原稿的三倍。

    螢幕上看不太出來（有 max-width 兜著），紙上是災難：實測一份 9 題
    的卷子印成 9 頁，一頁一題。老師要的是三張紙。
    """
    page = make_page(coordinate_figure(300, 400, size=120))
    figs = find_figures(page)
    shot = crop(page, figs[0])

    # 300 DPI 的像素 → 96 DPI 的 CSS 像素，剛好是 96/300
    assert shot.display_width < shot.width, "顯示尺寸沒有換算，圖會被畫成三倍大"
    assert abs(shot.display_width / shot.width - 96 / 300) < 0.02
    # 長寬比不可以在換算中跑掉，否則畫面預留的位置形狀就是錯的
    assert abs(
        shot.display_width / shot.display_height - shot.width / shot.height
    ) < 0.02


def test_display_size_of_a_capped_figure_still_matches_the_source():
    """
    被 `MAX_PX` 縮過的圖，顯示尺寸仍然要對應**原稿的大小**。

    從縮過的像素回推的話，一張滿版的圖會被畫成半頁——它在原稿上
    是滿版的，在我們的卷子上就該是滿版的。「為了省頻寬縮到多少像素」
    與「這張圖該畫多大」是兩件事。
    """
    page = make_page(coordinate_figure(300, 400, size=120))
    full = Figure(0.0, 0.0, 595.0, 842.0, strokes=40, labels=[])
    shot = crop(page, full)
    assert max(shot.width, shot.height) <= MAX_PX
    # 595pt 寬 → 595 × 96/72 ≈ 793 CSS 像素（含 _PAD，但被頁面切掉了）
    assert 770 <= shot.display_width <= 800, shot.display_width
    assert display_size(round(595 * 300 / 72), round(842 * 300 / 72))[0] == 793


def test_crop_of_a_figure_flush_to_the_page_edge():
    """
    圖貼齊頁緣。`_PAD` 會把裁切框推到頁面外，與頁面取交集之後那一側
    就沒有留白——這是對的，頁面外沒有東西可以裁。

    錯的做法是不取交集：PyMuPDF 會回一張把頁外算成白色的圖，
    於是那張圖的一邊多出一條白邊，而學生看到的是歪掉的座標圖。
    """
    page = make_page(coordinate_figure(40, 40, size=60))
    fig = Figure(0.0, 0.0, 70.0, 70.0, strokes=8, labels=[])
    shot = crop(page, fig)
    assert (shot.width, shot.height) == png_size(shot.png)
    # 沒有 pad 的那兩側：裁出來的寬度不可以超過「圖寬 + 單邊的 pad」
    # 換算成像素之後的值。
    assert shot.width <= round((70.0 + 7.0) * 300 / 72) + 2, shot.width


def test_crop_of_a_bbox_beyond_the_page():
    """
    bbox 超出頁面（座標算錯、或頁面被前處理切過）。

    交集不為空的部分照裁；完全落在頁外的**丟例外而不是回一張空白圖**。
    空白圖會被存進物件儲存、掛到題目上，然後學生看到一塊白色的方塊，
    而沒有任何地方說得出那是壞掉的。
    """
    page = make_page(coordinate_figure(300, 400, size=120))

    # 一半在頁內：照裁，不可以超過頁面尺寸
    half = Figure(500.0, 700.0, 900.0, 1200.0, strokes=8, labels=[])
    shot = crop(page, half)
    assert shot.width <= round(595 * 300 / 72) + 2
    assert shot.height <= round(842 * 300 / 72) + 2

    # 完全在頁外：丟例外
    try:
        crop(page, Figure(2000.0, 3000.0, 2100.0, 3100.0, strokes=8, labels=[]))
    except ValueError:
        pass
    else:
        raise AssertionError("完全落在頁面外的框應該丟例外，而不是回一張空白圖")


def test_crop_of_a_zero_area_box():
    """零面積的框（兩個座標相同）。丟例外，不要產出 0×0 的 PNG。"""
    page = make_page(coordinate_figure(300, 400, size=120))
    # _PAD 會把零面積的點撐成一個小方塊，所以這裡刻意讓 pad 之後
    # 仍然與頁面沒有交集——那才是真正的零面積。
    for fig in (
        Figure(-100.0, -100.0, -100.0, -100.0, strokes=0, labels=[]),
        Figure(700.0, 900.0, 700.0, 900.0, strokes=0, labels=[]),
    ):
        try:
            crop(page, fig)
        except ValueError:
            continue
        raise AssertionError(f"零面積的框應該丟例外：{fig}")


def test_full_page_figure_is_capped():
    """
    **一張全頁的圖不該以 300 DPI 的原始解析度送到學生手機上。**

    595×842 點的頁面在 300 DPI 之下是 2480×3508，PNG 約 3–6 MB。
    考場是整班共用 20–50 Mbps 的熱點，三十個人同時開同一題就是把
    那條線塞死——而學生看到的是一直轉的作答頁。

    上限只咬得到超過半頁的圖：實測講義的座標圖約 150–250 點，
    300 DPI 之下是 625–1040 像素，下面第二段驗的就是它沒被縮。
    """
    page = make_page(coordinate_figure(300, 400, size=120))

    full = Figure(0.0, 0.0, 595.0, 842.0, strokes=40, labels=[])
    shot = crop(page, full)
    assert max(shot.width, shot.height) <= MAX_PX, f"{shot.width}×{shot.height}"
    assert (shot.width, shot.height) == png_size(shot.png)
    # 縮的是整張，長寬比不變
    assert abs(shot.width / shot.height - 595 / 842) < 0.02

    # 一般大小的圖不受影響：縮小它只是在製造模糊的像素
    normal = Figure(100.0, 100.0, 300.0, 260.0, strokes=12, labels=[])
    small = crop(page, normal)
    assert small.width > 700, f"一般大小的圖被縮了：{small.width}"


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
