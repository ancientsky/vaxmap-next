#!/usr/bin/env bash
# 在國內的 Linux 機器上安裝「每天自動更新院所資料」：
#   建立一個專用資料夾（與您平常修改程式的資料夾分開）→ 設定 systemd 使用者計時器，
#   每天臺北時間 05:30、12:30 執行 scripts/publish-data.sh --sync；關機錯過的會在開機後補跑。
# 用法：在專案資料夾內執行  scripts/install-updater.sh
# 移除：scripts/install-updater.sh --uninstall
set -euo pipefail
cd "$(dirname "$0")/.."

UNIT_DIR="$HOME/.config/systemd/user"
WORK_DIR="${VAXMAP_UPDATER_DIR:-$HOME/.local/share/vaxmap-updater}"

if [[ "${1:-}" == "--uninstall" ]]; then
  systemctl --user disable --now vaxmap-updater.timer 2>/dev/null || true
  rm -f "$UNIT_DIR/vaxmap-updater.service" "$UNIT_DIR/vaxmap-updater.timer"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "已移除計時器。專用資料夾仍在 $WORK_DIR，不需要的話可自行刪除。"
  exit 0
fi

fail() { echo "✗ $*" >&2; exit 1; }
command -v git >/dev/null || fail "找不到 git"
command -v gh >/dev/null || fail "找不到 gh（GitHub CLI）"
command -v node >/dev/null || fail "找不到 node，請先安裝 Node.js 20 以上（例如：sudo apt install nodejs，或用 nvm）"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || fail "Node.js 版本太舊（$(node -v)），需要 20 以上"
command -v systemctl >/dev/null || fail "這台機器沒有 systemd，請改用 cron 執行 scripts/publish-data.sh --sync"
gh auth status >/dev/null 2>&1 || fail "gh 尚未登入，請先執行 gh auth login"
if gh auth status 2>&1 | grep -qi keyring; then
  echo "！gh 的登入憑證存放在桌面鑰匙圈，背景排程在您沒有登入桌面時可能讀不到。"
  echo "  若之後排程出現驗證失敗，請執行：gh auth login --insecure-storage（改存成檔案）後再試。"
fi

origin="$(git remote get-url origin 2>/dev/null)" || fail "這個資料夾還沒有連到 GitHub（找不到 origin），請先完成上傳步驟"

echo "→ 確認這台機器連得到疾管署現站…"
node -e "fetch('https://vaxmap.cdc.gov.tw/',{signal:AbortSignal.timeout(20000)}).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status)}).catch(e=>{console.error('連線失敗：'+(e.cause?.code||e.message));process.exit(1)})" \
  || fail "這台機器連不到 vaxmap.cdc.gov.tw，無法擔任更新機器"

echo "→ 建立專用資料夾 $WORK_DIR"
if [[ -d "$WORK_DIR/.git" ]]; then
  git -C "$WORK_DIR" remote set-url origin "$origin"
  git -C "$WORK_DIR" fetch -q origin main && git -C "$WORK_DIR" reset -q --hard origin/main
else
  mkdir -p "$(dirname "$WORK_DIR")"
  git clone -q "$origin" "$WORK_DIR"
fi

# 背景服務的 PATH 很精簡：把 node、gh、git 目前所在的資料夾寫進去（用 nvm 安裝的 node 也找得到）
bin_path="$(dirname "$(command -v node)"):$(dirname "$(command -v gh)"):$(dirname "$(command -v git)"):/usr/local/bin:/usr/bin:/bin"

mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/vaxmap-updater.service" <<UNIT
[Unit]
Description=vaxmap-next：擷取院所資料並發布到 GitHub
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$WORK_DIR
Environment=PATH=$bin_path
ExecStart=$WORK_DIR/scripts/publish-data.sh --sync
TimeoutStartSec=3600
UNIT
cat > "$UNIT_DIR/vaxmap-updater.timer" <<UNIT
[Unit]
Description=vaxmap-next：每天 05:30、12:30（臺北時間）更新院所資料

[Timer]
OnCalendar=*-*-* 05:30:00 Asia/Taipei
OnCalendar=*-*-* 12:30:00 Asia/Taipei
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now vaxmap-updater.timer
loginctl enable-linger "$USER" 2>/dev/null \
  || echo "！無法設定「登出後仍執行」。若希望沒登入時也會更新，請執行：sudo loginctl enable-linger $USER"

cat <<MSG

✓ 安裝完成。
  立刻跑一次：   systemctl --user start vaxmap-updater.service   （約 10–15 分鐘）
  看執行紀錄：   journalctl --user -u vaxmap-updater.service -n 40
  看下次時間：   systemctl --user list-timers vaxmap-updater.timer
  移除：         scripts/install-updater.sh --uninstall
MSG
