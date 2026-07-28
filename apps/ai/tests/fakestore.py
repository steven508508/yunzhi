"""
測試用的假物件儲存。**三支測試共用同一份。**

原本每一支各自宣告一個 `_FAKE` 並各自覆寫 `storage.get_bytes`。
模組層級的覆寫是「最後 import 的贏」：

    test_import_api.py     _FAKE_A ← storage.get_bytes 指向這裡
    test_real_worksheet.py _FAKE_B ← 然後改指向這裡
    test_scan_figures.py   _FAKE_C ← 最後指向這裡

於是前兩支寫進自己 dict 的檔案，路由拿不到。單獨跑每一支都綠，
一起跑就有七支紅，而錯誤訊息是 `KeyError: 'src/worksheet.pdf'`
——看起來像產品壞了，實際上是測試互相踩。

值得修，是因為**紅燈若會因為與程式無關的理由出現，人就會開始
忽略紅燈**。而這個專案的紅燈要擋的是「答錯的學生被判對」那一類
的東西。
"""

from __future__ import annotations

import storage

#: 全部測試共用的一份。key → bytes。
FAKE: dict[str, bytes] = {}


def install() -> dict[str, bytes]:
    """
    把 `storage` 換成記憶體版本，回傳共用的那份 dict。

    重複呼叫是安全的——每一支測試模組都會呼叫一次，而它們指向的
    是同一個 `FAKE`。
    """
    storage.get_bytes = lambda key: FAKE[key]  # type: ignore[assignment]
    storage.put_bytes = lambda key, data, content_type="": (  # type: ignore[assignment]
        FAKE.__setitem__(key, data),
        key,
    )[1]
    storage.healthy = lambda: (True, None)  # type: ignore[assignment]
    return FAKE
