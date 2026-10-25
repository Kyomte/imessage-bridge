# iMessage Bridge — Plan

Read and send iMessage/SMS from Windows, with full history (both sides, including
messages sent from the iPhone), using an always-on Mac as the bridge.

```
iPhone ─iCloud / SMS relay─► Messages.app ─writes─► chat.db (WAL)
                                 ▲                      │ read-only
                            osascript                   ▼
                                 └── Node server (LaunchAgent, 127.0.0.1)
                                        ├─ app.db (device tokens, outbox, media index)
                                        └─ media cache (~/Library/Caches/imessage-bridge)
                                                       │
                                     tailscale serve (HTTPS, tailnet only)
                                                       │
                                     Windows: Tauri tray app (React UI)
```

## Decisions (2026-10-25)

| Question | Decision |
|---|---|
| Contact names | Read the Contacts (AddressBook) SQLite for names/avatars |
| New conversations | v1 replies to existing threads only |
| Group chats | In v1 (reading them is nearly free) |
| Remote access | Tailscale only, never Funnel, no open ports |
| Reboots | Auto-login recommended (see Ops) |
| Windows client | Native tray app: Tauri v2 wrapping the React UI |

## Facts about chat.db

- Measured on macOS 26.3 with Node 26.5.
- chat.db: WAL mode.
- Nearly all messages have `text` NULL and content only in `attributedBody`.
- All chat GUIDs use the `any;-;…` / `any;+;…` prefix (not `iMessage;-;`).
- Tapback rows must be filtered from the timeline even before reactions ship. Inline
  replies, edits and system rows (`item_type <> 0`) are also present.
- Dates are nanoseconds since 2001-01-01: `unixMs = date / 1e6 + 978307200000`.
- Attachments are mostly HEIC, plus QuickTime videos. Some files are missing on disk
  and some rows have no path.

## Stack

**Server: Node 26 + TypeScript** (monorepo: `server/`, `client/`, `shared/` types).
- `node:sqlite` opened read-only on chat.db (no native build; `better-sqlite3` as fallback).
- Fastify + `@fastify/websocket` + `@fastify/multipart` (Range streaming, uploads).
- Modules: `db` (queries + mappers), `decode` (typedstream), `watcher`, `send`
  (serialized osascript queue), `media`, `contacts`, `api`.
- Own `app.db` for device tokens, send outbox, media cache index. chat.db is never written.
- Shipped as a Node single-executable binary so Full Disk Access and Automation are
  granted to that one file, not to `/opt/homebrew/bin/node` (a `brew upgrade` would
  silently drop the grants, and FDA on global node covers every node script).

**Client: React + Vite + TypeScript inside Tauri v2.**
- TanStack Query for REST cache, patched by WebSocket events.
- react-virtuoso for long threads with prepend-on-scroll.
- Why Tauri over Electron: WebView2 ships with Windows 11, so the installer is ~10 MB
  instead of ~100 MB+; tray, notifications, autostart and single-instance are official
  plugins with JS APIs, so very little Rust is needed. Electron stays the fallback if
  we hit a WebView2 limitation.
- The tray process keeps the WebSocket open while the window is hidden, which makes
  native Windows toast notifications cheap (no Web Push needed).
- Build on the Windows laptop (or a GitHub Actions Windows runner); Tauri's
  macOS→Windows cross-compile is not reliable.
- The server also serves the same React build at its HTTPS URL for debugging.

## Reading chat.db

Joins: `chat` → `chat_message_join` → `message` → `handle`;
`message_attachment_join` → `attachment`.

**Big integers:** `node:sqlite` throws `ERR_OUT_OF_RANGE` on any integer above 2^53,
and every Apple nanosecond date (`date`, `date_read`, `date_delivered`, `date_edited`,
`date_retracted`, …) is ~8e17. Convert in SQL (`date / 1000000 + 978307200000 AS …Ms`)
in every query, or use `stmt.setReadBigInts(true)` where raw values are needed.

Timeline filters: `associated_message_type = 0` (drop tapbacks), `item_type = 0`
(drop system rows; groups may later render them as "X renamed the group").
Order by `date`; use `ROWID` only for change detection (iCloud backfills out of order).

**attributedBody:** `spike/decode.ts` — a small typedstream reader that pulls the first
`+`-typed value after the `NSString`/`NSMutableString` class. Verified against Apple's
`NSUnarchiver` (`spike/reference.m`) on every blob: **100% identical**, ~0.3 s
for the whole corpus. Keep the reference as a regression test.

**Contacts:** read `~/Library/Application Support/AddressBook/Sources/*/AddressBook-v22.abcddb`
(covered by FDA), normalize phone numbers to E.164 with `libphonenumber-js`, map
handle → name. Refresh on a timer or when the file changes.

## Watching for changes

1. `fs.watch` (FSEvents) on `~/Library/Messages/` for `chat.db` / `chat.db-wal`,
   debounced ~75 ms.
2. Backstop: `PRAGMA data_version` once a second (cheap; changes only when another
   process commits).

M0 finding: in the first watcher run the incoming message was detected by the
`data_version` poll, not FSEvents, so FSEvents may not fire for this TCC-protected
folder. The poll is therefore required, not just a backstop; M2 confirms whether
FSEvents adds anything (e.g. watching the folder from the FDA-granted binary).
3. On trigger:
   - `ROWID > lastRowId` → `message.new`
   - hot-window re-scan (last ~500 rows / 24 h) of mutable fields (delivered, read,
     edited, retracted, error) against an in-memory fingerprint → `message.updated`

## API

```
POST /api/auth/pair                     {password, deviceName} → {deviceToken}
DELETE /api/auth/devices/:id            revoke a device
GET  /api/conversations?cursor=&limit=
GET  /api/conversations/:id
GET  /api/conversations/:id/messages?before=<date,rowid>&limit=50
POST /api/conversations/:id/messages    {text, clientId}          → 202
POST /api/conversations/:id/attachments multipart(file, clientId) → 202
GET  /api/attachments/:id/{thumb|preview|original}?exp=&sig=     (Range-capable)
GET  /api/health    → FDA ok, Automation ok, Messages running, last DB change
```

Cursor pagination. Sends return 202 at once; `clientId` makes optimistic UI and
retries idempotent.

**WebSocket `/ws`** (push only; state changes go through REST):
- client → server: `auth {token}` as the first frame (WebSockets can't carry an
  Authorization header from a webview), `resume {sinceRowId}` on reconnect.
- server → client: `hello {lastRowId}`, `message.new`, `message.updated`,
  `conversation.updated`, `send.status {clientId, state: queued|sent|failed|unconfirmed, messageId?}`,
  `server.status`, `resync` (gap too large to replay).

**Send reconciliation:** AppleScript returns no GUID. The send queue keeps pending
`{chatId, text | filename, clientId}`; the watcher's next `is_from_me = 1` row in that
chat with matching content (within 30 s) resolves it to `sent` with the real id;
non-zero `error` → `failed`; timeout → `unconfirmed`.

**Sending:** `osascript` with chat id / text / path as argv (never interpolated),
one send at a time, launch Messages.app if needed. Attachments are staged in a
folder Messages can read (M0 decides which) and deleted only after delivery is
confirmed.

## Media

- Images: HEIC/TIFF → JPEG with `sips` (2048 px preview, 400 px thumb); PNG/JPEG/GIF as-is.
- Video: ffmpeg poster frame; transcode once to H.264 MP4 with `h264_videotoolbox`
  (avoids HEVC playback gaps on Windows); Range requests.
- Audio: `.caf` voice messages → m4a.
- Cache keyed by attachment GUID with a size cap (LRU).
- Paths come from the DB by id only and must realpath under
  `~/Library/Messages/Attachments`. Missing files → "not on this Mac" placeholder.

## Security

- Server binds to 127.0.0.1; exposed only through `tailscale serve` (tailnet only,
  never Funnel). Tailscale ACL restricts it to your devices.
- Require the `Tailscale-User-Login` header that `tailscale serve` adds to equal your
  tailnet login.
- Device pairing: password (scrypt hash in config) once → long-lived, revocable device
  token, stored by the Tauri app in Windows Credential Manager. Sent as
  `Authorization: Bearer` on REST and as the first WS frame. Login is rate-limited.
- Media uses short-lived HMAC-signed URLs, because `<img>`/`<video>` can't send headers.
- CORS allows only the Tauri origin (and the dev origin).
- chat.db read-only; uploads get random names and size caps; send rate limit; message
  content never logged.

## Ops

- Run as a **LaunchAgent** (needs your GUI session for Messages.app and AppleScript;
  a LaunchDaemon won't work).
- Hold a sleep assertion (`caffeinate -i -w <pid>` style) so the Mac doesn't idle-sleep
  while the bridge runs. Closing the lid without an external display still
  sleeps the Mac.
- **Auto-login** (System Settings → Users & Groups → Automatically log in as): after a
  reboot (macOS update, crash) the Mac goes straight to your session, so Messages.app
  and the LaunchAgent start without anyone typing a password at the Mac. Without it the
  bridge is down until you log in physically. Trade-off: someone with physical access
  lands in your account, especially with FileVault off.
  Pair it with a short display-sleep + "require password immediately" so the session
  locks itself; the bridge keeps working while the screen is locked.
- `/api/health` surfaces lost permissions after macOS updates.

## Milestones

| # | Milestone | Done when |
|---|---|---|
| M0 | Spike (go/no-go) | (a) decoder ≥99.9% on corpus ✅ 100%; (b) text send via osascript to an `any;-;` iMessage chat and an SMS chat; (c) image send to both, staging folder found; (d) watcher fires on incoming and iPhone-sent messages, latency measured |
| M1 | Read-only viewer | Pair → conversation list with contact names → paged history (text, groups included), at the ts.net HTTPS URL. Server + client built 2026-10-26; runs from the Claude Code session until M6 gives it its own FDA grant |
| M2 | Real-time | Watcher + WS + resume; delivered/read/edited/unsent update live; iPhone-sent messages appear without refresh |
| M3 | Send text | Optimistic send, reconciliation, failure/retry, SMS + iMessage |
| M4 | Receive attachments | Inline images/thumbs, video, file download, missing-file placeholder |
| M5 | Send attachments | Upload → stage → send → reconcile → cleanup after delivery |
| M6 | Tray app + service | Tauri tray app (pairing, autostart, toasts), server as LaunchAgent single binary, health page |
| Later | | Tapbacks, inline-reply display, new conversations |

## Risks

1. AppleScript on macOS 26: `any;-;` targeting, attachment send, and MMS via SMS relay
   are unproven until M0 (b)/(c). Apple can break them in
   any update. BlueBubbles' Private API needs SIP disabled — out of scope.
2. Not possible without private APIs: mark-as-read, typing indicators, sending tapbacks.
3. Uptime after reboots (see auto-login) and TCC grants reset by macOS updates.
4. iPhone-sent messages appear only after iCloud syncs them (usually seconds).
