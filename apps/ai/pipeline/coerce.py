"""
模型輸出的寬容轉換。

**這一層存在的理由，是模型看不到 schema。** 提示詞說「輸出符合
PageReading schema 的 JSON」，卻沒有附上那份 schema——於是模型只能
照字面意思猜欄位名與允許值。實地跑一份數學講義收到的四類不合：

    subject   → '數學'      （schema 要 MATH_A／MATH_B 那組列舉）
    language  → 'zh-TW'     （schema 要 'zh-Hant'）
    placement → 整個沒給    （必填，但模型不知道要給）
    options   → {key,text}  （schema 要 order／label／content）

`providers.py` 送 `response_format` 之後這些會少很多，但**不會消失**：
自架閘道不一定支援、支援的也不保證嚴格模式，而每一次驗證失敗都是
一次真金白銀的重試。所以請求層盡力、這一層兜底。

轉換一律**只補不改**：模型給了值就尊重它，只有缺漏與已知的等價寫法
才動手。把 '數學' 猜成 MATH_A 這種事不做——寧可留 UNKNOWN 讓校對的人
決定，也不要安靜地把題目歸錯科。
"""

from __future__ import annotations

from typing import Any

__all__ = ["fill_placements", "normalize_language", "SUBJECT_ALIASES"]


#: 中文科目名 → SubjectCode。**刻意不含單獨的「數學」**：學測分數學 A
#: 與數學 B，猜錯的後果是整份講義進錯題庫，而化學老師組不出化學考卷
#: 那種錯誤要到用的時候才發現。留 UNKNOWN 讓校對的人選。
SUBJECT_ALIASES: dict[str, str] = {
    "國文": "CHINESE",
    "中文": "CHINESE",
    "英文": "ENGLISH",
    "英語": "ENGLISH",
    "數學A": "MATH_A",
    "數學甲": "MATH_A",
    "數A": "MATH_A",
    "數學B": "MATH_B",
    "數學乙": "MATH_B",
    "數B": "MATH_B",
    "社會": "SOCIAL",
    "自然": "SCIENCE",
    "歷史": "HISTORY",
    "地理": "GEOGRAPHY",
    "公民": "CIVICS",
    "公民與社會": "CIVICS",
    "物理": "PHYSICS",
    "化學": "CHEMISTRY",
    "生物": "BIOLOGY",
    "地科": "EARTH_SCIENCE",
    "地球科學": "EARTH_SCIENCE",
}

#: 語言標籤。模型很常回 BCP 47 的地區碼，而 schema 用的是文字系統碼。
_LANGUAGE_ALIASES: dict[str, str] = {
    "zh-tw": "zh-Hant",
    "zh-hant-tw": "zh-Hant",
    "zh-hk": "zh-Hant",
    "zh-hant": "zh-Hant",
    "zh": "zh-Hant",
    "zh-cn": "zh-Hant",  # 簡體來源仍以繁體處理，題庫是台灣的
    "zh-hans": "zh-Hant",
    "中文": "zh-Hant",
    "繁體中文": "zh-Hant",
    "en-us": "en",
    "en-gb": "en",
    "english": "en",
    "英文": "en",
    "混合": "mixed",
}

#: canonical.py 裡必填 placement 的類別，各自掛在 PageReading 的哪個欄位
_PLACEMENT_BEARING = ("assets", "sections", "groups", "questions", "materials")


def normalize_language(value: Any) -> Any:
    """把常見的語言標籤寫法收斂到 schema 的四個值。認不得就原樣放行。"""
    if not isinstance(value, str):
        return value
    return _LANGUAGE_ALIASES.get(value.strip().lower(), value)


def fill_placements(data: Any, page: int) -> Any:
    """
    補上模型漏掉的 `placement`。

    `placement.page` 是**呼叫端才知道的資訊**——模型讀的是一張影像，
    它不知道那是全份文件的第幾頁，所以漏掉這個欄位其實情有可原。
    這裡用讀取當下的頁碼補齊。

    只補整個缺漏的情況。模型給了 placement 但少了 bbox 是可以的，
    bbox 本來就選填。
    """
    if not isinstance(data, dict):
        return data
    for key in _PLACEMENT_BEARING:
        items = data.get(key)
        if not isinstance(items, list):
            continue
        for item in items:
            if isinstance(item, dict) and not item.get("placement"):
                item["placement"] = {"page": page}
    return data
