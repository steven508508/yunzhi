#!/usr/bin/env python3
"""
接上 AI 端點之後的第一件事：問四個問題，花不到一塊錢。

    python3 tools/ai-preflight.py

# 為什麼要有這一支

`tools/verify-ai.py` 會拿真實講義跑六到十二頁，那是要花錢也要花時間的。
在它之前先確認四件事，可以把「跑了十分鐘才發現模型看不懂圖」變成
「二十秒就知道」。

四個問題，依「錯了會不會讓整個設計失效」排序：

  一、**連得到嗎、認證過嗎。** 最基本，但第三方相容閘道最常在這裡
      卡住——網址少了 /v1、金鑰前後有空白、模型名稱閘道不認得。
  二、**看得懂圖嗎。** 這一項最重要。整條匯入管線是「模型讀整頁影像」
      設計的（文件 22）；模型若不吃 images，那個設計就不成立，
      要退回規則路徑重做。
  三、**吐得出合規的 JSON 嗎。** 管線全程要求結構化輸出並嚴格驗證。
      吐不出來的話會連續重試三次然後放棄，錢照花、結果是零。
  四、**回報 token 用量嗎。** 不少閘道省略 usage。省略了不會壞，
      但成本就只能用估的，而預算控制與成本外推都靠它。

# 設定

    export AI_PROVIDER=openai
    export AI_BASE_URL=https://你的端點/v1
    export AI_API_KEY=...
    export AI_MODEL_MID=你的模型名稱

金鑰請放在 chmod 600 的檔案或當次的環境變數裡。這支腳本從頭到尾
不會印出金鑰。
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "ai"))

OK = "\033[32m✓\033[0m"
NO = "\033[31m✗\033[0m"
WARN = "\033[33m!\033[0m"


def line(mark: str, name: str, detail: str = "") -> None:
    print(f"  {mark} {name}")
    if detail:
        print(f"      {detail}")


def probe_image() -> bytes:
    """
    造一張寫著已知內容的圖。

    刻意用「台灣題本會出現的東西」而不是「hello world」：五個半形括號
    選項、一個上標、一個中文題幹。模型讀得出英文字母卻讀不出中文，
    或讀得出文字卻認不得選項編號，都是這條管線會遇到的真實失敗，
    而一張只有 HELLO 的圖看不出來。
    """
    import fitz

    doc = fitz.open()
    page = doc.new_page(width=420, height=200)
    page.insert_text((30, 50), "3. 下列何者正確？", fontsize=16, fontname="china-t")
    page.insert_text((40, 85), "(1) 甲　(2) 乙　(3) 丙", fontsize=14, fontname="china-t")
    page.insert_text((40, 115), "(4) 丁　(5) 戊", fontsize=14, fontname="china-t")
    page.insert_text((30, 155), "PREFLIGHT-7Q4", fontsize=15, fontname="helv")
    png = page.get_pixmap(dpi=150).tobytes("png")
    doc.close()
    return png


async def main() -> int:
    provider_name = (os.getenv("AI_PROVIDER") or "").strip().lower()
    if provider_name in ("", "mock"):
        print(
            f"\n{NO} AI_PROVIDER 是 mock 或沒設。這支就是要打真的端點。\n\n"
            "    export AI_PROVIDER=openai\n"
            "    export AI_BASE_URL=https://你的端點/v1\n"
            "    export AI_API_KEY=...\n"
            "    export AI_MODEL_MID=你的模型名稱\n",
        )
        return 1

    from providers import ProviderError, build_provider

    base = os.getenv("AI_BASE_URL") or "(預設)"
    model = os.getenv("AI_MODEL_MID") or "(預設)"
    print(f"\n\033[1mAI 端點預檢\033[0m")
    print(f"  provider={provider_name}　base={base}　model={model}")
    print()

    provider = build_provider(os.environ)
    failures = 0
    warnings = 0

    # ── 一、連得到、認證過、模型認得 ────────────────────────────
    t0 = time.time()
    try:
        r = await provider.complete(
            tier="MID",
            system="你只回覆被要求的內容，不要多說。",
            user="請只回覆這四個字：連線正常",
            max_tokens=64,
            temperature=0.0,
        )
        dt = time.time() - t0
        got = (r.text or "").strip()
        line(OK, f"連得上而且模型回應了（{dt:.1f}s）", f"回覆：{got[:40]!r}")
    except ProviderError as e:
        line(NO, "連不上或被拒絕", str(e)[:400])
        print(
            "\n  常見原因，依機率排序：\n"
            "    · AI_BASE_URL 少了路徑前綴（OpenAI 協定通常要以 /v1 結尾）\n"
            "    · 模型名稱不是這個閘道認得的名稱\n"
            "    · 金鑰前後有多餘的空白或引號\n"
            "    · 這台機器連不出去（防火牆、代理）\n",
        )
        return 1
    except Exception as e:  # noqa: BLE001
        line(NO, "連不上", f"{type(e).__name__}: {e}")
        return 1

    # ── 二、看得懂圖嗎 ──────────────────────────────────────────
    #
    # **這一項是整條管線的前提。** 不是「有這個功能比較好」，是
    # 「沒有的話文件 22 的模型主導設計不成立」。
    try:
        img = probe_image()
        t0 = time.time()
        r = await provider.complete(
            tier="MID",
            system="你是題本判讀器。只輸出被要求的內容。",
            user=(
                "這張圖上有一行英數編號與一道中文題目。"
                "請只輸出一行 JSON："
                '{"code": "圖上的英數編號", "options": 選項的數量}'
            ),
            max_tokens=200,
            temperature=0.0,
            images=[img],
        )
        dt = time.time() - t0
        text = (r.text or "").strip()
        code_ok = "PREFLIGHT-7Q4" in text.upper().replace(" ", "")
        opts_ok = '"options": 5' in text.replace("  ", " ") or '"options":5' in text
        if code_ok and opts_ok:
            line(OK, f"看得懂圖，而且認得出中文題幹與選項數（{dt:.1f}s）")
        elif code_ok:
            warnings += 1
            line(
                WARN,
                f"讀得到圖上的英數，但選項數不對（{dt:.1f}s）",
                f"回覆：{text[:150]}　"
                "英數讀得到、中文版面認不得，是最麻煩的一種——"
                "它會抽出題目卻抽錯選項，而且看起來很正常。",
            )
        else:
            failures += 1
            line(
                NO,
                "看不懂圖",
                f"回覆：{text[:200]}\n      "
                "**整條匯入管線是「模型讀整頁影像」設計的。**\n      "
                "模型不吃 images 的話那個設計不成立，要改用規則路徑，\n      "
                "而規則路徑對掃描件與翻拍照片幾乎沒有用。",
            )
    except ProviderError as e:
        failures += 1
        line(NO, "送圖被拒絕", str(e)[:300])
    except Exception as e:  # noqa: BLE001
        failures += 1
        line(NO, "送圖出錯", f"{type(e).__name__}: {str(e)[:200]}")

    # ── 三、吐得出合規的 JSON 嗎 ────────────────────────────────
    try:
        from pipeline.stages import _structured
        from pydantic import BaseModel, Field

        class Probe(BaseModel):
            subject: str = Field(description="科目")
            count: int = Field(ge=1, le=10)
            options: list[str]

        t0 = time.time()
        got, _ = await _structured(
            provider,
            model_cls=Probe,
            system="你只輸出 JSON，不要有其他文字，不要用 markdown 圍欄。",
            user=(
                "輸出一個 JSON 物件，欄位：subject（字串，填「數學A」）、"
                "count（整數，填 3）、options（字串陣列，內容為 甲、乙、丙）。"
            ),
            tier="MID",
            max_tokens=500,
            attempts=2,
        )
        dt = time.time() - t0
        exact = got.subject == "數學A" and got.count == 3 and len(got.options) == 3
        line(
            OK if exact else WARN,
            f"吐得出通過驗證的結構化輸出（{dt:.1f}s）",
            "" if exact else f"內容與要求略有出入：{got.model_dump()}",
        )
        if not exact:
            warnings += 1
    except Exception as e:  # noqa: BLE001
        failures += 1
        line(
            NO,
            "拿不到合規的結構化輸出",
            f"{str(e)[:300]}\n      "
            "管線全程要求結構化輸出並嚴格驗證。拿不到的話會連續重試\n      "
            "三次然後放棄——錢照花，結果是零。",
        )

    # ── 四、回報 token 用量嗎 ───────────────────────────────────
    if r.usage.estimated:
        warnings += 1
        line(
            WARN,
            "上游沒有回報 token 用量，系統改用估算",
            "不會壞，但預算上限與成本外推都會是估的。"
            "AI_MONTHLY_TOKEN_BUDGET 的準確度受影響。",
        )
    else:
        line(OK, "有回報 token 用量", f"這一次：進 {r.usage.input_tokens}、出 {r.usage.output_tokens}")

    # ── 協商結果 ────────────────────────────────────────────────
    tp = getattr(provider, "_token_param", None)
    st = getattr(provider, "_send_temperature", None)
    if tp or st is False:
        line(
            OK,
            "參數協商完成",
            f"token 參數用 {tp or 'max_tokens'}"
            + ("；此模型不接受自訂 temperature，已停用" if st is False else ""),
        )

    print()
    if failures:
        print(f"\033[31m{failures} 項不通過\033[0m —— 先解決再跑 verify-ai.py，")
        print("否則那一支會花掉真的錢然後得到一份沒有意義的報告。\n")
        return 1
    if warnings:
        print(f"\033[33m可以往下，但有 {warnings} 項要留意（見上）。\033[0m\n")
    else:
        print("\033[32m四項全過。可以跑 tools/verify-ai.py 了。\033[0m\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
