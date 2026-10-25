# M5: Send photos and files from Windows

Status: open (deferred 2026-10-26, after M4)

## Goal

Pick or paste a photo/file in a Windows thread and send it through Messages, with the
same Sending… → confirmed flow as text (M3).

## Plan

- **Upload:** `POST /api/conversations/:id/attachments` (multipart: `file`, `clientId`),
  size cap (iMessage ~100 MB; SMS/MMS is far smaller and carrier-dependent, so warn or
  downscale images for SMS chats). `@fastify/multipart`, streamed to disk.
- **Staging:** Messages.app is sandboxed and only sends files it can read. Find a folder
  that works on macOS 26 (candidates: `~/Pictures/imessage-bridge/`, a subfolder of
  `~/Library/Messages/Attachments/`). Probe read-only first, then one real send to
  yourself. Random file names; keep the original name for display if Messages uses it.
- **Send:** extend `SEND_TEXT_SCRIPT` with a file variant:
  `send (POSIX file (item 2 of argv)) to chat id …`, with the same participant fallback
  for chats AppleScript hasn't loaded.
- **Reconcile:** match the new `is_from_me` row by chat + attachment (`transfer_name` or
  byte size) instead of text. Delete the staged file only after delivery is confirmed:
  Messages copies lazily and deleting early fails the send.
- **Client:** attach button + drag-and-drop + paste in the composer; pending bubble with
  a local preview (`URL.createObjectURL`), progress during upload, Retry/Remove on failure.

## Unknowns / risks

- Attachment sends via AppleScript are known to fail silently on some macOS versions
  unless the file is in an allowed folder; M0 (c) never ran.
- MMS through SMS relay may need the iPhone nearby/awake.
- HEIC from Windows is rare; JPEG/PNG/MP4/PDF are the realistic inputs.

## Done when

A photo and a PDF sent from Windows arrive in an iMessage chat and an SMS chat, show as
sent, and the staging folder is cleaned up afterwards.
