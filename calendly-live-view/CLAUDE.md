# Calendly live view - guide for Claude Code

Read this first. It covers what the project is, how it is built, the rules that are easy to break, how to test, and what is planned next.

## What this is

A small internal dashboard for one person who coordinates candidate interviews through Calendly. It has three pages:

- **Calendar** `/` - live week view of bookings (name, company, round). Click a booking for that person's interview history.
- **Search** `/search` - find bookings by name, company or round. Nothing is listed until the user types.
- **Analytics** `/analytics` - one person at a time (deliberately no overall view): summary line, "needs attention" strip, "Progress by company" table with a mini timeline, and a pace / cancellations pane.

Users are non-technical. Text on screen must be plain language. All data is real candidate information (names, companies, times): treat it as sensitive.

## Hard constraints

- **One file: `index.tsx`.** It is deployed as a Railway *Function* (a single TypeScript file run by Bun). No local imports, no build step, no npm dependencies. Do not split it unless the deploy method changes (see Deploying).
- **No database.** All state is in memory and is rebuilt from the Calendly API after a restart. Anything that must persist needs a database first (see Roadmap).
- **No login.** Anyone with the URL can read everything. Do not add features that write or change data before adding a lock.
- **Secrets:** `CALENDLY_TOKEN` (and optional `NTFY_TOPIC`) live only in Railway variables. Never put tokens, personal emails or the live URL in the repo.
- **Emails never go to the browser.** APIs return counts (`emails: 2`), never addresses. Keep it that way.

## Commands

```bash
npm install                     # only needed for the tests (jsdom)
CALENDLY_TOKEN=xxx bun run index.tsx     # run locally on :3000
npm test                        # all tests, about 130 checks, no network needed
```

Tests run the real server under Bun against a mocked Calendly, then check the rendered pages in jsdom. Run `npm test` after every change to `index.tsx`. You can run one page test alone (`node tests/pages/analytics.test.js`) after `bun run tests/server.test.ts` has written `tests/.out/*.html`.

## How the code is organised (`index.tsx`, top to bottom)

1. **Config and Calendly client** - `cal()` wraps `fetch` with the bearer token, 15 s timeout, and a `CalError` (status 429 carries `retryAfter`).
2. **Polling** - `poll()` runs every `POLL_SECONDS` (default 30, minimum 15). It lists active events from 42 days back to 60 days ahead, then fetches invitee details (company, round, email, no-show) for at most 20 events per poll into `inviteeCache`. It pushes changes to browsers over SSE (`/stream`, event `state`; `tick` when nothing changed). Optional ntfy push on new or canceled future bookings.
3. **Person lookups** - `loadPerEmail()` lists a person's active (and, for analytics, canceled) events using Calendly's `invitee_email` filter, retrying in lowercase if the address has capitals and nothing came back. `personHistory()` builds the side-panel history; `analyticsFor()` builds the analytics payload (adds canceled events, `rescheduled`, `cancelReason`, `canceledBy`, `created`). Both cache for 45 s and de-duplicate in-flight requests.
4. **Same-name merge** - `normName()` lowercases and strips accents and punctuation. With `?merge=1`, `emailsFor()` adds every other email seen (in `inviteeCache` or `histCache`) whose invitee name normalises the same, so one person with several addresses becomes one. `people()` groups the same way for the picker.
5. **HTTP routes** - see the table below. All responses carry security headers; pages get a CSP with a per-request nonce.
6. **Page templates** - CSS and HTML live in `String.raw` templates (`BASE_CSS`, `APP_CSS`, `PANEL_HTML`). Page scripts are `CORE_JS` (shared) + one of `CALENDAR_JS`, `SEARCH_JS`, `ANALYTICS_JS`, all wrapped in one IIFE by `shell()`. Plain ES5 (`var`, `function`), no framework, DOM built with the `el()` helper.

| Route | Purpose |
| --- | --- |
| `/`, `/search`, `/analytics` | Pages |
| `/api/state` | Current window of bookings (also pushed over `/stream`) |
| `/api/people[?merge=1]` | Picker list: name, company, booking count, last booking, `event` id, `emails` count |
| `/api/analytics?event=<id>[&merge=1]` | Full history of one person, including canceled bookings |
| `/api/person?event=<id>[&merge=1]` | Interview list for the side panel |
| `/stream`, `/healthz` | SSE feed, health check |

`event` is any booking id belonging to the person; the server resolves the email from cached invitee data.

## Domain rules (these define the analytics; change them deliberately)

- **Company and round** come from the booking-form answers: the question whose text matches `/compan|organi[sz]ation|employer|firm|client/i` is the company, and `/round|stage/i` is the round (`parseDetail`). Fallback: first and second answers. The real question wording on the user's form is unconfirmed.
- **Company grouping** (client): `trim().toLowerCase()`. So "Honeywell", "honeywell " and "HONEYWELL" are one company. Names that differ more (typos, "Pvt Ltd", "India") are **not** merged; they are only suggested as duplicates (`similar()`: edit distance with transposition, suffix words such as pvt/ltd/india/technologies/solutions stripped, or word-prefix match). "Combine in this view" is a session-only alias (`joined`), reset on every person load. It is not saved anywhere.
- **Round ranking** (`roundRank`): digits win (`1st`, `Round 2`, `L3`), ordinal words (`second`), `final|last|offer` = 90, `screen|phone|intro` = 0. If every round of a company can be ranked, the **highest rank** is the current stage (ties: latest). If any round can't be ranked (for example "Technical", "HR"), the company falls back to booking order (latest wins).
- **Booking kinds:** active; canceled and *not* rescheduled ("dropped"); canceled and rescheduled ("moved", Calendly sets `rescheduled` on the old invitee). Only active events count as progress. A later dropped round is shown as a note ("2nd round was canceled"). A company whose only events are moved/dropped shows as Rescheduled / Canceled.
- **Company status** (`progress()`): `booked` (an active event ends in the future) > `noshow` > `quiet` (last interview ended at least T days ago, nothing booked) > `waiting` (fewer than T days). A waiting company at rank 90 says "Waiting for a result". **T** is 10 days by default (`QUIET`); with at least three measured gaps between rounds it becomes 1.5 x the median gap, clamped to 5-21 days. Calendly does not record outcomes (selected/rejected), so all of this is estimated from booking dates and the UI says so.
- **Counts:** "interviews done" = active events that ended, excluding no-shows (counted separately). Rows sort: booked first (soonest), then most recent activity.
- **Times** are shown in the Calendly account's timezone (`state.tz`, from `/users/me`; currently Asia/Calcutta). Every date formatter must go through `fmt()`, `ymd()`, `mod()` in `CORE_JS`. The analytics page re-renders when the timezone arrives after the data (`shownTz`).

## Rules that are easy to break

- **ASCII only inside `BASE_CSS`, `APP_CSS`, `PANEL_HTML`.** Bun rewrites non-ASCII characters inside `String.raw` templates into escape codes; harmless in JavaScript strings, but it breaks CSS such as `content: "..."`. Use entities (`&rsaquo;`) in HTML.
- Inside those templates never use a backtick or `${`.
- **CSP blocks inline styles and inline handlers.** Style through CSSOM (`el.style.left = ...`) or classes, never `style="..."` in HTML strings. No external scripts, fonts or images; `connect-src` is `'self'`.
- **Never use `innerHTML`.** Names, companies and cancellation reasons are user-typed. Use `textContent` (the `el()` helper does). Tests check this with `<b>` / `<i>` in names.
- Page JS shares one scope (CORE + page). Avoid duplicate function names (`card`, `words`, `render`...).
- `CORE_JS` calls `render()` (defined by each page script) on every SSE state and every 60 s; every page must define it.
- Calendly limits: keep per-request detail lookups bounded (20 per poll, 30 per history, 40 per analytics) and handle 429 (`retryAfter`).

## Tests (`tests/`)

- `tests/server.test.ts` - Bun. Overrides `globalThis.fetch` to fake Calendly (events, invitees, canceled bookings, a second email address in mixed case), imports `../index.tsx`, calls the real HTTP endpoints, and writes the rendered pages to `tests/.out/`.
- `tests/pages/*.test.js` - Node + jsdom. They load the rendered HTML with a fake `EventSource` and `fetch`, a **fixed clock (2026-09-20T09:00:00Z)** and timezone `Asia/Calcutta`, then click and assert. The analytics test has datasets that pin each rule above (Triveni, Nita, Kavya, Rohit); read them before changing any rule, and add a dataset when you add one.
- jsdom has **no layout engine**: it cannot check overlap, wrapping, colours or scrolling. `analytics-scroll` fakes `scrollHeight`. **Nobody has looked at the pages in a real browser or on a phone during development.** Layout and mobile behaviour were reasoned about, not seen. A Playwright screenshot pass (desktop dark and light, 390 px wide phone) is the most valuable missing check.

## Deploying

Production is a Railway Function. Until now the whole `index.tsx` was pasted in with the Railway MCP tool `update-function-source-code`. Options going forward:

1. Keep doing that (works, but you must send the complete file each time).
2. Connect the Railway service to this GitHub repo (`connect-service-source`) so a push deploys. Railway then runs `bun run index.tsx` from `package.json`. Check the service still gets `PORT`, add `CALENDLY_TOKEN` as a variable, and use `/healthz` as the health check. This also makes splitting `index.tsx` into modules possible.

Always run `npm test` first. After a deploy, read the logs for `calendly-live-view listening on ...`.

## Roadmap (agreed direction, nothing below is built)

1. **Lock the dashboard** (password or secret link). Prerequisite for everything that writes.
2. **Invite links that carry identity.** Problem: candidates use different emails and spell company names differently. Idea: generate a per-booking Calendly link with prefilled name, email, company and round (`?name=&email=&a1=`) plus hidden UTM tags (`utm_content` = candidate key, `utm_campaign` = company). Calendly stores UTM values with the booking and returns them as `tracking` on the invitee (documented by Calendly), and the dashboard would trust the tag over what the candidate typed. Optionally single-use links via the API (`POST /scheduling_links`). **Not yet verified on the user's account:** whether tags come through, whether they survive on single-use links, and whether secret event types are available on their plan. Do one test booking before building.
3. **Persistent storage** (Railway Postgres): saved company aliases (make "Combine" permanent), candidate outcomes (selected / rejected / on hold), then real conversion views.
4. **Visual QA in a browser** and any layout fixes that follow.
5. Smaller ideas raised earlier: reminders and a morning summary via ntfy, colour by round on the calendar, back-to-back meeting warning, a 3-day mobile calendar view, dropping the weak "Time booked this week" card.

## Decisions already made with the user (do not silently reverse)

- Search and the analytics picker list nobody until the user types.
- Analytics is all-time only (no 30/90-day ranges) and per person only.
- Same-name people are combined by default, with a checkbox to turn it off (remembered in `localStorage` key `lv_merge`).
- The analytics page is four blocks (summary line, attention strip, company table, pace pane). The earlier duration, weekday, trend, companies, rounds and pipeline panes were removed as repetitive.
- Typos and near-duplicate company names are suggested, never auto-merged.
- The Calendly plan appears to be Free (no webhooks), which is why the app polls.

## How to work with this user

- Plain, short language; lead with the outcome, then limits. Avoid jargon.
- If they ask for suggestions or say "don't make changes", only suggest and wait for a go-ahead.
- Test before deploying, and say honestly what was and was not verified (especially layout).
- Prefer removing repetition over adding panes; they asked for a page that looks productive, not busy.
