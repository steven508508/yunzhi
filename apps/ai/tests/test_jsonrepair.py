r"""
JSON 修復。

實地案例：一份數學講義的匯入在第三次重試死於
`Invalid \escape: line 19 column 32 (char 554)`——模型把原稿的 LaTeX
原樣寫進 JSON 字串。
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pipeline.jsonrepair import loads_tolerant, repair_json_escapes  # noqa: E402


def test_正常的_json_原樣通過():
    src = '{"a": "b", "n": 1, "esc": "line\\nbreak"}'
    assert loads_tolerant(src) == json.loads(src)


def test_非法跳脫_不再解析失敗():
    # \d 不是合法的 JSON 跳脫，原本會 raise
    src = r'{"content": "求 \dfrac{1}{2} 的值"}'
    try:
        json.loads(src)
        raised = False
    except json.JSONDecodeError:
        raised = True
    assert raised, "前提錯了：這段本來就該解析失敗"

    assert loads_tolerant(src)["content"] == r"求 \dfrac{1}{2} 的值"


def test_frac_不會被吃成換頁字元():
    """`\\f` 是合法的 JSON 跳脫，所以這一段解析得過——但結果是錯的。"""
    src = r'{"content": "\frac{1}{2}"}'
    assert json.loads(src)["content"] == "\x0crac{1}{2}", "前提錯了"
    assert loads_tolerant(src)["content"] == r"\frac{1}{2}"


def test_beta_同理():
    src = r'{"content": "角 \beta 等於"}'
    assert loads_tolerant(src)["content"] == r"角 \beta 等於"


def test_真正的換行與引號不被動到():
    src = '{"a": "第一行\\n第二行", "b": "他說「\\"好\\"」", "c": "tab\\there"}'
    got = loads_tolerant(src)
    assert got["a"] == "第一行\n第二行"
    assert got["b"] == '他說「"好"」'
    assert got["c"] == "tab\there"


def test_unicode_跳脫保留():
    assert loads_tolerant(r'{"a": "\u4e2d\u6587"}')["a"] == "中文"


def test_壞掉的_unicode_跳脫當字面處理():
    assert loads_tolerant(r'{"a": "\uZZ 不是碼位"}')["a"] == r"\uZZ 不是碼位"


def test_結構不被動到():
    src = r'{"questions": [{"no": "1", "content": "\vec{F}"}], "n": 2}'
    got = loads_tolerant(src)
    assert got["n"] == 2
    assert got["questions"][0]["content"] == r"\vec{F}"


def test_反斜線本身仍然是跳脫():
    # `\\` 是字面反斜線，不該被再加一層
    assert loads_tolerant(r'{"a": "C:\\path"}')["a"] == "C:" + chr(92) + "path"


def test_修復是冪等的():
    src = r'{"a": "\dfrac{1}{2}"}'
    once = repair_json_escapes(src)
    assert repair_json_escapes(once) == once
