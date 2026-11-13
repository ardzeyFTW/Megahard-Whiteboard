---
trigger: always_on
---

# Release and Git Workflow

1. **Always include the desktop app release when pushing app changes**:
   - Pushing to `main` only deploys the web app via `.github/workflows/pages.yml`.
   - The Electron desktop app only gets an update when a `v*` tag is pushed to trigger `.github/workflows/release.yml` (which builds the Windows installer `.exe` and `latest.yml`).
   - Therefore, whenever the user asks to push app/UI/code changes to git, activate the `release-desktop-app` skill after committing the changes to `main` (unless the user explicitly asks not to bump the version, or the changes only touch non-app files like `docs/`, `README.md`, or `.agents/`).
2. **Stage intentionally**:
   - Stage only files relevant to the current task. Do not run `git add -A` or blindly commit unrelated untracked files.
