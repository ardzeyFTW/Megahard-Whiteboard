---
name: release-desktop-app
description: >-
  Use this skill whenever pushing app changes to git or releasing a new desktop
  application version of Megahard Whiteboard so both GitHub Pages and the
  Electron Windows installer (.exe) + auto-updater release are published.
---

# Release Desktop App

Publishes the current `main` branch as a versioned GitHub Release (`vX.Y.Z`), triggering `.github/workflows/release.yml` to build the Windows `.exe` installer and `latest.yml` for `electron-updater`.

## Steps

1. **Ensure code changes are verified and committed on `main`**:
   - Run `npm.cmd run build` (if not already run after the final edit) to verify `tsc --noEmit` and `vite build` pass.
   - Check `git status` and commit only task-related files on `main`. Leave unrelated untracked files untouched.
2. **Cut and push the release**:
   - Run the release script (defaults to `patch`; pass `minor` or `major` if requested):
     ```powershell
     node scripts/release.cjs patch --push
     ```
   - `scripts/release.cjs` automatically runs `npm.cmd run test` and `npm.cmd run typecheck`, updates `package.json` and `src/version.ts` (`APP_VERSION`), creates commit `Release vX.Y.Z` and tag `vX.Y.Z`, and pushes both `main` and `vX.Y.Z` to `origin`.
3. **Verify**:
   - Confirm `git log -n 2 --oneline` shows the `Release vX.Y.Z` commit at `HEAD` and `git tag --points-at HEAD` shows `vX.Y.Z`.
   - Report the new version tag (`vX.Y.Z`) and note that GitHub Actions (`release.yml`) is building the `.exe` and `latest.yml` release assets while `pages.yml` deploys the web app.
