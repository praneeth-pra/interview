# booking-form (hi-techie.dev)

Interview booking site for Hi-Techie: candidates pick a time at `/`, manage it from the link in their email (`/b/<id>?t=<token>`), and the team runs the calendar, allow-list and analytics at `/admin`.

Runs on Railway: project `calendly-live-view`, service `booking-form`, production environment. Domains `hi-techie.dev`, `www.hi-techie.dev`.

## Layout

```
src/server.ts        HTTP server: booking rules, emails (Resend), web push, admin APIs, JSON stores
src/assets.ts        fingerprints, compresses and serves everything below at startup (no build step)
src/pages/*.html     page shells (book, admin, analytics, login)
src/pages/*.css|js   page styles and scripts, served as /assets/<name>.<hash>.<ext>
src/fonts/           Inter (same files Google Fonts serves), self-hosted
data/companies.json  company suggestions for the booking form ("Name|Alias|Alias")
public/icon.png      app icon (admin home-screen app and browser alerts)
tests/               bun tests for the server, plus a Chromium smoke test
```

Bookings and settings live as JSON files on the Railway volume mounted at `/data` (`DATA_DIR`), not in this repo.

## Run and test

```bash
PORT=3000 DATA_DIR=/tmp/bf bun run src/server.ts       # admin is open when ADMIN_LOGIN isn't on
bun test tests/                                          # server tests, ~0.5 s
NODE_PATH=$(npm root -g) node tests/browser-smoke.cjs    # needs the playwright package
```

## How pages are served

- Page shells revalidate on every visit (`Cache-Control: private, no-cache` plus an ETag, so a repeat visit is a ~0.5 KB 304).
- CSS, JS and fonts are served from `/assets/<name>.<hash>.<ext>` with a one-year `immutable` cache. The hash changes whenever the file changes, so a deploy is picked up on the next page load.
- Everything is brotli/gzip-compressed once at startup; large JSON/CSV API answers are compressed per request.
- The Content-Security-Policy is `script-src 'self'; style-src 'self'` with no nonces, so pages must not contain inline `<script>`/`<style>` or `style="..."` attributes (a test enforces this). Per-request values go in `<script type="application/json" id="boot">`.
- Analytics loads in the admin page as a same-origin frame from `/admin/analytics`, only when that tab is opened.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `ADMIN_PASSWORD`, `ADMIN_LOGIN=on` | Admin sign-in (both needed to turn it on) |
| `DATA_DIR` | Folder for the JSON stores (`/data` on Railway) |
| `RESEND_API_KEY`, `EMAIL_FROM`, `HOST_EMAIL` | Confirmation emails and host copies |
| `HOST_NAME`, `EVENT_NAME`, `EVENT_LOCATION`, `EVENT_DESCRIPTION`, `MEETING_LINK` | Text shown on pages, emails and invites |
| `DAY_START_HOUR`, `DAY_END_HOUR`, `BOOKING_DAYS` | Booking window (default 9-21 IST, 7 days) |
| `PUBLIC_URL` | Base URL for links in emails (defaults to the request host) |
| `REMOVE_BOOKINGS` | One-time cleanup on start: `Name@YYYY-MM-DD`, comma separated |

## Deploying

Railway builds `Dockerfile` in this folder. The service settings live in Railway (root directory `/calendly-live-view`, start command `bun run src/server.ts`, health check `/healthz`, watch pattern `/calendly-live-view/**`). After a deploy, the log should end with `booking-form listening on 8080`.
