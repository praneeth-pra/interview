# Hi-Techie for macOS

A desktop app for the Hi-Techie site. It opens **https://hi-techie.dev/admin** in its own window with a Dock icon, so the team can run the calendar, contacts, enquiries and payments without a browser tab.

It is a small native app (Swift, one file) that shows the live site with the Safari engine built into macOS, so the download is a couple of MB. It isn't a second copy of the app: the data, sign-in and features are exactly the web app's, and every Railway deploy shows up on the next reload. Nothing here changes the web app or its deploy (Railway only watches `calendly-live-view/**`).

What it does:

- Pages on `hi-techie.dev` (and `www.`) stay in the app; links that open a new tab on the site (an invite, a receipt) open a new window. Other sites (LinkedIn, meeting links, `mailto:`) open in the default browser or mail app.
- The sign-in is remembered between launches.
- Downloads (CSV exports, invites, receipts) ask where to save; file uploads, copy links and the "Are you sure?" questions work as on the web.
- File → New Window (⌘N). View: Home (⇧⌘H), Back (⌘[), Forward (⌘]), Reload (⌘R), zoom (⌘+ / ⌘- / ⌘0), full screen. Edit has copy, paste and Find (⌘F). Help → Open in Browser.
- It remembers the window's size and place. Two-finger swipe goes back and forward.
- With no internet it shows "Can't reach Hi-Techie" with a Try again link.
- Runs on macOS 12 (Monterey) or later, on Apple silicon and Intel Macs.

Not supported: the browser alerts (the bell) rely on web push, which apps that embed Safari's engine don't get; keep using a browser or the phone home-screen app for alerts.

## Get the app (no Mac tools needed)

Every push to `main` that touches `mac-app/` (or a manual run of the **mac app** workflow in GitHub Actions) builds it on a GitHub Mac runner:

1. GitHub → Actions → **mac app** → the latest run → Artifacts → **Hi-Techie-mac** (GitHub wraps it in a zip).
2. Unzip it, open `Hi-Techie-<version>.dmg` and drag Hi-Techie onto Applications.
3. The app isn't signed with an Apple Developer ID, so the first time macOS won't open it. Right-click (or Control-click) Hi-Techie in Applications → **Open** → **Open**. On macOS 15 and later: try to open it once, then System Settings → Privacy & Security → **Open Anyway**. After that it opens normally.

## Build it yourself (on a Mac)

Needs only the Xcode command line tools (`xcode-select --install`).

```bash
cd mac-app
./build.sh                                          # dist/Hi-Techie.app and dist/Hi-Techie-<version>.dmg
open dist/Hi-Techie.app                             # run it
dist/Hi-Techie.app/Contents/MacOS/Hi-Techie --self-test   # the link-rule checks
```

Point it at another server (a local one, for example) with `HI_TECHIE_URL`:

```bash
HI_TECHIE_URL=http://localhost:3000/admin dist/Hi-Techie.app/Contents/MacOS/Hi-Techie
```

The version number is `VERSION` at the top of `build.sh`.

## Signing and notarizing (optional)

To remove the "unidentified developer" step, the app has to be signed and notarized with a paid Apple Developer account ($99/year): replace `codesign --force --sign -` in `build.sh` with `codesign --force --options runtime --sign "Developer ID Application: …"`, then submit the .dmg with `xcrun notarytool submit --wait` and `xcrun stapler staple`. In CI, the certificate and Apple ID password go in GitHub Actions secrets.

## Files

```
Sources/App.swift     the whole app: window, link rules, downloads and uploads, menus, offline message, --self-test
Info.plist            the app's name, id, icon and minimum macOS
build.sh              compiles, makes the icon, signs ad hoc and builds the .dmg
build/icon.png        the app icon (same as the site's public/icon.png)
```
