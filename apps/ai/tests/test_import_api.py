"""
匯入管線 HTTP 介面的端到端測試。

用 mock provider 與記憶體內的假物件儲存跑完整條路徑：
  上傳的原稿 → 正規化 → 切分 → 結構化 → 自答 → 標註

這條測試存在的理由不是「覆蓋率」，而是**介面契約**。管線的各階段
是分開開發的，而它們之間傳遞的是 storage key 與 JSON 形狀；
任何一邊改了欄位名，這裡會立刻紅，而不是等到老師上傳題本才發現。
"""

from __future__ import annotations

import io
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("AI_PROVIDER", "mock")
os.environ.setdefault("S3_BUCKET", "test")
os.environ.setdefault("S3_ENDPOINT", "http://localhost:9000")

import storage  # noqa: E402

# ── 假的物件儲存 ─────────────────────────────────────────────────
# 真的接 MinIO 會讓這組測試需要一個跑著的服務，那會讓它從
# 「每次存檔都跑」降級成「偶爾才跑」。

_FAKE: dict[str, bytes] = {}

storage.get_bytes = lambda key: _FAKE[key]  # type: ignore[assignment]
storage.put_bytes = lambda key, data, content_type="": (  # type: ignore[assignment]
    _FAKE.__setitem__(key, data),
    key,
)[1]
storage.healthy = lambda: (True, None)  # type: ignore[assignment]

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402

# 用 context manager 進入，才會跑 lifespan（provider 在那裡建立）。
# 少了這一步，每個需要 AI 的端點都會回 503，而錯誤訊息會讓人
# 以為是設定問題。
client = TestClient(main.app)
client.__enter__()


def make_pdf() -> bytes:
    """
    造一份形狀像學測試卷的原生 PDF。

    體例照 115 學測：五個選項、(1)–(5) 而非 A–D、節標題含「（占 N 分）」、
    節說明含配分規則。這些細節決定了機械解析抓不抓得到東西。
    """
    import fitz

    doc = fitz.open()
    page = doc.new_page(width=595, height=842)

    # 必須指定中文字型。PyMuPDF 預設的 Helvetica 編不了中文，
    # 而且**不會報錯**——它會把每個中文字寫成一個點，於是整份
    # 測試題本變成「··········」。這正是真實世界裡「轉出來的
    # PDF 全是方框」那一類問題的縮影，值得在測試裡踩一次。
    cjk = "china-t"  # PyMuPDF 內建的繁體中文字型

    def put(x, y, text, size=11):
        page.insert_text((x, y), text, fontsize=size, fontname=cjk)

    y = 60
    put(60, y, "第壹部分、選擇題（占 30 分）", 13)
    y += 26
    put(60, y, "一、單選題（占 30 分）", 12)
    y += 24
    put(60, y, "說明：第 1 題至第 6 題，每題有 5 個選項，各題答對者，得 5 分。", 10)
    y += 30
    for q in range(1, 4):
        put(60, y, f"{q}. 設 f(x) 為第 {q} 題所定義的函數，試問下列敘述何者正確？", 11)
        y += 20
        for o in range(1, 6):
            put(80, y, f"({o}) 這是第 {q} 題的第 {o} 個選項。", 10)
            y += 16
        y += 8
    put(240, 800, "第 1 頁，共 1 頁", 9)

    data = doc.tobytes()
    doc.close()
    return data


def test_full_pipeline():
    _FAKE.clear()
    _FAKE["src/paper.pdf"] = make_pdf()

    # ── 階段一：正規化 ──────────────────────────────────────────
    r = client.post(
        "/v1/import/normalize",
        json={
            "source_key": "src/paper.pdf",
            "file_name": "paper.pdf",
            "page_key_prefix": "job1/pages",
        },
    )
    assert r.status_code == 200, r.text
    norm = r.json()
    assert norm["kind"] == "native_pdf", norm["kind"]
    assert norm["has_text_layer"] is True
    assert norm["page_count"] == 1
    page = norm["pages"][0]
    assert page["index"] == 1, "頁碼對外一律 1 起算"
    assert page["storage_key"] in _FAKE, "頁面影像應已寫入物件儲存"
    assert len(page["text_blocks"]) > 5, "原生 PDF 應該抽得到文字區塊"

    # ── 階段二：切分 ────────────────────────────────────────────
    r = client.post(
        "/v1/import/segment",
        json={
            "pages": [
                {
                    "index": p["index"],
                    "storage_key": p["storage_key"],
                    "text_blocks": p["text_blocks"],
                }
                for p in norm["pages"]
            ]
        },
    )
    assert r.status_code == 200, r.text
    segd = r.json()
    assert segd["method"]["1"] == "native", "有文字層就不該花錢問視覺模型"
    assert segd["vision_pages"] == 0
    assert segd["usage"]["calls"] == 0, "純程式切分不應產生任何 AI 呼叫"
    assert segd["sections"], "應該切出至少一節"

    sec = segd["sections"][0]
    assert "單選題" in sec["title"]
    assert "得 5 分" in sec["note"] or "得5分" in sec["note"]
    assert "[OPTION]" in sec["text"], "送下游的文字要帶區塊類型標記"
    assert "第 1 頁，共 1 頁" not in sec["text"], "頁首頁尾不該送給下游"

    # ── 階段三：結構化 ──────────────────────────────────────────
    r = client.post(
        "/v1/import/structure",
        json={
            "sections": [
                {"title": s["title"], "note": s["note"], "text": s["text"]}
                for s in segd["sections"]
            ]
        },
    )
    assert r.status_code == 200, r.text
    struct = r.json()
    assert struct["questions"], "應該產生候選題"
    q = struct["questions"][0]
    assert q["type"] == "SINGLE_CHOICE"
    assert len(q["options"]) == 5, "學測選擇題是 5 個選項"
    # mock 的候選必須帶警告，否則假資料可能被當真入庫
    assert any(x["code"] == "mock_provider" for x in q["confidence_reasons"])

    # ── 階段四：自答 ────────────────────────────────────────────
    r = client.post(
        "/v1/import/solve",
        json={"items": [{"ref": "c1", "question": q, "provided_keys": []}]},
    )
    assert r.status_code == 200, r.text
    solved = r.json()["results"][0]
    assert solved["ref"] == "c1"
    assert solved["error"] is None, solved["error"]
    assert solved["patch"]["answerOrigin"] == "AI_SOLVED"
    assert solved["patch"]["selfConsistency"] == 1.0, "mock 每次都回同一個答案"

    # ── 階段六：標註 ────────────────────────────────────────────
    r = client.post(
        "/v1/import/annotate",
        json={
            "subject_name": "數學A",
            "items": [
                {
                    "ref": "c1",
                    "question": q,
                    "candidates": [{"id": "kp1", "name": "二次函數", "description": ""}],
                }
            ],
        },
    )
    assert r.status_code == 200, r.text
    ann = r.json()["results"][0]
    assert ann["ref"] == "c1"
    assert ann["result"]["no_suitable_candidate"] is True, "mock 不該假裝挑得出知識點"

    # ── 去重雜湊 ────────────────────────────────────────────────
    r = client.post(
        "/v1/import/content-hash",
        json={
            "items": [
                {"stem": "1. 設 f(x)＝x２，求極值", "options": ["（1）ａ", "（2）ｂ"]},
                {"stem": "設 f(x)=x2,求極值", "options": ["(1)a", "(2)b"]},
            ]
        },
    )
    assert r.status_code == 200, r.text
    h = r.json()["hashes"]
    assert h[0] == h[1], "全形半形與題號差異不該產生不同的雜湊，否則去重會靜默失效"


def test_annotate_without_candidates_is_an_error_not_a_guess():
    """
    沒有候選知識點時，要明說錯在哪，而不是讓模型自由發揮。
    模型幻覺出來的知識點名稱會讓同一個概念有五種寫法，
    整個能力分析就廢了。
    """
    r = client.post(
        "/v1/import/annotate",
        json={
            "subject_name": "數學A",
            "items": [
                {
                    "ref": "x",
                    "question": {
                        "question_no": "1",
                        "type": "SHORT_ANSWER",
                        "content": "試證明之。",
                        "confidence": 0.5,
                    },
                    "candidates": [],
                }
            ],
        },
    )
    assert r.status_code == 200
    out = r.json()["results"][0]
    assert out["result"] is None
    assert "知識點" in out["error"]


def test_unsupported_format_says_what_to_do():
    _FAKE["src/junk.bin"] = b"\x00\x01\x02\x03not a document at all"
    r = client.post(
        "/v1/import/normalize",
        json={
            "source_key": "src/junk.bin",
            "file_name": "junk.bin",
            "page_key_prefix": "job2/pages",
        },
    )
    assert r.status_code == 415, r.text
    assert "支援" in r.json()["detail"]


def test_open_ended_question_is_not_solved():
    """
    非選題沒有標準答案，投票沒有意義。votes_needed 回 0，
    solve 應該回一個「沒做」而不是硬掰一個答案。
    """
    r = client.post(
        "/v1/import/solve",
        json={
            "items": [
                {
                    "ref": "essay",
                    "question": {
                        "question_no": "1",
                        "type": "ESSAY",
                        "content": "請以「機會」為題，寫一篇文章。",
                        "confidence": 0.9,
                    },
                }
            ]
        },
    )
    assert r.status_code == 200, r.text
    out = r.json()["results"][0]
    assert out["patch"] == {"answerOrigin": None}
    assert out["error"] is None


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
