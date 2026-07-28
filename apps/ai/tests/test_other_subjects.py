"""
數學以外的科目體例。

在此之前，整條管線只用**數學**講義驗過——而數學的結構是五科裡
最規則的。老師傳來五張其他科目的翻拍照片（地理兩張、公民一張、
英文兩張）之後，第一件事就是拿它們的實際版面回頭打規則，結果
打出一個會讓整科不能用的漏洞：

    英文與社會的講義把作答括號印在**題號前面**：

        (  ) 6. It was on Sep. 21, 1999 ______ a big earthquake hit Taiwan.

    題號規則要求數字在行首，於是那一頁 20 題**一題都認不出來**，
    整頁變成一團沒有結構的文字。

這裡的文字全部照抄自那五張照片的實際版面（翰林《英文文法》
pp.274–275、《社會規範與法律》pp.140–141、地理 pp.31/39），
只保留辨識規則需要的骨架。原始檔案有著作權，不進版控。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pipeline.schemas import BlockType  # noqa: E402
from pipeline.segment import (  # noqa: E402
    _classify,
    answer_in_paren,
    detect_genre,
    extract_provenance,
    segment_native,
)


def blocks(*lines: str) -> list[dict]:
    """把幾行文字做成 text_blocks，由上而下排列。"""
    out = []
    for i, text in enumerate(lines):
        y = 0.06 + i * 0.035
        out.append(
            {
                "text": text,
                "bbox": {"x0": 0.08, "y0": y, "x1": 0.94, "y1": y + 0.03},
                "order": i,
            }
        )
    return out


# ─────────────────────────────────────────────────────────────────
# 英文：作答括號在題號前、選項四個一列
# ─────────────────────────────────────────────────────────────────

ENGLISH = [
    "1 文法選擇：40%（每題 2 分，共 20 題）",
    "(  ) 6. It was on Sep. 21, 1999 ________ a big earthquake hit Taiwan and caused tremendous damage.",
    "(A) which　(B) where　(C) that　(D) then",
    "(  ) 7. To win the game, all the players have to cooperate with ________.",
    "(A) every other　(B) one another　(C) some other　(D) the others",
    "(  ) 8. We have many different opinions about where to go for our graduation trip.",
    "(A) some　(B) other　(C) the others　(D) another",
]


def test_english_answer_parenthesis_is_a_question_number():
    """
    **這一條是這支測試存在的理由。** 少了它，英文整科不能用。
    """
    assert _classify(ENGLISH[1], None) is BlockType.QUESTION_NO


def test_english_page_yields_one_block_per_question():
    result = segment_native(1, blocks(*ENGLISH))
    numbered = [b for b in result.blocks if b.type is BlockType.QUESTION_NO]
    assert len(numbered) == 3, [b.text[:30] for b in result.blocks]


def test_english_options_stay_options():
    """
    四個選項排成一列仍然是選項列。判成題幹的話，下游會看到一題
    「沒有選項的選擇題」而在 schema 驗證時被擋掉——整題丟失。
    """
    result = segment_native(1, blocks(*ENGLISH))
    options = [b for b in result.blocks if b.type is BlockType.OPTION]
    assert len(options) == 3, [b.text[:30] for b in result.blocks]


def test_teacher_edition_answer_in_the_parenthesis():
    """
    教用版把答案印在括號裡。這是**零成本**拿到答案的路徑，
    比 AI 自答便宜也可靠得多——AI 自答一題要投票五次。
    """
    line = "( C ) 7. To win the game, all the players have to cooperate with ________."
    assert answer_in_paren(line) == "C"
    assert _classify(line, None) is BlockType.QUESTION_NO

    result = segment_native(1, blocks(line))
    assert result.blocks[0].answers == ["C"]


def test_student_edition_parenthesis_is_empty():
    """學生版的括號是空的。空的就是空的，不要猜一個答案出來。"""
    assert answer_in_paren(ENGLISH[1]) is None
    result = segment_native(1, blocks(ENGLISH[1]))
    assert result.blocks[0].answers == []


def test_option_letter_alone_is_still_an_option():
    """
    `(C) themselves` 是選項，`( C ) 7. …` 是題號。兩者只差在
    括號後面接的是不是「數字＋標點」——分不清的話，一整道題
    會被當成前一題的第五個選項。
    """
    assert _classify("(C) themselves", None) is BlockType.OPTION
    assert answer_in_paren("(C) themselves") is None


# ─────────────────────────────────────────────────────────────────
# 社會：非選作答格、時事題組
# ─────────────────────────────────────────────────────────────────

CIVICS = [
    "考古題大搜查",
    "1.某公司違反《勞動基準法》第 49 條規定，下列敘述何者正確？　答對率 39%　115學測",
    "(A)司法院大法官　(B)最高行政法院　(C)高等行政法院　(D)最高法院",
    "夯時事練非選",
    "1.根據上文，某公司若違反該條規定，主管機關應如何處理？（10 分）",
    "作答區",
]


def test_civics_provenance_is_lifted_off_the_stem():
    prov, cleaned = extract_provenance(CIVICS[1])
    assert prov.correct_rate == 0.39
    assert prov.exam == "115學測"
    assert "答對率" not in cleaned and "115" not in cleaned


def test_civics_answer_area_is_recognised():
    """
    非選題的作答格是給學生寫字的空白，不是題目內容。當成表格
    抽取的話，題庫裡會多出一堆內容為空的欄位。
    """
    assert _classify("作答區", None) is BlockType.ANSWER_AREA


def test_civics_questions_are_found():
    result = segment_native(1, blocks(*CIVICS))
    numbered = [b for b in result.blocks if b.type is BlockType.QUESTION_NO]
    assert len(numbered) == 2, [f"{b.type.name}:{b.text[:20]}" for b in result.blocks]


# ─────────────────────────────────────────────────────────────────
# 地理：題組、答對率
# ─────────────────────────────────────────────────────────────────

GEOGRAPHY = [
    "圖為某地的等高線地形圖，甲、乙、丙、丁為該地的四個觀景臺，請問 9～10 題。",
    "9. 若要觀賞東北方向的低處景緻，圖中哪個觀景臺最為適當？　答對率 79%　111學測",
    "(A)甲　(B)乙　(C)丙　(D)丁",
    "10. 沿圖中登山步道健行，最可能經過哪個觀景臺？　答對率 74%　111學測",
    "(A)甲　(B)乙　(C)丙　(D)丁",
]


def test_geography_group_lead_is_detected():
    result = segment_native(1, blocks(*GEOGRAPHY))
    kinds = [b.type for b in result.blocks]
    assert BlockType.GROUP_LEAD in kinds, [f"{b.type.name}:{b.text[:22]}" for b in result.blocks]


def test_geography_每題都有全國答對率():
    for line in (GEOGRAPHY[1], GEOGRAPHY[3]):
        prov, cleaned = extract_provenance(line)
        assert prov.correct_rate is not None, line
        assert prov.exam == "111學測"
        assert "答對率" not in cleaned


def test_non_maths_pages_are_not_mistaken_for_worksheets_with_範例():
    """
    這幾頁沒有「範例／類題」，體例判定不該把它們判成數學講義那種
    結構——判錯的話會走 split_by_exercise，而那條路找不到任何
    題目邊界，整頁的題目會全部消失。
    """
    result = segment_native(1, blocks(*ENGLISH))
    assert detect_genre(result.blocks) != "worksheet" or all(
        b.type is not BlockType.EXERCISE_HEADER for b in result.blocks
    )


def test_decimal_option_is_not_mistaken_for_a_question():
    """
    **這一條擋的是憑空生出標準答案。**

    `(A) 4.5 公尺` 與 `( C ) 7. To win…` 只差一點點。認錯的話這一題
    少一個選項，而且括號裡的「A」會被當成教用版印出來的答案——
    一個完全沒印答案的學生版講義，會產出兩個標準答案，然後拿去
    改全班的卷子。這種錯誤在校對介面上看不出來（答案欄有東西，
    而且是合法的選項編號）。
    """
    for line in ("(A) 4.5 公尺", "(B) 3.14 倍", "(1) 2.5 公斤", "(2) 1.5 小時"):
        assert _classify(line, None) is BlockType.OPTION, line
        assert answer_in_paren(line) is None, line


def test_student_edition_never_yields_an_answer():
    """學生版整頁跑完，一個答案都不該生出來。"""
    lines = [
        "1 文法選擇：40%（每題 2 分，共 20 題）",
        "(  ) 6. It was on Sep. 21, 1999 ________ a big earthquake hit Taiwan.",
        "(A) which　(B) where　(C) that　(D) then",
        "(  ) 7. The distance is about ________.",
        "(A) 4.5 公尺　(B) 3.14 倍　(C) 2.5 公斤　(D) 1.5 小時",
    ]
    result = segment_native(1, blocks(*lines))
    answers = [a for b in result.blocks for a in b.answers]
    assert answers == [], f"學生版憑空生出答案：{answers}"


def test_question_number_followed_by_a_digit_still_works():
    """`6. 3x＋2＝5` 的題幹以數字開頭。小數點後面沒有空白，題號後面有。"""
    assert _classify("6. 3x＋2＝5，求 x 的值", None) is BlockType.QUESTION_NO


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
