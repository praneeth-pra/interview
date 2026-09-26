# booking-form (hi-techie.dev)

Interview booking site for Hi-Techie: `/` links to booking and the enquiry page; candidates pick a time at `/booking`, manage it from the link in their email (`/b/<id>?t=<token>`), and the team runs the calendar, allow-list and analytics at `/admin`. People can also send an enquiry with their resume at `/enquiry`; the responses are in the admin page's Enquiries tab, which shows a red count of new ones.

Runs on Railway: project `calendly-live-view`, service `booking-form`, production environment. Domains `hi-techie.dev`, `www.hi-techie.dev`.

## Layout

```
src/server.ts        starts the server: loads the data, logs the settings, listens, runs backups
src/server/          the server, one module per feature:
                     routes/ (public.ts, auth.ts, admin.ts: every URL), config.ts (environment variables),
                     data.ts (what is stored, one JSON file each) and store.ts (reading and writing them),
                     bookings.ts, schedule.ts (free times), companies.ts, enquiries.ts, auth.ts (sign-in codes and
                     sessions), email.ts (Resend and calendar invites), push.ts (browser alerts), live.ts (live admin
                     updates), backup.ts, pages.ts (page shells), http.ts (headers, limits), sw.js (service worker)
src/assets.ts        fingerprints, compresses and serves everything below at startup (no build step)
src/pages/*.html     page shells (book, admin, analytics, login)
src/pages/*.css|js   page styles and scripts (readable; scripts are bundled and minified at startup), served as /assets/<name>.<hash>.<ext>
src/pages/book/      the booking page as TypeScript modules: main.ts (steps and rendering), time.ts, companies.ts, dom.ts, icons.ts
src/pages/admin/     the admin page: main.ts (calendar, panel, forms, search, allowlist, live updates), alerts.ts, nav.ts,
                     stats-frame.ts, download-menu.ts, and helpers time.ts, dom.ts, api.ts, labels.ts, types.ts
src/pages/analytics/ the Analytics tab (framed in admin): main.ts (people picker, company progress, timeline, insights),
                     api.ts (answers the page's old dashboard API in the browser from /admin/api/*), companies.ts, rounds.ts
src/fonts/           Figtree and Instrument Serif (open source, SIL OFL), self-hosted
data/companies.json  company suggestions for the booking form ("Name|Alias|Alias")
public/icon.png      app icon (admin home-screen app and browser alerts)
tests/               bun tests for the server, a Chromium smoke test, and visual.cjs (screen-by-screen comparison with main)
scripts/restore.ts   puts a backup back into a data folder
```

Bookings and settings live as JSON files on the Railway volume mounted at `/data` (`DATA_DIR`), not in this repo.

## Run and test

```bash
ADMIN_OPEN=1 PORT=3000 DATA_DIR=/tmp/bf bun run src/server.ts   # ADMIN_OPEN=1: no sign-in, for local testing only
bun install && bun run typecheck                         # strict server check and the page modules (dev tools only)
bun test tests/                                          # server tests, ~0.5 s
NODE_PATH=$(npm root -g) node tests/browser-smoke.cjs    # needs the playwright package
NODE_PATH=$(npm root -g) node tests/visual.cjs           # every screen vs origin/main; must match for refactors
```

## How pages are served

- Page shells revalidate on every visit (`Cache-Control: private, no-cache` plus an ETag, so a repeat visit is a ~0.5 KB 304).
- CSS, JS and fonts are served from `/assets/<name>.<hash>.<ext>` with a one-year `immutable` cache. The hash changes whenever the file changes, so a deploy is picked up on the next page load.
- Everything is brotli/gzip-compressed once at startup; large JSON/CSV API answers are compressed per request.
- The Content-Security-Policy is `script-src 'self'; style-src 'self'` with no nonces, so pages must not contain inline `<script>`/`<style>` or `style="..."` attributes (a test enforces this). Per-request values go in `<script type="application/json" id="boot">`.
- Search engines may list only the landing page (`/`): every other response carries `X-Robots-Tag: noindex`. `/robots.txt` keeps crawlers out of `/admin`, `/api/` and manage links, and `/sitemap.xml` lists the landing page. The landing page's canonical address is the one without `www.`.
- Analytics loads in the admin page as a same-origin frame from `/admin/analytics`, only when that tab is opened.
- `/enquiry` is a plain page (`src/pages/enquiry.html|css|js`) that posts a multipart form to `/api/enquiry`. The details go to `enquiries.json`; the resume (PDF or Word, checked by its first bytes, 200 KB at most, not mentioned on the form) is saved as `DATA_DIR/resumes/<id>.<ext>`.

## Security

- Admin pages and APIs need a signed-in admin. Sign-in never switches itself off: if `ADMIN_EMAILS` goes missing, the admin page locks instead of opening.
- Every response carries `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, HSTS, `Cross-Origin-Opener-Policy: same-origin` and a `Permissions-Policy` that turns off camera, microphone and location.
- Limits count visitors by `X-Real-IP`, which Railway's edge sets to the real address (`X-Forwarded-For` can be written by the visitor, so it isn't used).
- The server reads at most 2 MB per request. Enquiries: five an hour per network and 100 in any 24 hours in total.
- `/api/companies` shares the built-in company list and names that at least two candidates typed; a name only one person typed stays private.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `ADMIN_EMAILS` | Admin sign-in: the owners' emails (comma separated). Anyone on the admin list signs in with a 6-digit code emailed to them; owners can add more admins in the ⋯ menu (Admins). Unset = the admin page stays locked (only admins added earlier can sign in). With email off (no `RESEND_API_KEY`), codes are printed in the server log. |
| `ADMIN_OPEN` | `1` turns admin sign-in off while `ADMIN_EMAILS` is empty. For local testing only; never set it on Railway. |
| `DATA_DIR` | Folder for the JSON stores (`/data` on Railway) |
| `RESEND_API_KEY`, `EMAIL_FROM`, `HOST_EMAIL` | Confirmation emails and host copies |
| `HOST_NAME`, `EVENT_NAME`, `EVENT_LOCATION`, `EVENT_DESCRIPTION`, `MEETING_LINK` | Text shown on pages, emails and invites |
| `DAY_START_HOUR`, `DAY_END_HOUR`, `BOOKING_DAYS` | Booking window (default 9-21 IST, 7 days) |
| `PUBLIC_URL` | Base URL for links in emails (defaults to the request host) |
| `REMOVE_BOOKINGS` | One-time cleanup on start: `Name@YYYY-MM-DD`, comma separated |
| `BACKUP_EMAIL` | Where the daily backup email goes (comma separated; falls back to `HOST_EMAIL`) |
| `BACKUP_HOUR` | Hour (IST) after which the daily backup runs, default `2` |

## Backups

Every day after `BACKUP_HOUR` (IST) the server:

1. writes a full snapshot to `/data/backups/YYYY-MM-DD.json` (the last 14 days are kept), and
2. emails `BACKUP_EMAIL` a `bookings-YYYY-MM-DD.csv` (opens in Excel or Sheets) and a `backup-YYYY-MM-DD.json` with all the data except `push.json` (browser-alert keys; after a restore, turn alerts on again on each device) and `sessions.json` (who is signed in; a restore signs everyone out).

`/data/backup-state.json` remembers the last day done, so restarts don't send duplicates; a failed email is retried every 15 minutes that day. The admin's ⋯ menu has the bookings CSV; the full backup is still at `/admin/backup.json` for a signed-in admin.

To restore, copy a backup JSON into the running service and run the restore script, then restart the service:

```bash
railway ssh --service booking-form          # or upload the file with: railway service files upload
bun run scripts/restore.ts /tmp/backup.json /data
```

The script keeps each replaced file as `<name>.pre-restore`.

## Deploying

GitHub Actions (`.github/workflows/booking-form.yml`) runs the tests on every pull request and on `main`, and on pull requests also compares every screen with the base branch. Label a PR `ui-change` when it changes the design on purpose; the failed run's screenshots are attached as an artifact.

Railway builds `Dockerfile` in this folder. The service settings live in Railway (root directory `/calendly-live-view`, start command `bun run src/server.ts`, health check `/healthz`, watch pattern `/calendly-live-view/**`). After a deploy, the log should end with `booking-form listening on 8080`.
