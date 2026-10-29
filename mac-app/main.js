// Hi-Techie for macOS: a window onto the live site, so the app always matches the web app
// (same data, same sign-in, updates with every Railway deploy).

const { app, BrowserWindow, Menu, shell, session } = require("electron");
const { startUrl, isInternal, isSafeExternal } = require("./links");

const START_URL = startUrl(process.env);
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    minHeight: 600,
    title: "Hi-Techie",
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.loadURL(START_URL);

  // Links to other sites (LinkedIn, meeting links, mailto:) open in the default browser or mail app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternal(url, START_URL)) return { action: "allow" };
    if (isSafeExternal(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (isInternal(url, START_URL)) return;
    event.preventDefault();
    if (isSafeExternal(url)) shell.openExternal(url);
  });

  // No network: show a short message with a retry instead of a blank window.
  win.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3: navigation replaced by another, not an error
    const html =
      "<body style=\"font:15px -apple-system,sans-serif;display:grid;place-items:center;height:90vh;color:#333\">" +
      "<div style=\"text-align:center\"><h2>Can't reach Hi-Techie</h2><p>Check the internet connection.</p>" +
      "<p><a href=\"" + encodeURI(url || START_URL) + "\">Try again</a></p></div></body>";
    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  });

  win.on("closed", () => (win = null));
}

function buildMenu() {
  const template = [
    { role: "appMenu" },
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Home", accelerator: "CmdOrCtrl+Shift+H", click: () => win && win.loadURL(START_URL) },
        { label: "Back", accelerator: "CmdOrCtrl+[", click: () => win && win.webContents.navigationHistory.goBack() },
        { label: "Forward", accelerator: "CmdOrCtrl+]", click: () => win && win.webContents.navigationHistory.goForward() },
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [{ label: "Open in Browser", click: () => shell.openExternal(win ? win.webContents.getURL() : START_URL) }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  // The site never needs camera, microphone or location; allow only notifications and clipboard writes.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(["notifications", "clipboard-sanitized-write", "fullscreen"].includes(permission));
  });
  buildMenu();
  createWindow();
  // macOS: clicking the Dock icon with no window open brings one back.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// One copy of the app at a time.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
