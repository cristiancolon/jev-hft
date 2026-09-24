#!/usr/bin/env bash
# Sets up jev-hft on a Raspberry Pi (64-bit Raspberry Pi OS) and runs it as a background service.
#
#   ./deploy/pi/setup.sh                    install and start the news pipeline
#   ./deploy/pi/setup.sh --service record   run "save Coinbase data" instead (or: live)
#   ./deploy/pi/setup.sh --service record-binanceus  also save Binance.US data (BTC/USD, BTC/USDT)
#   ./deploy/pi/setup.sh --service dashboard  also run the live dashboard (see docs/dashboard.md)
#   ./deploy/pi/setup.sh --no-start         install everything but don't start it yet
#   ./deploy/pi/setup.sh --dry-run          show what would happen without changing anything
set -euo pipefail

SERVICE=news-live
START=1
DRY_RUN=0
NODE_MAJOR=24

usage() {
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --service) SERVICE="${2:-}"; shift 2 ;;
    --no-start) START=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage 0 ;;
    *) echo "Unknown option: $1" >&2; usage 1 ;;
  esac
done

case "$SERVICE" in
  news | news-live) SERVICE=news-live ;;
  binanceus | record-binanceus) SERVICE=record-binanceus ;;
  record | live | dashboard) ;;
  *) echo "--service must be news, record, record-binanceus, live, or dashboard" >&2; exit 1 ;;
esac

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
UNIT_NAME="jev-hft@${SERVICE}.service"
UNIT_PATH=/etc/systemd/system/jev-hft@.service

say() { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
# In a dry run, print commands instead of running them.
run() { if [ "$DRY_RUN" = 1 ]; then printf '   (dry run) %s\n' "$*"; else "$@"; fi; }

cd "$PROJECT_DIR"

say "Checking the system"
if [ "$(uname -s)" != Linux ]; then
  if [ "$DRY_RUN" = 1 ]; then warn "this isn't Linux; continuing only because it's a dry run"; else fail "this script is for Raspberry Pi OS (Linux)"; fi
fi
[ "$(uname -m)" = aarch64 ] || [ "$(uname -m)" = arm64 ] || warn "expected a 64-bit ARM system, found $(uname -m). Use the 64-bit Raspberry Pi OS."
[ "$(id -u)" -ne 0 ] || fail "run this as your normal user, not root (it uses sudo when it needs to)"
case "$PROJECT_DIR" in *' '*) fail "the project folder's path can't contain spaces: $PROJECT_DIR" ;; esac
echo "Project folder: $PROJECT_DIR"

say "Node.js $NODE_MAJOR"
node_major() { if command -v node >/dev/null; then node -p 'process.versions.node.split(".")[0]'; else echo 0; fi; }
if [ "$(node_major)" -lt "$NODE_MAJOR" ]; then
  echo "Installing Node.js $NODE_MAJOR from NodeSource (the version in Raspberry Pi OS is too old)."
  run curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh
  run sudo -E bash /tmp/nodesource_setup.sh
  run sudo apt-get install -y nodejs
  [ "$DRY_RUN" = 1 ] || [ "$(node_major)" -ge "$NODE_MAJOR" ] || fail "Node.js $NODE_MAJOR didn't install"
fi
# The real binary path (version managers like nvm or fnm can put a temporary link on PATH).
NODE_BIN="$(node -p 'process.execPath' 2>/dev/null || echo /usr/bin/node)"
echo "Using $NODE_BIN ($(node -v 2>/dev/null || echo 'not installed yet'))"

say "Clock sync"
# The service waits for time-sync.target before starting. Enabling systemd-time-wait-sync makes
# that target wait for a real sync (the Raspberry Pi OS default uses systemd-timesyncd).
if systemctl cat systemd-time-wait-sync.service >/dev/null 2>&1; then
  run sudo systemctl enable systemd-time-wait-sync.service
else
  warn "systemd-time-wait-sync isn't available; the service may start before the clock is synced"
fi
if command -v timedatectl >/dev/null; then
  [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ] || warn "the clock isn't synced right now; check with 'timedatectl'"
fi

say "Installing dependencies"
run npm ci --omit=dev

say "Checking .env"
if [ ! -f .env ]; then
  run cp .env.example .env
  run chmod 600 .env
  echo "Created .env from .env.example. Fill in your keys, then run this script again."
  [ "$DRY_RUN" = 1 ] || exit 1
else
  run chmod 600 .env
fi
has_key() { [ -f .env ] && grep -qE "^$1=.+" .env; }
provider="$( (grep -E '^JEV_PROVIDER=' .env 2>/dev/null || true) | tail -1 | cut -d= -f2- | tr -d '"')"
# Saving market data and showing the dashboard never call Jev, so they need no key for it.
# Each route needs its own: TYPESAFE_AI_API_KEY by default, AI_GATEWAY_API_KEY for the gateway.
if [ "$SERVICE" != record ] && [ "$SERVICE" != record-binanceus ] && [ "$SERVICE" != dashboard ]; then
  case "${provider:-typesafe}" in
    gateway) needed=AI_GATEWAY_API_KEY ;;
    typesafe) needed=TYPESAFE_AI_API_KEY ;;
    *) needed= ;;  # mock reaches no model at all
  esac
  if [ -n "$needed" ] && ! has_key "$needed"; then
    if [ "$DRY_RUN" = 1 ]; then warn "$needed is missing from .env"; else fail "$needed is missing from .env; the pipeline can't reach Jev without it (JEV_PROVIDER=${provider:-typesafe})"; fi
  fi
fi
if [ "$SERVICE" = news-live ]; then
  { has_key ALPACA_API_KEY_ID && has_key ALPACA_API_SECRET_KEY; } || warn "no Alpaca keys: no stock prices and no Benzinga news"
  has_key X_BEARER_TOKEN || warn "no X_BEARER_TOKEN: the X source will be skipped"
  has_key NEWS_USER_AGENT || warn "no NEWS_USER_AGENT: the SEC filing source will be skipped"
fi
if [ "$SERVICE" = dashboard ] && ! grep -qE '^DASHBOARD_HOST=.+' .env 2>/dev/null; then
  warn "DASHBOARD_HOST isn't set in .env, so the dashboard will only be reachable from the Pi itself. Add DASHBOARD_HOST=0.0.0.0 to open it from another computer on your network (it has no password)."
fi
echo ".env is in place (private to $(id -un))"

say "Installing the service: $UNIT_NAME"
run mkdir -p data
unit="$(sed -e "s|__USER__|$(id -un)|g" -e "s|__GROUP__|$(id -gn)|g" -e "s|__DIR__|$PROJECT_DIR|g" -e "s|__NODE__|$NODE_BIN|g" deploy/pi/jev-hft@.service)"
if [ "$DRY_RUN" = 1 ]; then
  printf '   (dry run) would write %s:\n' "$UNIT_PATH"
  printf '%s\n' "$unit" | sed 's/^/      /'
else
  printf '%s\n' "$unit" | sudo tee "$UNIT_PATH" >/dev/null
fi
run sudo systemctl daemon-reload
run sudo systemctl enable "$UNIT_NAME"
if [ "$START" = 1 ]; then
  run sudo systemctl restart "$UNIT_NAME"
  if [ "$DRY_RUN" = 0 ]; then
    sleep 3
    systemctl --no-pager --lines=5 status "$UNIT_NAME" || true
  fi
fi

cat <<EOF

Done. It starts automatically at boot from now on. Useful commands:

  journalctl -u $UNIT_NAME -f               follow the live log (Ctrl-C to stop following)
  systemctl status $UNIT_NAME               is it running?
  sudo systemctl stop $UNIT_NAME            stop it (pending records are saved first)
  sudo systemctl start $UNIT_NAME           start it again
  sudo systemctl disable --now $UNIT_NAME   stop it and don't start it at boot

After changing .env or updating the code (git pull), restart it:
  sudo systemctl restart $UNIT_NAME

Results are written to $PROJECT_DIR/data/.
EOF
