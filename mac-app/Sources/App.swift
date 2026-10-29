// Hi-Techie for macOS: a native window onto the live site, using the Safari engine (WebKit) that comes
// with macOS, so the app stays tiny and always matches the web app (same data, same sign-in, every deploy).

import Cocoa
import WebKit

// MARK: - Which links stay in the app

let defaultURL = "https://hi-techie.dev/admin"

func startURL(_ env: [String: String]) -> URL {
    if let s = env["HI_TECHIE_URL"], let u = URL(string: s), u.host != nil { return u }
    return URL(string: defaultURL)!
}

private func bareHost(_ h: String) -> String {
    let h = h.lowercased()
    return h.hasPrefix("www.") ? String(h.dropFirst(4)) : h
}

/// Pages on the app's own site (hi-techie.dev, www.hi-techie.dev, or the HI_TECHIE_URL host) stay in the window.
func isInternal(_ url: URL, start: URL) -> Bool {
    guard let us = url.scheme?.lowercased(), let ss = start.scheme?.lowercased(), us == ss,
        let uh = url.host, let sh = start.host
    else { return false }
    return bareHost(uh) == bareHost(sh) && url.port == start.port
}

/// Only web, mail and phone links are handed to the system; anything else (file:, custom schemes) is dropped.
func isSafeExternal(_ url: URL) -> Bool {
    ["https", "http", "mailto", "tel"].contains(url.scheme?.lowercased() ?? "")
}

/// `Hi-Techie --self-test` checks the link rules without opening a window (run by CI).
func selfTest() -> Bool {
    let s = URL(string: defaultURL)!
    let u = { (x: String) in URL(string: x)! }
    let checks: [(String, Bool)] = [
        ("default start", startURL([:]) == s),
        ("HI_TECHIE_URL", startURL(["HI_TECHIE_URL": "http://localhost:3000/admin"]) == u("http://localhost:3000/admin")),
        ("bad HI_TECHIE_URL", startURL(["HI_TECHIE_URL": "nonsense"]) == s),
        ("same site", isInternal(u("https://hi-techie.dev/booking"), start: s)),
        ("www", isInternal(u("https://www.hi-techie.dev/admin?view=payments"), start: s)),
        ("plain http", !isInternal(u("http://hi-techie.dev/admin"), start: s)),
        ("look-alike host", !isInternal(u("https://hi-techie.dev.evil.com/"), start: s)),
        ("other site", !isInternal(u("https://www.linkedin.com/in/x"), start: s)),
        ("local", isInternal(u("http://localhost:3000/booking"), start: u("http://localhost:3000/admin"))),
        ("other port", !isInternal(u("http://localhost:4000/"), start: u("http://localhost:3000/admin"))),
        ("https out", isSafeExternal(u("https://meet.google.com/abc"))),
        ("mailto out", isSafeExternal(u("mailto:hr@example.com"))),
        ("file blocked", !isSafeExternal(u("file:///etc/passwd"))),
        ("javascript blocked", !isSafeExternal(u("javascript:alert(1)"))),
    ]
    var ok = true
    for (name, pass) in checks where !pass {
        print("FAIL: \(name)")
        ok = false
    }
    print(ok ? "links: all \(checks.count) checks passed" : "links: failures above")
    return ok
}

// MARK: - A window with the site in it

let START = startURL(ProcessInfo.processInfo.environment)
@MainActor var windows: [BrowserWindow] = []

@MainActor
final class BrowserWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    let window: NSWindow
    let webView: WKWebView
    private var titleObservation: NSKeyValueObservation?

    /// `configuration` is passed when the page opens a new window (a link with target="_blank").
    init(configuration: WKWebViewConfiguration? = nil, load url: URL?) {
        // A new window from the page must use the configuration WebKit hands over, unchanged.
        let config = configuration ?? WKWebViewConfiguration()
        if configuration == nil {
            config.websiteDataStore = .default()  // sign-in and settings are kept between launches
            config.applicationNameForUserAgent = "Hi-Techie-Mac/1"
            if #available(macOS 12.3, *) { config.preferences.isElementFullscreenEnabled = true }
        }
        let wv = WKWebView(frame: .zero, configuration: config)
        wv.allowsBackForwardNavigationGestures = true
        wv.allowsMagnification = true

        let first = windows.isEmpty
        let w = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        w.title = "Hi-Techie"
        w.minSize = NSSize(width: 380, height: 600)
        w.contentView = wv
        w.isReleasedWhenClosed = false
        webView = wv
        window = w
        super.init()

        window.delegate = self
        webView.navigationDelegate = self
        webView.uiDelegate = self
        titleObservation = webView.observe(\.title) { [weak self] wv, _ in
            DispatchQueue.main.async {
                if let t = wv.title, !t.isEmpty { self?.window.title = t }
            }
        }
        if first {
            window.setFrameAutosaveName("Main")  // remembers size and place
            if !window.setFrameUsingName("Main") { window.center() }
        } else if let last = windows.last?.window {
            window.setFrameTopLeftPoint(NSPoint(x: last.frame.minX + 24, y: last.frame.maxY - 24))
        }
        windows.append(self)
        if let url = url { webView.load(URLRequest(url: url)) }
        window.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        windows.removeAll { $0 === self }
    }

    // Links: the site stays in the app, other sites open in the default browser or mail app.
    func webView(
        _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if action.shouldPerformDownload { return decisionHandler(.download) }  // <a download>
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        let mainFrame = action.targetFrame?.isMainFrame ?? true
        if !mainFrame || ["about", "blob", "data"].contains(url.scheme ?? "") || isInternal(url, start: START) {
            return decisionHandler(.allow)
        }
        if isSafeExternal(url) { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    // Files the page can't show, or that the server sends as attachments, are saved instead.
    func webView(
        _ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        if !response.canShowMIMEType || disposition.lowercased().hasPrefix("attachment") {
            return decisionHandler(.download)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(
        _ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.beginSheetModal(for: window) { result in
            guard result == .OK, let url = panel.url else { return completionHandler(nil) }
            try? FileManager.default.removeItem(at: url)  // the panel already asked before replacing
            completionHandler(url)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let alert = NSAlert()
        alert.messageText = "The download didn't finish"
        alert.informativeText = error.localizedDescription
        alert.beginSheetModal(for: window)
    }

    // A link with target="_blank": the site opens in a new window, other sites in the browser.
    func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
        for action: WKNavigationAction, windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard let url = action.request.url else { return nil }
        if isInternal(url, start: START) || url.scheme == "about" {
            return BrowserWindow(configuration: configuration, load: nil).webView
        }
        if isSafeExternal(url) { NSWorkspace.shared.open(url) }
        return nil
    }

    func webViewDidClose(_ webView: WKWebView) { window.close() }

    // File uploads (resumes, receipts, invites).
    func webView(
        _ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { result in
            completionHandler(result == .OK ? panel.urls : nil)
        }
    }

    // alert(), confirm() and prompt() (the admin page asks before cancelling or deleting).
    func webView(
        _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(
        _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(
        _ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    // The site never needs the camera or microphone.
    func webView(
        _ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        decisionHandler(.deny)
    }

    // No network: a short message with a retry instead of a blank window.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let e = error as NSError
        if e.code == NSURLErrorCancelled || (e.domain == "WebKitErrorDomain" && e.code == 102) { return }  // replaced, or a download
        let retry = (e.userInfo[NSURLErrorFailingURLErrorKey] as? URL) ?? START
        let href = retry.absoluteString.replacingOccurrences(of: "\"", with: "%22")
        let html = """
            <meta name="color-scheme" content="light dark"><body style="font:15px -apple-system,sans-serif;display:grid;\
            place-items:center;height:90vh"><div style="text-align:center"><h2>Can't reach Hi-Techie</h2>\
            <p>Check the internet connection.</p><p><a href="\(href)">Try again</a></p></div></body>
            """
        webView.loadHTMLString(html, baseURL: nil)
    }
}

// MARK: - The app and its menus

@main
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    static func main() {
        if CommandLine.arguments.contains("--self-test") { exit(selfTest() ? 0 : 1) }
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()  // keeps `delegate` alive: run() doesn't return while the app is open
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = buildMenu()
        _ = BrowserWindow(load: START)
        NSApp.activate(ignoringOtherApps: true)
    }

    // Clicking the Dock icon with no window open brings one back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { _ = BrowserWindow(load: START) }
        return true
    }

    private var current: WKWebView? { windows.first { $0.window.isKeyWindow }?.webView ?? windows.last?.webView }

    @objc func home(_ sender: Any?) { current?.load(URLRequest(url: START)) }
    @objc func newWindow(_ sender: Any?) { _ = BrowserWindow(load: START) }
    @objc func back(_ sender: Any?) { current?.goBack() }
    @objc func forward(_ sender: Any?) { current?.goForward() }
    @objc func reload(_ sender: Any?) { current?.reload() }
    @objc func zoomIn(_ sender: Any?) { if let w = current { w.pageZoom = min(w.pageZoom + 0.1, 3) } }
    @objc func zoomOut(_ sender: Any?) { if let w = current { w.pageZoom = max(w.pageZoom - 0.1, 0.5) } }
    @objc func zoomReset(_ sender: Any?) { current?.pageZoom = 1 }
    @objc func openInBrowser(_ sender: Any?) { NSWorkspace.shared.open(current?.url ?? START) }

    private func buildMenu() -> NSMenu {
        let main = NSMenu()
        func add(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
            let menu = NSMenu(title: title)
            for i in items { menu.addItem(i) }
            let holder = NSMenuItem()
            holder.submenu = menu
            main.addItem(holder)
            return menu
        }
        func item(_ title: String, _ action: Selector, _ key: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            return i
        }

        _ = add(
            "Hi-Techie",
            [
                item("About Hi-Techie", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
                .separator(),
                item("Hide Hi-Techie", #selector(NSApplication.hide(_:)), "h"),
                item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
                item("Show All", #selector(NSApplication.unhideAllApplications(_:)), ""),
                .separator(),
                item("Quit Hi-Techie", #selector(NSApplication.terminate(_:)), "q"),
            ])
        _ = add(
            "File",
            [
                item("New Window", #selector(newWindow(_:)), "n"),
                item("Close Window", #selector(NSWindow.performClose(_:)), "w"),
            ])
        // Without an Edit menu, ⌘C / ⌘V / ⌘A don't work in the page's text boxes.
        _ = add(
            "Edit",
            [
                item("Undo", Selector(("undo:")), "z"),
                item("Redo", Selector(("redo:")), "z", [.command, .shift]),
                .separator(),
                item("Cut", #selector(NSText.cut(_:)), "x"),
                item("Copy", #selector(NSText.copy(_:)), "c"),
                item("Paste", #selector(NSText.paste(_:)), "v"),
                item("Select All", #selector(NSText.selectAll(_:)), "a"),
                .separator(),
                item("Find…", #selector(NSTextView.performFindPanelAction(_:)), "f"),
            ])
        _ = add(
            "View",
            [
                item("Home", #selector(home(_:)), "h", [.command, .shift]),
                item("Back", #selector(back(_:)), "["),
                item("Forward", #selector(forward(_:)), "]"),
                item("Reload", #selector(reload(_:)), "r"),
                .separator(),
                item("Actual Size", #selector(zoomReset(_:)), "0"),
                item("Zoom In", #selector(zoomIn(_:)), "+"),
                item("Zoom Out", #selector(zoomOut(_:)), "-"),
                .separator(),
                item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
            ])
        let windowMenu = add(
            "Window",
            [
                item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
                item("Zoom", #selector(NSWindow.performZoom(_:)), ""),
                .separator(),
                item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:)), ""),
            ])
        NSApp.windowsMenu = windowMenu
        _ = add("Help", [item("Open in Browser", #selector(openInBrowser(_:)), "")])
        return main
    }
}

