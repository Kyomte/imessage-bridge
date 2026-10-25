# imessage-bridge

Self-hosted bridge to read and send iMessage/SMS from Windows, using an always-on
Mac signed into Messages. See [docs/PLAN.md](docs/PLAN.md) for architecture,
decisions and milestones.

## Status

M0 spike in progress (`spike/`).

## Spike scripts

All scripts read `~/Library/Messages/chat.db` read-only and need Full Disk Access for
the process that runs them. None of them print message text.

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
