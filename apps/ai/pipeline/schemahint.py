"""
把 Pydantic 模型壓成給模型看的精簡 schema。

提示詞原本只說「輸出符合 PageReading schema 的 JSON」，**卻沒有附上
那份 schema**。模型於是照字面猜欄位名與允許值，實地收到的是
`subject: '數學'`、`language: 'zh-TW'`、`question_no` 寫成 `number`、
`content` 寫成 `stem`。那不是模型不聽話，是它沒有東西可以聽。

為什麼不直接塞 `model_json_schema()`：PageReading 展開後是好幾萬字元
的 JSON Schema，裡面大半是 `$defs`、`anyOf`、`title` 這類對模型沒有
幫助的結構噪音。每一頁都送一份等於為了省重試而付更多錢。

這裡輸出的是**只有模型會用到的三件事**：欄位名、必填與否、列舉的
允許值。實測 PageReading 壓到約 2 千字元，而一次驗證失敗的重試要
重送整張頁面影像——那比這份提示貴得多。
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

__all__ = ["compact_schema"]

#: 對模型沒有幫助的鍵，一律略過
_NOISE = {"title", "description", "default", "examples", "$schema"}


def _type_of(node: dict[str, Any], defs: dict[str, Any]) -> str:
    """把一個 schema 節點壓成一行型別描述。"""
    if "$ref" in node:
        return node["$ref"].rsplit("/", 1)[-1]

    if "enum" in node:
        return "|".join(str(v) for v in node["enum"])

    if "const" in node:
        return str(node["const"])

    # Optional[X] 會展開成 anyOf[X, null]
    if "anyOf" in node:
        parts = [
            _type_of(x, defs) for x in node["anyOf"] if x.get("type") != "null"
        ]
        nullable = any(x.get("type") == "null" for x in node["anyOf"])
        inner = "|".join(dict.fromkeys(parts)) or "any"
        return f"{inner}?" if nullable else inner

    t = node.get("type")
    if t == "array":
        return f"[{_type_of(node.get('items') or {}, defs)}]"
    if t == "object":
        return "object"
    return t or "any"


def _render(name: str, schema: dict[str, Any], defs: dict[str, Any]) -> str:
    props = schema.get("properties") or {}
    if not props:
        return ""
    required = set(schema.get("required") or [])
    lines = [f"{name}:"]
    for field, node in props.items():
        mark = "*" if field in required else " "
        lines.append(f"  {mark}{field}: {_type_of(node, defs)}")
    return "\n".join(lines)


@lru_cache(maxsize=64)
def compact_schema(model_cls: type) -> str:
    """
    產生精簡 schema。**同一個類別只算一次**——它是靜態的，而這段字串
    會附在每一頁的提示詞後面。

    輸出形狀：

        PageReading:
          *questions: [Question]
           language: zh-Hant|en|mixed|unknown
        Question:
          *question_no: string
          *content: string

    `*` 是必填。列舉直接列出允許值，那正是 `'數學'` 與 `'zh-TW'`
    這類錯誤的來源。
    """
    root = model_cls.model_json_schema()
    defs = root.get("$defs") or {}

    blocks = [_render(model_cls.__name__, root, defs)]
    for dname, dschema in defs.items():
        if "enum" in dschema:
            blocks.append(f"{dname}: {'|'.join(str(v) for v in dschema['enum'])}")
        else:
            blocks.append(_render(dname, dschema, defs))

    return "\n".join(b for b in blocks if b)
