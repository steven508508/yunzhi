"""
出處與全國答對率的抽取測試。

社會科與英文的講義在每道考古題旁邊印兩個小標籤：「112學測」與
「答對率 43%」。第一眼看起來只是版面裝飾，實際上是這套系統拿得到
的**最有價值的一筆資料**——那個答對率是大考中心的實測難度。

有它，一道題入庫當天就有校準過的難度；沒有它，要等本班學生作答
幾百次才知道難不難。而且能力分析才說得出「你這題錯了，但全國有
57% 的人也錯」——訪談時老師抱怨現有系統「分析很淺」，指的正是
這種東西。

這一支測試的重點其實是**不要誤抓**。「自 108 學測起，社會科加考
混合題型」裡的年份是題幹的一部分；把它當標籤拿掉，題目就被改寫
了，而且改寫後的句子仍然通順——校對介面上看不出來。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pipeline.segment import extract_provenance  # noqa: E402


def test_rate_and_exam_side_by_side():
    """實際版面：題幹後面接兩個色塊標籤。"""
    prov, cleaned = extract_provenance(
        "13.地球內部的組成，下列何者正確？　答對率 43%　112學測"
    )
    assert prov.correct_rate == 0.43
    assert prov.exam == "112學測"
    assert cleaned == "13.地球內部的組成，下列何者正確？"


def test_rate_in_brackets():
    prov, cleaned = extract_provenance("11.圖一為何處？[答對率 95%]")
    assert prov.correct_rate == 0.95
    assert "答對率" not in cleaned
    assert cleaned == "11.圖一為何處？"


def test_full_width_percent_and_colon():
    prov, _ = extract_provenance("答對率：39％　115學測")
    assert prov.correct_rate == 0.39
    assert prov.exam == "115學測"


def test_exam_at_the_tail_is_a_badge():
    prov, cleaned = extract_provenance("15. 婆羅洲島的面積約多少？（108學測）")
    assert prov.exam == "108學測"
    assert "108" not in cleaned


def test_exam_inside_the_sentence_is_content():
    """
    **這一條是這支測試存在的理由。**

    「自 108 學測起…」的年份是題目在講的事情，不是標籤。抓掉它
    之後句子變成「自 起，社會科加考…」——仍然通順，校對者掃過去
    不會發現，而題目已經壞了。
    """
    text = "自 108 學測起，社會科加考混合題型，下列敘述何者正確？"
    prov, cleaned = extract_provenance(text)
    assert cleaned == text, f"題幹被改寫了：{cleaned!r}"
    assert prov.exam is None


def test_exam_mid_sentence_with_trailing_text_is_content():
    text = "說明：本題取自 110學測，請作答。"
    _, cleaned = extract_provenance(text)
    assert cleaned == text


def test_standalone_badge_block():
    """標籤自成一個區塊的情形（版面上是一個獨立的圓角色塊）。"""
    prov, cleaned = extract_provenance("112學測")
    assert prov.exam == "112學測"
    assert cleaned == ""


def test_plain_question_is_untouched():
    text = "2. 下列何者為真？"
    prov, cleaned = extract_provenance(text)
    assert not prov
    assert cleaned == text


def test_dollar_amount_is_not_a_rate():
    text = "小明有 $100 元，買了 3 支筆"
    prov, cleaned = extract_provenance(text)
    assert prov.correct_rate is None
    assert cleaned == text


def test_impossible_rate_is_rejected():
    """
    答對率不可能超過 100%。抓到 999% 代表規則配到了別的東西——
    寧可留空，也不要讓一個假的實測難度進到題庫。
    """
    prov, _ = extract_provenance("編號 999% 的題目")
    assert prov.correct_rate is None


def test_rate_is_a_ratio_not_a_percentage():
    """
    存 0.43 而不是 43。存錯的話能力分析會算出「比全國高 4200%」
    這種數字，而且不會報錯。
    """
    prov, _ = extract_provenance("答對率 43%")
    assert prov.correct_rate is not None
    assert 0.0 <= prov.correct_rate <= 1.0


def test_rate_inside_the_sentence_is_content():
    """
    **這一條與上面那條一樣重要，而且更難發現。**

    「已知該次測驗全班答對率 43%，共 40 人應試，求答對人數」是一道
    數學題。把 43% 當成大考中心的實測難度抓走，題幹會變成
    「…全班，共 40 人應試…」——一道無解的題目，而那個編出來的
    難度會被當成實測值寫進題庫，之後再也分不出真假。
    """
    text = "已知該次測驗全班答對率 43%，共 40 人應試，求答對人數。"
    prov, cleaned = extract_provenance(text)
    assert prov.correct_rate is None, "題幹裡的百分比被當成實測難度了"
    assert cleaned == text


def test_badges_must_form_a_trailing_cluster():
    """
    版面事實：這兩個標籤印在題目末端的一串圓角色塊裡。所以判準是
    「文字結尾的一段連續標籤區」，不是「位置接近」。
    """
    prov, cleaned = extract_provenance("答對率 43% 的那一題，112學測")
    # 「112學測」在結尾 → 是標籤；「答對率 43%」中間隔著中文 → 是內容
    assert prov.exam == "112學測"
    assert prov.correct_rate is None
    assert "答對率 43%" in cleaned


def test_stripping_does_not_leave_a_dangling_bracket():
    """
    剝掉標籤之後左括號會落單，變成「…面積約多少？（」——
    看起來就像抽壞了，校對者會退回重做。
    """
    _, cleaned = extract_provenance("15. 婆羅洲島的面積約多少？（108學測）")
    assert cleaned == "15. 婆羅洲島的面積約多少？", repr(cleaned)
    _, cleaned2 = extract_provenance("11.圖一為何處？[答對率 95%]")
    assert cleaned2 == "11.圖一為何處？", repr(cleaned2)


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
