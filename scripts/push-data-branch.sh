#!/usr/bin/env bash
# 更新 data 分支的「唯一」程序。data 分支有兩個寫入者：
#   - 國內更新機器的 scripts/publish-data.sh     → hospitals.json
#   - GitHub Actions 的 .github/workflows/info-update.yml → info/*.json（接種資訊專區）
# 兩者都呼叫這支腳本，只覆蓋自己負責的檔案，其他檔案原樣保留：
#   1. 取回 data 分支目前的最新提交（sha S）與它的檔案樹
#   2. 把指定的檔案疊到那棵樹上（其餘檔案不動）
#   3. 以整棵樹建立一個「沒有上一代」的新提交（orphan），所以 data 分支永遠只有一個提交，repo 不會越來越大
#   4. git push --force-with-lease=refs/heads/data:S —— 只有當遠端仍是 S（沒有別人剛好在這之間推送）才覆蓋；
#      否則重新取回、重新疊加、再試，最多 3 次重試。所以兩個寫入者同時執行時，任一方的檔案都不會被另一方蓋掉。
#
# 用法：scripts/push-data-branch.sh -C <來源資料夾> [-m <提交訊息>] <相對路徑>…
#       每個 <相對路徑> 從 <來源資料夾>/<相對路徑> 讀取，寫到 data 分支的同一路徑（例如 hospitals.json、info/en.json）。
# 環境變數：
#   DATA_REMOTE   推送目標（預設為目前資料夾 git 的 origin 網址）。可以是本機的 bare repo 路徑（測試用）
#   DATA_BRANCH   分支名稱（預設 data）
#   DATA_PUSH_RETRIES  租約失敗時的重試次數（預設 3）
#   GIT_AUTHOR_NAME／GIT_AUTHOR_EMAIL  提交者（預設 vaxmap-updater）
# 結束代碼：0 已推送或內容完全相同不需推送；1 參數錯誤、推送失敗或重試用完。
# 最後一行印出 "pushed <sha>" 或 "unchanged <sha>"，供呼叫者判斷。
set -euo pipefail

src_dir="" msg=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -C) src_dir="${2:?}"; shift 2 ;;
    -m) msg="${2:?}"; shift 2 ;;
    --) shift; break ;;
    -*) echo "不認得的參數 $1" >&2; exit 1 ;;
    *) break ;;
  esac
done
[[ -n "$src_dir" && $# -gt 0 ]] || { echo "用法：push-data-branch.sh -C <來源資料夾> [-m <提交訊息>] <相對路徑>…" >&2; exit 1; }
src_dir="$(cd "$src_dir" && pwd)"
for p in "$@"; do
  # 只接受單純的相對路徑，避免寫到樹以外或 .git 之類的位置
  if [[ "$p" == /* || "$p" == *..* || "$p" == .git* || "$p" == */.git* || ! "$p" =~ ^[A-Za-z0-9._/-]+$ ]]; then
    echo "不合法的路徑：$p" >&2; exit 1
  fi
  [[ -f "$src_dir/$p" ]] || { echo "找不到檔案：$src_dir/$p" >&2; exit 1; }
done

branch="${DATA_BRANCH:-data}"
remote="${DATA_REMOTE:-$(git remote get-url origin)}"
retries="${DATA_PUSH_RETRIES:-3}"
msg="${msg:-data: 更新 $*}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# 在暫存的 bare repo 裡操作，不碰呼叫者的工作目錄與索引
export GIT_DIR="$tmp/repo.git" GIT_INDEX_FILE="$tmp/index"
git init -q --bare "$GIT_DIR"
export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-vaxmap-updater}" GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-vaxmap-updater@users.noreply.github.com}"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

attempt=0
retry() {
  attempt=$((attempt + 1))
  if (( attempt > retries )); then
    [[ -s "$tmp/err" ]] && sed 's/^/  /' "$tmp/err" >&2
    echo "✗ $1（已重試 $retries 次）" >&2
    exit 1
  fi
  echo "$1，重新取回 data 分支後再試（第 $attempt 次重試）" >&2
  sleep "$(( attempt * ${DATA_PUSH_BACKOFF:-2} ))"
}
while :; do
  # 1. 目前的 data 分支（沒有 data 分支屬正常：第一次執行，租約改為「遠端必須還沒有這個分支」）
  base=""
  git update-ref -d refs/tmp/base 2>/dev/null || true
  if ! heads="$(git ls-remote --heads "$remote" "refs/heads/$branch" 2>"$tmp/err")"; then
    retry "無法連線到 $branch 分支所在的 repo"; continue
  fi
  if [[ -n "$heads" ]]; then
    if ! git fetch -q --no-tags --depth=1 "$remote" "+refs/heads/$branch:refs/tmp/base" 2>"$tmp/err"; then
      retry "取回 $branch 分支失敗"; continue
    fi
    base="$(git rev-parse refs/tmp/base)"
  fi
  # 2. 疊加
  rm -f "$GIT_INDEX_FILE"
  if [[ -n "$base" ]]; then git read-tree "$base^{tree}"; else git read-tree --empty; fi
  for p in "$@"; do
    blob="$(git hash-object -w -- "$src_dir/$p")"
    git update-index --add --cacheinfo "100644,$blob,$p"
  done
  tree="$(git write-tree)"
  if [[ -n "$base" && "$tree" == "$(git rev-parse "$base^{tree}")" ]]; then
    echo "data 分支內容相同，不需推送"
    echo "unchanged $base"
    exit 0
  fi
  # 3. 單一提交（沒有 parent）
  commit="$(printf '%s\n' "$msg" | git commit-tree "$tree")"
  # 4. 附租約推送
  if git push -q --force-with-lease="refs/heads/$branch:$base" "$remote" "$commit:refs/heads/$branch" 2>"$tmp/err"; then
    echo "pushed $commit"
    exit 0
  fi
  retry "推送 $branch 分支被拒（多半是另一個寫入者剛好在這段期間更新了它），或推送暫時失敗"
done
