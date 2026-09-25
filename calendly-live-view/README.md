# calendly-live-view

Source pulled from the Railway project `calendly-live-view` (service `booking-form`, production environment). Deployed as a Railway Function on the `ghcr.io/railwayapp/function-bun:1.4.0` image.

Live domains: `hi-techie.dev`, `www.hi-techie.dev`, `booking-form-production-7ed8.up.railway.app`.

A Bun/TypeScript HTTP server that serves the booking/interview pages (each page's HTML/JS is stored brotli-compressed + base64 in a Railway env var), talks to the Calendly API, tracks interviewer assignments, and emails via Resend.

## Environment variables

- `CALENDLY_TOKEN` — Calendly personal access token.
- `ADMIN_PASSWORD` — password for the admin pages.
- `RESEND_API_KEY` — Resend API key for outbound email.
- `DASHBOARD_URL`, `HOST_NAME`, `EVENT_NAME`, `EVENT_LOCATION` — display/config values.
- `DATA_DIR` — path for persistent storage of bookings/interviewer state.
- `DATA_ICON`, `DATA_COMPANIES` — data assets (companies list is a compressed page variable like `PAGE_*`).
- `PAGE_BOOK`, `PAGE_ADMIN`, `PAGE_ADMIN_2`, `PAGE_LOGIN`, `PAGE_ANALYTICS` — compressed page sources (`<12-char sha256 check>.<brotli+base64>`; a value over Railway's 32,768-char limit continues in `_2`/`_3` suffixes).
- `PAGE_BOOK_PREV`, `PAGE_ADMIN_PREV` — previous versions of the corresponding page, restored when `PAGE_USE_PREV` lists that page.
- `ASSETS_B64_1`, `ASSETS_B64_2` — legacy combined asset bundle, used as a fallback if the `PAGE_*` variables are missing/damaged.
- `SHOW_PAGES` — set to `on` to print each page variable into the startup log.
- `REMOVE_BOOKINGS` — admin-triggered booking removal control.

## Run locally

```bash
bun run index.ts
```

## Updating from Railway

Pulled with the Railway MCP `get-function-source-code` tool against project `calendly-live-view` / service `booking-form` / environment `production`. Re-pull the same way to sync future deploys.
