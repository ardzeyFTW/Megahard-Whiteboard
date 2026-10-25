# Releasing Megahard Whiteboard

This guide outlines the exact, repeatable steps to publish new releases of Megahard Whiteboard. 

Releases update:
1. **The Web & PWA Version** (deployed via GitHub Pages)
2. **The Windows Desktop `.exe` Installer** (built via GitHub Actions and published to GitHub Releases)
3. **The In-App Auto-Updater** (notifies running apps and downloads differential `.blockmap` updates)

---

## The 1-Command Automated Way (Recommended)

A helper script is provided to automate version bumping, testing, tagging, and pushing:

### 1. Release a patch (e.g. 0.1.2 -> 0.1.3)
```bash
npm run release patch --push
```

### 2. Release a minor feature update (e.g. 0.1.2 -> 0.2.0)
```bash
npm run release minor --push
```

### 3. Release a specific version
```bash
npm run release 0.3.0 --push
```

*(Tip: Omit `--push` if you want to inspect the commit and tag locally before pushing).*

---

## The Manual Step-by-Step Way

If you prefer to run each step manually:

### Step 1: Verify Tests and Types
Make sure all tests and TypeScript checks pass before releasing:
```bash
npm run test
npm run typecheck
```

### Step 2: Bump the Version Number
Update the version string in two files:
1. **`package.json`**:
   ```json
   "version": "0.1.3",
   ```
2. **`src/version.ts`**:
   ```typescript
   export const APP_VERSION = '0.1.3';
   ```

### Step 3: Commit and Tag
```bash
git add package.json src/version.ts
git commit -m "Release v0.1.3"
git tag v0.1.3
```

### Step 4: Push to GitHub
Push both the code branch and the new release tag:
```bash
git push origin main
git push origin v0.1.3
```

---

## What Happens Automatically on GitHub

Once the tag is pushed to GitHub, two GitHub Actions workflows run in parallel:

1. **Deploy website (`pages.yml`)**:
   * Compiles the web app with Vite.
   * Updates the live website and web version on GitHub Pages (~30 seconds).

2. **Build and Release Desktop App (`release.yml`)**:
   * Runs on a Windows runner (`windows-latest`).
   * Bundles the Electron desktop app with the official icon (`build/icon.ico`).
   * Packages the Windows installer: `Megahard-Whiteboard-Setup-0.1.3.exe`.
   * Creates the differential update index: `latest.yml` and `.blockmap`.
   * Attaches all assets to the new [GitHub Release](https://github.com/ardzeyFTW/Megahard-Whiteboard/releases) (~2 minutes).

---

## Monitoring the Release

Check the build progress from your terminal using the GitHub CLI:
```bash
gh run list --limit 3
```

Or view the published release:
```bash
gh release view v0.1.3
```

---

## Permanent Download Links

Your website and documentation use permanent GitHub download links that always redirect to the newest version automatically:

* **Latest Release Page**:  
  `https://github.com/ardzeyFTW/Megahard-Whiteboard/releases/latest`
* **Direct Installer Download**:  
  `https://github.com/ardzeyFTW/Megahard-Whiteboard/releases/latest/download/Megahard-Whiteboard-Setup-0.1.3.exe`
