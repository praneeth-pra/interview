# booking-form - notes for Claude Code

Read README.md first for layout, commands and deploy.

## Rules that are easy to break

- **Real candidate data** lives on the Railway volume (`/data/*.json`). Never delete or overwrite it, never copy it into the repo.
- **No inline scripts or styles.** The CSP is `script-src 'self'; style-src 'self'`. Put code in `src/pages/*.js|css`, set styles through classes or `el.style.x = ...`, and pass per-request data through the `<script type="application/json" id="boot">` block. `bun test` fails if a page shell breaks this.
- Page shells use `__HOST__`, `__EVENT__`, `__BOOT__`, `__PRELOAD__` placeholders, filled once at startup (per request only for `/b/<id>`).
- Reference assets as `/assets/<file>` in HTML and CSS; `src/assets.ts` rewrites them to fingerprinted URLs. New files in `src/pages` or `src/fonts` are picked up automatically.
- The booking, admin and analytics pages (`src/pages/book/`, `admin/`, `analytics/`) are typed TypeScript modules; `bun run typecheck` must pass. Sign-in is `src/pages/login.js`.
- Page scripts are readable sources; `src/assets.ts` bundles and minifies them at startup (`src/pages/<page>.js`, or `src/pages/<page>/main.ts` plus modules). Rename with a scope-aware tool (the editor's rename), never find-and-replace: the pages reuse short names like `row`, `box`, `event` in many scopes.
- Names, companies and reasons are typed by candidates: build DOM with `textContent`, not `innerHTML` with user text.
- Fonts: every page (booking, admin, Contacts, sign-in) uses self-hosted Figtree, close to the Calendly app's font. Keep text at 11.5px or larger and grey text at 4.5:1 contrast.
- The admin page's styles are `src/pages/admin/css/*.css`, joined in file-name order into one `admin.css`: order is the cascade, so add rules to the file for their feature and keep the numbering.
- **CSS class names are global per page and short** (`.ev`, `.t`, `.go`...). Before adding a class, grep the page's CSS for it, and grep the page's scripts before deleting one: some are built at runtime (`"c" + n`, `"st-" + status`, `"sk-w" + n`).
- The server is split by feature under `src/server/` (see README); `src/server.ts` only starts it. `bun run typecheck` checks the server in strict mode, so run `bun install` once for the dev tools.
- Admin sign-in fails closed: without `ADMIN_EMAILS` the admin page is locked. Local servers and test harnesses set `ADMIN_OPEN=1` to open it; never set that on Railway.
- Per-network limits use `clientIp()` (Railway's `X-Real-IP`); tests that need a different network send `x-real-ip`.
- Backups (`runBackup` in `src/server/backup.ts`) email candidate data (resumes in `DATA_DIR/resumes` stay on the volume). Keep `push.json` and `sessions.json` (admin sign-in sessions) out of anything that leaves the volume.
- Admin sign-in (`ADMIN_EMAILS`, `admins.json`): codes are emailed (printed in the log only when email is off). Never log or return a session token, and give the same answers whether or not an email is an admin.

## Before pushing

1. `bun test tests/`
2. `NODE_PATH=$(npm root -g) node tests/browser-smoke.cjs`
3. Refactors must not change any pixel: `NODE_PATH=$(npm root -g) node tests/visual.cjs` compares every screen with `origin/main` (about 2 minutes). CI runs it on every PR unless the PR has the `ui-change` label.
4. For intentional visual changes, look at the page in a real browser at desktop and 390 px phone width, light and dark.

A push to the branch Railway follows deploys to production (see README). Check the deploy logs afterwards.
