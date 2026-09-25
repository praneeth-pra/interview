# booking-form - notes for Claude Code

Read README.md first for layout, commands and deploy.

## Rules that are easy to break

- **Real candidate data** lives on the Railway volume (`/data/*.json`). Never delete or overwrite it, never copy it into the repo.
- **No inline scripts or styles.** The CSP is `script-src 'self'; style-src 'self'`. Put code in `src/pages/*.js|css`, set styles through classes or `el.style.x = ...`, and pass per-request data through the `<script type="application/json" id="boot">` block. `bun test` fails if a page shell breaks this.
- Page shells use `__HOST__`, `__EVENT__`, `__BOOT__`, `__PRELOAD__` placeholders, filled once at startup (per request only for `/b/<id>`).
- Reference assets as `/assets/<file>` in HTML and CSS; `src/assets.ts` rewrites them to fingerprinted URLs. New files in `src/pages` or `src/fonts` are picked up automatically.
- The booking page (`src/pages/book/`) is typed TypeScript modules; `bun run typecheck` must pass. Admin and analytics are still single files.
- Page scripts are readable sources; `src/assets.ts` bundles and minifies them at startup (`src/pages/<page>.js`, or `src/pages/<page>/main.ts` plus modules). Some names are still single letters from the old minified code: rename with a scope-aware tool, never find-and-replace.
- Names, companies and reasons are typed by candidates: build DOM with `textContent`, not `innerHTML` with user text.
- **CSS class names are global per page and short** (`.dl`, `.ev`, `.t`, `.go`...). Before adding a class, grep the page's CSS for it; `.dl` already meant the booking panel's details list.
- Backups (`runBackup` in `src/server.ts`) email candidate data. Keep `push.json` out of anything that leaves the volume.

## Before pushing

1. `bun test tests/`
2. `NODE_PATH=$(npm root -g) node tests/browser-smoke.cjs`
3. Refactors must not change any pixel: `NODE_PATH=$(npm root -g) node tests/visual.cjs` compares every screen with `origin/main` (about 2 minutes). CI runs it on every PR unless the PR has the `ui-change` label.
4. For intentional visual changes, look at the page in a real browser at desktop and 390 px phone width, light and dark.

A push to the branch Railway follows deploys to production (see README). Check the deploy logs afterwards.
