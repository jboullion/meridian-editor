# To do

Planned but not started. Newest at the bottom of each section.

## Installers

Releases are GitHub releases, built by `.github/workflows/release.yml` (`npm run release -- <x.y.z>`, see the README's *Releases and updates*).

- [ ] **Code signing.**
  - *Windows:* sign the NSIS installer and the app with a code-signing certificate, so SmartScreen stops warning. electron-builder signs with `signtool` already, once given a certificate (`win.signtoolOptions` or the `CSC_LINK` / `CSC_KEY_PASSWORD` environment variables).
  - *macOS:* sign with a Developer ID and notarize, or Gatekeeper blocks the app (`mac.notarize`, `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`). This also lets macOS update itself: `src/main/updates.ts` only links to the release there now.
  - Keep certificates out of the repo: CI secrets only.
- [x] ~~**Auto-updates through GitHub releases**~~: `src/main/updates.ts` (electron-updater), from v0.1.0.
- [x] ~~**A release script and workflow**~~: `tools/release/release.ts` and `.github/workflows/release.yml`.
- [x] ~~**macOS and Linux installers**~~: built by the release workflow.
- [ ] **A download page**, on the Meridian Shards website, linking the latest release.

## Shards

- [x] ~~**The room build step in meridian-browser**~~: room sources are committed in shards-server beside their `.roo` files instead (docs/0001-room-editor.md decision 6, 2026-10-15).

## Agent tools (MCP)

`packages/agent` is done through the plan (ADR 0002). Follow-ups:

- [ ] **The editor reads new rooms' Kod.** The agent's tools read `rooms/new/<room>.kod` ahead of the server's copy; the editor's map and Kod tab only see it once `shards:install` has copied it into the server's tree.
- [ ] **`render_3d` without the editor**, through the web build in Playwright (as `tools/screenshots` does), for agents working on files.
- [ ] **Undo labels in the editor's history.** The status bar names each agent step, but the undo stack doesn't keep labels.
