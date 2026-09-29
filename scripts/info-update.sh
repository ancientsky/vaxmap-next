#!/usr/bin/env bash
# 接種資訊專區的每日更新（擷取 → 翻譯 → 檢查 → 推到 data 分支 → 需要時觸發部署）。
# 由 .github/workflows/info-update.yml 分階段呼叫（每個階段是一個 step，翻譯金鑰只給 translate 階段、
# 推送權杖只給 publish 階段）；也可以在本機依序執行全部階段（見 docs/INFO_PIPELINE.md「在本機跑一次」）。
#
# 用法：scripts/info-update.sh <prepare|harvest|translate|check|publish|all>
# 環境變數：
#   INFO_WORK_DIR  工作資料夾（各階段之間以這裡的檔案交接；GitHub Actions 上未設定時為 $RUNNER_TEMP/info-work）
#   DATA_REPO_URL  讀取 data 分支的 repo（預設為 origin 的網址；公開 repo 可匿名讀取）
#   DATA_REMOTE    推送 data 分支的目標（預設同 DATA_REPO_URL；見 scripts/push-data-branch.sh）
#   INFO_FORCE     手動執行時的強制選項（workflow_dispatch 的 force 輸入）：
#                    空白     一般執行
#                    deploy   來源沒變也照常翻譯缺少的區塊並觸發部署
#                    all | title | <區塊 id>   丟棄這些單位的翻譯快取、重新翻譯，並觸發部署
#   INFO_FORCE_LANGS  搭配上一項，只重翻這些語言（逗號分隔，例如 en,ja；空白＝全部）
#   INFO_REPO_CACHE  要併入的 repo 內翻譯快取（預設 data/info/translations.json；人工譯文優先）
#   SKIP_DEPLOY_TRIGGER=1  不呼叫 gh workflow run deploy.yml（測試用）
#   翻譯相關（GEMINI_API_KEY、TRANSLATE_*）見 scripts/translate-info.mjs
# 各階段失敗時結束代碼非 0，data 分支維持上一版（publish 之前都不會寫入 data 分支）。
set -euo pipefail
cd "$(dirname "$0")/.."

phase="${1:-}"
W="${INFO_WORK_DIR:-${RUNNER_TEMP:+$RUNNER_TEMP/info-work}}"
[[ -n "$W" ]] || { echo "✗ 請設定 INFO_WORK_DIR（工作資料夾）" >&2; exit 1; }
mkdir -p "$W"
W="$(cd "$W" && pwd)"
export INFO_DATA_DIR="$W/data" INFO_OUT_DIR="$W/data" INFO_PUBLIC_DIR="$W/pub"
LANGS=(zh-Hant en ja ko id vi th tl)

force="${INFO_FORCE:-}"
if [[ -n "$force" && ! "$force" =~ ^(deploy|all|title|[0-9]{1,12})$ ]]; then
  echo "✗ force 只接受 deploy、all、title 或區塊 id（數字），收到：${force//[^A-Za-z0-9_-]/?}" >&2; exit 1
fi
force_langs="${INFO_FORCE_LANGS:-}"
if [[ -n "$force_langs" && ! "$force_langs" =~ ^[a-z]{2}(,[a-z]{2})*$ ]]; then
  echo "✗ langs 格式不正確（例：en,ja）" >&2; exit 1
fi

state() { # state <key> [value]：各階段之間交接的小狀態
  if [[ $# -eq 2 ]]; then echo "$2" > "$W/state.$1"; [[ -n "${GITHUB_OUTPUT:-}" ]] && echo "$1=$2" >> "$GITHUB_OUTPUT"; return 0; fi
  cat "$W/state.$1" 2>/dev/null || true
}

do_prepare() {
  rm -rf "$W/prev" "$W/data" "$W/pub" "$W/out" "$W"/state.*
  mkdir -p "$W/prev" "$W/data" "$W/pub"
  local url="${DATA_REPO_URL:-$(git remote get-url origin)}"
  local g="$W/fetch.git"
  rm -rf "$g"; git init -q --bare "$g"
  # data 分支上一版：上一版原文（判斷有無變動、沿用 changedAt）、翻譯快取、上一版語言檔（判斷要不要部署）
  # 「沒有 data 分支」（第一次執行）與「連不上／沒有權限」要分開：後者若當成第一次執行，會遺失翻譯快取而全部重翻
  local heads
  heads="$(git --git-dir="$g" ls-remote --heads "$url" refs/heads/data)" || { echo "✗ 無法讀取 data 分支所在的 repo" >&2; exit 1; }
  if [[ -n "$heads" ]]; then
    git --git-dir="$g" fetch -q --no-tags --depth=1 "$url" "+refs/heads/data:refs/heads/data"
    git --git-dir="$g" archive data | tar -x -C "$W/prev"
    echo "已取回 data 分支 $(git --git-dir="$g" rev-parse --short data)"
  else
    echo "沒有 data 分支（第一次執行屬正常）"
  fi
  rm -rf "$g"
  if [[ -f "$W/prev/info/source.json" ]] && node scripts/sanitize-info.mjs --check "$W/prev/info/source.json" >/dev/null 2>&1; then
    cp "$W/prev/info/source.json" "$W/data/source.json"
  fi
  [[ -f "$W/prev/info/translations.json" ]] && cp "$W/prev/info/translations.json" "$W/data/translations.json"
  # repo（main）裡的快取：translate-info.mjs --import 產生並提交的人工譯文優先於 data 分支上的機器翻譯
  local repo_cache="${INFO_REPO_CACHE:-data/info/translations.json}"
  if [[ -f "$repo_cache" ]]; then
    node scripts/translate-info.mjs --merge-cache "$repo_cache"
  fi
}

do_harvest() {
  node scripts/harvest-info.mjs | tee "$W/harvest.log"
  local last; last="$(tail -n 1 "$W/harvest.log")"
  [[ "$last" == changed || "$last" == unchanged ]] || { echo "✗ harvest-info 沒有回報 changed／unchanged" >&2; exit 1; }
  state changed "$([[ $last == changed ]] && echo 1 || echo 0)"
}

# 上一版語言檔是否有尚未翻譯的區塊（例如先前翻譯失敗、剛設定金鑰、新增語言）
pending_translation() {
  node -e '
    const fs = require("fs"), path = require("path");
    const [dir, ...langs] = process.argv.slice(1);
    const pending = langs.filter((l) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, l + ".json"), "utf8")).meta.translation === "partial"; } catch { return true; }
    });
    console.log(pending.join(","));
  ' "$W/prev/info" "${LANGS[@]:1}"
}

do_translate() {
  local changed; changed="$(state changed)"
  [[ -n "$changed" ]] || { echo "✗ 請先執行 harvest 階段" >&2; exit 1; }
  local args=()
  if [[ -n "$force" && "$force" != deploy ]]; then
    args=(--force "$force"); [[ -n "$force_langs" ]] && args+=(--lang "$force_langs")
  fi
  local pending; pending="$(pending_translation)"
  if [[ "$changed" == 0 && -z "$force" && -z "$pending" ]]; then
    # 來源沒變、上一版全部已翻譯：保證不呼叫 API（不把金鑰交給翻譯程式），只重新產生語言檔以更新 meta.fetchedAt
    echo "來源沒有變動且各語言都已翻譯：不呼叫翻譯 API，只以快取重建語言檔"
    env -u GEMINI_API_KEY -u ANTHROPIC_API_KEY node scripts/translate-info.mjs
    state translated 0
  else
    [[ "$changed" == 0 && -n "$pending" ]] && echo "來源沒有變動，但上一版有尚未翻譯的語言（$pending），補翻缺少的區塊"
    node scripts/translate-info.mjs "${args[@]}"
    state translated 1
  fi
}

do_check() {
  node scripts/sanitize-info.mjs --check "$W/data/source.json" "$W"/pub/*.json
  local n; n="$(ls "$W"/pub/*.json | wc -l)"
  [[ "$n" == "${#LANGS[@]}" ]] || { echo "✗ 語言檔應有 ${#LANGS[@]} 個，實際 $n 個" >&2; exit 1; }
}

do_publish() {
  mkdir -p "$W/out/info"
  local files=(info/source.json info/translations.json)
  cp "$W/data/source.json" "$W/data/translations.json" "$W/out/info/"
  for l in "${LANGS[@]}"; do cp "$W/pub/$l.json" "$W/out/info/"; files+=("info/$l.json"); done
  # 是否有「會影響網站畫面」的變動（忽略每次都會更新的 meta.fetchedAt）
  local diff
  diff="$(node -e '
    const fs = require("fs"), path = require("path");
    const [a, b, ...langs] = process.argv.slice(1);
    const norm = (f) => { try { const d = JSON.parse(fs.readFileSync(f, "utf8")); delete d.meta.fetchedAt; return JSON.stringify(d); } catch { return null; } };
    console.log(langs.some((l) => norm(path.join(a, l + ".json")) !== norm(path.join(b, l + ".json"))) ? 1 : 0);
  ' "$W/prev/info" "$W/out/info" "${LANGS[@]}")"
  local stamp; stamp="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).meta.fetchedAt)' "$W/data/source.json")"
  DATA_REMOTE="${DATA_REMOTE:-${DATA_REPO_URL:-$(git remote get-url origin)}}" \
    bash scripts/push-data-branch.sh -C "$W/out" -m "info: 接種資訊 ${stamp}" "${files[@]}"
  state visible_change "$diff"
  if [[ "${SKIP_DEPLOY_TRIGGER:-}" == 1 ]]; then
    echo "（SKIP_DEPLOY_TRIGGER=1，不觸發部署；畫面有變動＝$diff）"
  elif [[ "$diff" == 1 || -n "$force" ]]; then
    gh workflow run deploy.yml --ref main
    echo "已觸發部署（畫面有變動＝$diff，force＝${force:-無}）"
  else
    echo "網站內容沒有變動，不觸發部署（data 分支的 info/source.json 抓取時間已更新，供新鮮度檢查使用；語言檔隨下一次部署上線）"
  fi
}

case "$phase" in
  prepare) do_prepare ;;
  harvest) do_harvest ;;
  translate) do_translate ;;
  check) do_check ;;
  publish) do_publish ;;
  all) do_prepare; do_harvest; do_translate; do_check; do_publish ;;
  *) echo "用法：scripts/info-update.sh <prepare|harvest|translate|check|publish|all>" >&2; exit 1 ;;
esac
