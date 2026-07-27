"""
物件儲存的存取（MinIO，S3 相容）。

為什麼 AI 服務要直接接物件儲存，而不是讓 Node 端把檔案內容
用 HTTP 傳過來：

  一份 200 頁的題本，原稿約 80 MB，正規化後的頁面影像約 300 MB。
  若走 HTTP 傳遞，同一份資料要在兩個行程之間搬兩次（進去一次、
  出來一次），而中間還得 base64 編碼（再膨脹 33%）。在一台
  自架的機器上，這是把記憶體與時間花在搬運而不是計算。

  改成兩邊都認 storage key，HTTP 上只走 JSON——請求裡是
  「處理這個 key」，回應裡是「產出在這些 key」。

用 boto3 而非 minio 套件：boto3 同時支援 MinIO 與 AWS S3，
日後若有補習班想把儲存放到 S3（授權自建的情境）不必改程式。
"""

from __future__ import annotations

import logging
import os
import threading
from functools import lru_cache
from typing import Any

log = logging.getLogger("yunzhi.ai.storage")

_lock = threading.Lock()
_client: Any = None


class StorageError(RuntimeError):
    pass


@lru_cache(maxsize=1)
def bucket() -> str:
    b = os.getenv("S3_BUCKET")
    if not b:
        raise StorageError("未設定 S3_BUCKET。AI 服務需要讀寫物件儲存才能處理題本。")
    return b


def client() -> Any:
    """
    延後建立。匯入時就建會讓「只想跑 /healthz」的情境也需要
    完整的 S3 設定，而部署時的第一次啟動往往還沒設好。
    """
    global _client
    if _client is not None:
        return _client

    with _lock:
        if _client is not None:
            return _client

        try:
            import boto3
            from botocore.config import Config
        except ImportError as e:  # pragma: no cover
            raise StorageError(
                "缺少 boto3。請確認映像是以 requirements.txt 建置的。"
            ) from e

        endpoint = os.getenv("S3_ENDPOINT")
        if not endpoint:
            raise StorageError("未設定 S3_ENDPOINT。")

        _client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=os.getenv("S3_ACCESS_KEY"),
            aws_secret_access_key=os.getenv("S3_SECRET_KEY"),
            region_name=os.getenv("S3_REGION", "us-east-1"),
            config=Config(
                # MinIO 用路徑式定址（bucket 在路徑而非子網域）
                s3={"addressing_style": "path"},
                # 重試交給呼叫端的佇列管。boto3 自己重試會讓
                # 「這個階段花了多久」變得無法解釋。
                retries={"max_attempts": 2, "mode": "standard"},
                connect_timeout=15,
                read_timeout=300,
            ),
        )
        return _client


def get_bytes(key: str) -> bytes:
    try:
        r = client().get_object(Bucket=bucket(), Key=key)
        return r["Body"].read()
    except Exception as e:
        raise StorageError(f"讀取 {key} 失敗：{e}") from e


def put_bytes(key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
    try:
        client().put_object(Bucket=bucket(), Key=key, Body=data, ContentType=content_type)
        return key
    except Exception as e:
        raise StorageError(f"寫入 {key} 失敗：{e}") from e


def healthy() -> tuple[bool, str | None]:
    """給 /readyz 用。只檢查 bucket 可達，不做寫入測試。"""
    try:
        client().head_bucket(Bucket=bucket())
        return True, None
    except Exception as e:
        return False, str(e)
