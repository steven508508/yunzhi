#!/usr/bin/env bash
# Prisma Client 產生器，含離線退路。
#
# 正常環境直接跑 `prisma generate` 就好。但在**沒有對外網路**的
# 環境裡（開發容器、封閉的校內網段）它會失敗：
#
#   Error: Failed to fetch the engine file at
#   https://binaries.prisma.sh/.../libquery_engine.so.node.gz - 403 Forbidden
#
# 產生 Client 的**型別**其實完全不需要那些引擎二進位檔——引擎是
# 執行期查詢用的，產生階段只是順手下載。所以離線時用兩個空檔案
# 假裝引擎已經在了，型別照樣產得出來。
#
# 這件事值得寫成腳本而不是留在某個人的記憶裡：少了它，離線環境
# 下 `npm run typecheck` 會用**過期的** Client 型別去檢查，於是
# 剛加進 schema 的欄位會被報成「不存在的屬性」，而人只會覺得
# 「Prisma 壞了」然後把那個欄位刪掉。
set -euo pipefail

cd "$(dirname "$0")/.."
SCHEMA="packages/db/schema.prisma"

if npx prisma generate --schema "$SCHEMA" 2>/tmp/prisma-generate.log; then
  exit 0
fi

if ! grep -q "binaries.prisma.sh" /tmp/prisma-generate.log; then
  echo "prisma generate 失敗，且不是因為抓不到引擎：" >&2
  cat /tmp/prisma-generate.log >&2
  exit 1
fi

echo "· 抓不到 Prisma 引擎（離線環境），改用空檔案佔位後重試" >&2

STUB_DIR="node_modules/.prisma/client"
mkdir -p "$STUB_DIR"
touch "$STUB_DIR/fake-engine" "$STUB_DIR/fake-schema-engine"

PRISMA_QUERY_ENGINE_LIBRARY="$PWD/$STUB_DIR/fake-engine" \
PRISMA_SCHEMA_ENGINE_BINARY="$PWD/$STUB_DIR/fake-schema-engine" \
PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1 \
  npx prisma generate --schema "$SCHEMA"

echo "· 已產生 Client 型別。**執行期仍需要真正的引擎**——" >&2
echo "  部署環境要能連到 binaries.prisma.sh，或改用預先下載的映像。" >&2
