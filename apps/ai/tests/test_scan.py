"""
手機翻拍的前處理測試。

這條路徑在此之前**只用合成資料驗過**。五張真實翻拍照片（地理兩張、
公民一張、英文兩張）一進來就打破了三個假設：

  · 拍的是攤開的書，一張照片裡有**兩頁**，而系統把它當一頁。
  · 其中一張整頁躺著（轉了 90°），而去歪斜只修小角度。
  · 光照補償把整張圖轉成灰階再轉回來，**顏色被扔掉了**——
    而教用版的答案就是靠洋紅色認出來的。

再加上一個不會壞掉、只會默默扣分的：對比度是在光照補償**之後**
量的，而補償本來就會把背景壓平，於是每一張正常的照片都被判成
「淡墨或影本多次複印」。

合成資料驗不出這些，因為合成資料是照著假設造的。所以這一支測試
分兩層：不需要照片的用合成圖驗邏輯，需要照片的在 `samples/` 找得
到才跑。真實照片有著作權，不進版控。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import cv2  # noqa: E402
import numpy as np  # noqa: E402

from pipeline.normalize import (  # noqa: E402
    _enhance_scan,
    _rotate,
    _to_cv,
    _to_png,
    estimate_orientation,
    find_book_gutter,
    flatten_illumination,
    normalize_image,
    split_spread,
)

#: 真實翻拍照片。有著作權，不進版控；找不到就跳過。
PHOTOS = sorted(Path(os.getenv("SCAN_SAMPLES", "/home/claude/samples")).glob("照片-*"))
#: 已知整頁躺著的那一張（拍攝時書是橫的）
SIDEWAYS = "公民"


# ─────────────────────────────────────────────────────────────────
# 合成資料：不需要照片就能跑
# ─────────────────────────────────────────────────────────────────


def fake_page(width=800, height=1100, lines=28, ragged=True, colour=None):
    """
    造一頁假的排版：左側對齊、右側參差的橫向文字行。

    段落取四行一段、末行縮短——中文教科書的散文大致是這個樣子
    （實測真實照片的行首／行尾齊整度比落在 1.14–2.0）。段落再長
    一點的話行尾也會變齊，判正反的訊號就會消失，那時候偵測會
    誠實地說「不確定」而不是亂猜。
    """
    img = np.full((height, width, 3), 250, np.uint8)
    rng = np.random.default_rng(7)
    y = 60
    for i in range(lines):
        w = width - 160
        if ragged and i % 4 == 3:  # 段末短行
            w = int(w * rng.uniform(0.3, 0.65))
        cv2.rectangle(img, (80, y), (80 + w, y + 14), (30, 30, 30), -1)
        y += 34
    if colour:
        cv2.rectangle(img, (100, 200), (400, 214), colour, -1)
    return img


def spread(gap=60):
    """兩頁並排，中間留一條裝訂線。"""
    left, right = fake_page(), fake_page()
    h = left.shape[0]
    band = np.full((h, gap, 3), 250, np.uint8)
    return np.hstack([left, band, right])


def test_upright_page_is_left_alone():
    deg, note = estimate_orientation(fake_page())
    assert deg == 0, f"正的頁面被轉了 {deg}°：{note}"


def test_sideways_page_is_detected():
    """
    躺著的頁面要轉回來。這是公民那張照片的情形——去歪斜只修
    小角度，90° 完全不在它的守備範圍。
    """
    sideways = cv2.rotate(fake_page(), cv2.ROTATE_90_COUNTERCLOCKWISE)
    deg, _ = estimate_orientation(sideways)
    assert deg in (90, 270), f"躺著的頁面判成 {deg}°"
    # 轉回來之後應該是正的
    deg2, _ = estimate_orientation(_rotate(sideways, deg))
    assert deg2 in (0, 180), f"轉正之後又被判成 {deg2}°"


def test_upside_down_page_is_detected():
    """行首齊、行尾參差；轉 180° 之後兩者互換，這是判正反的依據。"""
    deg, _ = estimate_orientation(cv2.rotate(fake_page(), cv2.ROTATE_180))
    assert deg == 180, f"顛倒的頁面判成 {deg}°"


def test_orientation_gives_up_when_there_is_no_text():
    """整頁都是圖的時候不要亂猜——猜錯比不猜更糟。"""
    blank = np.full((900, 700, 3), 250, np.uint8)
    cv2.circle(blank, (350, 450), 200, (40, 40, 40), 3)
    deg, note = estimate_orientation(blank)
    assert deg == 0
    assert "無法判定" in note or note == ""


def test_spread_is_split_in_two():
    parts = split_spread(spread())
    assert parts is not None, "並排的兩頁沒有被切開"
    assert len(parts) == 2
    lo, hi = sorted(p.shape[1] for p in parts)
    assert lo / hi > 0.7, f"切得太偏：{lo} vs {hi}"


def test_single_page_is_not_split():
    """
    直幅的單頁不可以被切。誤切會把每一行從中間折斷，那比漏切
    嚴重得多——漏切只是讓視覺模型一次看兩頁，它本來就會。
    """
    assert split_spread(fake_page()) is None


def test_wide_single_page_is_not_split():
    """橫幅但只有一頁：中間的留白是版面，不是裝訂線。"""
    wide = fake_page(width=1500, height=1000, lines=20)
    assert find_book_gutter(cv2.cvtColor(wide, cv2.COLOR_BGR2GRAY)) is None


def test_illumination_compensation_keeps_colour():
    """
    **顏色不能扔。** 教用版的答案是洋紅色印的，答對率標記、
    英文講義的表格底色也都靠顏色分辨。舊版本把整張圖轉灰階再
    轉回 BGR，這一條就是防它回來。
    """
    magenta = (127, 0, 236)  # BGR of #EC008C
    img = fake_page(colour=magenta)
    # 疊一層漸層陰影，逼出光照補償
    shade = np.linspace(0, 120, img.shape[1], dtype=np.float32)
    img = np.clip(img.astype(np.float32) - shade[None, :, None], 0, 255).astype(np.uint8)

    out, shadow = flatten_illumination(img)
    assert shadow > 22, f"這張圖應該被判為光照不均，實得 {shadow:.0f}"

    patch = out[200:214, 100:400].reshape(-1, 3).astype(int)
    spread_bgr = patch.max(axis=0) - patch.min(axis=0)
    assert spread_bgr.max() > 40, f"色塊被壓成灰的了：{patch.mean(axis=0)}"


def test_contrast_is_measured_before_compensation():
    """
    對比度要在**原圖**上量。補償之後量到的是補償的效果——
    實測五張正常照片的原圖對比度是 54–66，補償後掉到 27–36，
    而門檻是 35，於是每一張都被誤判成「淡墨」。
    """
    shade = np.linspace(0, 120, 800, dtype=np.float32)
    img = fake_page()
    img = np.clip(img.astype(np.float32) - shade[None, :, None], 0, 255).astype(np.uint8)

    _, _, notes = _enhance_scan(_to_png(img))
    assert not any("對比度偏低" in n for n in notes), notes


# ─────────────────────────────────────────────────────────────────
# 真實照片
# ─────────────────────────────────────────────────────────────────


def test_real_photos_all_survive():
    if not PHOTOS:
        print("  · 跳過：samples/ 裡沒有照片")
        return

    for p in PHOTOS:
        result = normalize_image(p.read_bytes())
        assert result.kind == "image"
        assert result.has_text_layer is False
        assert result.pages, f"{p.name} 沒有輸出任何頁"
        assert 0.0 < result.quality <= 1.0
        for page in result.pages:
            assert page.width > 200 and page.height > 200, (
                f"{p.name} 第 {page.index} 頁太小：{page.width}x{page.height}"
            )
            assert page.text_blocks == [], "照片不該有文字層"


def test_real_photos_are_split_into_pages():
    """
    這五張都是翻拍攤開的書。切不開的話，版面切分會橫跨裝訂線
    把左頁的第一行接到右頁的第一行——題目看起來完全正常，
    只是內容錯了，而那種錯誤沒有任何跡象可循。
    """
    if not PHOTOS:
        print("  · 跳過：samples/ 裡沒有照片")
        return

    split = 0
    for p in PHOTOS:
        result = normalize_image(p.read_bytes())
        if len(result.pages) == 2:
            split += 1
    assert split >= len(PHOTOS) - 1, (
        f"只有 {split}/{len(PHOTOS)} 張被切成兩頁"
    )


def test_real_sideways_photo_is_turned_upright():
    hit = [p for p in PHOTOS if SIDEWAYS in p.name]
    if not hit:
        print(f"  · 跳過：找不到 {SIDEWAYS} 那張")
        return

    result = normalize_image(hit[0].read_bytes())
    assert any("旋轉" in n for n in result.pages[0].quality_notes), (
        f"躺著的那張沒有被轉正：{result.pages[0].quality_notes}"
    )
    # 轉正並切頁之後，每一頁都應該是直幅
    for page in result.pages:
        assert page.height > page.width, (
            f"第 {page.index} 頁是 {page.width}x{page.height}，不是直幅"
        )


def test_real_photos_are_not_wrongly_penalised():
    """
    正常的翻拍不該被扣「淡墨」的分。老師會照著品質分數決定要不要
    重拍，分數不準就等於在騙他重拍一張一樣的。
    """
    if not PHOTOS:
        print("  · 跳過：samples/ 裡沒有照片")
        return

    for p in PHOTOS:
        result = normalize_image(p.read_bytes())
        notes = result.pages[0].quality_notes
        assert not any("對比度偏低" in n for n in notes), f"{p.name}：{notes}"
        assert result.quality >= 0.7, f"{p.name} 品質只有 {result.quality:.2f}：{notes}"


def test_real_photos_keep_their_colour():
    if not PHOTOS:
        print("  · 跳過：samples/ 裡沒有照片")
        return

    for p in PHOTOS:
        result = normalize_image(p.read_bytes())
        img = _to_cv(result.pages[0].png)
        b, g, r = (img[:, :, i].astype(int) for i in range(3))
        chroma = np.maximum(np.maximum(abs(r - g), abs(g - b)), abs(r - b))
        coloured = float((chroma > 40).mean())
        assert coloured > 0.001, (
            f"{p.name} 處理後幾乎沒有顏色（{coloured:.4%}），"
            f"答案墨色偵測會失效"
        )


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
            traceback.print_exc(limit=3)
    print(f"\n{len(fns) - failed}/{len(fns)} 通過")
    sys.exit(1 if failed else 0)
