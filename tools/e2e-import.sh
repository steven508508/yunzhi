#!/usr/bin/env bash
#
# 端到端驗證的總入口。
#
# 起一組真的相依（Postgres、Redis、S3 相容儲存、AI 服務），套用真的
# 遷移，然後**把 tools/ 底下每一支 e2e-*.mjs 都跑過一遍**。
#
# 為什麼要用真的相依而不是全部 mock：這些路徑上最容易出錯的東西
# 恰恰是 mock 掉就測不到的——資料庫的 CHECK 約束、Prisma 的欄位
# 對應、跨行程的 JSON 形狀、階段續跑時的唯一鍵衝突、RLS 真的擋不擋。
#
# **為什麼是用萬用字元找檔案，而不是列一份清單。**
# 這支腳本原本只呼叫 e2e-import.mjs 與 e2e-exam.mjs 兩支，而 tools/
# 底下實際上有十三支。另外十一支（名冊、智慧老師、能力分析、監考、
# 升學、AI 閱卷、通知、級分預測、學習歷程、家長端…）沒有被任何
# shell 或 npm script 引用，也不在 CI 裡——它們**只有人記得手動一支
# 一支跑的時候才會被執行**，而文件把那幾百項寫成「全過」。
# 寫死清單就是那件事再發生一次：新增一支 e2e 卻忘了加進清單，
# 沒有任何地方會提醒。用萬用字元找，新增就自動被涵蓋。
#
# 用法：
#   ./tools/e2e-import.sh                # 全部跑完，最後列出成敗
#   ./tools/e2e-import.sh --fail-fast    # 第一支失敗就停
#   ./tools/e2e-import.sh --only tutor   # 只跑 e2e-tutor.mjs（可重複指定）
set -Eeuo pipefail

FAIL_FAST=0
declare -a ONLY=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fail-fast) FAIL_FAST=1; shift ;;
    --only) ONLY+=("$2"); shift 2 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) printf '不認得的參數：%s\n' "$1" >&2; exit 1 ;;
  esac
done

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

# 超級使用者連線有兩種來源，因為執行環境有兩種：
#   開發機／沙箱  本機 cluster，走 unix socket ＋ peer 認證（su postgres）
#   CI            Postgres 跑在另一個容器裡，沒有 postgres 這個 OS 使用者，
#                 只有一組帳密。硬寫 `su postgres` 的話 CI 上必定失敗，
#                 而那正是這一整套端到端測試進不了 CI 的原因之一。
# E2E_SUPERUSER_URL 有設就用它，沒有就退回本機的做法。
sudo_pg() {
  if [[ -n "${E2E_SUPERUSER_URL:-}" ]]; then
    psql -qtAX -v ON_ERROR_STOP=0 "${E2E_SUPERUSER_URL}" -c "$1" >/dev/null 2>&1 || true
  else
    su postgres -c "psql -qtAX -c \"$1\"" >/dev/null 2>&1 || true
  fi
}
sudo_pg_db() {
  if [[ -n "${E2E_SUPERUSER_URL:-}" ]]; then
    psql -qX -v ON_ERROR_STOP=1 "${E2E_SUPERUSER_URL%/*}/${DB_NAME}" -c "$1" >/dev/null
  else
    su postgres -c "psql -qX -d ${DB_NAME} -c \"$1\"" >/dev/null
  fi
}
sudo_pg "DROP DATABASE IF EXISTS ${DB_NAME}"
sudo_pg "DROP ROLE IF EXISTS ${DB_USER}"
sudo_pg "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}' CREATEDB"
sudo_pg "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}"
# pgvector 與 pg_trgm 不是 trusted extension，要超級使用者建。
# 這與正式安裝腳本 (deploy/scripts/install.sh) 的處理一致。
sudo_pg_db "CREATE EXTENSION IF NOT EXISTS vector"
sudo_pg_db "CREATE EXTENSION IF NOT EXISTS pg_trgm"
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
#
# 全部沿用同一個資料庫與環境變數：這些測試要驗的東西（RLS、CHECK、
# onDelete、jsonb 快照）全部長在遷移上，每一支換一個乾淨的庫反而
# 驗不到「遷移一路套下來之後的真實狀態」。各支自己會先清掉需要的表。
#
# 順序只釘住有相依關係的那兩支（匯入先跑，考卷接著用它建出來的題），
# 其餘照檔名排。**新增的 e2e 檔案不必來這裡登記**，下面的萬用字元
# 會自動找到——那正是這一段存在的理由。
declare -a ORDERED=(e2e-import e2e-exam)
declare -a SUITES=()
for s in "${ORDERED[@]}"; do
  [[ -f "tools/${s}.mjs" ]] && SUITES+=("${s}")
done
for f in tools/e2e-*.mjs; do
  s="$(basename "${f}" .mjs)"
  for done_s in "${SUITES[@]}"; do [[ "${done_s}" == "${s}" ]] && continue 2; done
  SUITES+=("${s}")
done

# --only 是給「改某一支的時候不想等其他十二支」用的。
if (( ${#ONLY[@]} > 0 )); then
  declare -a PICKED=()
  for want in "${ONLY[@]}"; do
    for s in "${SUITES[@]}"; do
      [[ "${s}" == "e2e-${want}" || "${s}" == "${want}" ]] && PICKED+=("${s}")
    done
  done
  (( ${#PICKED[@]} > 0 )) || die "--only 指定的 ${ONLY[*]} 沒有對應的 tools/e2e-*.mjs"
  SUITES=("${PICKED[@]}")
fi

declare -a FAILED=()
PASSED=0

for s in "${SUITES[@]}"; do
  say "${s}"
  if node "tools/${s}.mjs"; then
    PASSED=$((PASSED + 1))
  else
    # 失敗要記下來繼續跑完，而不是停在第一支：一次看到全部的失敗，
    # 比修一支跑一次、再發現下一支也壞掉快得多。
    FAILED+=("${s}")
    printf '   \033[31m✗ %s 失敗\033[0m\n' "${s}" >&2
    (( FAIL_FAST )) && break
  fi
done

# ── 總結 ─────────────────────────────────────────────────────
#
# **一支失敗就整體失敗，而且要說得出是哪一支。** 沒有這一段的話，
# 十三支的輸出捲過去之後，畫面上留下的是最後一支的結果——
# 中間某一支紅掉會被當成綠的。
say "總結"
printf '   通過 %d／%d\n' "${PASSED}" "${#SUITES[@]}"
if (( ${#FAILED[@]} > 0 )); then
  printf '   \033[31m失敗：%s\033[0m\n' "${FAILED[*]}" >&2
  printf '   單獨重跑：./tools/e2e-import.sh --only %s\n' "${FAILED[0]#e2e-}" >&2
  exit 1
fi
ok "全部端到端測試通過"
