# To do

Planned but not started. Newest at the bottom of each section.

## Installers

The editor already builds installers with electron-builder (`npm run editor:dist`, see the README's *Installers*). Releases will be GitHub releases, as the Shards desktop app does.

- [ ] **Code signing.**
  - *Windows:* sign the NSIS installer and the app with a code-signing certificate, so SmartScreen stops warning. electron-builder signs with `signtool` already, once given a certificate (`win.signtoolOptions` or the `CSC_LINK` / `CSC_KEY_PASSWORD` environment variables).
  - *macOS:* sign with a Developer ID and notarize, or Gatekeeper blocks the app (`mac.notarize`, `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`).
  - Keep certificates out of the repo: CI secrets only.
- [ ] **Auto-updates through GitHub releases.** Follow meridian-browser's `apps/desktop`:
  - A GitHub repo for meridian-editor, and a `publish` block in `apps/editor/electron-builder.yml` (provider `github`, draft releases).
  - `electron-updater` in the main process: check on start, download in the background, offer to restart. It needs signed builds on macOS, and the `latest*.yml` and `.blockmap` files from each release.
  - A release script (bump the version, tag, push) and a workflow that builds Windows, macOS and Linux on a `v*` tag and uploads them to the draft release, like Shards' *Desktop builds* workflow.
  - A download link or page, once there's something to download.
- [ ] **macOS and Linux installers.** These come with the release workflow: each must be built on its own OS (DMG and zip; AppImage and deb).

## Shards

- [ ] **The room build step in meridian-browser** (ADR 0001 decision 6): room sources committed there, and `tools/assets/build-assets.ts` running `roomc` to make the `.roo` files.

## Agent tools (MCP)

`packages/agent` is done through the plan (ADR 0002). Follow-ups:

- [ ] **The editor reads new rooms' Kod.** The agent's tools read `rooms/new/<room>.kod` ahead of the server's copy; the editor's map and Kod tab only see it once `shards:install` has copied it into the server's tree.
- [ ] **`render_3d` without the editor**, through the web build in Playwright (as `tools/screenshots` does), for agents working on files.
- [ ] **Undo labels in the editor's history.** The status bar names each agent step, but the undo stack doesn't keep labels.
