#!/bin/zsh
# Installs the bridge as a per-user service on this Mac:
#   - builds the client
#   - creates "~/Applications/iMessage Bridge.app", a signed launcher for
#     node + server/src/main.ts (Full Disk Access and Automation are granted to it)
#   - installs a LaunchAgent that starts it at login and restarts it if it stops
#
# Safe to re-run (e.g. after `git pull`). The app is only rebuilt when the launcher
# would change, because a rebuilt app needs its permissions granted again.
#
# Usage: npm run service:install        (IMB_NODE=/path/to/node to use another node)

set -euo pipefail

REPO=${0:A:h:h:h}
LABEL=com.kio.imessage-bridge
APP="$HOME/Applications/iMessage Bridge.app"
EXE="$APP/Contents/MacOS/imessage-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$HOME/Library/Logs/imessage-bridge"
CONFIG="$HOME/Library/Application Support/imessage-bridge/config.json"
NODE=${IMB_NODE:-/opt/homebrew/bin/node}
SCRIPT="$REPO/server/src/main.ts"
PORT=$(/usr/bin/python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('port', 7317))" "$CONFIG" 2>/dev/null || echo 7317)

say() { print -P "%F{blue}==>%f $*"; }
die() { print -P "%F{red}error:%f $*" >&2; exit 1; }

[[ -x $NODE ]] || die "node not found at $NODE (set IMB_NODE)"
[[ $SCRIPT != *[[:space:]]* && $NODE != *[[:space:]]* ]] || die "paths with spaces aren't supported: $SCRIPT"
command -v ffmpeg >/dev/null || say "warning: ffmpeg not found; videos and voice messages won't convert (brew install ffmpeg)"

if [[ ! -f $CONFIG ]]; then
  say "First run: creating config"
  (cd "$REPO" && npm run --silent setup)
fi

say "Building the client"
(cd "$REPO" && npm run --silent build >/dev/null)

say "Building the launcher"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
env -u SDKROOT xcrun --sdk macosx clang -O2 -Wall \
  -DNODE_PATH="\"$NODE\"" -DSCRIPT_PATH="\"$SCRIPT\"" \
  "$REPO/scripts/service/launcher.c" -o "$TMP/imessage-bridge"

cat > "$TMP/Info.plist" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$LABEL</string>
  <key>CFBundleName</key><string>iMessage Bridge</string>
  <key>CFBundleDisplayName</key><string>iMessage Bridge</string>
  <key>CFBundleExecutable</key><string>imessage-bridge</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSAppleEventsUsageDescription</key><string>iMessage Bridge sends the replies you type on your other devices through Messages.</string>
</dict>
</plist>
PLIST_END

# Stop the running service before touching its files.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true

if [[ -f $EXE ]] && cmp -s "$TMP/imessage-bridge" "$EXE" && cmp -s "$TMP/Info.plist" "$APP/Contents/Info.plist"; then
  say "Launcher unchanged; keeping the existing app (and its permissions)"
  REBUILT=0
else
  mkdir -p "$APP/Contents/MacOS"
  cp "$TMP/Info.plist" "$APP/Contents/Info.plist"
  cp "$TMP/imessage-bridge" "$EXE"
  codesign --force --sign - --identifier "$LABEL" "$APP"
  say "Created $APP"
  REBUILT=1
fi

mkdir -p "$LOGS" "${PLIST:h}"
cat > "$PLIST" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$EXE</string></array>
  <key>AssociatedBundleIdentifiers</key><string>$LABEL</string>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>IMB_LOG_FILE</key><string>$LOGS/server.log</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>StandardOutPath</key><string>$LOGS/launcher.log</string>
  <key>StandardErrorPath</key><string>$LOGS/launcher.log</string>
</dict>
</plist>
PLIST_END

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "port $PORT is already in use (another bridge running from a terminal?). Stop it and re-run."
fi

say "Starting the service"
launchctl bootstrap "gui/$UID" "$PLIST"

for _ in {1..40}; do
  curl -fs "http://127.0.0.1:$PORT/api/ping" >/dev/null 2>&1 && break
  sleep 0.25
done

STATUS=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/conversations")
if [[ $STATUS == 503 ]]; then
  say "Running, but it needs Full Disk Access to read your messages:"
  print "    System Settings → Privacy & Security → Full Disk Access → + → choose"
  print "    $APP"
  print "    (Finder and System Settings are opening on this Mac.) It starts by itself once allowed."
  open -R "$APP"
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
elif [[ $STATUS == 401 ]]; then
  say "Running with access to Messages data."
  (( REBUILT )) && print "    If macOS asks whether iMessage Bridge may control Messages, click Allow."
else
  die "service didn't come up (HTTP $STATUS). See $LOGS/launcher.log and $LOGS/server.log"
fi
print "    Logs: $LOGS/server.log"
