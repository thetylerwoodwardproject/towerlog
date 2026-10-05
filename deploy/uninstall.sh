#!/usr/bin/env bash
# Remove Towerlog.
#   sudo ./deploy/uninstall.sh           remove the service and app, keep settings/recordings
#   sudo ./deploy/uninstall.sh --purge   also delete /etc/towerlog, /var/lib/towerlog, /var/log/towerlog and the user
# ffmpeg, chrony and Node.js are left installed.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root: sudo $0 $*" >&2; exit 1; }
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

systemctl disable --now towerlog 2>/dev/null || true
systemctl disable --now towerlog-chrony.path 2>/dev/null || true
rm -f /etc/systemd/system/towerlog-chrony.path /etc/systemd/system/towerlog-chrony.service /etc/chrony/sources.d/towerlog.sources
rm -f /etc/systemd/system/towerlog.service /etc/logrotate.d/towerlog /usr/local/bin/towerlog
systemctl daemon-reload
rm -rf /usr/local/lib/towerlog
echo "removed the towerlog service and /usr/local/lib/towerlog"

if [ "$PURGE" = 1 ]; then
  rm -rf /etc/towerlog /var/lib/towerlog /var/log/towerlog
  userdel towerlog 2>/dev/null || true
  echo "deleted settings, recordings, logs and the towerlog user"
else
  echo "kept /etc/towerlog (settings), /var/lib/towerlog (recordings) and /var/log/towerlog"
fi
