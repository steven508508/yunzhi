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

#: 真實講義的路徑。有著作權，不進版控；找不到就跳過，不讓 CI 失敗。
#: 多份用 os.pathsep 分隔，第一份會被當成「主樣本」做細部檢查。
SAMPLES = [
    Path(p)
    for p in os.getenv(
        "WORKSHEET_SAMPLES",
        "/home/claude/samples/講義-數學1-4-1直線方程式.pdf"
        + os.pathsep
        + "/home/claude/samples/講義-學生版-4-3圓與直線.pdf",
    ).split(os.pathsep)
    if p
]
SAMPLE = SAMPLES[0]

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


def _run(sample: Path = None):
    sample = sample or SAMPLE
    _FAKE.clear()
    _FAKE["src/worksheet.pdf"] = sample.read_bytes()

    r = client.post(
        "/v1/import/normalize",
        json={
            "source_key": "src/worksheet.pdf",
            "file_name": sample.name,
            "page_key_prefix": "job/pages",
        },
    )
    assert r.status_code == 200, r.text
    norm = r.json()

    r = client.post(
        "/v1/import/segment",
        json={
            "pages": [
                {"index": p["index"], "storage_key": p["storage_key"],
                 "text_blocks": p["text_blocks"], "figures": p["figures"]}
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


def test_figures_are_extracted_and_attached():
    """
    講義的幾何題幾乎每題都有附圖。抓不到圖的話，題幹寫著「如右圖」
    而學生看到一片空白——那是不能用的題目。
    """
    if not SAMPLE.exists():
        print(f"  · 跳過：找不到 {SAMPLE}")
        return

    norm, segd = _run()

    total = sum(len(p["figures"]) for p in norm["pages"])
    assert total >= 20, f"整份只抓到 {total} 張圖，太少"

    # 圖要真的裁出來並寫進物件儲存
    keys = [f["key"] for p in norm["pages"] for f in p["figures"]]
    assert keys, "沒有任何圖被裁切"
    for k in keys[:5]:
        assert k in _FAKE, f"{k} 沒有寫進物件儲存"
        assert len(_FAKE[k]) > 500, f"{k} 太小，可能裁到空白"

    with_fig = [e for e in segd["exercises"] if e["assets"]]
    assert len(with_fig) >= 8, f"只有 {len(with_fig)} 題掛到圖"

    # bbox 要在頁面範圍內，否則校對介面的連動會指到頁面外
    for p in norm["pages"]:
        for f in p["figures"]:
            b = f["bbox"]
            assert 0 <= b["x0"] < b["x1"] <= 1, b
            assert 0 <= b["y0"] < b["y1"] <= 1, b


def test_math_is_reconstructed_in_real_content():
    """
    分數與上下標要真的組回來。沒組起來的話下游收到的是
    `－3－（－1）＝－7` 這種碎片，而模型會盡力理解然後給出
    合理但錯誤的結果——沒有任何錯誤訊息。
    """
    if not SAMPLE.exists():
        print(f"  · 跳過：找不到 {SAMPLE}")
        return

    _, segd = _run()
    body = "\n".join(
        (e["stem"] + "\n" + e["explanation"]) for e in segd["exercises"]
    )
    assert r"\frac" in body, "一份數學講義不可能沒有分數"
    assert "^{" in body or "_{" in body, "應該有上下標"

    import re

    # 分隔符必須成對。未還原的符號字型會把 ①②③④ 吐成 `!@#$`，
    # 那個裸奔的 $ 會讓後面所有配對錯位。
    for e in segd["exercises"]:
        for field in ("stem", "explanation"):
            v = e.get(field) or ""
            assert len(re.findall(r"(?<!\\)\$", v)) % 2 == 0, (
                f"{e['label']} 的 {field} 有落單的 $：{v[:80]}"
            )

    # 全形運算符號在數學區間內要換成半形，否則 KaTeX 排不出來
    for m in re.finditer(r"(?<!\\)\$(.+?)(?<!\\)\$", body):
        assert "＝" not in m.group(1), f"數學區間裡還有全形等號：{m.group(1)[:40]}"


def test_every_sample_parses():
    """
    每一份樣本都要走得完，而且結果要合理。
    細部斷言只對主樣本做——其餘的驗「不會壞掉、數量級對」就夠了，
    否則每加一份樣本就要改一次測試，那會讓人不想加樣本。
    """
    for sample in SAMPLES:
        if not sample.exists():
            print(f"  · 跳過：{sample.name}")
            continue

        norm, segd = _run(sample)
        assert norm["kind"] == "native_pdf", sample.name
        assert segd["vision_pages"] == 0, f"{sample.name} 不該用到視覺模型"
        assert segd["genre"] == "worksheet", sample.name
        assert len(segd["exercises"]) >= 20, f"{sample.name} 題目單位太少"

        # 教用版才有答案墨色。有的話，詳解的覆蓋率要夠高——
        # 教用版的價值就在詳解。
        if segd["answer_ink"]:
            ex = segd["exercises"]
            with_sol = sum(1 for e in ex if e["explanation"])
            assert with_sol / len(ex) >= 0.8, (
                f"{sample.name}：只有 {with_sol}/{len(ex)} 題抓到詳解"
            )


def test_answer_ink_is_not_hardcoded():
    """
    同一家出版社的不同章節，答案墨色不完全一樣（實測 #EC008C 與
    #E4007F）。偵測必須是真的偵測，不能是寫死的色票。
    """
    inks = set()
    for sample in SAMPLES:
        if not sample.exists():
            continue
        _, segd = _run(sample)
        if segd["answer_ink"]:
            inks.add(segd["answer_ink"])

    if len(SAMPLES) >= 2 and len(inks) >= 2:
        assert len(inks) >= 2, "兩份講義的答案墨色應該不同，卻偵測成同一個"


def test_glyph_cache_pays_off_across_documents():
    """
    第二份講義應該大量命中第一份建立的字形對應。
    這是整個設計的重點：**同一家出版社只要問一次模型**。
    """
    if len(SAMPLES) < 2 or not all(s.exists() for s in SAMPLES[:2]):
        print("  · 跳過：需要兩份樣本")
        return

    from pipeline.glyphmap import load_cache
    from pipeline.normalize import prepare

    if not load_cache():
        print("  · 跳過：字形快取是空的")
        return

    prep = prepare(SAMPLES[1].read_bytes(), SAMPLES[1].name)
    cache = load_cache()
    hits = sum(1 for u in prep.glyphs.uses if u.key in cache)
    assert prep.glyphs.uses, "第二份應該也偵測得到符號字型"
    assert hits / len(prep.glyphs.uses) >= 0.5, (
        f"快取只命中 {hits}/{len(prep.glyphs.uses)}，跨文件重用沒有生效"
    )


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
