#!/usr/bin/env bash
# 在「連得到疾管署現站的機器」（國內）上執行：
#   1. 擷取最新院所資料 → 檢查（hospitals.json）
#   2. 以 scripts/push-data-branch.sh 把 hospitals.json 疊到 GitHub 的 data 分支（其他檔案原樣保留）→ 觸發部署
# 接種資訊專區（data 分支的 info/*.json）不在這裡處理：www.cdc.gov.tw 境外連得到，所以改由 GitHub Actions
# 的 .github/workflows/info-update.yml 每天擷取、翻譯並寫入 data 分支（見 docs/INFO_PIPELINE.md）。
# data 分支永遠只有一個提交；兩個寫入者同時推送時由 push-data-branch.sh 的 --force-with-lease 與重試保證不互相覆蓋。
#
# 用法：scripts/publish-data.sh          在目前的資料夾執行
#       scripts/publish-data.sh --sync   先把資料夾同步成 GitHub 上 main 的最新版本（會丟棄本機修改！
#                                        只給 install-updater.sh 建立的專用資料夾使用，不要在您平常修改程式的資料夾用）
# 需要：git、node 20 以上、已登入的 gh（gh auth login）
# 結束代碼：院所資料擷取或檢查失敗為 1（data 分支維持上一版）。
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--sync" ]]; then
  git fetch -q origin main
  git reset -q --hard origin/main
fi

tmp="$(mktemp -d)"
out="$tmp/out"     # 這次要推送的內容
mkdir -p "$out"
cleanup() {
  # 還原工作目錄：擷取產生的檔案不留在這個資料夾
  git checkout -q -- public/data/hospitals.json 2>/dev/null || true
  git clean -fdq data/raw 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT

# normalize.mjs 需要 pinyin-pro（院所名稱、地址的英文拼音；devDependency）
[[ -d node_modules/pinyin-pro ]] || npm ci --no-audit --no-fund --loglevel=error

echo "== $(date '+%F %T') 院所資料"
if ! { node scripts/harvest.mjs && node scripts/normalize.mjs && node --test tests/data.test.mjs >/dev/null; }; then
  echo "✗ 院所資料擷取或檢查未通過，本次不更新（data 分支維持上一版）"
  exit 1
fi
cp public/data/hospitals.json "$out/hospitals.json"

stamp="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).meta.generatedAt)' "$out/hospitals.json")"
count="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).hospitals.length)' "$out/hospitals.json")"

result="$(bash scripts/push-data-branch.sh -C "$out" -m "data: 院所 ${stamp}（${count} 家）" hospitals.json | tail -n 1)"
echo "data 分支：院所 ${stamp}（${count} 家）— ${result%% *}"

if [[ "${SKIP_DEPLOY_TRIGGER:-}" == "1" ]]; then
  :
elif [[ "$result" == pushed* ]]; then
  gh workflow run deploy.yml --ref main
  echo "已觸發部署，約 1–2 分鐘後上線"
fi
