"""
用真實講義跑完整條 HTTP 路徑。

只有拿到 samples/ 底下的真實講義才會跑；沒有就跳過，不讓 CI 失敗。
真實檔案不進版控（有著作權），但這支測試會留著——它記錄了那份
講義暴露出來的每一個問題，日後換出版社時可以照著換一份檔案再跑一次。

實測的那一份：翰林《互動式教學講義·數學(1)》4-1 直線方程式及其圖形，
教用版，29 頁，原生 PDF。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("AI_PROVIDER", "mock")
os.environ.setdefault("S3_BUCKET", "test")
os.environ.setdefault("S3_ENDPOINT", "http://localhost:9000")

SAMPLE = Path(
    os.getenv("WORKSHEET_SAMPLE", "/home/claude/samples/講義-數學1-4-1直線方程式.pdf")
)

import storage  # noqa: E402

_FAKE: dict[str, bytes] = {}
storage.get_bytes = lambda key: _FAKE[key]  # type: ignore[assignment]
storage.put_bytes = lambda key, data, content_type="": (  # type: ignore[assignment]
    _FAKE.__setitem__(key, data),
    key,
)[1]
storage.healthy = lambda: (True, None)  # type: ignore[assignment]

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402

client = TestClient(main.app)
client.__enter__()


def _run():
    _FAKE.clear()
    _FAKE["src/worksheet.pdf"] = SAMPLE.read_bytes()

    r = client.post(
        "/v1/import/normalize",
        json={
            "source_key": "src/worksheet.pdf",
            "file_name": SAMPLE.name,
            "page_key_prefix": "job/pages",
        },
    )
    assert r.status_code == 200, r.text
    norm = r.json()

    r = client.post(
        "/v1/import/segment",
        json={
            "pages": [
                {"index": p["index"], "storage_key": p["storage_key"], "text_blocks": p["text_blocks"]}
                for p in norm["pages"]
            ]
        },
    )
    assert r.status_code == 200, r.text
    return norm, r.json()


def test_real_worksheet():
    if not SAMPLE.exists():
        print(f"  · 跳過：找不到 {SAMPLE}")
        return

    norm, segd = _run()

    # ── 正規化 ──────────────────────────────────────────────
    assert norm["kind"] == "native_pdf"
    assert norm["has_text_layer"] is True
    assert norm["page_count"] == 29

    # ── 符號字型 ────────────────────────────────────────────
    # 這份講義用了 11 套出版社自製符號字型。沒有還原的話，
    # （1）（2）會變成 1 2、「解」會變成 x。
    g = norm["glyphs"]
    assert len(g["fonts"]) >= 5, f"符號字型偵測不足：{g['fonts']}"
    assert g["resolved"] + g["unresolved"] >= 40

    # ── 切分完全走純程式 ────────────────────────────────────
    assert segd["vision_pages"] == 0, "原生 PDF 不該花錢問視覺模型"
    assert segd["usage"]["calls"] == 0

    # ── 文件性質 ────────────────────────────────────────────
    assert segd["genre"] == "worksheet", f"應判定為講義，實得 {segd['genre']}"

    # ── 教用版的答案墨色 ────────────────────────────────────
    assert segd["answer_ink"], "教用版應該偵測得到答案墨色"

    # ── 題目單位 ────────────────────────────────────────────
    ex = segd["exercises"]
    assert len(ex) >= 30, f"題目單位太少：{len(ex)}"

    labels = [e["label"] for e in ex]
    assert any(l.startswith("範例") for l in labels)
    assert any(l.startswith("類題") for l in labels)

    with_solution = [e for e in ex if e["explanation"]]
    assert len(with_solution) / len(ex) >= 0.8, (
        f"只有 {len(with_solution)}/{len(ex)} 題抓到詳解。"
        f"教用版的價值就在詳解，抓不到等於白做。"
    )

    # 詳解不可以混進題幹：兩者的著作權地位不同（文件 16 §3）
    for e in ex:
        if e["explanation"]:
            head = e["explanation"].split("\n")[0][:20]
            if len(head) > 8:
                assert head not in e["stem"], f"詳解漏進題幹：{e['label']}"

    # 頁首頁尾不該出現在題幹裡
    for e in ex:
        assert "互動式教學講義" not in e["stem"], f"頁首漏進題幹：{e['label']}"


def test_glyph_restoration_changes_the_text():
    """
    還原前後要真的不一樣。這一條防的是「偵測到了但沒套用」——
    那種 bug 不會有任何錯誤訊息，只會讓下游的品質莫名其妙地差。
    """
    if not SAMPLE.exists():
        print(f"  · 跳過：找不到 {SAMPLE}")
        return

    from pipeline.normalize import normalize, prepare

    raw = SAMPLE.read_bytes()
    plain = normalize(raw, SAMPLE.name)  # 不做還原

    prep = prepare(raw, SAMPLE.name)
    if not prep.glyphs.uses:
        print("  · 跳過：這份檔案沒有符號字型")
        return

    # 用快取裡既有的對應（若有）。沒有的話這一條只驗偵測有沒有發生。
    from pipeline.glyphmap import load_cache, translator

    prep.glyphs.mapping = {
        u.key: v for u in prep.glyphs.uses if (v := load_cache().get(u.key))
    }
    if not prep.glyphs.mapping:
        print("  · 快取為空，只驗偵測")
        assert len(prep.glyphs.uses) > 0
        return

    restored = normalize(prep, SAMPLE.name)
    page = 2
    assert plain.pages[page].text_layer != restored.pages[page].text_layer
    # 最明顯的一組：子題編號
    assert "（1）" in restored.pages[page].text_layer


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
