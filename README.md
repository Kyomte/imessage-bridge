# imessage-bridge

Self-hosted bridge to read and send iMessage/SMS from Windows, using an always-on
Mac signed into Messages. See [docs/PLAN.md](docs/PLAN.md) for architecture,
decisions and milestones.

## Status

- M0 spike: decoder verified (100% vs NSUnarchiver); send tests pending.
- M1 read-only viewer: server + web client.
- M2 live updates: chat.db watcher + WebSocket (`/api/ws`); new messages, receipts,
  edits and unsends appear without reloading. The sidebar shows Live / Offline.
- M3 sending text: composer in each thread; sends go through Messages.app via osascript
  and are confirmed against chat.db (Sending… → real message, or Not Delivered + Retry).
- M4 attachments: inline photos (HEIC → JPEG), stickers, videos (HEVC → H.264 on first
  play), voice messages (CAF → m4a) and file downloads. Conversions are cached in
  `~/Library/Caches/imessage-bridge/media` (5 GB cap). Needs ffmpeg (`brew install ffmpeg`).
- M5 sending attachments: deferred, see [docs/issues/0001-send-attachments.md](docs/issues/0001-send-attachments.md).
- M6 always-on: LaunchAgent service with its own permissions, status panel, Windows
  tray app ([desktop/](desktop/README.md)).

## Layout

```
shared/   API types used by server and client
server/   Node 26 + Fastify; reads chat.db read-only (runs .ts directly, no build)
client/   React + Vite; built into client/dist and served by the server
desktop/  Windows tray app (Tauri v2) that opens the UI from the Mac
scripts/  service install/uninstall (LaunchAgent + "iMessage Bridge.app" launcher)
spike/    M0 probes (decoder corpus test, watcher, osascript sends)
```

## Running (on the Mac)

```sh
npm install
npm run service:install   # first run also creates config + pairing password
```

That builds the client, creates `~/Applications/iMessage Bridge.app` and a LaunchAgent
(`com.kio.imessage-bridge`) that starts it at login and restarts it if it stops. Then,
once, on the Mac:

1. **Full Disk Access** (to read chat.db and Contacts): System Settings → Privacy &
   Security → Full Disk Access → + → `~/Applications/iMessage Bridge.app`. Until then the
   web UI explains this step; the service restarts by itself when access is granted.
2. **Automation**: click **Allow** when macOS asks whether iMessage Bridge may control
   Messages (needed to send). The Status panel in the UI shows both.

The permissions belong to the app, not to node, so `brew upgrade node` doesn't reset
them. Re-running `service:install` keeps the app unless its launcher changed.

```sh
npm run service:restart    # after git pull / code changes
npm run service:logs       # ~/Library/Logs/imessage-bridge/server.log (no message content)
npm run service:uninstall  # --purge also deletes config, devices, cache, logs
```

For development, `npm run setup && npm run build && npm start` runs it in a terminal
(the terminal app then needs Full Disk Access instead).

Remote access is through Tailscale only:

```sh
tailscale serve --bg --http=80 7317   # http://<mac>.<tailnet>.ts.net → 127.0.0.1:7317 (tailnet only)
tailscale serve --http=80 off         # undo
```

Plain HTTP is fine here: tailnet traffic is already WireGuard-encrypted end to end.
HTTPS (`tailscale serve --bg 7317`) needs Serve/HTTPS enabled in the Tailscale admin
console, which also publishes the machine's ts.net name in Certificate Transparency logs.

Open the ts.net URL on Windows, enter the pairing password, and the device gets
its own revocable token. `npm run setup -- --rotate-password` issues a new pairing
password; existing devices keep working until revoked (`DELETE /api/devices/:id`).

Ctrl+Shift+B blurs names and message text (useful when screen sharing).

## Development

```sh
npm run dev        # server with --watch + Vite dev server (proxies /api)
npm test           # server tests, incl. an integration test against the real chat.db
npm run typecheck
```

## Spike scripts

All read `~/Library/Messages/chat.db` read-only. None print message text.

```sh
# attributedBody decoder vs Apple's NSUnarchiver, over the whole corpus
env -u SDKROOT xcrun --sdk macosx clang -fobjc-arc -framework Foundation -lsqlite3 \
  spike/reference.m -o /tmp/imb-reference
/tmp/imb-reference ~/Library/Messages/chat.db > /tmp/imb-reference.tsv
node spike/corpus.ts /tmp/imb-reference.tsv

# log new messages (metadata + detection latency) for N minutes
node spike/watch.ts 30

# AppleScript sending (needs Automation permission for Messages)
node spike/send.ts check
node spike/send.ts text '<chat guid>' 'test'
node spike/send.ts file '<chat guid>' /path/to/image.jpg
```
