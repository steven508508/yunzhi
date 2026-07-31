# 雲端智學 — AI 服務映像
FROM python:3.12-slim AS base

# **APP_VERSION 不能放在這裡。** 它每次發版都變，而 Docker 的層快取
# 是鏈式的：上面任何一層變了，下面全部失效。放在 apt 之前的話，光是
# 版本號從 0.27.1 跳到 0.27.4 就會讓下面那個要下載約 500MB
# （LibreOffice ＋ 兩份 Noto CJK 字型）、實測三十分鐘的 apt 層整個重來——
# 而 apps/ai/ 可能一行都沒改。
#
# 所以這裡只放「幾乎不變」的環境變數，版本號挪到檔案後段。
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models

# 影像處理與 PDF 解析需要的系統函式庫。
# 即使目前註解掉了那些套件，先裝好可以讓日後啟用時不必重建基底層。
# libgl1 / libglib2.0-0：opencv 需要
# libreoffice-writer：DOCX/ODT 轉 PDF。老師的講義有相當比例是
#   Word 檔（訪談第 6 題「每一種形式都要完美支援」），而自己
#   解析 DOCX 的排版永遠追不上 Word 的實際呈現——轉成 PDF 之後
#   走同一條路徑，比維護兩套解析器可靠得多。
# fonts-noto-cjk：沒有中文字型的話，LibreOffice 轉出來的 PDF
#   會是一整頁的方框，而且不會報錯。
RUN apt-get update && apt-get install -y --no-install-recommends \
      libglib2.0-0 libgl1 curl \
      libreoffice-writer-nogui fonts-noto-cjk fonts-noto-cjk-extra \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# 版本號放在這裡：它在 `COPY . .` 之後，而原始碼本來就是每次發版都變的
# 東西，所以這一層失效不會多付任何代價。放在檔案開頭則會拖著 apt 與
# pip 兩個昂貴的層一起重跑。
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

# 非 root 執行。容器逃逸的風險本來就存在，用 root 跑只是把
# 「逃出來之後能做什麼」這個問題的答案變成「什麼都能做」。
RUN useradd --system --uid 10001 --create-home yunzhi \
    && mkdir -p /models && chown -R yunzhi:yunzhi /app /models
USER yunzhi

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/healthz || exit 1

# workers=2：AI 呼叫多半在等網路 I/O，加上 asyncio 的併發控制
# 已在 provider 層做了，行程數不需要多。
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2", "--no-access-log"]
