# M5: Send photos and files from Windows

Status: done 2026-11-14 for iMessage. SMS/MMS sends are built the same way but not yet
tried against a real recipient.

## Goal

Pick or paste a photo/file in a Windows thread and send it through Messages, with the
same Sending… → confirmed flow as text (M3).

## What was built

- **Upload:** `POST /api/conversations/:id/attachments`, multipart with a `clientId` field
  before one `file`. Capped at 100 MB (`MAX_ATTACHMENT_BYTES`); a larger file gets 413 and
  nothing is kept. Streamed to disk with `@fastify/multipart`. A repeated `clientId`
  returns the existing status without staging or sending again.
- **Staging:** `~/Library/Messages/Attachments/imessage-bridge/<random>/<original name>`
  (`stagingDir` in config.json). The random folder keeps names unique, so the file keeps
  the name the recipient sees.
- **Send:** `SEND_FILE_SCRIPT` runs `send (POSIX file (item 2 of argv)) …` with the same
  argv and participant fallback as text.
- **Reconcile:** a fromMe row in the same chat with an attachment whose `transfer_name`
  equals the staged name. Matched on `message.new` and `message.updated`, since the
  attachment can be linked after the row. File sends wait up to 120 s before
  'unconfirmed' (text: 30 s).
- **Cleanup:** a failed osascript run deletes its folder at once. Every hour, folders
  older than a day that no `attachment.filename` points at are deleted. Sent files are
  never deleted (see findings).
- **Client:** paperclip button, paste, and drag-and-drop onto the thread put files in
  the composer as removable chips; Send sends each file as its own message, then the
  text. The pending row shows an image preview or a file chip, upload progress, and
  Retry/Remove on failure. Drag-and-drop in the Windows tray app needs
  `dragDropEnabled: false` (desktop/src-tauri/tauri.conf.json), so a tray app rebuild.

## Findings (macOS 26.7, osascript over SSH)

- Messages only sends files from inside `~/Library/Messages/Attachments/`. From
  `~/Pictures/…` or `$TMPDIR` the send "succeeds" but Messages writes a fromMe row with
  no attachment: an empty message.
- Messages doesn't copy the file: the new `attachment.filename` is the staged path. So a
  staged file must stay after sending, or the attachment breaks on the Mac.
- `transfer_name` is the staged file's name. `total_bytes` differs from the file's size,
  so it isn't used for matching.
- The attachment row was linked together with the message row in these tests.

## Still open

- A real SMS/MMS send. MMS through SMS relay may need the iPhone nearby and awake, and
  carriers cap MMS far below 100 MB; if large photos fail there, downscale images for
  SMS chats (`sips -Z`, as in media.ts).
- HEIC from Windows is rare; JPEG/PNG/MP4/PDF are the realistic inputs.
