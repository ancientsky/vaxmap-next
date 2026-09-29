#!/usr/bin/env bash
# 在「連得到疾管署現站的機器」（國內）上執行：
#   1. 擷取最新院所資料 → 檢查（hospitals.json）
#   2. 擷取「疫苗接種專區」頁面 → 翻譯有變動的區塊 → 檢查（info/<lang>.json，見 docs/INFO_PIPELINE.md）
#   3. 推到 GitHub 的 data 分支 → 有變動才觸發部署
# data 分支永遠只有一個提交（每次強制覆蓋），所以 repo 不會因為每天更新而變大；main 分支完全不受影響。
# 翻譯快取（info/translations.json）與上一版原文（info/source.json）也放在 data 分支，每次執行前取回，
# 所以內容沒變的區塊不會重新翻譯（不會重複花 API 費用）。
#
# 用法：scripts/publish-data.sh          在目前的資料夾執行
#       scripts/publish-data.sh --sync   先把資料夾同步成 GitHub 上 main 的最新版本（會丟棄本機修改！
#                                        只給 install-updater.sh 建立的專用資料夾使用，不要在您平常修改程式的資料夾用）
# 需要：git、node 20 以上、已登入的 gh（gh auth login）
# 翻譯金鑰：環境變數 ANTHROPIC_API_KEY；未設定時讀取 ~/.config/vaxmap-updater/env（install-updater.sh 建立）。
#           沒有金鑰也能執行：外語檔以繁中原文輸出、標示尚未翻譯。
# 結束代碼：院所資料或接種資訊任一步失敗為 1（另一項成功的部分仍會發布；失敗的部分沿用 data 分支上一版）。
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--sync" ]]; then
  git fetch -q origin main
  git reset -q --hard origin/main
fi

tmp="$(mktemp -d)"
prev="$tmp/prev"   # data 分支上一版
out="$tmp/out"     # 這次要推送的內容
mkdir -p "$prev" "$out/info"
cleanup() {
  # 還原工作目錄：擷取產生的檔案不留在這個資料夾
  git checkout -q -- public/data/hospitals.json 2>/dev/null || true
  git checkout -q -- public/data/info data/info 2>/dev/null || true
  git clean -fdq data/raw public/data/info data/info 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT

# 讀取金鑰檔（只接受下列變數；不以 source 執行檔案內容）
env_file="${VAXMAP_UPDATER_ENV:-$HOME/.config/vaxmap-updater/env}"
if [[ -f "$env_file" ]]; then
  while IFS='=' read -r k v; do
    case "$k" in
      ANTHROPIC_API_KEY|TRANSLATE_MODEL|TRANSLATE_EFFORT|TRANSLATE_LANGS|HARVEST_UA)
        v="${v%\"}"; v="${v#\"}"
        [[ -z "${!k:-}" && -n "$v" ]] && export "$k=$v" ;;
    esac
  done < <(grep -E '^[A-Z_]+=' "$env_file" || true)
fi

# normalize.mjs 需要 pinyin-pro（院所名稱、地址的英文拼音；devDependency）
[[ -d node_modules/pinyin-pro ]] || npm ci --no-audit --no-fund --loglevel=error

origin="$(git remote get-url origin)"
status=0

# 取回 data 分支上一版（沒有 data 分支屬正常：第一次執行）
if git fetch -q --depth=1 "$origin" data 2>/dev/null; then
  git archive FETCH_HEAD | tar -x -C "$prev"
fi
mkdir -p data/info
if [[ -f "$prev/info/source.json" ]] && node scripts/sanitize-info.mjs --check "$prev/info/source.json" >/dev/null 2>&1; then
  cp "$prev/info/source.json" data/info/source.json
fi
# 翻譯快取：以 data 分支上的為主，併入 repo（main）裡的項目——repo 中 source:"manual" 的人工譯文
# （translate-info.mjs --import 產生並提交到 main）優先。translate-info.mjs 讀取時逐筆驗證形狀，輸出前再整份清理。
if [[ -f "$prev/info/translations.json" ]]; then
  node -e '
    const fs = require("fs");
    const [a, b] = process.argv.slice(1);
    const read = (f) => { try { const d = JSON.parse(fs.readFileSync(f, "utf8")); return d && typeof d === "object" && !Array.isArray(d) ? d : {}; } catch { return {}; } };
    const out = read(a), repo = read(b);
    for (const h of Object.keys(repo)) {
      if (h === "__proto__" || !repo[h] || typeof repo[h] !== "object") continue;
      if (!Object.hasOwn(out, h) || !out[h] || typeof out[h] !== "object") out[h] = {};
      for (const l of Object.keys(repo[h])) {
        if (l === "__proto__") continue;
        if (repo[h][l]?.source === "manual" || !Object.hasOwn(out[h], l)) out[h][l] = repo[h][l];
      }
    }
    fs.writeFileSync(b, JSON.stringify(out, null, 1) + "\n");
  ' "$prev/info/translations.json" data/info/translations.json
fi

echo "== $(date '+%F %T') 院所資料"
hosp_ok=0
if node scripts/harvest.mjs && node scripts/normalize.mjs && node --test tests/data.test.mjs >/dev/null; then
  cp public/data/hospitals.json "$out/hospitals.json"
  hosp_ok=1
else
  echo "✗ 院所資料擷取或檢查未通過，本次不更新院所資料"
  status=1
  [[ -f "$prev/hospitals.json" ]] && cp "$prev/hospitals.json" "$out/hospitals.json"
fi

echo "== $(date '+%F %T') 接種資訊專區"
info_ok=0
if node scripts/harvest-info.mjs \
   && node scripts/translate-info.mjs \
   && node scripts/sanitize-info.mjs --check data/info/source.json public/data/info/*.json >/dev/null; then
  cp data/info/source.json data/info/translations.json public/data/info/*.json "$out/info/"
  info_ok=1
else
  echo "✗ 接種資訊擷取、翻譯或檢查未通過，本次沿用上一版"
  status=1
  [[ -d "$prev/info" ]] && cp "$prev"/info/*.json "$out/info/" 2>/dev/null || true
fi

if [[ ! -f "$out/hospitals.json" ]]; then
  echo "沒有可發布的院所資料（data 分支也沒有上一版），不發布"
  exit 1
fi

# 接種資訊是否有「會影響網站畫面」的變動（忽略每次都會更新的 meta.fetchedAt）
info_diff="$(node -e '
  const fs = require("fs"), path = require("path");
  const [a, b] = process.argv.slice(1);
  const norm = (f) => { try { const d = JSON.parse(fs.readFileSync(f, "utf8")); delete d.meta.fetchedAt; return JSON.stringify(d); } catch { return null; } };
  const langs = ["zh-Hant", "en", "ja", "ko", "id", "vi", "th", "tl"];
  console.log(langs.some((l) => norm(path.join(a, l + ".json")) !== norm(path.join(b, l + ".json"))) ? 1 : 0);
' "$prev/info" "$out/info")"

stamp="$(node -p "require('$out/hospitals.json').meta.generatedAt")"
count="$(node -p "require('$out/hospitals.json').hospitals.length")"
info_stamp="$(node -p "try { require('$out/info/source.json').meta.fetchedAt } catch { '—' }")"

git -C "$out" init -q -b data
git -C "$out" add -A
git -C "$out" -c user.name="${GIT_AUTHOR_NAME:-vaxmap-updater}" -c user.email="${GIT_AUTHOR_EMAIL:-vaxmap-updater@users.noreply.github.com}" \
  commit -q -m "data: ${stamp}（${count} 家）；接種資訊 ${info_stamp}"
git -C "$out" push -q -f "$origin" data
hosp_note=""; [[ $hosp_ok == 1 ]] || hosp_note="，沿用上一版"
info_note="（無變動）"; [[ $info_diff == 1 ]] && info_note="（有變動）"
[[ $info_ok == 1 ]] || info_note="${info_note}，沿用上一版"
echo "已推送到 data 分支：院所 ${stamp}（${count} 家${hosp_note}）；接種資訊 ${info_stamp}${info_note}"

if [[ "${SKIP_DEPLOY_TRIGGER:-}" == "1" ]]; then
  :
elif [[ $hosp_ok == 1 || $info_diff == 1 ]]; then
  gh workflow run deploy.yml --ref main
  echo "已觸發部署，約 1–2 分鐘後上線"
else
  echo "網站內容沒有變動，不觸發部署（data 分支的時間戳記已更新，供新鮮度檢查使用）"
fi
exit $status
