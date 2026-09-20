# calendly-live-view

Source pulled from the Railway project `calendly-live-view` (service `calendly-live-view`, production environment). Deployed there as a Railway Function on the `ghcr.io/railwayapp/function-bun:1.4.0` image, entrypoint `./run.sh`.

A Bun/TypeScript HTTP server that polls the Calendly API for upcoming/past events, serves a live dashboard, and can push notifications to an ntfy.sh topic on changes.

## Environment variables

- `CALENDLY_TOKEN` (required) — Calendly personal access token.
- `NTFY_TOPIC` (optional) — ntfy.sh topic to push notifications to.
- `NTFY_SERVER` (optional, default `https://ntfy.sh`) — ntfy server base URL.
- `POLL_SECONDS` (optional, default `30`, minimum `15`) — polling interval.
- `PORT` (optional, default `3000`).

## Run locally

```bash
bun run index.ts
```
