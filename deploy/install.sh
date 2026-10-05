#!/usr/bin/env bash
# Towerlog installer for Debian / Ubuntu (amd64, arm64).
#
#   sudo ./deploy/install.sh          install or upgrade (keeps your settings)
#   sudo ./deploy/install.sh --yes    no questions; accept the defaults
#   sudo ./deploy/install.sh --network-manager   also install NetworkManager and let it manage the interfaces
#                                     (needed for Configuration -> Network on ifupdown/netplan hosts)
#
# What it does:
#   1. installs ffmpeg, multimon-ng (EAS decoding), chrony (the clock) and Node.js 22 (from nodejs.org if the system Node is older)
#   2. installs the app to /usr/local/lib/towerlog and builds it
#   3. creates the "towerlog" service user, /etc/towerlog, /var/lib/towerlog, /var/log/towerlog
#   4. sets the web UI password and installs and starts towerlog.service
#
# Re-running it upgrades in place. Settings live in /etc/towerlog/config.json,
# recordings in /var/lib/towerlog/recordings (change it in Configuration -> System).
# For a container instead, see the Dockerfile and docker-compose.yml.
set -euo pipefail

APP_DIR=/usr/local/lib/towerlog
CONF_DIR=/etc/towerlog
DATA_DIR=/var/lib/towerlog
LOG_DIR=/var/log/towerlog
SERVICE=towerlog
NODE_MAJOR=22
NODE_MIN=22.12.0
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

YES=0
NETWORK_MANAGER=0
for a in "$@"; do
  case "$a" in
    -y|--yes) YES=1 ;;
    --network-manager) NETWORK_MANAGER=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else B= G= Y= R= N=; fi
STEP=0
step() { STEP=$((STEP + 1)); echo; echo "${B}==> ${STEP}. $*${N}"; }
ok()   { echo "    ${G}✓${N} $*"; }
info() { echo "    $*"; }
warn() { echo "    ${Y}!${N} $*"; }
die()  { echo "${R}ERROR:${N} $*" >&2; exit 1; }
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }
[ "$(id -u)" = 0 ] || die "run as root: sudo $0 $*"
command -v apt-get >/dev/null || die "this installer needs apt (Debian/Ubuntu); use the Docker image elsewhere"

step "System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ffmpeg multimon-ng chrony curl ca-certificates xz-utils rsync >/dev/null
ok "ffmpeg $(ffmpeg -version | head -n1 | awk '{print $3}'), chrony $(chronyc -v 2>/dev/null | awk '{print $3}')"

step "Node.js ${NODE_MAJOR}"
NODE_BIN="$(command -v node || true)"
if [ -n "$NODE_BIN" ] && version_ge "$(node -v | sed 's/^v//')" "$NODE_MIN"; then
  ok "using $NODE_BIN $(node -v)"
else
  case "$(uname -m)" in
    x86_64) NARCH=x64 ;; aarch64|arm64) NARCH=arm64 ;;
    *) die "no Node.js build for $(uname -m); install Node >= $NODE_MIN yourself and re-run" ;;
  esac
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  BASE="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  TARBALL="$(curl -fsSL "$BASE/SHASUMS256.txt" | awk '{print $2}' | grep "linux-${NARCH}.tar.xz$" | head -n1)"
  [ -n "$TARBALL" ] || die "could not find a Node.js ${NODE_MAJOR} download for linux-${NARCH}"
  curl -fsSL -o "$TMP/$TARBALL" "$BASE/$TARBALL"
  (cd "$TMP" && curl -fsSL "$BASE/SHASUMS256.txt" | grep " $TARBALL\$" | sha256sum -c - >/dev/null) || die "Node.js download checksum mismatch"
  rm -rf /usr/local/lib/nodejs && mkdir -p /usr/local/lib/nodejs
  tar -xJf "$TMP/$TARBALL" -C /usr/local/lib/nodejs --strip-components=1
  for b in node npm npx; do ln -sf "/usr/local/lib/nodejs/bin/$b" "/usr/local/bin/$b"; done
  hash -r
  ok "installed Node.js $(/usr/local/bin/node -v) to /usr/local/lib/nodejs"
fi
NODE_BIN="$(command -v node)"

step "Stop the old service"
systemctl stop "$SERVICE" 2>/dev/null && ok "stopped" || info "not running"

step "Install the app to $APP_DIR"
mkdir -p "$APP_DIR"
rsync -a --delete --exclude node_modules --exclude dist --exclude .git --exclude dev --exclude .dev "$SRC_DIR/" "$APP_DIR/"
(cd "$APP_DIR" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null && npm prune --omit=dev --no-audit --no-fund >/dev/null)
[ -f "$APP_DIR/dist/towerlog.mjs" ] || die "build failed: dist/towerlog.mjs is missing"
ok "built $APP_DIR/dist/towerlog.mjs"

step "Service user and folders"
id towerlog >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin towerlog
mkdir -p "$CONF_DIR" "$DATA_DIR" "$LOG_DIR"
chown -R towerlog:towerlog "$CONF_DIR" "$DATA_DIR" "$LOG_DIR"
chmod 750 "$CONF_DIR"
ok "user towerlog; $CONF_DIR $DATA_DIR $LOG_DIR"

step "Clock (chrony)"
# Towerlog writes its NTP servers to a chrony sourcedir file; a path unit makes chrony re-read it.
mkdir -p /etc/chrony/sources.d
grep -Rqs '^sourcedir /etc/chrony/sources.d' /etc/chrony/chrony.conf || echo 'sourcedir /etc/chrony/sources.d' >> /etc/chrony/chrony.conf
[ -f /etc/chrony/sources.d/towerlog.sources ] || printf '# Written by Towerlog (Configuration -> Clock).\n' > /etc/chrony/sources.d/towerlog.sources
chown root:towerlog /etc/chrony/sources.d /etc/chrony/sources.d/towerlog.sources 2>/dev/null || true
chmod 775 /etc/chrony/sources.d; chmod 664 /etc/chrony/sources.d/towerlog.sources
install -m 644 "$SRC_DIR/deploy/towerlog-chrony.path" /etc/systemd/system/towerlog-chrony.path
install -m 644 "$SRC_DIR/deploy/towerlog-chrony.service" /etc/systemd/system/towerlog-chrony.service
systemctl enable --now chrony >/dev/null 2>&1 || systemctl enable --now chronyd >/dev/null 2>&1 || warn "could not start chrony"
ok "chrony running; servers are set in Configuration -> Clock"

step "Service and command"
sed -e "s#@APP_DIR@#$APP_DIR#g" -e "s#@CONF_DIR@#$CONF_DIR#g" -e "s#@DATA_DIR@#$DATA_DIR#g" -e "s#@LOG_DIR@#$LOG_DIR#g" -e "s#@NODE@#$NODE_BIN#g" "$SRC_DIR/deploy/towerlog.service" > /etc/systemd/system/towerlog.service
sed -e "s#@APP_DIR@#$APP_DIR#g" -e "s#@CONF_DIR@#$CONF_DIR#g" -e "s#@DATA_DIR@#$DATA_DIR#g" -e "s#@LOG_DIR@#$LOG_DIR#g" -e "s#@NODE@#$NODE_BIN#g" "$SRC_DIR/deploy/towerlog-cli" > /usr/local/bin/towerlog
chmod 755 /usr/local/bin/towerlog
install -m 644 "$SRC_DIR/deploy/logrotate.conf" /etc/logrotate.d/towerlog
systemctl daemon-reload
systemctl enable --now towerlog-chrony.path >/dev/null 2>&1 || true
/usr/local/bin/towerlog init >/dev/null
ok "towerlog.service installed; try: towerlog check"

# ------------------------------------------------------------------ network settings
# The web UI changes the network through NetworkManager (or, without it, the root
# helper below), and host name / time through hostnamectl and timedatectl over D-Bus;
# this polkit rule lets the towerlog user (only) do the D-Bus part.
step "Network settings (Configuration -> Network)"
if [ "$NETWORK_MANAGER" = 1 ] && ! systemctl is-active --quiet NetworkManager; then
  warn "Installing NetworkManager and handing the interfaces over to it (your SSH session may drop briefly)"
  apt-get install -y network-manager >/dev/null
  # ifupdown-managed interfaces stay unmanaged unless NetworkManager is told otherwise.
  mkdir -p /etc/NetworkManager/conf.d
  printf '[ifupdown]\nmanaged=true\n' >/etc/NetworkManager/conf.d/10-towerlog-managed.conf
  systemctl enable --now NetworkManager >/dev/null 2>&1 || true
fi
mkdir -p /etc/polkit-1/rules.d
cat >/etc/polkit-1/rules.d/50-towerlog.rules <<'RULES'
// Installed by Towerlog: network, host name and time settings from the web UI.
polkit.addRule(function (action, subject) {
  if (subject.user !== "towerlog") return polkit.Result.NOT_HANDLED;
  if (action.id.indexOf("org.freedesktop.NetworkManager.") === 0) return polkit.Result.YES;
  if (action.id === "org.freedesktop.hostname1.set-static-hostname" || action.id === "org.freedesktop.hostname1.set-hostname") return polkit.Result.YES;
  if (action.id === "org.freedesktop.timedate1.set-timezone" || action.id === "org.freedesktop.timedate1.set-ntp") return polkit.Result.YES;
  return polkit.Result.NOT_HANDLED;
});
RULES

# Which network stack is in charge? NetworkManager is driven directly; the others
# (headless servers, older Raspberry Pi OS) go through the root helper towerlog-netapply,
# which the web UI reaches by dropping a request file (see src/engine/netapply.ts).
detect_network_backend() {
  if systemctl is-active --quiet NetworkManager 2>/dev/null; then echo nm; return; fi
  if ls /etc/netplan/*.yaml /etc/netplan/*.yml >/dev/null 2>&1; then echo netplan; return; fi
  if systemctl is-active --quiet systemd-networkd 2>/dev/null; then echo networkd; return; fi
  if systemctl is-active --quiet dhcpcd 2>/dev/null; then echo dhcpcd; return; fi
  if [ -f /etc/network/interfaces ] && grep -Eq '^[[:space:]]*iface[[:space:]]+[^[:space:]]+[[:space:]]+inet6?[[:space:]]' /etc/network/interfaces \
     && grep -Ev '^[[:space:]]*iface[[:space:]]+lo[[:space:]]' /etc/network/interfaces | grep -Eq '^[[:space:]]*iface[[:space:]]'; then echo ifupdown; return; fi
  echo none
}
NET_BACKEND="$(detect_network_backend)"
printf '{"backend": "%s"}\n' "$NET_BACKEND" >"$CONF_DIR/network.json"
chown root:root "$CONF_DIR/network.json"
chmod 644 "$CONF_DIR/network.json"
case "$NET_BACKEND" in
  nm)       ok "network managed by NetworkManager" ;;
  netplan)  ok "network managed by netplan (changes go to /etc/netplan/90-towerlog-<if>.yaml)" ;;
  networkd) ok "network managed by systemd-networkd (changes go to /etc/systemd/network/05-towerlog-<if>.network)" ;;
  dhcpcd)   ok "network managed by dhcpcd (changes go to a marked block in /etc/dhcpcd.conf)" ;;
  ifupdown) ok "network managed by ifupdown (changes go to /etc/network/interfaces.d/towerlog-<if>)" ;;
  *)        warn "no supported network stack found: Configuration → Network is view-only (re-run with --network-manager to use NetworkManager)" ;;
esac
install -d -m 755 -o towerlog -g towerlog "$DATA_DIR/net"
install -d -m 700 -o root -g root /var/lib/towerlog-netapply
for unit in towerlog-netapply.path towerlog-netapply.service ; do
  sed -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@NODE@|$NODE_BIN|g" -e "s|@CONF_DIR@|$CONF_DIR|g" -e "s|@DATA_DIR@|$DATA_DIR|g" "$SRC_DIR/deploy/$unit" >"/etc/systemd/system/$unit"
done
systemctl daemon-reload
if [ "$NET_BACKEND" != nm ] && [ "$NET_BACKEND" != none ]; then
  systemctl enable --now towerlog-netapply.path >/dev/null 2>&1 && ok "network helper ready (towerlog-netapply.path)" || warn "could not enable towerlog-netapply.path"
else
  systemctl disable --now towerlog-netapply.path >/dev/null 2>&1 || true
fi

step "Web UI password"
if sudo -u towerlog env TOWERLOG_CONFIG="$CONF_DIR/config.json" TOWERLOG_DATA="$DATA_DIR" TOWERLOG_LOG_DIR="$LOG_DIR" "$NODE_BIN" "$APP_DIR/dist/towerlog.mjs" has-password; then
  ok "already set"
elif [ "$YES" = 1 ] || [ ! -t 0 ]; then
  warn "no password set yet: run 'sudo towerlog password' (the web UI stays locked until you do)"
else
  /usr/local/bin/towerlog password
fi

step "Start"
systemctl enable --now "$SERVICE" >/dev/null 2>&1
sleep 2
if systemctl is-active --quiet "$SERVICE"; then ok "towerlog is running"; else warn "not running: journalctl -u towerlog -n 50"; fi
PORT=$(sudo -u towerlog env TOWERLOG_CONFIG="$CONF_DIR/config.json" "$NODE_BIN" -e "try{console.log(JSON.parse(require('fs').readFileSync('$CONF_DIR/config.json')).web.port)}catch{console.log(8090)}" 2>/dev/null || echo 8090)
echo
echo "${B}Open http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT:-8090}${N} and add your inputs under Configuration -> Inputs."
echo "Encoders push to this server's source port (default 8000): see Configuration -> Inputs -> Icecast push."
