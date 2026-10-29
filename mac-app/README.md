# Hi-Techie for macOS

A desktop app for the Hi-Techie site. It opens **https://hi-techie.dev/admin** in its own window with a Dock icon, so the team can run the calendar, contacts, enquiries and payments without a browser tab.

It is a thin [Electron](https://www.electronjs.org/) window onto the live site, not a second copy of the app: the data, sign-in and features are exactly the web app's, and every Railway deploy shows up in the Mac app on the next reload. Nothing here changes the web app or its deploy (Railway only watches `calendly-live-view/**`).

What it does:

- Pages on `hi-techie.dev` (and `www.`) stay in the window; other links (LinkedIn, meeting links, `mailto:`) open in the default browser or mail app.
- The sign-in is remembered between launches, like a browser.
- Downloads (CSV exports, invites, receipts) ask where to save; file uploads work as on the web.
- View menu: Home (⇧⌘H), Back (⌘[), Forward (⌘]), reload, zoom, full screen. Help → Open in Browser.
- With no internet it shows "Can't reach Hi-Techie" with a Try again link.

Not supported: the browser alerts (the bell) rely on web push, which Electron doesn't deliver; keep using a browser or the phone home-screen app for alerts.

## Get the app (no Mac tools needed)

Every push to `main` that touches `mac-app/` (or a manual run of the **mac app** workflow in GitHub Actions) builds it on a GitHub Mac runner:

1. GitHub → Actions → **mac app** → the latest run → Artifacts → **Hi-Techie-mac** (GitHub wraps it in a zip).
2. Unzip it and open `Hi-Techie-<version>-arm64.dmg`, then drag Hi-Techie to Applications. It is built for Apple silicon Macs (M1 and later); for an Intel Mac, change `--arm64` to `--universal` in the `dist` script and add `"x64"` to the dmg `arch` list.
3. The app isn't signed with an Apple Developer ID, so the first time macOS says it "cannot be opened" or "can't be checked for malicious software": right-click (or Control-click) Hi-Techie in Applications → **Open** → **Open**. On recent macOS you may instead need System Settings → Privacy & Security → **Open Anyway**. After that it opens normally.

## Build it yourself (on a Mac)

```bash
cd mac-app
npm ci
npm start                 # run it from source
npm run dist              # dist/Hi-Techie-<version>-arm64.dmg
npm run dist:dir          # just the .app, faster
npm run check             # syntax and link-rule tests (works on any OS)
```

Point it at another server (a local one, for example) with `HI_TECHIE_URL`:

```bash
HI_TECHIE_URL=http://localhost:3000/admin npm start
```

## Signing and notarizing (optional)

To remove the "unidentified developer" step, the app has to be signed and notarized with a paid Apple Developer account ($99/year). With one, add these as GitHub Actions secrets, pass them to the build step, remove `"identity": null` from `package.json` and add `"notarize": true` under `build.mac`:

- `CSC_LINK` (the Developer ID Application certificate, a base64 .p12) and `CSC_KEY_PASSWORD`
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (for notarization)

## Files

```
main.js               the window, menus, link rules, offline message
links.js              which links stay in the app (plain Node, tested in tests/links.test.cjs)
build/icon.png        the app icon (same as the site's public/icon.png)
package.json          scripts and the electron-builder settings (dmg, Apple silicon)
```
