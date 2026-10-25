# Messages Bridge for Windows (tray app)

A small Tauri v2 app around the bridge web UI:

- opens the UI from your Mac (`shell/config.js`), after a "Connecting to your Mac…" page
  that waits until the Mac answers
- closing the window hides it to the tray; it stays connected and shows Windows
  notifications for new messages (except the conversation you're looking at)
- starts minimized at login (turn off in Task Manager → Startup apps); one copy only
- tray menu: Open Messages · Reconnect to Mac · Quit

The UI itself is served by the Mac, so updating the Mac updates the app; rebuild this
only when `desktop/` changes.

## Server URL

`shell/config.js` and `src-tauri/capabilities/remote.json` both name the Mac:
`http://your-mac.your-tailnet.ts.net`. Change both if that changes. The capability
lets only that URL use notifications; it gets no other native access.

## Build on Windows

One-time setup:

1. Install [Node.js](https://nodejs.org) (LTS) and [Rust](https://rustup.rs) (`rustup-init.exe`, default options).
2. Install **Visual Studio Build Tools** with the "Desktop development with C++" workload
   (Rust's MSVC toolchain needs its linker). WebView2 is already part of Windows 11.

Then, in this folder:

```powershell
npm install
npm run build
```

The installer is `src-tauri\target\release\bundle\nsis\Messages Bridge_0.1.0_x64-setup.exe`.
It installs for the current user (no admin prompt). Pair once with the password from the
Mac, like the browser.

## Build in the cloud instead

`.github/workflows/desktop-windows.yml` builds the same installer on a GitHub Windows
runner and uploads it as an artifact, once the repo is on GitHub.

## Develop

`npm run dev` runs it against the real Mac. On macOS it also runs (tray in the menu bar),
which is how the Rust side was checked.
