#!/usr/bin/env bash
# 在「連得到疾管署現站的機器」（國內）上執行：擷取最新院所資料 → 檢查 → 推到 GitHub 的 data 分支 → 觸發部署。
# data 分支永遠只有一個提交（每次強制覆蓋），所以 repo 不會因為每天更新而變大；main 分支完全不受影響。
#
# 用法：scripts/publish-data.sh          在目前的資料夾執行
#       scripts/publish-data.sh --sync   先把資料夾同步成 GitHub 上 main 的最新版本（會丟棄本機修改！
#                                        只給 install-updater.sh 建立的專用資料夾使用，不要在您平常修改程式的資料夾用）
# 需要：git、node 20 以上、已登入的 gh（gh auth login）
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--sync" ]]; then
  git fetch -q origin main
  git reset -q --hard origin/main
fi

cleanup() {
  # 還原工作目錄：擷取產生的檔案不留在這個資料夾
  git checkout -q -- public/data/hospitals.json 2>/dev/null || true
  git clean -fdq data/raw 2>/dev/null || true
  [[ -n "${tmp:-}" ]] && rm -rf "$tmp"
}
trap cleanup EXIT

echo "== $(date '+%F %T') 開始擷取"
node scripts/harvest.mjs
node scripts/normalize.mjs
node --test tests/data.test.mjs >/dev/null || { echo "資料檢查未通過，不發布"; exit 1; }

origin="$(git remote get-url origin)"
stamp="$(node -p "require('./public/data/hospitals.json').meta.generatedAt")"
count="$(node -p "require('./public/data/hospitals.json').hospitals.length")"

tmp="$(mktemp -d)"
cp public/data/hospitals.json "$tmp/hospitals.json"
git -C "$tmp" init -q -b data
git -C "$tmp" add hospitals.json
git -C "$tmp" -c user.name="${GIT_AUTHOR_NAME:-vaxmap-updater}" -c user.email="${GIT_AUTHOR_EMAIL:-vaxmap-updater@users.noreply.github.com}" \
  commit -q -m "data: ${stamp}（${count} 家）"
git -C "$tmp" push -q -f "$origin" data
echo "已推送到 data 分支：${stamp}，${count} 家"

if [[ "${SKIP_DEPLOY_TRIGGER:-}" != "1" ]]; then
  gh workflow run deploy.yml --ref main
  echo "已觸發部署，約 1–2 分鐘後上線"
fi
