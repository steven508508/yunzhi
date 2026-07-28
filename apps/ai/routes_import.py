"""
匯入管線的 HTTP 介面。

設計上的一個關鍵取捨：**請求與回應只走 JSON，檔案內容走物件儲存**。

一份 200 頁的題本，原稿約 80 MB、正規化後的頁面影像約 300 MB。
若把這些塞進 HTTP body，同一份資料要在兩個行程之間搬兩次，
中間還要 base64（再膨脹三分之一）。改成兩邊都認 storage key 之後，
HTTP 上只剩下幾十 KB 的 JSON。

另一個取捨：**階段的邊界對齊 ImportStatus 的列舉值**。
每個端點對應恰好一個階段，做完就回，由 Node 端的 worker 負責
持久化與推進。這樣「第 7 階段失敗」時能真的只重跑第 7 階段——
若把好幾個階段合在一個端點裡，那個承諾就是假的。

每個回應都帶 `usage`，讓呼叫端能把成本記到 AiUsageLog。
不在這裡寫資料庫：AI 服務不該有資料庫連線，那是攻擊面也是耦合。
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import storage
from providers import BaseProvider, ContentRefused, FatalError, ProviderError, RetryableError
from pipeline import segment as seg
from pipeline import stages
from pipeline import figures as figmod
from pipeline import glyphmap
from pipeline.normalize import Prepared, normalize, prepare
from pipeline.prompts import PROMPT_VERSION
from pipeline.schemas import (
    AnnotateResult,
    BBox,
    BlockType,
    LayoutBlock,
    QuestionType,
    SegmentResult,
    StructuredQuestion,
)

log = logging.getLogger("yunzhi.ai.import")


# ─────────────────────────────────────────────────────────────────
# 共用
# ─────────────────────────────────────────────────────────────────


class Usage(BaseModel):
    """本次呼叫的用量。呼叫端據此寫 AiUsageLog 並累計工作成本。"""

    input_tokens: int = 0
    output_tokens: int = 0
    calls: int = 0
    estimated: bool = False
    model: str = ""
    provider: str = ""
    prompt_version: str = PROMPT_VERSION


class _Meter:
    """
    把一次階段裡的多次 AI 呼叫加總起來。

    不用全域計數器：這個服務是多工作者並行的，全域狀態會讓
    A 工作的成本記到 B 工作頭上。每次請求一個計量器。
    """

    def __init__(self) -> None:
        self.usage = Usage()

    def add(self, completion: Any) -> None:
        if completion is None:
            return
        u = getattr(completion, "usage", None)
        if u is None:
            return
        self.usage.input_tokens += u.input_tokens
        self.usage.output_tokens += u.output_tokens
        self.usage.calls += 1
        self.usage.estimated = self.usage.estimated or u.estimated
        self.usage.model = getattr(completion, "model", "") or self.usage.model
        self.usage.provider = getattr(completion, "provider", "") or self.usage.provider


def _provider_or_503(get_provider) -> BaseProvider:
    p = get_provider()
    if p is None:
        raise HTTPException(503, detail="AI provider 未就緒，請檢查設定後重啟服務")
    return p


def _to_http(e: Exception) -> HTTPException:
    """
    把管線錯誤翻譯成呼叫端能據以決策的狀態碼。

    這個對應關係是佇列重試策略的依據，所以要準：
      503 → 值得重試（限流、上游暫時故障）
      502 → 不要重試（設定錯、模型不存在）
      422 → 內容問題，重試也沒用，要轉人工
    """
    if isinstance(e, RetryableError):
        return HTTPException(503, detail=str(e))
    if isinstance(e, ContentRefused):
        return HTTPException(422, detail=f"上游拒絕處理此內容：{e}")
    if isinstance(e, FatalError):
        return HTTPException(502, detail=str(e))
    if isinstance(e, stages.StageError):
        return HTTPException(503 if e.retryable else 422, detail=str(e))
    if isinstance(e, storage.StorageError):
        return HTTPException(502, detail=str(e))
    return HTTPException(500, detail=f"{type(e).__name__}：{e}")


# ─────────────────────────────────────────────────────────────────
# 階段一：正規化
# ─────────────────────────────────────────────────────────────────


class NormalizeRequest(BaseModel):
    source_key: str = Field(min_length=1, description="原稿在物件儲存中的鍵")
    file_name: str = Field(default="", description="原始檔名，僅用於判定 DOCX/ODT")
    page_key_prefix: str = Field(min_length=1, description="頁面影像要寫到哪個前綴下")
    #: 頁數上限。避免誤傳一份 2000 頁的檔案把磁碟寫爆。
    max_pages: int = Field(default=600, ge=1, le=2000)


class PageOut(BaseModel):
    index: int
    width: int
    height: int
    storage_key: str
    text_layer: str | None = None
    text_blocks: list[dict] = Field(default_factory=list)
    quality: float = 1.0
    quality_notes: list[str] = Field(default_factory=list)
    #: 這一頁各區塊的主要墨色。教用版靠顏色分辨題目與詳解。
    ink: str | None = None
    #: 這一頁偵測到的圖。bbox 已正規化為頁面比例。
    figures: list[dict] = Field(default_factory=list)


class GlyphInfo(BaseModel):
    """符號字型的還原結果，寫進 stageDetail 讓校對者看得到。"""

    fonts: list[str] = Field(default_factory=list)
    resolved: int = 0
    unresolved: int = 0
    from_cache: int = 0
    samples: list[dict] = Field(default_factory=list)


class NormalizeResponse(BaseModel):
    kind: str
    quality: float
    quality_note: str
    has_text_layer: bool
    page_count: int
    truncated: bool = False
    pages: list[PageOut]
    glyphs: GlyphInfo = Field(default_factory=GlyphInfo)
    usage: Usage = Field(default_factory=Usage)
    elapsed_ms: int = 0


def _prepare_sync(req: NormalizeRequest) -> tuple[Prepared, bytes]:
    """轉檔與符號字型盤點。同步、不呼叫 AI。"""
    data = storage.get_bytes(req.source_key)
    return prepare(data, req.file_name), data


def _normalize_sync(req: NormalizeRequest, prep: Prepared, t0: float) -> NormalizeResponse:
    """
    同步的重活。在執行緒裡跑，見下方 endpoint 的說明。
    """
    result = normalize(prep)

    # 附圖從 PDF 的繪圖物件聚出來。
    #
    # 只在**頁數沒有變**的時候做：掃描頁的前處理會把一張翻拍攤開
    # 書本的影像切成兩頁，那時候輸出頁碼與 PDF 頁碼對不起來，
    # 照著 pno+1 掛圖會把圖掛到別頁去。掃描頁本來也沒有繪圖物件，
    # 圖改由視覺模型在切分階段回報（見 _crop_vision_figures）。
    figures_by_page: dict[int, list[dict]] = {}
    if prep.pdf and len(result.pages) == _pdf_page_count(prep.pdf):
        import fitz

        doc = fitz.open(stream=prep.pdf, filetype="pdf")
        try:
            for pno in range(min(len(doc), req.max_pages)):
                page = doc[pno]
                found = figmod.find_figures(page)
                if not found:
                    continue
                w, h = page.rect.width, page.rect.height
                items = []
                for idx, fig in enumerate(found):
                    key = (
                        f"{req.page_key_prefix.rstrip('/')}/"
                        f"fig/{pno + 1:04d}-{idx:02d}.png"
                    )
                    try:
                        storage.put_bytes(key, figmod.crop(page, fig), "image/png")
                    except Exception as e:  # noqa: BLE001
                        log.warning("第 %d 頁第 %d 張圖裁切失敗：%s", pno + 1, idx, e)
                        continue
                    items.append(
                        {
                            "key": key,
                            "bbox": fig.norm(w, h),
                            "labels": fig.labels[:12],
                            "strokes": fig.strokes,
                        }
                    )
                if items:
                    figures_by_page[pno + 1] = items
        finally:
            doc.close()

    pages = result.pages[: req.max_pages]
    truncated = len(result.pages) > len(pages)

    out: list[PageOut] = []
    for p in pages:
        # 頁碼從 1 起算。PageOut.index 是 0 起算的內部索引，
        # 對外一律 1 起算——老師講的「第 3 頁」是第 3 頁。
        page_no = p.index + 1
        key = f"{req.page_key_prefix.rstrip('/')}/{page_no:04d}.png"
        storage.put_bytes(key, p.png, "image/png")
        inks = [b.get("ink") for b in p.text_blocks if b.get("ink")]
        out.append(
            PageOut(
                index=page_no,
                width=p.width,
                height=p.height,
                storage_key=key,
                text_layer=p.text_layer,
                text_blocks=p.text_blocks,
                quality=p.quality,
                quality_notes=p.quality_notes,
                ink=max(set(inks), key=inks.count) if inks else None,
                figures=figures_by_page.get(page_no, []),
            )
        )

    note = result.quality_note
    if truncated:
        note += (
            f"　檔案共 {len(result.pages)} 頁，只處理前 {len(pages)} 頁。"
            f"其餘請拆成另一次匯入。"
        )

    g = prep.glyphs
    return NormalizeResponse(
        kind=result.kind,
        quality=result.quality,
        quality_note=note,
        has_text_layer=result.has_text_layer,
        page_count=len(out),
        truncated=truncated,
        pages=out,
        glyphs=GlyphInfo(
            fonts=g.fonts,
            resolved=g.resolved,
            unresolved=g.unresolved,
            from_cache=g.from_cache,
            # 只留前 20 筆給校對者抽查。「(A) 被讀成 A」這種錯
            # 一眼就看得出來，但要先讓人看得到。
            samples=[
                {"font": u.font, "raw": u.char, "as": g.mapping.get(u.key, "（未還原）")}
                for u in g.uses[:20]
            ],
        ),
        elapsed_ms=int((time.perf_counter() - t0) * 1000),
    )


async def _normalize_impl(req: NormalizeRequest, get_provider) -> NormalizeResponse:
    """
    第一階段。不呼叫 AI，純本地運算（PDF 渲染、影像前處理、LibreOffice）。

    放在執行緒池執行而非直接 await：這些是 CPU 密集且會阻塞的工作，
    在事件迴圈裡直接跑會讓同一個行程的健康探測也一起卡住——
    然後容器被判定不健康而重啟，正在處理的 200 頁題本就白做了。
    """
    t0 = time.perf_counter()
    try:
        # 三段：轉檔與盤點（執行緒）→ 符號字型辨識（AI，事件迴圈）
        # → 正規化（執行緒）。中間那段是唯一需要呼叫 AI 的，
        # 而且一份文件只呼叫一次。
        prep, _raw = await asyncio.to_thread(_prepare_sync, req)

        if prep.glyphs.uses and prep.pdf:
            import fitz

            doc = fitz.open(stream=prep.pdf, filetype="pdf")
            try:
                prep.glyphs = await glyphmap.resolve(get_provider(), doc, prep.glyphs)
            finally:
                doc.close()

        return await asyncio.to_thread(_normalize_sync, req, prep, t0)
    except storage.StorageError as e:
        # **要排在 RuntimeError 之前**：StorageError 繼承自 RuntimeError，
        # 排在後面的話永遠被攔截成 422，而 422 的契約是「內容有問題、
        # 重試也沒用、轉人工」。MinIO 重開機那幾秒鐘剛好上傳的老師，
        # 會看到他剛傳的 80MB 題本被標成永久失敗。
        raise _to_http(e) from e
    except (ValueError, NotImplementedError) as e:
        # 格式不支援：重試沒有意義，要讓老師知道該換檔案。
        raise HTTPException(415, detail=str(e)) from e
    except RuntimeError as e:
        # LibreOffice 轉檔失敗等。訊息已經寫成給老師看的了。
        raise HTTPException(422, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise _to_http(e) from e


# ─────────────────────────────────────────────────────────────────
# 階段二：切分
# ─────────────────────────────────────────────────────────────────


class SegmentPage(BaseModel):
    index: int
    storage_key: str = ""
    text_blocks: list[dict] = Field(default_factory=list)
    figures: list[dict] = Field(default_factory=list)


class SegmentRequest(BaseModel):
    pages: list[SegmentPage] = Field(min_length=1)
    #: 只切這些頁（續跑用）。空的話全切。
    only_pages: list[int] = Field(default_factory=list)


class SectionOut(BaseModel):
    title: str
    note: str
    block_count: int
    text: str


class ExerciseOut(BaseModel):
    """講義的題目單位：標頭＋題幹＋詳解＋答案。"""

    label: str
    page: int
    stem: str
    explanation: str = ""
    answer: str = ""
    inline_answers: list[str] = Field(default_factory=list)
    #: 這一題的附圖。沒有圖的幾何題是不能用的題目。
    assets: list[dict] = Field(default_factory=list)
    #: 題目旁邊印的出處：「112學測」。社會與英文的講義幾乎每題都有。
    source_exam: str | None = None
    #: 大考中心的**全國**答對率（0–1）。這是校準過的實測難度，
    #: 與我們自己學生的 correctRate 是兩回事，不可混用。
    national_correct_rate: float | None = None


class SegmentResponse(BaseModel):
    method: dict[int, str]  # 頁碼 → native / vision
    blocks: list[LayoutBlock]
    group_ranges: list[str]
    sections: list[SectionOut]
    #: 試卷走 sections，講義走 exercises。兩者互斥。
    genre: str = "unknown"
    exercises: list[ExerciseOut] = Field(default_factory=list)
    #: 掃描頁由視覺模型回報、在這一階段裁出來的附圖，{頁碼: [圖]}。
    #: 原生 PDF 的圖在正規化階段就切好了，不會出現在這裡。
    #: 講義的圖已經掛在 exercises[].assets 上，這裡是給試卷用的——
    #: 試卷走 sections，而 sections 沒有掛圖的地方。
    figures: dict[int, list[dict]] = Field(default_factory=dict)
    answer_ink: str | None = None
    vision_pages: int = 0
    usage: Usage = Field(default_factory=Usage)
    elapsed_ms: int = 0


#: 視覺切分的並行度。壓得比 provider 的併發上限低，是因為每次請求
#: 帶兩張 300 dpi 的頁面影像，記憶體與上游速率都吃得比純文字重。
_VISION_CONCURRENCY = 3



# ─────────────────────────────────────────────────────────────────
# 其餘階段的請求／回應模型
#
# 這些**必須**定義在模組層級，不能塞進 build_router 裡面。
# 檔頭有 `from __future__ import annotations`，所有型別註解都是
# 字串，FastAPI 要靠 get_type_hints 在**模組的命名空間**解析它們；
# 定義成區域類別的話解析不到，FastAPI 會退而把整個請求體當成
# query 參數，症狀是每個請求都回 422「Field required: query.req」。
#
# 這個坑很值得記下來：錯誤訊息完全不會提到「型別解析不到」。
# ─────────────────────────────────────────────────────────────────

class StructureSection(BaseModel):
    title: str = ""
    note: str = ""
    text: str = Field(min_length=1)

class StructureRequest(BaseModel):
    sections: list[StructureSection] = Field(min_length=1)

class StructureResponse(BaseModel):
    questions: list[StructuredQuestion]
    section_of: list[int]  # 與 questions 等長，指出各題屬於第幾節
    section_warnings: list[str]
    usage: Usage
    elapsed_ms: int = 0

class SolveItem(BaseModel):
    ref: str = Field(min_length=1, description="呼叫端的候選題 id，原樣回傳")
    question: StructuredQuestion
    #: 題本已附的答案。有的話仍會自答一次做交叉驗證。
    provided_keys: list[int] = Field(default_factory=list)

class SolveRequest(BaseModel):
    items: list[SolveItem] = Field(min_length=1, max_length=100)
    #: 覆寫投票次數。預設依題型（選擇 3、計算 5、非選 0）。
    votes: int | None = Field(default=None, ge=0, le=9)

class SolveOut(BaseModel):
    ref: str
    patch: dict[str, Any]
    reasons: list[dict[str, Any]] = Field(default_factory=list)
    error: str | None = None

class SolveResponse(BaseModel):
    results: list[SolveOut]
    usage: Usage
    elapsed_ms: int = 0

#: 自答的並行度。每題要跑 3–5 次獨立推導，10 題並行就是 50 次
#: 同時在飛——超過多數閘道的舒適區。壓在 4。
_SOLVE_CONCURRENCY = 4

class AnnotateItem(BaseModel):
    ref: str = Field(min_length=1)
    question: StructuredQuestion
    #: 由呼叫端以向量相似度取回的候選知識點，模型只能從中挑。
    candidates: list[dict] = Field(default_factory=list)

class AnnotateRequest(BaseModel):
    subject_name: str = Field(min_length=1)
    items: list[AnnotateItem] = Field(min_length=1, max_length=100)

class AnnotateOut(BaseModel):
    ref: str
    result: AnnotateResult | None = None
    error: str | None = None

class AnnotateResponse(BaseModel):
    results: list[AnnotateOut]
    usage: Usage
    elapsed_ms: int = 0

_ANNOTATE_CONCURRENCY = 8  # LIGHT 級呼叫，可以放寬

class RubricRequest(BaseModel):
    text: str = Field(min_length=1)
    expected_total: float | None = None
    #: 是否做獨立重抽比對（文件 16 §4.4）。成本加倍，但這是
    #: 唯一能抓出「模型穩定地抽錯」的機制。
    double_extract: bool = False

class RubricResponse(BaseModel):
    rubric: dict[str, Any]
    checks_passed: list[str]
    diffs: list[str] = []
    usage: Usage
    elapsed_ms: int = 0

class HashRequest(BaseModel):
    items: list[dict] = Field(min_length=1, max_length=1000)

class HashResponse(BaseModel):
    hashes: list[str]


def _assets_for(unit, figures_by_page: dict[int, list[dict]]) -> list[dict]:
    """
    把圖分派給題目單位。

    判準是**垂直重疊**：講義的圖都放在題目右側、與題幹同高。
    用「最近的一行」會分錯——兩題之間那張圖旁邊最近的一行
    常常是上一題的詳解。

    重疊不到就不分派。寧可讓校對者手動補，也不要分錯：
    分錯的圖比沒有圖更容易誤導學生。
    """
    blocks = unit.stem + unit.explanation
    if not blocks:
        return []

    out: list[dict] = []
    for b in blocks:
        page = b.bbox.page
        for fig in figures_by_page.get(page, []):
            bb = fig.get("bbox") or {}
            overlap = min(b.bbox.y1, bb.get("y1", 0)) - max(b.bbox.y0, bb.get("y0", 0))
            if overlap <= 0:
                continue
            if any(a["key"] == fig["key"] for a in out):
                continue
            out.append({**fig, "page": page})
    return out


def _pdf_page_count(pdf: bytes) -> int:
    import fitz

    doc = fitz.open(stream=pdf, filetype="pdf")
    try:
        return doc.page_count
    finally:
        doc.close()


#: 圖的 bbox 至少要有這麼大才裁。太小的多半是模型把一個項目符號
#: 或一個色塊當成圖了，裁出來是一塊沒有意義的碎片。
_MIN_FIG_SIDE = 0.06


def _crop_vision_figures(
    results: list[SegmentResult],
    by_index: dict[int, SegmentPage],
    method: dict[int, str],
) -> dict[int, list[dict]]:
    """
    把視覺模型回報的 FIGURE 區塊從頁面影像裁出來，存進物件儲存。

    回傳 {頁碼: [圖]}，形狀與原生 PDF 那條路一致，讓 `_assets_for`
    不必分辨圖是怎麼來的。
    """
    out: dict[int, list[dict]] = {}
    counter: dict[int, int] = {}

    for result in results:
        for b in result.blocks:
            if b.type is not BlockType.FIGURE:
                continue
            page_no = b.bbox.page
            if not method.get(page_no, "").startswith("vision"):
                continue  # 原生頁的圖已經由繪圖物件精確切好了
            page = by_index.get(page_no)
            if not page or not page.storage_key:
                continue

            w = b.bbox.x1 - b.bbox.x0
            h = b.bbox.y1 - b.bbox.y0
            if w < _MIN_FIG_SIDE or h < _MIN_FIG_SIDE:
                continue

            idx = counter.get(page_no, 0)
            counter[page_no] = idx + 1
            key = f"{page.storage_key.rsplit('.', 1)[0]}-fig-{idx:02d}.png"
            try:
                data = _crop_png(storage.get_bytes(page.storage_key), b.bbox)
                storage.put_bytes(key, data, "image/png")
            except Exception as e:  # noqa: BLE001
                log.warning("第 %d 頁第 %d 張圖裁切失敗：%s", page_no, idx, e)
                continue

            out.setdefault(page_no, []).append(
                {
                    "key": key,
                    "bbox": {
                        "x0": b.bbox.x0, "y0": b.bbox.y0,
                        "x1": b.bbox.x1, "y1": b.bbox.y1,
                    },
                    "labels": [b.text.strip()] if b.text.strip() else [],
                    "strokes": 0,
                    "origin": "vision",
                }
            )
    return out


#: 裁切時往外多留一點。模型給的框常常剛好貼著圖形，而座標軸的
#: 標籤畫在框外——貼齊裁的話標籤會被切掉。
_FIG_PAD = 0.012


def _crop_png(png: bytes, bbox: BBox) -> bytes:
    import cv2
    import numpy as np

    img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("頁面影像無法解碼")
    h, w = img.shape[:2]
    x0 = max(0, int((bbox.x0 - _FIG_PAD) * w))
    y0 = max(0, int((bbox.y0 - _FIG_PAD) * h))
    x1 = min(w, int((bbox.x1 + _FIG_PAD) * w))
    y1 = min(h, int((bbox.y1 + _FIG_PAD) * h))
    if x1 - x0 < 8 or y1 - y0 < 8:
        raise ValueError("裁切範圍太小")
    ok, buf = cv2.imencode(".png", img[y0:y1, x0:x1])
    if not ok:
        raise ValueError("裁切後的影像無法編碼")
    return buf.tobytes()


def build_router(get_provider) -> APIRouter:
    """
    把 provider 注入各端點。

    用工廠而不是 FastAPI 的 Depends：provider 是行程層級的單例，
    而且啟動失敗時要回一個講得清楚的 503（Depends 的失敗訊息
    對維運人員沒有幫助）。
    """
    r = APIRouter(prefix="/v1/import", tags=["import"])
    @r.post("/normalize", response_model=NormalizeResponse)
    async def _normalize(req: NormalizeRequest) -> NormalizeResponse:  # noqa: ANN202
        return await _normalize_impl(req, get_provider)

    # ── 切分 ────────────────────────────────────────────────────

    @r.post("/segment", response_model=SegmentResponse)
    async def _segment(req: SegmentRequest) -> SegmentResponse:  # noqa: ANN202
        t0 = time.perf_counter()

        wanted = set(req.only_pages) if req.only_pages else None
        pages = [p for p in req.pages if wanted is None or p.index in wanted]
        if not pages:
            raise HTTPException(400, detail="沒有要切分的頁面")

        by_index = {p.index: p for p in req.pages}
        method: dict[int, str] = {}
        results: dict[int, SegmentResult] = {}

        # 全份先做兩件跨頁的判斷，再逐頁切。
        # 兩者都需要看過所有頁面才判斷得出來，所以不能放進單頁的迴圈。
        all_blocks = [p.text_blocks for p in req.pages if p.text_blocks]
        answer_ink = seg.detect_answer_ink(all_blocks) if all_blocks else None
        running_heads = seg.detect_running_heads(all_blocks) if all_blocks else set()

        # 有文字層的先做完——純程式、零成本、零延遲。
        needs_vision: list[SegmentPage] = []
        for p in pages:
            if p.text_blocks:
                results[p.index] = seg.segment_native(
                    p.index, p.text_blocks, answer_ink, running_heads
                )
                method[p.index] = "native"
            else:
                needs_vision.append(p)

        # 掃描頁走視覺模型。一次送連續兩頁，讓模型看得到跨頁接續。
        sem = asyncio.Semaphore(_VISION_CONCURRENCY)
        provider_obj = _provider_or_503(get_provider) if needs_vision else None

        async def one(p: SegmentPage) -> None:
            nxt = by_index.get(p.index + 1)
            try:
                async with sem:
                    images = [storage.get_bytes(p.storage_key)]
                    note = f"這是第 {p.index} 頁"
                    if nxt and nxt.storage_key and not nxt.text_blocks:
                        images.append(storage.get_bytes(nxt.storage_key))
                        note = f"這是第 {p.index} 頁與第 {nxt.index} 頁"
                    out = await seg.segment_scanned(
                        provider_obj, p.index, images, note
                    )
                    # **只留本頁的區塊。** 下一頁是給模型看接續用的
                    # 上下文，它自己也會被當成主頁跑一次——兩邊都留
                    # 的話，第 2 頁起每一頁的內容都會進題庫兩次，
                    # 而且是一模一樣的兩份，看起來就像題本印了兩遍。
                    out.blocks = [b for b in out.blocks if b.bbox.page == p.index]
                    results[p.index] = out
                    method[p.index] = "vision"
            except Exception as e:  # noqa: BLE001
                # 單頁失敗不該讓整份失敗。標記為空結果並記下來，
                # 校對介面會顯示「第 N 頁未能解析」讓老師手動補。
                log.error("第 %d 頁切分失敗：%s", p.index, e)
                results[p.index] = SegmentResult(blocks=[], group_ranges=[])
                method[p.index] = f"failed: {type(e).__name__}"

        if needs_vision:
            await asyncio.gather(*(one(p) for p in needs_vision))

        ordered = [results[p.index] for p in sorted(pages, key=lambda x: x.index)]
        merged = seg.merge_across_pages(ordered)
        genre = seg.detect_genre(merged)

        # 掃描頁的附圖從視覺模型回報的 FIGURE 區塊裁出來。
        #
        # 原生 PDF 的圖是從繪圖物件聚出來的（figures.py），掃描頁沒有
        # 繪圖物件，只有像素。試過純影像的作法——遮掉文字行、把剩下的
        # 墨聚類——地理那兩頁抓得很準，但英文那兩頁抓出 15 個全是誤判
        # （密排的英文行沒被遮乾淨，剩下的墨連成一片看起來就像圖）。
        # 誤判的圖會讓學生看到一塊沒有意義的裁切，比沒有圖更糟。
        #
        # 而視覺模型這一趟**本來就要呼叫**（切分要用），順手讓它回報
        # 圖的位置是零額外成本，而且它知道那是不是一張圖。
        vision_figs = _crop_vision_figures(ordered, by_index, method)

        # 講義才切題目單位。試卷走 sections，兩條路不重疊。
        exercises: list[ExerciseOut] = []
        if genre == "worksheet":
            figures_by_page = {p.index: p.figures for p in req.pages if p.figures}
            for page_no, items in vision_figs.items():
                figures_by_page.setdefault(page_no, []).extend(items)
            for u in seg.split_by_exercise(merged):
                # 出處標籤要在這裡就從題幹拿掉：留著會讓重複題偵測
                # 把「同一題不同年份標籤」看成兩題，也會讓學生作答時
                # 先看到「答對率 27%」而心生預設。
                prov = u.provenance()
                stem = u.clean_stem_text()
                exercises.append(
                    ExerciseOut(
                        label=u.label,
                        page=u.page,
                        assets=_assets_for(u, figures_by_page),
                        stem=stem,
                        explanation=u.explanation_text(),
                        answer=u.answer,
                        source_exam=prov.exam,
                        national_correct_rate=prov.correct_rate,
                        # 優先用顏色（零猜測）；沒有顏色資訊時才退回
                        # 文字啟發式，而那條路只在確定是教用版時走。
                        inline_answers=(
                            u.inline_answers()
                            or (seg.extract_inline_answers(stem) if answer_ink else [])
                        ),
                    )
                )

        sections = [
            SectionOut(
                title=s["title"],
                note=s["note"],
                block_count=len(s["blocks"]),
                text=seg.blocks_to_text(s["blocks"]),
            )
            for s in seg.split_by_section(merged)
        ]

        return SegmentResponse(
            method=method,
            blocks=merged,
            group_ranges=sorted({g for r_ in ordered for g in r_.group_ranges}),
            sections=sections,
            genre=genre,
            exercises=exercises,
            figures=vision_figs,
            answer_ink=answer_ink,
            vision_pages=sum(1 for m in method.values() if m == "vision"),
            # 視覺切分的用量無法逐次取得（segment_scanned 內部走
            # _structured 的重試迴圈）。以實際用到視覺的頁數估算。
            usage=Usage(
                calls=sum(1 for m in method.values() if m == "vision"),
                estimated=True,
                provider=provider_obj.name if provider_obj else "",
                model=provider_obj.model_for("MID") if provider_obj else "",
            ),
            elapsed_ms=int((time.perf_counter() - t0) * 1000),
        )

    # ── 結構化 ──────────────────────────────────────────────────

    @r.post("/structure", response_model=StructureResponse)
    async def _structure(req: StructureRequest) -> StructureResponse:  # noqa: ANN202
        t0 = time.perf_counter()
        p = _provider_or_503(get_provider)
        meter = _Meter()

        questions: list[StructuredQuestion] = []
        section_of: list[int] = []
        warnings: list[str] = []

        for i, s in enumerate(req.sections):
            ctx = stages.parse_section(s.title, s.note)
            try:
                result, completion = await stages.structure_questions(p, s.text, ctx)
            except Exception as e:  # noqa: BLE001
                raise _to_http(e) from e
            meter.add(completion)

            # 機械不變量：各題配分加總 = 節總分。零成本，且不依賴
            # 任何模型判斷——加總對不起來就是有題目讀錯或漏切。
            if w := stages.check_section_totals(ctx, result.questions):
                warnings.append(f"第 {i + 1} 節（{s.title[:20] or '無標題'}）：{w}")

            questions.extend(result.questions)
            section_of.extend([i] * len(result.questions))

        return StructureResponse(
            questions=questions,
            section_of=section_of,
            section_warnings=warnings,
            usage=meter.usage,
            elapsed_ms=int((time.perf_counter() - t0) * 1000),
        )

    # ── 自答 ────────────────────────────────────────────────────

    @r.post("/solve", response_model=SolveResponse)
    async def _solve(req: SolveRequest) -> SolveResponse:  # noqa: ANN202
        t0 = time.perf_counter()
        p = _provider_or_503(get_provider)
        sem = asyncio.Semaphore(_SOLVE_CONCURRENCY)

        async def one(item: SolveItem) -> SolveOut:
            try:
                async with sem:
                    sr = await stages.solve_question(p, item.question, n=req.votes)
            except Exception as e:  # noqa: BLE001
                # 單題失敗不影響其他題。候選題會維持「無答案」狀態，
                # 校對時由老師填——比整批失敗好得多。
                log.warning("候選 %s 自答失敗：%s", item.ref, e)
                return SolveOut(ref=item.ref, patch={}, error=str(e)[:300])

            patch = stages.apply_solve(item.question, sr)
            reasons = []
            if reason := patch.pop("reason", None):
                reasons.append(reason.model_dump())
            if x := stages.cross_check_answer(item.question, item.provided_keys, sr):
                reasons.append(x.model_dump())
            return SolveOut(ref=item.ref, patch=patch, reasons=reasons)

        results = await asyncio.gather(*(one(i) for i in req.items))

        # 用量無法逐次取得（solve_question 內部自己跑多次），
        # 以呼叫次數估算。標記 estimated 讓成本報表知道這是估的。
        usage = Usage(
            calls=sum(1 for r_ in results if not r_.error),
            estimated=True,
            provider=p.name,
            model=p.model_for("HIGH"),
        )
        return SolveResponse(
            results=list(results),
            usage=usage,
            elapsed_ms=int((time.perf_counter() - t0) * 1000),
        )

    # ── 知識點標註 ──────────────────────────────────────────────

    @r.post("/annotate", response_model=AnnotateResponse)
    async def _annotate(req: AnnotateRequest) -> AnnotateResponse:  # noqa: ANN202
        t0 = time.perf_counter()
        p = _provider_or_503(get_provider)
        sem = asyncio.Semaphore(_ANNOTATE_CONCURRENCY)

        async def one(item: AnnotateItem) -> AnnotateOut:
            if not item.candidates:
                return AnnotateOut(
                    ref=item.ref,
                    error="沒有候選知識點。請先為此科目建立知識點並產生嵌入向量。",
                )
            try:
                async with sem:
                    res = await stages.annotate(
                        p, item.question, req.subject_name, item.candidates
                    )
                return AnnotateOut(ref=item.ref, result=res)
            except Exception as e:  # noqa: BLE001
                log.warning("候選 %s 標註失敗：%s", item.ref, e)
                return AnnotateOut(ref=item.ref, error=str(e)[:300])

        results = await asyncio.gather(*(one(i) for i in req.items))
        return AnnotateResponse(
            results=list(results),
            usage=Usage(
                calls=len(req.items), estimated=True, provider=p.name, model=p.model_for("LIGHT")
            ),
            elapsed_ms=int((time.perf_counter() - t0) * 1000),
        )

    # ── 評分原則 ────────────────────────────────────────────────

    @r.post("/rubric", response_model=RubricResponse)
    async def _rubric(req: RubricRequest) -> RubricResponse:  # noqa: ANN202
        t0 = time.perf_counter()
        p = _provider_or_503(get_provider)
        try:
            first, passed = await stages.extract_rubric(p, req.text, req.expected_total)
        except Exception as e:  # noqa: BLE001
            raise _to_http(e) from e

        diffs: list[str] = []
        if req.double_extract:
            try:
                second, _ = await stages.extract_rubric(p, req.text, req.expected_total)
                diffs = stages.compare_extractions(first, second)
                if not diffs:
                    passed.append("independent_reextraction")
            except Exception as e:  # noqa: BLE001
                diffs = [f"第二次抽取失敗，無法比對：{e}"]

        return RubricResponse(
            rubric=first.model_dump(),
            checks_passed=passed,
            diffs=diffs,
            usage=Usage(
                calls=2 if req.double_extract else 1,
                estimated=True,
                provider=p.name,
                model=p.model_for("HIGH"),
            ),
            elapsed_ms=int((time.perf_counter() - t0) * 1000),
        )

    # ── 去重的雜湊（純函式，放這裡讓 Node 端不必自己實作正規化）──

    @r.post("/content-hash", response_model=HashResponse)
    async def _hash(req: HashRequest) -> HashResponse:  # noqa: ANN202
        """
        內容雜湊。放在這裡而不是 Node 端實作，是為了**只有一份**
        正規化規則——兩份實作遲早會分岐，而分岐的症狀是去重靜默
        失效（同一題以兩種排版存進題庫，沒有任何錯誤訊息）。
        """
        return HashResponse(
            hashes=[
                stages.content_hash(
                    str(i.get("stem", "")),
                    [str(o) for o in (i.get("options") or [])],
                )
                for i in req.items
            ]
        )

    return r
