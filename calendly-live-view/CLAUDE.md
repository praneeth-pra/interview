# booking-form - notes for Claude Code

Read README.md first for layout, commands and deploy.

## Rules that are easy to break

- **Real candidate data** lives on the Railway volume (`/data/*.json`). Never delete or overwrite it, never copy it into the repo.
- **No inline scripts or styles.** The CSP is `script-src 'self'; style-src 'self'`. Put code in `src/pages/*.js|css`, set styles through classes or `el.style.x = ...`, and pass per-request data through the `<script type="application/json" id="boot">` block. `bun test` fails if a page shell breaks this.
- Page shells use `__HOST__`, `__EVENT__`, `__BOOT__`, `__PRELOAD__` placeholders, filled once at startup (per request only for `/b/<id>`).
- Reference assets as `/assets/<file>` in HTML and CSS; `src/assets.ts` rewrites them to fingerprinted URLs. New files in `src/pages` or `src/fonts` are picked up automatically.
- The page scripts are minified legacy code (single-letter names). Edit them surgically and re-run both test commands; there is no source map.
- Names, companies and reasons are typed by candidates: build DOM with `textContent`, not `innerHTML` with user text.

## Before pushing

1. `bun test tests/`
2. `NODE_PATH=$(npm root -g) node tests/browser-smoke.cjs`
3. For visual changes, look at the page in a real browser at desktop and 390 px phone width, light and dark.

A push to the branch Railway follows deploys to production (see README). Check the deploy logs afterwards.
