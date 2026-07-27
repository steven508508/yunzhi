"""
講義體例的測試。

補習班日常用的是講義，不是學測試卷（訪談第 2 題：目前用翰林雲端；
第 9 題：「可以參考學測、但有時候會有作業或小考」）。兩者的結構
幾乎沒有重疊，所以講義的解析要單獨驗。

這一組全部是純函式測試，不需要真的講義檔——但每一條的輸入
都是從一份真實的翰林數學講義（29 頁）抄出來的字串，包括那些
一眼看不出問題、實際上會讓整份文件錯開一格的形狀。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pipeline.schemas import BlockType as B  # noqa: E402
from pipeline.segment import (  # noqa: E402
    _classify,
    _running_key,
    detect_answer_ink,
    detect_genre,
    detect_running_heads,
    extract_inline_answers,
    segment_native,
    split_by_exercise,
    split_embedded_headers,
    strip_answer_ink,
)

INK = "EC008C"  # 翰林教用版的答案墨色


def blk(text, y0=0.1, x0=0.08, x1=0.92, ink="231F20", runs=None):
    b = {
        "text": text,
        "bbox": {"x0": x0, "y0": y0, "x1": x1, "y1": y0 + 0.03},
        "order": 0,
        "ink": ink,
    }
    if runs:
        b["runs"] = runs
    return b


# ── 分類 ─────────────────────────────────────────────────────────


def test_worksheet_markers():
    cases = [
        ("範例1", B.EXERCISE_HEADER),
        ("類題", B.EXERCISE_HEADER),
        ("類題２", B.EXERCISE_HEADER),
        ("習題", B.EXERCISE_HEADER),
        ("隨堂練習", B.EXERCISE_HEADER),
        ("答：　(B)", B.ANSWER_KEY),
        ("解", B.EXPLANATION),
        ("解 連線 AB 的斜率 m＝", B.EXPLANATION),
        ("說明： 如右圖，設 P（x﹐y）為直線 L 上任意點。", B.TEACHING_NOTE),
        ("註：水平線沒有 x 截距。", B.TEACHING_NOTE),
        ("1. 點斜式：", B.CONCEPT),
        ("◎ 搭配課本 P.160～P.163", B.HEADER_FOOTER),
    ]
    for text, want in cases:
        assert _classify(text, None) is want, f"{text!r} → {_classify(text, None)}"


def test_exam_markers_still_win():
    """講義規則不可以搶走學測試卷的體例。兩套要能共存。"""
    cases = [
        ("一、單選題（占 30 分）", B.SECTION_HEADER),
        ("說明：第 1 題至第 6 題，每題有 5 個選項，各題答對者，得 5 分。", B.SECTION_NOTE),
        ("第 13 題至第 15 題為題組", B.GROUP_LEAD),
        ("12. 下列敘述何者正確？", B.QUESTION_NO),
        ("（a）試求該函數的極值。", B.STEM),
    ]
    for text, want in cases:
        assert _classify(text, None) is want, f"{text!r} → {_classify(text, None)}"


def test_math_fragments_are_not_question_numbers():
    """
    數學講義裡到處都是以數字開頭的算式片段。題號規則若不要求
    分隔標點，一份 29 頁的講義會抽出 419 個假題號，而真正的
    題目只有 39 個。
    """
    for text in ["2 ，如圖（一）", "1 ＝－4", "4－6 ＝k－6", "－3 ＝1", "2－1 ＝－5"]:
        assert _classify(text, None) is not B.QUESTION_NO, text


# ── 標頭拆分 ─────────────────────────────────────────────────────


def test_trailing_header_is_split_out():
    """
    「範例 1」是一個色塊標籤，排版時與同一行的其他東西被 PDF
    併成一個文字區塊。不拆開的話它不會被認成標頭，整份講義的
    題目邊界會全部錯開一格。
    """
    out = split_embedded_headers([blk("斜　率★ 搭配課本例題 1範例1")])
    assert [b["text"] for b in out] == ["斜　率★ 搭配課本例題 1", "範例1"]


def test_crossreference_is_not_a_header():
    """「★ 搭配課本習題 2」指的是課本裡的第 2 題，不是本頁的習題。"""
    for text in ["★ 搭配課本習題 2", "◎ 搭配課本 P.160～P.163", "參見習題 5"]:
        out = split_embedded_headers([blk(text)])
        assert len(out) == 1, f"{text!r} 不該被拆開"


# ── 教用版的答案墨色 ─────────────────────────────────────────────


def test_answer_ink_detected_only_with_confirmation():
    """
    要有彩度、要佔一定比例、而且「解」「答」開頭的區塊要確實是
    這個顏色。少了最後一項，一份用藍色標題的學生版會被誤判成教用版。
    """
    teacher = [
        [
            blk("設 A（6﹐6）、B（4﹐7）三點共線，則 k＝", ink="231F20"),
            blk("解 ∵A、B、C 三點共線　∴mAB＝mAC", ink=INK),
            blk("答：(B)", ink=INK),
            blk("⇒ 7－6 ＝ k－6 ⇒ k＝9，故所求為 9", ink=INK),
        ]
    ]
    assert detect_answer_ink(teacher) == INK

    # 藍色標題的學生版：顏色佔比夠，但沒有「解」「答」印成藍色
    student = [
        [
            blk("直線的斜率", ink="0070C0"),
            blk("直線方程式及其圖形", ink="0070C0"),
            blk("設 A（6﹐6）、B（4﹐7）三點共線，則 k＝", ink="231F20"),
        ]
    ]
    assert detect_answer_ink(student) is None

    # 灰階不算
    gray = [[blk("解 略", ink="808080"), blk("答：略", ink="808080")]]
    assert detect_answer_ink(gray) is None


def test_strip_answer_ink_splits_mixed_blocks():
    """
    「答：」是白字色塊、答案本身是答案墨色。整塊丟掉會連答案
    一起丟，整塊留著會把版面裝飾當成答案。
    """
    b = blk("答：(B)", runs=[["FFFFFF", "答："], [INK, "(B)"]])
    student, answers = strip_answer_ink(b, INK)
    assert student == "答："
    assert answers == ["(B)"]

    # 單色的整塊歸給一邊
    assert strip_answer_ink(blk("解 ∵三點共線", ink=INK), INK) == ("", ["解 ∵三點共線"])
    assert strip_answer_ink(blk("設 A、B、C 三點共線"), INK) == ("設 A、B、C 三點共線", [])


# ── 教用版的填空答案 ─────────────────────────────────────────────


def test_inline_answers_from_teacher_edition():
    assert extract_inline_answers("則 m1＝　1　，m2＝　－4　，m3＝　0　。") == ["1", "－4", "0"]


def test_student_edition_produces_no_fake_answers():
    """
    學生版的空格之間是真的空白。抽出假答案比抽不到答案糟得多——
    假答案會被當成標準答案入庫，然後拿去改學生的考卷。
    """
    assert extract_inline_answers("則 m1＝　　，m2＝　　。") == []
    assert extract_inline_answers("沒有任何空格的句子") == []


# ── 頁首頁尾 ─────────────────────────────────────────────────────


def test_running_heads_detected_by_repetition():
    """
    用重複偵測而不是正則：出版社的頁首寫法各不相同，但「同樣的
    文字出現在多數頁面的同一個位置」這個特徵是共通的。
    """
    pages = []
    for i in range(10):
        pages.append(
            [
                blk(f"{160 + i}　互動式教學講義‧數學（1）", y0=0.02),
                blk(f"這是第 {i} 頁的正文，內容每頁都不一樣。", y0=0.4),
            ]
        )
    heads = detect_running_heads(pages)
    assert _running_key("162　互動式教學講義‧數學（1）") in heads
    assert _running_key("這是第 3 頁的正文，內容每頁都不一樣。") not in heads


def test_short_documents_skip_running_head_detection():
    """三頁的文件談不上「重複」，硬判會誤傷真正的內容。"""
    pages = [[blk("同一句話", y0=0.02)] for _ in range(3)]
    assert detect_running_heads(pages) == set()


# ── 切題 ─────────────────────────────────────────────────────────


def _worksheet_page():
    """一段翰林講義的實際形狀：標頭在標題那一行的尾巴、答案是另一個顏色。"""
    return [
        blk("162　互動式教學講義‧數學（1）", y0=0.02),
        blk("三點共線（斜率相等）★ 搭配課本習題 2範例3", y0=0.10),
        blk("設 A（6﹐6）、B（4﹐7）、C（2﹐k）三點共線，則 k＝　9　。", y0=0.16),
        blk("解", y0=0.22, ink=INK),
        blk("∵A、B、C 三點共線　∴mAB＝mAC", y0=0.26, ink=INK),
        blk("答：9", y0=0.32, ink=INK),
        blk("類題", y0=0.44, x0=0.05, x1=0.12),
        blk("設 P（1﹐2）、Q（3﹐k）、R（5﹐8）三點共線，則 k＝", y0=0.42),
        blk("解 由斜率相等得 k＝5", y0=0.50, ink=INK),
    ]


def test_split_by_exercise():
    page = _worksheet_page()
    result = segment_native(1, page, answer_ink=INK, running_heads=detect_running_heads([page] * 5))
    units = split_by_exercise(result.blocks)

    assert [u.label for u in units] == ["範例3", "類題"], [u.label for u in units]

    first = units[0]
    assert "三點共線" in first.stem_text()
    assert first.answer == "9"
    assert "mAB＝mAC" in first.explanation_text()
    # 詳解不可以混進題幹——兩者的著作權地位不同（文件 16 §3）
    assert "mAB＝mAC" not in first.stem_text()


def test_stem_pulled_back_from_previous_explanation():
    """
    「類題」標籤對齊的是題幹的第二行，所以第一行在閱讀順序上
    排在標籤前面，會掉進上一題的詳解裡。教用版的詳解一律是
    答案墨色，所以詳解區段裡的黑字一定是下一題的題幹。
    """
    page = _worksheet_page()
    result = segment_native(1, page, answer_ink=INK)
    units = split_by_exercise(result.blocks)
    second = units[1]
    assert "P（1﹐2）" in second.stem_text(), f"題幹被吃掉了：{second.stem_text()!r}"


def test_genre_detection():
    page = _worksheet_page()
    blocks = segment_native(1, page, answer_ink=INK).blocks
    assert detect_genre(blocks) == "worksheet"

    exam = [
        blk("第壹部分、選擇題（占 30 分）", y0=0.05),
        blk("一、單選題（占 30 分）", y0=0.10),
        blk("說明：第 1 題至第 6 題，每題有 5 個選項，各題答對者，得 5 分。", y0=0.14),
        blk("1. 下列敘述何者正確？", y0=0.22),
    ]
    assert detect_genre(segment_native(1, exam).blocks) == "exam"


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
