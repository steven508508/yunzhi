"""
整頁閱讀：把辨識與抽取交給模型。

原本的流程是「規則切分版面 → 模型結構化內容」，規則那一段在原生
PDF 上是零成本的。問題不在準確率，在**維護的形狀**：每加一種體例
就要打一批新規則，而新規則會打壞舊的。實例是加英文的作答括號
支援之後，`(A) 4.5 公尺` 被判成題號並憑空生出標準答案。

改成整頁交給模型讀。規則路徑保留下來當**交叉驗證**——兩邊不一致
的題目自動標成存疑，讓校對者優先看那幾題。

這一支測的是：影像準備、跨頁去重、schema 的守門、以及交叉驗證
真的抓得到不一致。**模型本身的辨識品質測不到**（開發環境沒有
API 金鑰），那要等接上真的模型。
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("AI_PROVIDER", "mock")
os.environ.setdefault("S3_BUCKET", "test")
os.environ.setdefault("S3_ENDPOINT", "http://localhost:9000")

import cv2  # noqa: E402
import numpy as np  # noqa: E402

from pipeline import reading  # noqa: E402
from pipeline.canonical import (  # noqa: E402
    Answer,
    AnswerSource,
    Confidence,
    Option,
    PageReading,
    Placement,
    Question,
    QuestionKind,
)
from pipeline.schemas import BBox, BlockType, LayoutBlock  # noqa: E402

SAMPLES = sorted(Path("/home/claude/samples").glob("*.pdf"))


def png(width=2575, height=3615) -> bytes:
    img = np.full((height, width, 3), 250, np.uint8)
    for i in range(30):
        y = 200 + i * 100
        cv2.rectangle(img, (200, y), (width - 250, y + 40), (30, 30, 30), -1)
    ok, buf = cv2.imencode(".png", img)
    assert ok
    return buf.tobytes()


def q(no, content, options=(), keys=(), page=1, **kw):
    return Question(
        id=f"q{no}",
        number=str(no),
        kind=QuestionKind.SINGLE_CHOICE if options else QuestionKind.SHORT_ANSWER,
        stem=content,
        options=[
            Option(order=i + 1, label=f"({i + 1})", content=o)
            for i, o in enumerate(options)
        ],
        answer=(
            Answer(source=AnswerSource.PRINTED, keys=list(keys))
            if keys else Answer()
        ),
        placement=Placement(
            page=page,
            bbox=BBox(page=page, x0=0.08, y0=0.1, x1=0.92, y1=0.2),
            **kw,
        ),
        confidence=Confidence(score=0.9),
    )


def rule_block(text, kind=BlockType.QUESTION_NO, page=1, answers=()):
    return LayoutBlock(
        type=kind,
        bbox=BBox(page=page, x0=0.08, y0=0.1, x1=0.9, y1=0.14),
        text=text,
        answers=list(answers),
    )


# ─────────────────────────────────────────────────────────────────
# 影像準備
# ─────────────────────────────────────────────────────────────────


def test_page_is_downscaled_before_being_sent():
    """
    300 dpi 的 A4 頁面約 12,400 個影像 token，而上游協定本來就會把
    超過 1568 px 的影像縮下來——送原圖只是把錢丟掉。實測縮到長邊
    1568 之後約 2,300 token，五倍價差，而印刷字在這個尺寸下仍然
    清楚（連上下標與分數線都看得見）。
    """
    src = png()
    out = reading.prepare_image(src)
    before = cv2.imdecode(np.frombuffer(src, np.uint8), cv2.IMREAD_COLOR)
    after = cv2.imdecode(np.frombuffer(out, np.uint8), cv2.IMREAD_COLOR)

    assert max(after.shape[:2]) <= reading._LONG_EDGE
    # **驗像素數而不是位元組數。** 上游是按像素計費的；位元組只影響
    # 傳輸時間，而且對一張大片留白的合成頁面來說 PNG 反而比 JPEG 小，
    # 拿位元組當判準會得到一個看起來失敗、實際上省了五倍錢的結果。
    ratio = (after.shape[0] * after.shape[1]) / (before.shape[0] * before.shape[1])
    assert ratio < 0.25, f"像素只降到 {ratio:.0%}，省不了多少 token"


def test_small_pages_are_left_alone():
    """已經夠小的影像不要再壓一次——每壓一次都掉一點畫質。"""
    small = png(width=800, height=1100)
    assert reading.prepare_image(small) == small


def test_aspect_ratio_is_preserved():
    """比例變形會讓模型回報的 bbox 對不回原頁，左右連動就歪了。"""
    src = png(width=2000, height=3000)
    img = cv2.imdecode(np.frombuffer(reading.prepare_image(src), np.uint8), cv2.IMREAD_COLOR)
    assert abs(img.shape[1] / img.shape[0] - 2000 / 3000) < 0.01


def test_real_pdf_page_stays_readable():
    if not SAMPLES:
        print("  · 跳過：samples/ 裡沒有 PDF")
        return
    import fitz

    doc = fitz.open(stream=SAMPLES[0].read_bytes(), filetype="pdf")
    pix = doc[4].get_pixmap(matrix=fitz.Matrix(300 / 72, 300 / 72), alpha=False)
    out = reading.prepare_image(pix.tobytes("png"))
    img = cv2.imdecode(np.frombuffer(out, np.uint8), cv2.IMREAD_COLOR)
    assert max(img.shape[:2]) == reading._LONG_EDGE
    # 縮完之後仍要有足夠的邊緣資訊，全糊掉的話模型也讀不出來
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    assert cv2.Laplacian(gray, cv2.CV_64F).var() > 100, "縮太多，字糊了"


# ─────────────────────────────────────────────────────────────────
# 文字層提示
# ─────────────────────────────────────────────────────────────────


def test_text_hint_is_optional():
    assert reading.text_hint(None) == ""
    assert reading.text_hint([]) == ""


def test_text_hint_is_capped():
    """
    整頁抄進去通常一兩千字。超過上限多半是抓到整份文件而不是單頁，
    那時候寧可截斷——把一份 200 頁的文字塞進每一次呼叫，成本會
    翻好幾倍而且沒有幫助。
    """
    blocks = [{"text": "字" * 500} for _ in range(50)]
    hint = reading.text_hint(blocks)
    assert len(hint) <= reading._TEXT_HINT_MAX + 20
    assert "已截斷" in hint


# ─────────────────────────────────────────────────────────────────
# 跨頁：只留本頁
# ─────────────────────────────────────────────────────────────────


def stub_reader(result: PageReading):
    """把 _structured 換成固定回覆，測跨頁與正規化的邏輯。"""
    from pipeline import stages

    async def _fake(provider, **kw):
        return result.model_copy(deep=True), {"input_tokens": 100, "output_tokens": 200}

    original = stages._structured
    stages._structured = _fake
    return original


def test_next_page_blocks_are_dropped():
    """
    一次送兩頁讓模型看得到接續，但**下一頁自己也會被讀一次**。
    兩邊都留的話，第 2 頁起每一頁的內容都會進題庫兩次。
    """
    from pipeline import stages

    result = PageReading(
        questions=[q(1, "本頁的題目", page=1), q(2, "下一頁的題目", page=2)],
    )
    original = stub_reader(result)
    try:
        out, _ = asyncio.run(
            reading.read_page(None, page_index=7, image=png(), next_image=png())
        )
    finally:
        stages._structured = original

    assert [x.stem for x in out.questions] == ["本頁的題目"]
    assert out.questions[0].placement.page == 7, "頁碼沒有換算回真實頁碼"


def test_question_bbox_pages_are_remapped():
    from pipeline import stages

    result = PageReading(questions=[q(3, "求 x 的值", page=1)])
    original = stub_reader(result)
    try:
        out, _ = asyncio.run(reading.read_page(None, page_index=12, image=png()))
    finally:
        stages._structured = original
    assert out.questions[0].placement.page == 12
    assert out.questions[0].placement.bbox.page == 12


# ─────────────────────────────────────────────────────────────────
# schema 的守門
# ─────────────────────────────────────────────────────────────────


def test_printed_answer_outside_the_options_is_rejected():
    """
    **答案指向不存在的選項是最危險的一種錯**：題目看起來完全正常，
    只是每個答對的學生都會被判錯。schema 就擋掉，不要讓它進到
    候選題——`_structured` 會把驗證錯誤回饋給模型再試一次。
    """
    import pydantic

    try:
        q(7, "下列何者正確？", options=("甲", "乙"), keys=(4,))
        raise AssertionError("超出範圍的答案沒有被擋下來")
    except pydantic.ValidationError as e:
        assert "超出選項範圍" in str(e)


def test_printed_answer_within_range_is_fine():
    got = q(7, "下列何者正確？", options=("甲", "乙", "丙"), keys=(3,))
    assert got.answer.keys == [3]
    assert got.answer.source is AnswerSource.PRINTED


def test_no_printed_answer_is_the_normal_case():
    """學生版沒有印答案。空的就是空的——推導答案是另一個階段的事，
    那條路有多次投票與一致率把關，這裡沒有。"""
    got = q(7, "下列何者正確？", options=("甲", "乙"))
    assert got.answer.keys == []
    assert got.answer.source is AnswerSource.NONE


# ─────────────────────────────────────────────────────────────────
# 交叉驗證
# ─────────────────────────────────────────────────────────────────


def test_agreement_produces_no_noise():
    """兩邊看到一樣的東西時不要出聲。假警報會讓人開始忽略警報。"""
    questions = [q(1, "設 A（6，6）、B（4，7）三點共線，則 k＝？"),
                 q(2, "求通過 P（1，2）且斜率為 3 的直線方程式")]
    rules = [rule_block("1. 設 A（6，6）、B（4，7）三點共線，則 k＝？"),
             rule_block("2. 求通過 P（1，2）且斜率為 3 的直線方程式")]
    assert reading.cross_check(questions, rules) == []


def test_missing_questions_are_flagged():
    """規則切出 8 題而模型只讀出 2 題——有東西被整段漏掉了。"""
    questions = [q(1, "第一題的內容在這裡，長度要夠才比得出來")]
    rules = [rule_block(f"{i}. 第 {i} 題的內容在這裡，長度要夠才比得出來")
             for i in range(1, 9)]
    issues = reading.cross_check(questions, rules)
    assert any(i["code"] == "count_mismatch" for i in issues), issues


def test_teacher_edition_answers_lost_by_the_model_is_an_error():
    """
    規則靠**顏色**抓答案（零推論），模型靠閱讀。規則抓到一堆而
    模型一個都沒讀到，多半是模型把教用版當成了學生版——那會讓
    整批題目沒有標準答案，而且看起來很正常。
    """
    questions = [q(1, "設 A（6，6）、B（4，7）、C（2，k）三點共線，則 k＝？")]
    rules = [rule_block("1. 設 A（6，6）、B（4，7）、C（2，k）三點共線，則 k＝？",
                        answers=["(B)", "8", "－13"])]
    issues = reading.cross_check(questions, rules)
    hit = [i for i in issues if i["code"] == "answers_missing"]
    assert hit and hit[0]["severity"] == "error", issues


def test_disagreeing_answers_are_an_error():
    questions = [q(1, "設 A、B、C 三點共線，則 k 的值為何？",
                   options=("甲", "乙", "丙"), keys=(1,))]
    rules = [rule_block("1. 設 A、B、C 三點共線，則 k 的值為何？", answers=["(3)"])]
    issues = reading.cross_check(questions, rules)
    assert any(i["code"] == "answers_disagree" for i in issues), issues


def test_matching_answers_are_not_flagged():
    questions = [q(1, "設 A、B、C 三點共線，則 k 的值為何？",
                   options=("甲", "乙", "丙"), keys=(3,))]
    rules = [rule_block("1. 設 A、B、C 三點共線，則 k 的值為何？", answers=["(3)"])]
    assert not [i for i in reading.cross_check(questions, rules)
                if i["code"].startswith("answers")]


def test_math_notation_differences_do_not_trigger_a_warning():
    """
    規則路徑重建出 `$\\frac{7-6}{4-6}$`，模型可能寫成
    `$\\dfrac{7-6}{4-6}$`。兩者是同一題，比對不該為此出聲——
    假警報比沒有警報更糟，它會讓人養成略過的習慣。
    """
    questions = [q(1, r"設 $m=\frac{7-6}{4-6}$，求 $m$ 的值並說明理由")]
    rules = [rule_block(r"1. 設 $m=\dfrac{7-6}{4-6}$，求 $m$ 的值並說明理由")]
    assert reading.cross_check(questions, rules) == []


def test_no_rule_blocks_means_no_comparison():
    """規則路徑沒跑（例如掃描件）時，不要憑空生出「不一致」。"""
    assert reading.cross_check([q(1, "隨便一題")], []) == []


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
