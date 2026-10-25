#!/bin/zsh
# Stops the bridge service and removes its LaunchAgent and app. Keeps your config,
# paired devices and media cache; pass --purge to delete those too.

set -euo pipefail

LABEL=com.kio.imessage-bridge
APP="$HOME/Applications/iMessage Bridge.app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
rm -rf "$APP"
print "Removed the service and $APP."
print "Also remove 'iMessage Bridge' from System Settings → Privacy & Security → Full Disk Access and Automation."

if [[ ${1:-} == --purge ]]; then
  rm -rf "$HOME/Library/Application Support/imessage-bridge" "$HOME/Library/Caches/imessage-bridge" "$HOME/Library/Logs/imessage-bridge"
  print "Deleted config, paired devices, media cache and logs."
fi
