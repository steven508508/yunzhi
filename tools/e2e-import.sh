#!/usr/bin/env bash
#
# 匯入路徑的端到端驗證。
#
# 起一組真的相依（Postgres、Redis、S3 相容儲存、AI 服務），
# 套用真的遷移，然後把一份題本從上傳一路跑到候選題入庫。
#
# 為什麼要用真的相依而不是全部 mock：這條路徑上最容易出錯的東西
# 恰恰是 mock 掉就測不到的——資料庫的 CHECK 約束、Prisma 的欄位
# 對應、跨行程的 JSON 形狀、階段續跑時的唯一鍵衝突。
#
# 用法：./tools/e2e-import.sh
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DB_NAME="yunzhi_e2e"
DB_USER="yunzhi_e2e"
DB_PASS="e2e-password-not-a-secret"
S3_PORT=5555
AI_PORT=8123

PIDS=()
cleanup() {
  local code=$?
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  exit $code
}
trap cleanup EXIT

say() { printf '\n\033[1m── %s\033[0m\n' "$*"; }
ok()  { printf '   ✓ %s\n' "$*"; }
die() { printf '   ✗ %s\n' "$*" >&2; exit 1; }

# ── 相依 ─────────────────────────────────────────────────────

say "準備相依服務"

pg_isready -q || die "Postgres 沒有在跑。請先 pg_ctlcluster 16 main start"
redis-cli ping >/dev/null 2>&1 || die "Redis 沒有在跑"
ok "Postgres 與 Redis 就緒"

sudo_pg() { su postgres -c "psql -qtAX -c \"$1\"" >/dev/null 2>&1 || true; }
sudo_pg "DROP DATABASE IF EXISTS ${DB_NAME}"
sudo_pg "DROP ROLE IF EXISTS ${DB_USER}"
sudo_pg "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}' CREATEDB"
sudo_pg "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}"
# pgvector 與 pg_trgm 不是 trusted extension，要超級使用者建。
# 這與正式安裝腳本 (deploy/scripts/install.sh) 的處理一致。
su postgres -c "psql -qX -d ${DB_NAME} -c 'CREATE EXTENSION IF NOT EXISTS vector'" >/dev/null
su postgres -c "psql -qX -d ${DB_NAME} -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm'" >/dev/null
ok "資料庫 ${DB_NAME} 已建立（含 vector、pg_trgm）"

export DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:5432/${DB_NAME}"
export REDIS_URL="redis://127.0.0.1:6379/9"
export S3_ENDPOINT="http://127.0.0.1:${S3_PORT}"
export S3_BUCKET="yunzhi-e2e"
export S3_ACCESS_KEY="e2e" S3_SECRET_KEY="e2e-secret" S3_REGION="us-east-1"
export AI_SERVICE_URL="http://127.0.0.1:${AI_PORT}"
export AI_PROVIDER="mock"
export NODE_ENV="test"

# S3 相容儲存
python3 -m moto.server -p "${S3_PORT}" -H 127.0.0.1 >/tmp/e2e-s3.log 2>&1 &
PIDS+=($!)
for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:${S3_PORT}/" >/dev/null 2>&1 && break
  sleep 0.25
done
python3 - <<PY
import boto3
from botocore.config import Config
s3 = boto3.client("s3", endpoint_url="${S3_ENDPOINT}",
                  aws_access_key_id="${S3_ACCESS_KEY}",
                  aws_secret_access_key="${S3_SECRET_KEY}",
                  region_name="${S3_REGION}",
                  config=Config(s3={"addressing_style": "path"}))
s3.create_bucket(Bucket="${S3_BUCKET}")
PY
ok "物件儲存就緒（bucket ${S3_BUCKET}）"

# AI 服務
(cd apps/ai && python3 -m uvicorn main:app --host 127.0.0.1 --port "${AI_PORT}" --log-level warning) \
  >/tmp/e2e-ai.log 2>&1 &
PIDS+=($!)
for _ in $(seq 1 60); do
  curl -sf "${AI_SERVICE_URL}/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "${AI_SERVICE_URL}/readyz" >/dev/null || die "AI 服務未就緒，看 /tmp/e2e-ai.log"
ok "AI 服務就緒（provider=mock）"

# ── 遷移 ─────────────────────────────────────────────────────

say "套用遷移"
for dir in packages/db/migrations/*/; do
  name="$(basename "$dir")"
  [ -f "${dir}migration.sql" ] || continue
  PGPASSWORD="${DB_PASS}" psql -qX -v ON_ERROR_STOP=1 \
    -h 127.0.0.1 -U "${DB_USER}" -d "${DB_NAME}" -f "${dir}migration.sql" >/dev/null \
    || die "遷移 ${name} 失敗"
  ok "${name}"
done

TABLES=$(PGPASSWORD="${DB_PASS}" psql -qtAX -h 127.0.0.1 -U "${DB_USER}" -d "${DB_NAME}" \
  -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
ok "共 ${TABLES} 張表"

# ── 跑測試 ───────────────────────────────────────────────────

say "端到端流程"
node tools/e2e-import.mjs

# 考卷 → 派卷 → 作答 → 計分。沿用同一個資料庫與環境變數：這一段
# 要驗的東西（RLS、CHECK、onDelete、jsonb 快照）全部長在遷移上，
# 換一個乾淨的庫反而驗不到「遷移一路套下來之後的真實狀態」。
# 它自己會先 TRUNCATE，所以不受上一段留下的資料影響。
say "考卷與作答"
node tools/e2e-exam.mjs
