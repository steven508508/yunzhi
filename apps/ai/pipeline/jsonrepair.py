"""
模型輸出的 JSON 修復。

這個系統的題目大量含 LaTeX，而 LaTeX 與 JSON 對反斜線的用法是directly
衝突的：`\\frac`、`\\div`、`\\vec` 在 JSON 字串裡全都是跳脫序列的開頭。
模型即使被要求輸出 JSON，也經常照著原稿把 LaTeX 原樣寫進字串，於是：

  · `\\d`、`\\v`、`\\s` …  不是合法的 JSON 跳脫 → **解析直接失敗**
    （實地錯誤：`Invalid \\escape: line 19 column 32`）
  · `\\f`、`\\b`          **是**合法的 JSON 跳脫（換頁、退格）
    → 解析得過，但 `\\frac{1}{2}` 會變成「換頁字元 ＋ rac{1}{2}」。
    這一種更糟：它安靜地毀掉數學式，而且要到學生看到題目才會發現。

所以修復分兩種，都只在**字串內部**動手，不碰結構：

  一、非法跳脫 → 補成字面反斜線。這是純粹的修復，不會改變語意。
  二、`\\f` / `\\b` 後面接英文字母 → 判定為 LaTeX，補成字面反斜線。
      題幹裡不會有換頁或退格字元，但 `\\frac`、`\\beta`、`\\binom`
      到處都是。

`\\n`、`\\r`、`\\t`、`\\"`、`\\\\`、`\\/`、`\\uXXXX` 一律不動——那些
在模型輸出裡有正當用途（換行、引號），而對應的 LaTeX 命令
（`\\nu`、`\\tau`…）遠比換行罕見，改了風險更大。
"""

from __future__ import annotations

import json
import re
from typing import Any

__all__ = ["repair_json_escapes", "loads_tolerant"]

#: JSON 規格允許的跳脫字元
_VALID_ESCAPES = set('"\\/bfnrtu')

#: 會被誤判成跳脫、但後面接字母時幾乎必然是 LaTeX 命令的
_LATEX_LOOKALIKE = set("fb")


def repair_json_escapes(text: str) -> str:
    """
    把字串內部不該被當成跳脫的反斜線補成字面反斜線。

    以狀態機逐字掃描，因為只有在字串內部才需要處理——結構部分的
    反斜線本來就不合法，那種輸出救不回來也不該救。
    """
    out: list[str] = []
    in_string = False
    i = 0
    n = len(text)

    while i < n:
        ch = text[i]

        if not in_string:
            out.append(ch)
            if ch == '"':
                in_string = True
            i += 1
            continue

        if ch == '"':
            out.append(ch)
            in_string = False
            i += 1
            continue

        if ch != "\\":
            out.append(ch)
            i += 1
            continue

        # 到這裡：字串內部的反斜線
        nxt = text[i + 1] if i + 1 < n else ""

        if nxt not in _VALID_ESCAPES:
            # 非法跳脫：`\d`、`\v`、`\s`… 解析會失敗
            out.append("\\\\")
            i += 1
            continue

        if nxt == "u":
            # \uXXXX 只有四位十六進位才算數，否則同樣是壞的跳脫
            if re.match(r"[0-9a-fA-F]{4}", text[i + 2 : i + 6] or ""):
                out.append(text[i : i + 6])
                i += 6
            else:
                out.append("\\\\")
                i += 1
            continue

        if nxt in _LATEX_LOOKALIKE and re.match(r"[a-zA-Z]", text[i + 2 : i + 3] or ""):
            # `\frac`、`\beta`：合法跳脫但語意必然是 LaTeX
            out.append("\\\\")
            i += 1
            continue

        out.append(text[i : i + 2])
        i += 2

    return "".join(out)


def loads_tolerant(text: str) -> Any:
    """
    一律先修復再解析。

    **不能寫成「先試原樣、失敗才修復」**——那樣的話 `\\frac` 這一類
    「解析得過但語意是錯的」永遠繞過修復：`json.loads` 會愉快地把它
    變成換頁字元加 `rac`，然後那個壞掉的數學式一路寫進題庫。
    真正會爆的 `\\d` 反而是好事，至少它吵。

    修復對合法的 JSON 是恆等的（見 test_jsonrepair.py 的跳脫保留測試），
    所以無條件套用不會有代價。
    """
    repaired = repair_json_escapes(text)
    try:
        return json.loads(repaired)
    except json.JSONDecodeError:
        # 修復救不回來時用原文再解析一次，讓拋出的錯誤指向模型的真實輸出，
        # 而不是我們改過的版本——否則除錯時看到的行號對不上。
        return json.loads(text)
