# booking-form (hi-techie.dev)

Interview booking site for Hi-Techie: `/` links to booking and the enquiry page; candidates pick a time at `/booking`, manage it from the link in their email (`/b/<id>?t=<token>`), and the team runs the calendar, allow-list and analytics at `/admin`. People can also send an enquiry with their resume at `/enquiry`; the responses are in the admin page's Enquiries tab, which shows a red count of new ones. Candidates report a payment (Advance, First installment or Final installment; older payments may say 2nd or 3rd) with its receipt at `/payment` (not linked from the site, not indexed; open to any email, even when the Candidates list is on; confirming an email's first payment adds it to the Candidates list, later ones leave the list alone; one email can have at most three payments waiting for a decision); those are in the Payments tab, by candidate, with a search box for a name or email. Owners also get a Revenue tab (on phones and narrow windows, in the ⋯ menu): confirmed payments added up month by month (Cumulative, the default) or per month (Monthly), pending payments, and the payments as a CSV. Its search box suggests candidates as you type and narrows all of it (and the CSV) to the one picked, or to everyone whose name or email contains what's typed.

Runs on Railway: project `calendly-live-view`, service `booking-form`, production environment. Domains `hi-techie.dev`, `www.hi-techie.dev`.

## Layout

```
src/server.ts        starts the server: loads the data, logs the settings, listens, runs backups
src/server/          the server, one module per feature:
                     routes/ (public.ts, auth.ts, admin.ts: every URL, who may use it, and reading the request),
                     config.ts (environment variables), data.ts (what is stored, one JSON file each) and store.ts
                     (reading and writing them), bookings.ts, schedule.ts (free times), companies.ts, enquiries.ts,
                     payments.ts, allowlist.ts (the Candidates list), unavailable.ts (times candidates can't book), interviewers.ts (interview supporters),
                     analytics.ts (owners' Revenue tab data), auth.ts (sign-in codes, sessions and the admin list),
                     email.ts (Resend and calendar invites), push.ts (browser alerts), live.ts (live admin updates),
                     backup.ts, pages.ts (page shells), http.ts (headers, limits, file downloads), sw.js (service worker)
src/assets.ts        fingerprints, compresses and serves everything below at startup (no build step)
src/pages/*.html     page shells (book, admin, analytics, login)
src/pages/*.css|ts   page styles and scripts (readable; scripts are bundled and minified at startup), served as /assets/<name>.<hash>.<ext>
src/pages/shared/    DOM helpers (byId, el) used by the admin, booking and Contacts pages
src/pages/<page>/css/ the admin, booking and Contacts styles, joined in file-name order into <page>.css (later files override earlier ones)
src/pages/book/      the booking page as TypeScript modules: main.ts (which step to draw, and starting up), app.ts (boot data,
                     state and render()), slots.ts (free days and times), info.ts, calendar.ts, fields.ts, details.ts,
                     returning.ts (returning candidates), done.ts, manage.ts (manage links), message.ts, and helpers
                     time.ts, companies.ts, dom.ts, icons.ts, types.ts
src/pages/admin/     the admin page: main.ts (start-up, tabs, live updates, reload after a deploy); the calendar in
                     week.ts, agenda.ts and summary.ts; search.ts; state.ts (boot data, live state, the week on screen,
                     render()); panel.ts (the side panel) and booking-panel.ts (one booking: details, supporter, round
                     status, cancel, reschedule; lists of bookings); bookings.ts (every booking, for search); the ⋯ menu's
                     interviewers.ts, admins.ts, allowlist.ts (Candidates), unavailable.ts; the owners' enquiries.ts, payments.ts,
                     revenue.ts; alerts.ts, nav.ts, stats-frame.ts, download-menu.ts, theme-switch.ts; and helpers
                     time.ts, dom.ts, api.ts, labels.ts, types.ts
src/pages/analytics/ the Analytics tab (framed in admin): main.ts (people picker, company progress, timeline, insights),
                     api.ts (answers the page's old dashboard API in the browser from /admin/api/*)
src/fonts/           Figtree and Instrument Serif (open source, SIL OFL), self-hosted
data/companies.json  company suggestions for the booking form ("Name|Alias|Alias")
public/icon.png      app icon (admin home-screen app and browser alerts)
tests/               bun tests for the server, a Chromium smoke test, and visual.cjs (screen-by-screen comparison with main)
scripts/restore.ts   puts a backup back into a data folder
```

Admins mark days or hours as unavailable from the ⋯ menu (Unavailable, saved in `unavailable.json`): the booking page, booking and candidate reschedules leave those times out, while the admin's own booking form still offers them. Interviews already booked in that time stay; the calendar and agenda show the time as a hatched band.

Bookings and settings live as JSON files on the Railway volume mounted at `/data` (`DATA_DIR`), not in this repo.

## Run and test

```bash
ADMIN_OPEN=1 PORT=3000 DATA_DIR=/tmp/bf bun run src/server.ts   # ADMIN_OPEN=1: no sign-in, for local testing only
bun install && bun run typecheck                         # strict server check and the page modules (dev tools only)
bun run format                                           # Prettier (140 columns) over src/ and scripts/; CI runs format:check
bun test tests/                                          # server tests, ~0.5 s
bun run test:coverage                                    # the same, with coverage of the in-process code (bar in bunfig.toml)
NODE_PATH=$(npm root -g) node tests/browser-smoke.cjs    # needs the playwright package
NODE_PATH=$(npm root -g) node tests/visual.cjs           # every screen vs origin/main; must match for refactors
NODE_PATH=$(npm root -g) node tests/a11y.cjs             # accessibility: WCAG 2.1 A/AA on every page (axe-core)
```

## How pages are served

- Page shells revalidate on every visit (`Cache-Control: private, no-cache` plus an ETag, so a repeat visit is a ~0.5 KB 304).
- CSS, JS and fonts are served from `/assets/<name>.<hash>.<ext>` with a one-year `immutable` cache. The hash changes whenever the file changes, so a deploy is picked up on the next page load.
- Everything is brotli/gzip-compressed once at startup; large JSON/CSV API answers are compressed per request.
- The Content-Security-Policy is `script-src 'self'; style-src 'self'` with no nonces, so pages must not contain inline `<script>`/`<style>` or `style="..."` attributes (a test enforces this). Per-request values go in `<script type="application/json" id="boot">`.
- Search engines may list only the landing page (`/`): every other response carries `X-Robots-Tag: noindex`. `/robots.txt` keeps crawlers out of `/admin`, `/api/` and manage links, and `/sitemap.xml` lists the landing page. The landing page's canonical address is the one without `www.`.
- Analytics loads in the admin page as a same-origin frame from `/admin/analytics`, only when that tab is opened.
- `/enquiry` is a plain page (`src/pages/enquiry.html|css|ts`) that posts a multipart form to `/api/enquiry`. The details go to `enquiries.json`; the resume (PDF or Word, checked by its first bytes, 200 KB at most, not mentioned on the form) is saved as `DATA_DIR/resumes/<id>.<ext>`.
- `/payment` works the same way (`src/pages/payment.html|css|ts`, reusing `enquiry.css`) and posts to `/api/payment`. The details go to `payments.json`; the receipt (an image or a PDF, checked by its first bytes) is saved as `DATA_DIR/receipts/<id>.<ext>`. Its size limit is `RECEIPT_MAX_MB` (default 1), only mentioned when a file is too big. `src/server/receipt-check.ts` reads the receipt (pdftotext for PDFs, tesseract OCR for images; both installed by the Dockerfile) and refuses the payment when the receipt shows amounts but not the typed one. A receipt with no readable amount (or a HEIC photo) is saved as `check: "unread"` and shows "Needs check" in the admin; a match shows "Verified". Without the two commands (a local run), every receipt counts as unread. Each payment is Pending until an owner confirms or discards it (`POST /admin/api/payments/decide`); that is final, and the server refuses a second decision with a 409. There is no delete. Totals and By candidate count confirmed payments only; discarded ones keep their receipt and show under the Discarded filter. The Payments tab and bottom bar show the pending count, and a payment alert opens `/admin?view=payments&pay=<id>` on that payment.

## Security

- Admin pages and APIs need a signed-in admin. Sign-in never switches itself off: if `ADMIN_EMAILS` goes missing, the admin page locks instead of opening.
- Every response carries `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, HSTS, `Cross-Origin-Opener-Policy: same-origin` and a `Permissions-Policy` that turns off camera, microphone and location.
- Limits count visitors by `X-Real-IP`, which Railway's edge sets to the real address (`X-Forwarded-For` can be written by the visitor, so it isn't used).
- The server reads at most 2 MB per request (more when `RECEIPT_MAX_MB` is raised). Enquiries and payments: each five an hour per network and 100 in any 24 hours in total. Bookings: 20 an hour per network.
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
| `PUBLIC_URL` | Base URL for links in emails. Set it on Railway (`https://hi-techie.dev`): without it, links come from the request's host headers, which a visitor can set, and the server logs a warning at startup |
| `REMOVE_BOOKINGS` | One-time cleanup on start: `Name@YYYY-MM-DD`, comma separated |
| `BACKUP_EMAIL` | Where the weekly backup email goes (comma separated; falls back to `HOST_EMAIL`) |
| `BACKUP_HOUR` | Hour (IST) after which the daily snapshot and the weekly email run, default `2` |

## Backups

Every day after `BACKUP_HOUR` (IST) the server writes a data snapshot to `/data/backups/YYYY-MM-DD.json` (the last 14 days are kept). These live on the volume, so they don't survive losing it.

Once a week (7 days after the last one) it also emails `BACKUP_EMAIL` a `bookings-YYYY-MM-DD.csv` (opens in Excel or Sheets) and a `backup-YYYY-MM-DD.json` with all the data and the resumes and payment receipts, except `push.json` (browser-alert keys; after a restore, turn alerts on again on each device) and `sessions.json` (who is signed in). If the files don't fit in one email (about 18 MB), the newest go in and the email says how many were left out.

`/data/backup-state.json` remembers the last snapshot and email days, so restarts don't send duplicates; a failed email is retried every 15 minutes. Owners can download the same full backup any time from the admin's ⋯ menu → Backup (`/admin/backup.json`).

To restore, an owner opens ⋯ menu → Backup, chooses the `backup-YYYY-MM-DD.json` file from the latest email and confirms. The data is replaced (each replaced file is kept as `<name>.pre-restore`), then each resume and receipt is uploaded. Owners stay signed in.

Without the admin page, copy a backup JSON into the running service and run the restore script, then restart the service:

```bash
railway ssh --service booking-form          # or upload the file with: railway service files upload
bun run scripts/restore.ts /tmp/backup.json /data
```

The script keeps each replaced file as `<name>.pre-restore`.

If a data file and its `.bak` copy both fail to read at startup, the log says `store unreadable, not saving until it is fixed` and that store runs in memory only, so the files are left as they are for you to repair or restore.

## Deploying

GitHub Actions (`.github/workflows/booking-form.yml`) runs the tests on every pull request and on `main`, and on pull requests also compares every screen with the base branch. Label a PR `ui-change` when it changes the design on purpose; the failed run's screenshots are attached as an artifact.

Railway builds `Dockerfile` in this folder. The service settings live in Railway (root directory `/calendly-live-view`, start command `bun run src/server.ts`, health check `/healthz`, watch pattern `/calendly-live-view/**`). After a deploy, the log should end with `booking-form listening on 8080`.
