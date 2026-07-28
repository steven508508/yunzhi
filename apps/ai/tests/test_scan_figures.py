"""
掃描頁與照片的附圖。

原生 PDF 的圖是從繪圖物件聚出來的（figures.py）。掃描件沒有繪圖
物件，只有像素——而那條路原本的註解寫著「影像來源整張就是一張圖，
沒有『圖在哪裡』的問題」。老師傳來的五張照片證明那句話是錯的：
翻拍一頁地理講義，裡面有等高線地形圖、街道圖、三張衛星影像、
一張婆羅洲島輪廓圖，全都在同一頁。

**試過純影像的作法**：遮掉文字行、把剩下的墨聚類。地理那兩頁抓得
很準，英文那兩頁抓出 15 個候選、全部是誤判——密排的英文行沒被
遮乾淨，剩下的墨連成一片看起來就像一張圖。誤判的圖會讓學生看到
一塊沒有意義的裁切，比沒有圖更糟，所以那條路沒有採用。

改成由視覺模型回報圖的位置。它這一趟本來就要呼叫（切分要用），
順手回報位置是零額外成本，而且它知道那到底是不是一張圖。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("AI_PROVIDER", "mock")
os.environ.setdefault("S3_BUCKET", "test")
os.environ.setdefault("S3_ENDPOINT", "http://localhost:9000")

from fakestore import install  # noqa: E402

#: 三支測試共用同一份假儲存。各自宣告一份的話，模組層級的覆寫是
#: 「最後 import 的贏」，另外兩支就拿不到自己寫進去的檔案。
_FAKE = install()

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402
import routes_import as R  # noqa: E402
from pipeline import segment as seg  # noqa: E402
from pipeline.schemas import BBox, BlockType, LayoutBlock, SegmentResult  # noqa: E402

client = TestClient(main.app)
client.__enter__()

PHOTOS = sorted(Path(os.getenv("SCAN_SAMPLES", "/home/claude/samples")).glob("照片-*"))


def page_png(width=800, height=1100) -> bytes:
    """造一頁：上半是文字行，右下角畫一個明顯的方框當作圖。"""
    img = np.full((height, width, 3), 250, np.uint8)
    for i in range(12):
        y = 80 + i * 34
        cv2.rectangle(img, (70, y), (width - 90, y + 14), (30, 30, 30), -1)
    cv2.rectangle(img, (450, 620), (740, 900), (0, 0, 200), 4)
    cv2.line(img, (450, 900), (740, 620), (0, 0, 200), 3)
    ok, buf = cv2.imencode(".png", img)
    assert ok
    return buf.tobytes()


#: 視覺模型「應該」回報的東西。座標對應 page_png 裡那個方框。
FAKE_RESULT = SegmentResult(
    blocks=[
        LayoutBlock(
            type=BlockType.QUESTION_NO,
            bbox=BBox(page=1, x0=0.08, y0=0.06, x1=0.9, y1=0.10),
            text="9. 如右圖，求斜線的斜率。",
        ),
        LayoutBlock(
            type=BlockType.FIGURE,
            bbox=BBox(page=1, x0=0.55, y0=0.55, x1=0.94, y1=0.83),
            text="坐標圖，第一象限有一條由左下往右上的斜線",
        ),
    ],
    group_ranges=[],
)


def run_segment(monkey_result: SegmentResult):
    """走完整條 HTTP 路徑，但把視覺模型換成固定回覆。"""
    _FAKE.clear()
    _FAKE["job/pages/0001.png"] = page_png()

    async def fake_scanned(provider, page_index, images, page_note=""):
        out = monkey_result.model_copy(deep=True)
        for b in out.blocks:
            b.bbox.page = page_index
        return out

    original = seg.segment_scanned
    seg.segment_scanned = fake_scanned
    try:
        r = client.post(
            "/v1/import/segment",
            json={
                "pages": [
                    {"index": 1, "storage_key": "job/pages/0001.png",
                     "text_blocks": [], "figures": []}
                ]
            },
        )
    finally:
        seg.segment_scanned = original
    assert r.status_code == 200, r.text
    return r.json()


def test_vision_figure_is_cropped_and_stored():
    out = run_segment(FAKE_RESULT)
    keys = [k for k in _FAKE if "-fig-" in k]
    assert keys, f"視覺模型回報了圖卻沒有裁出來：{list(_FAKE)}"

    # 也要回報給呼叫端。裁了卻不回報的話，試卷體例（走 sections，
    # 沒有掛圖的地方）的圖會被存進物件儲存然後永遠找不到。
    reported = [f for items in out["figures"].values() for f in items]
    assert reported, f"裁出來的圖沒有回報：{out['figures']}"
    assert reported[0]["key"] in _FAKE
    assert reported[0]["labels"], "替代文字的素材沒有帶回來"

    data = _FAKE[keys[0]]
    assert len(data) > 500, "裁出來的圖太小，可能裁到空白"

    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    assert img is not None, "裁出來的不是合法影像"
    h, w = img.shape[:2]
    assert w > 100 and h > 100, f"裁切尺寸不合理：{w}x{h}"

    # 裁到的應該是那個藍框，不是一片白紙
    assert float(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).std()) > 15, "裁到的是空白"


def test_crop_pads_beyond_the_box():
    """
    模型給的框常常剛好貼著圖形，而座標軸的標籤畫在框外——
    貼齊裁的話標籤會被切掉，而標籤正是替代文字的素材。
    """
    png = page_png()
    box = BBox(page=1, x0=0.4, y0=0.4, x1=0.6, y1=0.6)
    out = R._crop_png(png, box)
    img = cv2.imdecode(np.frombuffer(out, np.uint8), cv2.IMREAD_COLOR)
    assert img.shape[1] > 0.2 * 800, f"寬度 {img.shape[1]} 沒有多留邊"


def test_tiny_boxes_are_ignored():
    """
    模型偶爾會把一個項目符號或色塊標成圖。裁出來是一塊沒有意義
    的碎片掛在題目上——那比沒有圖更糟。
    """
    result = FAKE_RESULT.model_copy(deep=True)
    result.blocks[1].bbox = BBox(page=1, x0=0.10, y0=0.10, x1=0.13, y1=0.12)
    run_segment(result)
    assert not [k for k in _FAKE if "-fig-" in k], "太小的框不該裁"


def test_native_pages_do_not_go_through_vision_cropping():
    """
    有文字層的頁面，圖已經由繪圖物件精確切好了。再從模型的
    估計框裁一次，會得到同一張圖的兩個版本掛在同一題上。
    """
    _FAKE.clear()
    _FAKE["job/pages/0001.png"] = page_png()
    out = R._crop_vision_figures(
        [FAKE_RESULT],
        {1: R.SegmentPage(index=1, storage_key="job/pages/0001.png")},
        {1: "native"},
    )
    assert out == {}


def test_real_photo_crops_are_valid_images():
    """
    真實照片：裁切座標經過正規化、透視校正、切頁之後仍要落在頁內。
    """
    if not PHOTOS:
        print("  · 跳過：samples/ 裡沒有照片")
        return

    from pipeline.normalize import normalize

    for p in PHOTOS[:2]:
        result = normalize(p.read_bytes(), p.name)
        png = result.pages[0].png
        box = BBox(page=1, x0=0.52, y0=0.30, x1=0.96, y1=0.62)
        data = R._crop_png(png, box)
        img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        assert img is not None and img.size > 0, p.name


def test_crop_at_the_page_edge_does_not_overflow():
    """框貼齊頁緣時，往外多留的邊不可以讓裁切範圍跑到頁面外。"""
    png = page_png()
    for box in (
        BBox(page=1, x0=0.0, y0=0.0, x1=0.3, y1=0.3),
        BBox(page=1, x0=0.7, y0=0.7, x1=1.0, y1=1.0),
    ):
        img = cv2.imdecode(
            np.frombuffer(R._crop_png(png, box), np.uint8), cv2.IMREAD_COLOR
        )
        assert img is not None and img.size > 0, box


def test_context_page_blocks_are_not_kept_twice():
    """
    視覺切分一次送**連續兩頁**給模型看接續，但下一頁自己也會被當成
    主頁跑一次。兩邊的區塊都留的話，第 2 頁起每一頁的內容都會進
    題庫兩次——一模一樣的兩份，看起來就像題本印了兩遍，而校對者
    會以為是自己看錯。
    """
    _FAKE.clear()
    for i in (1, 2, 3):
        _FAKE[f"job/pages/{i:04d}.png"] = page_png()

    async def fake_scanned(provider, page_index, images, page_note=""):
        # 模型看到兩頁就回兩頁的區塊，這是它被要求做的事
        out = []
        for offset in range(len(images)):
            out.append(
                LayoutBlock(
                    type=BlockType.QUESTION_NO,
                    bbox=BBox(page=page_index + offset, x0=0.08,
                              y0=0.06, x1=0.9, y1=0.10),
                    text=f"第 {page_index + offset} 頁的題目",
                )
            )
        return SegmentResult(blocks=out, group_ranges=[])

    original = seg.segment_scanned
    seg.segment_scanned = fake_scanned
    try:
        r = client.post(
            "/v1/import/segment",
            json={
                "pages": [
                    {"index": i, "storage_key": f"job/pages/{i:04d}.png",
                     "text_blocks": [], "figures": []}
                    for i in (1, 2, 3)
                ]
            },
        )
    finally:
        seg.segment_scanned = original

    assert r.status_code == 200, r.text
    texts = [b["text"] for b in r.json()["blocks"]]
    assert len(texts) == len(set(texts)), f"有重複的區塊：{texts}"
    assert len(texts) == 3, texts


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
