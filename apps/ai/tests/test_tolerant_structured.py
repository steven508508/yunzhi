r"""
七種實地收到的不合。

2026-07-31 一份數學講義的匯入，三次重試全滅。錯誤裡有四類不同的
不合，加上第三次的 JSON 解析失敗，全部來自同一個原因：**提示詞說
「輸出符合 PageReading schema 的 JSON」，卻沒有附上那份 schema**。

每一則測試對應一條實際的錯誤訊息。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pipeline.canonical import PageReading, SubjectCode  # noqa: E402
from pipeline.coerce import fill_placements  # noqa: E402
from pipeline.jsonrepair import loads_tolerant  # noqa: E402
from pipeline.schemahint import compact_schema  # noqa: E402
from pipeline.schemas import ExtractResult, StructuredQuestion  # noqa: E402


# ── 一、subject 回中文 ────────────────────────────────────────────
# Input should be 'CHINESE', … [input_value='數學']
def test_中文科目名不再讓整頁失敗():
    assert PageReading(subject="化學").subject is SubjectCode.CHEMISTRY
    assert PageReading(subject="國文").subject is SubjectCode.CHINESE


def test_有歧義的數學留給人決定():
    """學測分數學 A 與 B。猜錯＝整份講義進錯題庫，而且很晚才會發現。"""
    assert PageReading(subject="數學").subject is SubjectCode.UNKNOWN
    assert PageReading(subject="數學A").subject is SubjectCode.MATH_A
    assert PageReading(subject="數學B").subject is SubjectCode.MATH_B


# ── 二、language 回 BCP 47 ────────────────────────────────────────
# Input should be 'zh-Hant', … [input_value='zh-TW']
def test_zh_TW_收斂成_zh_Hant():
    assert PageReading(language="zh-TW").language == "zh-Hant"
    assert PageReading(language="zh").language == "zh-Hant"
    assert PageReading(language="en-US").language == "en"


# ── 三、sections[].placement 沒給 ────────────────────────────────
# sections.0.placement Field required
def test_缺漏的_placement_用當下頁碼補上():
    data = {"sections": [{"id": "s1", "title": "一、單選題"}]}
    got = PageReading.model_validate(fill_placements(data, 8))
    assert got.sections[0].placement.page == 8


def test_模型有給_placement_就不覆蓋():
    data = {"sections": [{"id": "s1", "title": "甲", "placement": {"page": 3}}]}
    got = PageReading.model_validate(fill_placements(data, 8))
    assert got.sections[0].placement.page == 3, "不該蓋掉模型的判斷"


# ── 四、欄位名不同 ───────────────────────────────────────────────
# questions.0.question_no Field required / questions.0.content Field required
def test_number_與_stem_當作別名收下():
    q = StructuredQuestion.model_validate(
        {
            "number": "1",
            "type": "SINGLE_CHOICE",
            "stem": "下列何者為質數？",
            # 單選題至少要兩個選項，那條不變量是對的，別名不該繞過它
            "options": [{"key": "A", "text": "4"}, {"key": "B", "text": "7"}],
        }
    )
    assert q.question_no == "1"
    assert q.content == "下列何者為質數？"


def test_原生欄位名仍然可用():
    q = StructuredQuestion.model_validate(
        {"question_no": "2", "type": "ESSAY", "content": "申論題", "confidence": 0.8}
    )
    assert (q.question_no, q.content, q.confidence) == ("2", "申論題", 0.8)


# ── 五、options 缺 order，且用 key/text ──────────────────────────
# questions.0.options.0.order Field required [input_value={'key': '1', 'text': '4個'}]
def test_選項缺_order_依序補上():
    q = StructuredQuestion.model_validate(
        {
            "number": "1",
            "type": "SINGLE_CHOICE",
            "stem": "幾個？",
            "options": [{"key": "1", "text": "4個"}, {"key": "2", "text": "5個"}],
        }
    )
    assert [(o.order, o.label, o.content) for o in q.options] == [
        (1, "1", "4個"),
        (2, "2", "5個"),
    ]


# ── 六、confidence 沒給 ─────────────────────────────────────────
def test_缺漏的信心分數預設為最低():
    """預設高分等於安靜地把沒把握的題目送過校對。"""
    q = StructuredQuestion.model_validate(
        {"number": "1", "type": "ESSAY", "stem": "甲"}
    )
    assert q.confidence == 0.0


# ── 七、LaTeX 反斜線 ────────────────────────────────────────────
# Invalid \escape: line 19 column 32 (char 554)
def test_latex_反斜線不再讓整批失敗():
    raw = r'{"questions": [{"number": "1", "type": "FILL_TEXT", "stem": "求 \dfrac{1}{2}"}]}'
    got = ExtractResult.model_validate(loads_tolerant(raw))
    assert got.questions[0].content == r"求 \dfrac{1}{2}"


# ── schema 注入本身 ─────────────────────────────────────────────
def test_精簡_schema_列出列舉的允許值():
    """這正是 '數學' 與 'zh-TW' 兩種錯誤的來源：模型沒看過允許值。"""
    hint = compact_schema(PageReading)
    assert "MATH_A" in hint and "zh-Hant" in hint
    assert "*" in hint, "必填欄位要標出來"


def test_精簡_schema_比完整_schema_小很多():
    """每一頁都要送，大小直接是錢。"""
    compact = len(compact_schema(PageReading))
    full = len(str(PageReading.model_json_schema()))
    assert compact < full / 3, f"精簡 {compact} vs 完整 {full}"
