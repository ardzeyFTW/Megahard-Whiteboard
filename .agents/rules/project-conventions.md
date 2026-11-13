---
trigger: always_on
---

# Megahard Whiteboard Conventions

- **Shell commands on Windows**: Use `npm.cmd` and `npx.cmd` instead of bare `npm`/`npx` in PowerShell so script execution policy does not block commands.
- **Verify before committing**: Run `npm.cmd test` and `npm.cmd run build` (which runs `tsc --noEmit && vite build`) after edits to `src/`.
- **UI & styling**: Build DOM elements with `h()` from `src/ui/dom.ts` and drive dynamic CSS states (colors, opacity, sizes, positions) through CSS custom properties in `src/styles.css` rather than inline layout logic. Respect both light and dark themes (`--panel`, `--hover`, `--accent`, `--muted`, `--panel-border`).
- **Versioning**: Keep `package.json` (`version`) and `src/version.ts` (`APP_VERSION`) in sync by cutting releases through `scripts/release.cjs` instead of editing versions by hand.
