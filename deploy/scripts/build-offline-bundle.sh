#!/usr/bin/env bash
# 雲端智學 — 離線安裝包
#
# 目標機房完全沒有對外網路時用這一支。在一台**同架構、有網路**的
# 機器上把所有映像建好、拉齊、打包成一個 tar.gz，搬過去 docker load。
#
# 為什麼非得這樣不可：
#
#   一、Prisma 的查詢引擎是執行期的硬相依，建置時要從
#       binaries.prisma.sh 下載並烤進映像。它不是「少了會降級」的
#       東西 —— 沒有它，migrate 容器第一秒就退出，整套堆疊卡住。
#   二、基底映像（pgvector、redis、minio、caddy）在 Docker Hub 上。
#   三、AI 映像的 pip 相依與 LibreOffice 的 apt 套件也都要抓。
#
#   這三樣沒有任何一樣可以「事後補」。所以離線安裝的做法是把
#   **建好的映像**搬過去，不是把原始碼搬過去再在封閉網段裡建。
#
# **架構必須一致。** x86_64 上打的包在 aarch64 機器上 load 得進去，
# 但容器一啟動就 exec format error。MANIFEST 裡記了架構，載入時會擋。
#
# 用法：
#   ./deploy/scripts/build-offline-bundle.sh                # 打包（預設含監控映像）
#   ./deploy/scripts/build-offline-bundle.sh --no-monitoring
#   ./deploy/scripts/build-offline-bundle.sh --output /mnt/usb
#   ./deploy/scripts/build-offline-bundle.sh --load offline # 目標機器載入（安裝腳本會自己呼叫）

# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

ACTION="pack"
LOAD_DIR=""
OUTPUT_DIR="${YZ_ROOT}"
WITH_MONITORING=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --load) ACTION="load"; LOAD_DIR="${2:-${YZ_ROOT}/offline}"; shift 2 ;;
    --output) OUTPUT_DIR="$2"; shift 2 ;;
    --no-monitoring) WITH_MONITORING=0; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) die "不認得的參數：$1" ;;
  esac
done

APP_VERSION="${APP_VERSION:-$(cat "${YZ_ROOT}/VERSION" 2>/dev/null || echo '0.1.0')}"
export APP_VERSION
ARCH="$(uname -m)"

need_cmd docker tar gzip || die "缺少必要指令。"
docker info >/dev/null 2>&1 || die "Docker daemon 連不上。請確認 docker 已啟動，且目前使用者在 docker 群組（加入群組後要重新登入）。"

# ════════════════════════════════════════════════════════════════
# 載入模式（在目標機器上執行）
# ════════════════════════════════════════════════════════════════
if [[ "${ACTION}" == "load" ]]; then
  section "載入離線映像"

  [[ -d "${LOAD_DIR}" ]] || die "找不到離線包目錄 ${LOAD_DIR}。請先把 yunzhi-offline-*.tar.gz 解開，offline/ 會在解出來的專案目錄底下。"

  MANIFEST="${LOAD_DIR}/MANIFEST"
  [[ -f "${MANIFEST}" ]] || die "${LOAD_DIR} 裡沒有 MANIFEST，這不像是本腳本產生的離線包。"

  bundle_arch="$(grep -E '^ARCH=' "${MANIFEST}" | cut -d= -f2 || true)"
  bundle_version="$(grep -E '^APP_VERSION=' "${MANIFEST}" | cut -d= -f2 || true)"

  if [[ -n "${bundle_arch}" && "${bundle_arch}" != "${ARCH}" ]]; then
    err "離線包是在 ${bundle_arch} 上打包的，這台機器是 ${ARCH}。"
    err "載入不會報錯，但容器一啟動就 exec format error —— 那個錯誤看起來像映像壞了。"
    die "請在 ${ARCH} 的機器上重新打包。"
  fi

  if [[ -n "${bundle_version}" && "${bundle_version}" != "${APP_VERSION}" ]]; then
    warn "離線包版本 ${bundle_version}，但這份原始碼是 ${APP_VERSION}。"
    warn "compose 會去找 yunzhi/web:${APP_VERSION} 這個標籤，找不到就會嘗試建置（離線會失敗）。"
    dim "把兩邊對齊：git checkout v${bundle_version}，或重新打包。"
  fi

  images_tar=""
  for candidate in "${LOAD_DIR}/images.tar.gz" "${LOAD_DIR}/images.tar"; do
    [[ -f "${candidate}" ]] && { images_tar="${candidate}"; break; }
  done
  [[ -n "${images_tar}" ]] || die "${LOAD_DIR} 裡找不到 images.tar.gz。"

  # 校驗和。搬運途中的損毀（USB 拔太快、NFS 中斷）會讓 docker load
  # 在最後幾個位元組失敗，而錯誤訊息是 "unexpected EOF"，看不出是檔案壞了。
  if [[ -f "${images_tar}.sha256" ]]; then
    info "驗證校驗和…"
    ( cd "$(dirname "${images_tar}")" && sha256sum -c "$(basename "${images_tar}").sha256" >/dev/null ) \
      || die "校驗和不符，映像檔在搬運過程中損毀了。請重新複製。"
    ok "校驗和正確"
  else
    warn "離線包裡沒有校驗和檔，跳過驗證。"
  fi

  info "載入映像（幾 GB，需要數分鐘）…"
  docker load -i "${images_tar}" || die "docker load 失敗。磁碟空間夠嗎？df -h /var/lib/docker"

  # 逐一確認。docker load 對「檔案裡少了一個映像」是不會抱怨的，
  # 而少掉的那一個要等到 compose up 才發現。
  missing=()
  while IFS= read -r img; do
    [[ -n "${img}" ]] || continue
    docker image inspect "${img}" >/dev/null 2>&1 || missing+=("${img}")
  done < <(grep -E '^IMAGE=' "${MANIFEST}" | cut -d= -f2-)

  if ((${#missing[@]})); then
    err "載入之後仍缺少這些映像："
    printf '    %s\n' "${missing[@]}" >&2
    die "離線包不完整。請在打包機器上重新執行 build-offline-bundle.sh。"
  fi

  ok "所有映像已就緒"
  exit 0
fi

# ════════════════════════════════════════════════════════════════
# 打包模式（在有網路的機器上執行）
# ════════════════════════════════════════════════════════════════
section "離線安裝包 — ${APP_VERSION} / ${ARCH}"

warn "這一步需要對外網路，而且要在**與目標機器相同架構**（${ARCH}）的機器上執行。"

# compose 的變數展開需要一份 .env。打包機器上不需要真的密碼，
# 但檔案要存在，否則 `docker compose` 直接以 "env file not found" 結束。
# 用暫存檔而不是動使用者的 .env —— 打包機可能同時是別人的正式機。
BUILD_ENV="$(mktemp)"
trap 'rm -f "${BUILD_ENV}"' EXIT
if [[ -f "${YZ_ROOT}/.env" ]]; then
  cp "${YZ_ROOT}/.env" "${BUILD_ENV}"
else
  cp "${YZ_ROOT}/.env.example" "${BUILD_ENV}"
  info "打包機器上沒有 .env，用 .env.example 做建置期的變數展開（不會進到包裡）。"
fi
# 映像標籤要對齊版本，否則打出來的是 yunzhi/web:dev，
# 目標機器上 compose 找 yunzhi/web:0.19.0 會找不到。
printf '\nAPP_VERSION=%s\n' "${APP_VERSION}" >>"${BUILD_ENV}"

dc() { ( cd "${YZ_ROOT}" && docker compose --env-file "${BUILD_ENV}" "$@" ); }

PROFILES=(--profile caddy)
(( WITH_MONITORING )) && PROFILES+=(--profile monitoring)

# ── 1. 建置自家映像 ─────────────────────────────────────────────
section "1／4  建置映像"
info "含 Prisma 引擎下載與 next build，視機器約 5 至 15 分鐘。"
dc "${PROFILES[@]}" build --pull || die "建置失敗。這台機器連得到 Docker Hub 與 binaries.prisma.sh 嗎？"
ok "自家映像建置完成"

# ── 2. 拉齊第三方映像 ───────────────────────────────────────────
section "2／4  拉取基底映像"
mapfile -t IMAGES < <(dc "${PROFILES[@]}" config --images | sort -u)
(( ${#IMAGES[@]} )) || die "compose 沒有回報任何映像名稱，設定檔可能有問題。"

for img in "${IMAGES[@]}"; do
  if docker image inspect "${img}" >/dev/null 2>&1; then
    dim "已在本機：${img}"
    continue
  fi
  info "拉取 ${img}…"
  docker pull "${img}" || die "拉取 ${img} 失敗。"
done
ok "${#IMAGES[@]} 個映像齊了"

# ── 3. 匯出 ─────────────────────────────────────────────────────
section "3／4  匯出映像"

STAGE="$(mktemp -d)"
trap 'rm -f "${BUILD_ENV}"; rm -rf "${STAGE}"' EXIT
PKG="${STAGE}/yunzhi"
mkdir -p "${PKG}/offline"

{
  printf 'APP_VERSION=%s\n' "${APP_VERSION}"
  printf 'ARCH=%s\n' "${ARCH}"
  printf 'BUILT_AT=%s\n' "$(date -Iseconds)"
  printf 'BUILT_ON=%s\n' "$(uname -sr)"
  printf 'MONITORING=%s\n' "$(( WITH_MONITORING ))"
  printf 'IMAGE=%s\n' "${IMAGES[@]}"
} >"${PKG}/offline/MANIFEST"

info "docker save（這一步最久，映像總量通常 3 至 5 GB）…"
docker save "${IMAGES[@]}" | gzip -1 >"${PKG}/offline/images.tar.gz" \
  || die "docker save 失敗。磁碟空間夠嗎？"
( cd "${PKG}/offline" && sha256sum images.tar.gz >images.tar.gz.sha256 )
ok "映像已匯出（$(du -sh "${PKG}/offline/images.tar.gz" | cut -f1)）"

# ── 4. 打包原始碼 ───────────────────────────────────────────────
section "4／4  打包"

# 用 git archive 而不是 cp -r：它只帶版控裡的檔案，
# 自動排除 node_modules、.next、data/ 與 **.env**。
# .env 進到離線包等於把資料庫密碼、AI 金鑰與備份加密金鑰
# 一起放進一顆到處傳的隨身碟。
if [[ -d "${YZ_ROOT}/.git" ]] && command -v git >/dev/null 2>&1; then
  ( cd "${YZ_ROOT}" && git archive --format=tar HEAD ) | tar -x -C "${PKG}" \
    || die "git archive 失敗。"
else
  warn "這不是 git 工作目錄，改用 tar 並手動排除。請自行確認包裡沒有 .env。"
  tar -C "${YZ_ROOT}" -cf - \
    --exclude=.git --exclude=node_modules --exclude=.next --exclude=data \
    --exclude='.env' --exclude='.env.*' --exclude=offline \
    . | tar -x -C "${PKG}"
fi

[[ -f "${PKG}/.env" ]] && die "內部錯誤：.env 跑進離線包了，已中止。"

BUNDLE="${OUTPUT_DIR}/yunzhi-offline-${APP_VERSION}-${ARCH}.tar.gz"
mkdir -p "${OUTPUT_DIR}"
tar -C "${STAGE}" -czf "${BUNDLE}" yunzhi
sha256sum "${BUNDLE}" >"${BUNDLE}.sha256"

section "完成"
ok "離線包：${BUNDLE}（$(du -sh "${BUNDLE}" | cut -f1)）"
echo
dim "搬到目標機器後："
dim "  sha256sum -c yunzhi-offline-${APP_VERSION}-${ARCH}.tar.gz.sha256"
dim "  tar -xzf yunzhi-offline-${APP_VERSION}-${ARCH}.tar.gz"
dim "  cd yunzhi"
dim "  sudo ./deploy/scripts/ubuntu-install.sh --offline    # 全新的 Ubuntu"
dim "  ./deploy/scripts/docker-install.sh --offline         # 已經有 Docker"
echo
warn "目標機器仍然需要 Docker Engine 本身。"
dim "封閉網段請一併下載 docker-ce 的 .deb："
dim "  在有網路的同版本 Ubuntu 上："
dim "  sudo apt-get install -y --download-only docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
dim "  然後把 /var/cache/apt/archives/*.deb 一起帶過去，用 sudo dpkg -i *.deb 安裝。"
echo
