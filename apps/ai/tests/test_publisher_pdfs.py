"""
出版社直接給的 PDF：兩件真材料才打得出來的事。

這一支的來由是兩份真實講義——南易《EZ 講義 物理(全)》第 3 章、
翰林《互動式教學講義·化學(全)》CH3。兩份都是出版社的原生 PDF，
兩份都在管線上炸出了設計時沒想到的問題：

  一、**有文字層不等於文字層是對的。**
      化學那份抽出來是「⛯⊣䘬㶟⎰䈑炻䧙䁢㹞㵚ˤ」，實際印的是
      「均勻的混合物，稱為溶液。」——出版社的自訂子集字型對不回
      Unicode。抽出來的每個字都是合法的 Unicode，只是**錯的字**，
      而且不會報錯。系統原本會拿它當題幹存進題庫。

  二、**沒有文字層不等於是掃描件。**
      物理那份一個字都抽不到（文字全轉成外框防拷貝），但它是
      原生向量的。系統原本把它當手機翻拍的照片處理，於是：
        · 1 頁被判成上下顛倒並**真的轉了 180°**
        · 26 頁被標「對比度偏低，可能是淡墨或影本多次複印」
        · 5 頁「方向無法判定」
      34 筆警告沒有一筆是真的，而其中一筆會毀掉一頁。

真實檔案有著作權，不進版控；找不到就跳過，不讓 CI 失敗。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import fitz  # noqa: E402

from pipeline.normalize import (  # noqa: E402
    _page_is_raster_scan,
    normalize_pdf,
    text_legibility,
)

SAMPLES = Path(os.getenv("WORKSHEET_SAMPLE_DIR", "/home/claude/samples"))
PHYSICS = SAMPLES / "講義-物理-EZ第3章學用.pdf"
CHEMISTRY = SAMPLES / "講義-化學-CH3溶液與常見的化學反應學用.pdf"
#: 正常的對照組。沒有它就不知道判準會不會把好的也判壞。
CLEAN = [
    SAMPLES / "講義-數學1-4-1直線方程式.pdf",
    SAMPLES / "講義-學生版-4-3圓與直線.pdf",
]


# ─────────────────────────────────────────────────────────────────
# 一、文字層讀不讀得懂（不需要真檔案）
# ─────────────────────────────────────────────────────────────────


def test_mojibake_is_caught():
    """
    翰林化學講義實際抽出來的文字。每個字都是合法的 Unicode，
    只是位移了 12376 個碼位——所以沒有任何一層會報錯。
    """
    bad = (
        "⛯⊣䘬㶟⎰䈑炻䧙䁢㹞㵚ˤ⣏⣂㔠䘬⊾⬠⍵ㅱ⛐㹞㵚ᷕ忚埴ˤ"
        "㹞∹烉慷⣂侭䁢㹞∹ˤ㹞㵚ᷕ⏓㯜㗪炻㯜䁢㹞∹ˤ"
        "㹞岒烉慷⮹侭䁢㹞岒ˤὅ㹞∹↮烉ὅ㹞㵚䉨ン↮烉ὅ⮶暣⿏↮烉"
        "ὅ㹞岒柮䰺⣏⮷↮烉⭂佑烉㹞岒柮䰺䘬䚜⼹⛐先橼㹞㵚ˤ"
        "㹞岒烉㹞岒柮䰺忂ⷠ㗗䓙檀↮⫸ˣ⣰䰛䰺⫸ˣ暊⫸⏠旬㹞㵚ᷕ"
    ) * 2
    ok, why = text_legibility(bad)
    assert not ok, "整段亂碼卻判成可信"
    assert "亂碼" in why


def test_normal_chinese_passes():
    """
    對照組。判錯的代價是白花一次視覺模型的錢，而且是整份。
    """
    good = (
        "下列關於等速度運動的敘述，何者正確？速度是具有量值與方向的物理量，"
        "稱為向量；速率只有量值，是純量。在同一段時間內，物體所走的路徑長"
        "一定大於或等於位移的量值。若物體沿直線同向運動，則兩者相等。"
        "以下各題請就選項中選出最適當的答案，並將代號填入括號中。"
    ) * 2
    ok, why = text_legibility(good)
    assert ok, f"正常中文被判成亂碼：{why}"


def test_short_text_is_not_accused():
    """
    漢字太少時一律放行。數學與英文的頁面本來就沒幾個中文字，
    **不確定就不要指控**——判錯一頁的代價是整份改走影像判讀。
    """
    for s in ("解", "第 3 題", "設 f(x)＝x²，求極值。", "(A) 甲　(B) 乙　(C) 丙"):
        ok, _ = text_legibility(s)
        assert ok, s


def test_classical_chinese_is_not_mojibake():
    """
    國文的文言文用字比較罕見，但仍在常用區。這是最可能誤判的一類，
    所以特別測一次。
    """
    text = (
        "陳情表曰：臣密言，臣以險釁，夙遭閔凶。生孩六月，慈父見背；"
        "行年四歲，舅奪母志。祖母劉愍臣孤弱，躬親撫養。臣少多疾病，"
        "九歲不行，零丁孤苦，至於成立。既無伯叔，終鮮兄弟，門衰祚薄，"
        "晚有兒息。外無期功強近之親，內無應門五尺之僮。"
    )
    ok, why = text_legibility(text)
    assert ok, f"文言文被判成亂碼：{why}"


# ─────────────────────────────────────────────────────────────────
# 二、真檔案
# ─────────────────────────────────────────────────────────────────


def test_physics_outlined_pdf_is_not_treated_as_a_photo():
    """
    **這一支測的是「不要做事」。**

    物理那份沒有文字層，但它是原生向量的。照片前處理（歪斜校正、
    光照補償、方向判定、書縫切頁）是為手機拍的紙本設計的，套到一張
    乾淨的向量頁上只會製造假警告——最壞的一筆是把一頁轉 180°，
    那一頁就毀了。
    """
    if not PHYSICS.exists():
        return

    doc = fitz.open(PHYSICS)
    try:
        assert not any(_page_is_raster_scan(p) for p in doc), "向量頁被當成掃描圖"
    finally:
        doc.close()

    r = normalize_pdf(PHYSICS.read_bytes())
    assert r.has_text_layer is False, "文字全轉成外框，不該宣稱有文字層"
    assert len(r.pages) == 36, f"36 頁不該被切成 {len(r.pages)} 頁"
    assert r.quality == 1.0, "出版社給的向量 PDF 不該被扣品質分"

    notes = [n for p in r.pages for n in p.quality_notes]
    assert not notes, f"乾淨的向量頁不該有任何品質警告，實得：{notes[:3]}"
    assert "外框" in r.quality_note, r.quality_note


def test_chemistry_mojibake_pdf_falls_back_to_the_image():
    """
    化學那份文字量充足（43712 字），密度判準會說「原生 PDF，
    辨識準確率高」——然後把亂碼當題幹送下去。

    正確的行為是當成沒有文字層，改走影像判讀。那比拿
    「⛯⊣䘬㶟⎰䈑」當題幹好得多。
    """
    if not CHEMISTRY.exists():
        return

    doc = fitz.open(CHEMISTRY)
    try:
        raw = "".join(p.get_text() for p in doc)
    finally:
        doc.close()
    assert len(raw) > 40000, "這一份本來就有大量文字——問題不在量而在對不對"

    r = normalize_pdf(CHEMISTRY.read_bytes())
    assert r.has_text_layer is False, "亂碼的文字層不該被當成可用"
    assert all(not p.text_blocks for p in r.pages), "亂碼不該被送到下游"
    assert "亂碼" in r.quality_note, r.quality_note
    # 老師上傳的是一份看起來完全正常的 PDF，系統說讀不懂裡面的字，
    # 那句話沒有解釋就沒有道理。
    assert "字型" in r.quality_note or "Unicode" in r.quality_note, r.quality_note


def test_clean_worksheets_still_take_the_cheap_path():
    """
    對照組。判準訂太鬆的話，正常的原生 PDF 會被推去問視覺模型，
    而那是白花錢——PDF 自己知道每個字在哪裡，模型的估計不可能更準。
    """
    for path in CLEAN:
        if not path.exists():
            continue
        r = normalize_pdf(path.read_bytes())
        assert r.kind == "native_pdf", f"{path.name} 被誤判成 {r.kind}"
        assert r.has_text_layer is True, path.name
        assert any(p.text_blocks for p in r.pages), path.name
        assert "亂碼" not in r.quality_note, f"{path.name}：{r.quality_note}"


def test_the_http_route_does_not_hand_mojibake_to_the_next_stage():
    """
    上面幾支測的是判斷本身，這一支測**真的走過那條路**。

    管線的各階段是分開跑的：正規化把 `text_blocks` 寫進工作，
    切分階段拿它去省視覺模型的錢。中間任何一層漏掉這個判斷，
    亂碼就會一路變成題幹——而那正是這一整支測試存在的理由。
    """
    if not CHEMISTRY.exists():
        return

    from fakestore import install

    fake = install()

    from fastapi.testclient import TestClient

    import main

    # 只取三頁：這一支要驗的是契約，不是效能。整份 44 頁跑一次要
    # 一分半，那會讓這支測試從「每次存檔都跑」降級成「偶爾才跑」。
    src = fitz.open(CHEMISTRY)
    slim = fitz.open()
    slim.insert_pdf(src, from_page=1, to_page=3)
    data = slim.tobytes()
    slim.close()
    src.close()

    fake["src/chem.pdf"] = data
    with TestClient(main.app) as client:
        r = client.post(
            "/v1/import/normalize",
            json={
                "source_key": "src/chem.pdf",
                "file_name": "chem.pdf",
                "page_key_prefix": "job-chem/pages",
            },
        )
    assert r.status_code == 200, r.text
    out = r.json()

    assert out["has_text_layer"] is False, "亂碼的文字層不該宣稱可用"
    for p in out["pages"]:
        assert not p.get("text_blocks"), "亂碼被送到下游了"
        assert p["storage_key"] in fake, "頁面影像要寫進物件儲存，模型才看得到"
    assert "亂碼" in out["quality_note"], out["quality_note"]
