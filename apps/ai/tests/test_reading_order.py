"""
閱讀順序的測試。

這些案例全部來自真實試卷的排版：學測英文的閱讀測驗是雙欄、
自然科的試卷是雙欄、詞彙表偶爾是三欄，而每一頁都有頁首頁尾。

會特別把這一段拉出來測，是因為它的錯誤特別難查——順序錯了之後，
下游模型收到的是被交錯打散的文字，它會盡力理解然後給出看起來
合理但完全錯誤的切題結果。從結果反推回「排序錯了」需要很久。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pipeline.normalize import _find_gutter, _reading_order  # noqa: E402


def blk(text: str, x0: float, y0: float, x1: float, y1: float, order: int = 0) -> dict:
    return {"text": text, "bbox": {"x0": x0, "y0": y0, "x1": x1, "y1": y1}, "order": order}


def names(blocks: list[dict]) -> list[str]:
    return [b["text"] for b in blocks]


def two_column(spanning: list[dict] | None = None, rows: int = 4) -> list[dict]:
    out = list(spanning or [])
    for i in range(rows):
        out.append(blk(f"L{i}", 0.08, 0.12 + i * 0.10, 0.46, 0.20 + i * 0.10))
    for i in range(rows):
        out.append(blk(f"R{i}", 0.54, 0.12 + i * 0.10, 0.92, 0.20 + i * 0.10))
    return out


# ── 雙欄 ──────────────────────────────────────────────────────────


def test_two_column_with_spanning_title():
    blocks = two_column([blk("T", 0.08, 0.05, 0.92, 0.09, order=99)])
    assert names(_reading_order(blocks)) == [
        "T", "L0", "L1", "L2", "L3", "R0", "R1", "R2", "R3",
    ]


def test_two_column_with_header_and_footer():
    """頁首＋頁尾＋跨欄標題：三個跨欄元素也不該讓分欄失效。"""
    blocks = two_column(
        [
            blk("HEAD", 0.08, 0.02, 0.92, 0.06),
            blk("FOOT", 0.08, 0.93, 0.92, 0.97),
        ]
    )
    assert names(_reading_order(blocks)) == [
        "HEAD", "L0", "L1", "L2", "L3", "R0", "R1", "R2", "R3", "FOOT",
    ]


def test_uneven_columns():
    """左窄右寬：題目在左、圖表在右。欄間帶不在正中央。"""
    blocks = [
        *[blk(f"L{i}", 0.08, 0.10 + i * 0.10, 0.38, 0.18 + i * 0.10) for i in range(3)],
        *[blk(f"R{i}", 0.44, 0.10 + i * 0.16, 0.94, 0.24 + i * 0.16) for i in range(2)],
    ]
    assert names(_reading_order(blocks)) == ["L0", "L1", "L2", "R0", "R1"]


def test_three_columns():
    """三欄（詞彙表）。分完欄後對每一欄再遞迴，所以也要正確。"""
    blocks = []
    for c, x in enumerate([0.04, 0.36, 0.68]):
        for i in range(4):
            blocks.append(blk(f"C{c}-{i}", x, 0.10 + i * 0.10, x + 0.24, 0.18 + i * 0.10))
    assert names(_reading_order(blocks)) == [f"C{c}-{i}" for c in range(3) for i in range(4)]


# ── 單欄：不可誤判 ────────────────────────────────────────────────


def test_single_column_not_split():
    blocks = [blk(f"S{i}", 0.10, 0.08 + i * 0.06, 0.90, 0.13 + i * 0.06) for i in range(10)]
    assert _find_gutter(blocks) is None
    assert names(_reading_order(blocks)) == [f"S{i}" for i in range(10)]


def test_indented_options_not_split():
    """選項縮排不是分欄。這是最容易誤判的形狀。"""
    blocks, want = [], []
    for i in range(4):
        blocks.append(blk(f"Q{i}", 0.08, 0.05 + i * 0.24, 0.92, 0.10 + i * 0.24))
        want.append(f"Q{i}")
        for j in range(3):
            y = 0.12 + i * 0.24 + j * 0.03
            blocks.append(blk(f"Q{i}o{j}", 0.14, y, 0.88, y + 0.02))
            want.append(f"Q{i}o{j}")
    assert _find_gutter(blocks) is None
    assert names(_reading_order(blocks)) == want


def test_left_aligned_short_lines_not_split():
    """
    整頁都是靠左的短行（例如答案欄「1. (3)」）。
    右半邊是空的，會找到「空白帶」，但那不是分欄——
    右欄沒有內容，必須退回單欄。
    """
    blocks = [blk(f"A{i}", 0.06, 0.08 + i * 0.07, 0.28, 0.13 + i * 0.07) for i in range(10)]
    assert names(_reading_order(blocks)) == [f"A{i}" for i in range(10)]


def test_too_few_blocks():
    """區塊太少時不做任何猜測，直接按 y 排。"""
    blocks = [blk("A", 0.08, 0.2, 0.4, 0.3), blk("B", 0.6, 0.1, 0.9, 0.2)]
    assert names(_reading_order(blocks)) == ["B", "A"]


# ── 不變量 ────────────────────────────────────────────────────────


def test_output_is_a_permutation_of_input():
    """
    無論走哪一條路徑，輸出必須是輸入的重排——不多不少。
    遞迴分欄時做了座標縮放與物件複製，這一條是防止那裡漏掉區塊。
    """
    cases = [
        two_column([blk("T", 0.08, 0.05, 0.92, 0.09)]),
        [blk(f"S{i}", 0.10, 0.08 + i * 0.06, 0.90, 0.13 + i * 0.06) for i in range(10)],
        [
            blk(f"C{c}-{i}", x, 0.10 + i * 0.10, x + 0.24, 0.18 + i * 0.10)
            for c, x in enumerate([0.04, 0.36, 0.68])
            for i in range(4)
        ],
    ]
    for blocks in cases:
        out = _reading_order(blocks)
        assert len(out) == len(blocks)
        assert {id(b) for b in out} == {id(b) for b in blocks}


if __name__ == "__main__":
    import traceback

    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"  ✓ {fn.__name__}")
        except AssertionError:
            failed += 1
            print(f"  ✗ {fn.__name__}")
            traceback.print_exc(limit=2)
    print(f"\n{len(fns) - failed}/{len(fns)} 通過")
    sys.exit(1 if failed else 0)
