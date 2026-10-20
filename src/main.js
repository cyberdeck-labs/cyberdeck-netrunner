// Cyberdeck Netrunner – Chromium-Browser im Cyberpunk-Stil (Electron)
// Hauptprozess: Fenster, Tabs (WebContentsView), Downloads, Lesezeichen, Adblock, Updates.
'use strict';
const {
  app, BaseWindow, WebContentsView, ipcMain, session, Menu, shell, protocol, net, clipboard,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

const UI_HEIGHT = 92; // Hoehe der Browser-Leiste (Tabs + Adresszeile) in px
const NEWTAB = 'netrunner://newtab/';
const isNewtab = (u) => (u || '').startsWith('netrunner://newtab');
const SEARCH = 'https://duckduckgo.com/?q=';
const TEST = process.env.NETRUNNER_TEST || '';

// eigenes Schema fuer interne Seiten (Neuer Tab)
protocol.registerSchemesAsPrivileged([
  { scheme: 'netrunner', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

app.setName('Cyberdeck Netrunner');
// Wayland nativ unter Hyprland, X11/Windows automatisch
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
app.commandLine.appendSwitch('lang', 'de-DE'); // Webseiten auf Deutsch (Accept-Language)
app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations');

let win; // BaseWindow
let ui; // WebContentsView mit der Browser-Oberflaeche
const tabs = []; // { id, view, title, url, loading, favicon }
let activeId = null;
let nextId = 1;
let blocked = 0;
const dataDir = () => app.getPath('userData');
const bmFile = () => path.join(dataDir(), 'bookmarks.json');

// ───────────── Lesezeichen ─────────────
let bookmarks = [];
function loadBookmarks() {
  try {
    bookmarks = JSON.parse(fs.readFileSync(bmFile(), 'utf8'));
  } catch {
    bookmarks = [
      { title: 'DuckDuckGo', url: 'https://duckduckgo.com' },
      { title: 'YouTube', url: 'https://www.youtube.com' },
      { title: 'GitHub', url: 'https://github.com' },
      { title: 'Wikipedia', url: 'https://de.wikipedia.org' },
    ];
  }
}
function saveBookmarks() {
  fs.mkdirSync(dataDir(), { recursive: true });
  const tmp = bmFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(bookmarks, null, 2));
  fs.renameSync(tmp, bmFile());
}

// ───────────── Hilfen ─────────────
function toUrl(input) {
  const s = (input || '').trim();
  if (!s) return NEWTAB;
  if (/^(https?|file|netrunner|about|chrome):/i.test(s)) return s;
  if (/^localhost(:\d+)?(\/|$)/i.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(s)) return 'http://' + s;
  if (!/\s/.test(s) && /\.[a-z]{2,}(:\d+)?(\/|$)/i.test(s)) return 'https://' + s;
  return SEARCH + encodeURIComponent(s);
}
const tab = (id) => tabs.find((t) => t.id === id);
const active = () => tab(activeId);

function send(ch, data) {
  if (ui && !ui.webContents.isDestroyed()) ui.webContents.send(ch, data);
}
function pushTabs() {
  send('tabs', {
    active: activeId,
    tabs: tabs.map((t) => ({
      id: t.id, title: t.title, url: isNewtab(t.url) ? '' : t.url, loading: t.loading, favicon: t.favicon,
      canBack: t.view.webContents.navigationHistory.canGoBack(),
      canFwd: t.view.webContents.navigationHistory.canGoForward(),
    })),
  });
}

function layout() {
  if (!win) return;
  const [w, h] = win.getContentSize();
  ui.setBounds({ x: 0, y: 0, width: w, height: h });
  for (const t of tabs) {
    if (t.id === activeId) {
      t.view.setBounds({ x: 0, y: UI_HEIGHT, width: w, height: Math.max(0, h - UI_HEIGHT) });
      t.view.setVisible(true);
    } else {
      t.view.setVisible(false);
    }
  }
}

// ───────────── Tabs ─────────────
function createTab(url = NEWTAB, activate = true) {
  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  view.setBackgroundColor('#07020A');
  const t = { id: nextId++, view, title: 'NEUER TAB', url, loading: true, favicon: null };
  tabs.push(t);
  win.contentView.addChildView(view);
  const wc = view.webContents;

  wc.on('page-title-updated', (_e, title) => { t.title = title; pushTabs(); });
  wc.on('page-favicon-updated', (_e, icons) => { t.favicon = icons[0] || null; pushTabs(); });
  wc.on('did-start-loading', () => { t.loading = true; pushTabs(); });
  wc.on('did-stop-loading', () => { t.loading = false; pushTabs(); });
  const onNav = (_e, u) => { t.url = u; if (isNewtab(u) && !u.includes('#error')) t.title = 'NEUER TAB'; pushTabs(); };
  wc.on('did-navigate', onNav);
  wc.on('did-navigate-in-page', onNav);
  wc.on('did-fail-load', (_e, code, desc, u, isMain) => {
    if (isMain && code !== -3) {
      t.loading = false;
      wc.loadURL(`${NEWTAB}#error=${encodeURIComponent(desc)}&url=${encodeURIComponent(u)}`);
    }
  });
  // Links mit target=_blank / window.open -> neuer Tab
  wc.setWindowOpenHandler(({ url: u }) => { createTab(u, true); return { action: 'deny' }; });
  wc.on('before-input-event', (e, input) => { if (handleShortcut(input)) e.preventDefault(); });
  wc.on('context-menu', (_e, p) => contextMenu(wc, p));

  wc.loadURL(url);
  if (activate) activateTab(t.id); else layout();
  pushTabs();
  return t;
}

function activateTab(id) {
  if (!tab(id)) return;
  activeId = id;
  layout();
  pushTabs();
  const t = active();
  if (isNewtab(t.url)) send('focus-address');
  else t.view.webContents.focus();
}

function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [t] = tabs.splice(i, 1);
  win.contentView.removeChildView(t.view);
  t.view.webContents.close();
  if (!tabs.length) { createTab(); return; }
  if (activeId === id) activateTab(tabs[Math.min(i, tabs.length - 1)].id);
  else pushTabs();
}

// ───────────── Tastenkuerzel ─────────────
function handleShortcut(input) {
  if (input.type !== 'keyDown') return false;
  const ctrl = input.control || input.meta;
  const k = input.key.toLowerCase();
  const t = active();
  if (ctrl && k === 't') { createTab(); return true; }
  if (ctrl && k === 'w') { closeTab(activeId); return true; }
  if (ctrl && (k === 'l' || k === 'k')) { send('focus-address'); ui.webContents.focus(); return true; }
  if (ctrl && k === 'r' || k === 'f5') { t?.view.webContents.reload(); return true; }
  if (ctrl && k === 'd') { toggleBookmark(); return true; }
  if (ctrl && k === 'tab') {
    const i = tabs.findIndex((x) => x.id === activeId);
    const n = (i + (input.shift ? -1 : 1) + tabs.length) % tabs.length;
    activateTab(tabs[n].id); return true;
  }
  if (input.alt && k === 'arrowleft') { t?.view.webContents.navigationHistory.goBack(); return true; }
  if (input.alt && k === 'arrowright') { t?.view.webContents.navigationHistory.goForward(); return true; }
  if (k === 'f12') { t?.view.webContents.toggleDevTools(); return true; }
  if (ctrl && ['+', '=', '-', '0'].includes(k) && t) {
    const wc = t.view.webContents;
    wc.setZoomLevel(k === '0' ? 0 : wc.getZoomLevel() + (k === '-' ? -0.5 : 0.5)); return true;
  }
  return false;
}

function contextMenu(wc, p) {
  const items = [];
  if (p.linkURL) {
    items.push({ label: 'Link in neuem Tab öffnen', click: () => createTab(p.linkURL, false) });
    items.push({ label: 'Link-Adresse kopieren', click: () => clipboard.writeText(p.linkURL) });
    items.push({ type: 'separator' });
  }
  if (p.selectionText) {
    items.push({ label: 'Kopieren', role: 'copy' });
    items.push({ label: `„${p.selectionText.slice(0, 25)}“ suchen`, click: () => createTab(toUrl(p.selectionText)) });
  }
  if (p.isEditable) items.push({ label: 'Einfügen', role: 'paste' }, { label: 'Ausschneiden', role: 'cut' });
  if (p.mediaType === 'image') items.push({ label: 'Bild in neuem Tab öffnen', click: () => createTab(p.srcURL, false) });
  if (items.length) items.push({ type: 'separator' });
  items.push(
    { label: 'Zurück', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
    { label: 'Neu laden', click: () => wc.reload() },
    { type: 'separator' },
    { label: 'Untersuchen (F12)', click: () => wc.inspectElement(p.x, p.y) },
  );
  Menu.buildFromTemplate(items).popup({ window: win });
}

function toggleBookmark() {
  const t = active();
  if (!t || isNewtab(t.url)) return;
  const i = bookmarks.findIndex((b) => b.url === t.url);
  if (i >= 0) bookmarks.splice(i, 1);
  else bookmarks.push({ title: (t.title || t.url).slice(0, 40), url: t.url });
  saveBookmarks();
  send('bookmarks', bookmarks);
}

// ───────────── Downloads ─────────────
function setupDownloads(ses) {
  ses.on('will-download', (_e, item) => {
    const dir = app.getPath('downloads');
    let file = path.join(dir, item.getFilename());
    for (let n = 1; fs.existsSync(file); n++) {
      const p = path.parse(item.getFilename());
      file = path.join(dir, `${p.name} (${n})${p.ext}`);
    }
    item.setSavePath(file);
    const id = Date.now();
    const info = () => ({
      id, name: path.basename(file), file, state: item.getState(),
      received: item.getReceivedBytes(), total: item.getTotalBytes(),
    });
    send('download', info());
    item.on('updated', () => send('download', info()));
    item.once('done', () => send('download', info()));
  });
}

// ───────────── Werbe- & Tracker-Blocker ─────────────
async function setupAdblock(ses) {
  try {
    const { ElectronBlocker } = require('@ghostery/adblocker-electron');
    const cache = path.join(dataDir(), 'adblock-engine.bin');
    const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: cache,
      read: fsp.readFile,
      write: async (p, buf) => { await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, buf); },
    });
    blocker.enableBlockingInSession(ses);
    blocker.on('request-blocked', () => { blocked++; send('blocked', blocked); });
    send('adblock', 'AKTIV');
  } catch (err) {
    console.error('adblock:', err.message);
    send('adblock', 'OFFLINE');
  }
}

// ───────────── Updates ─────────────
// Linux: AppImage, Windows: NSIS-Installer - beide ueber GitHub-Releases (electron-updater).
let updater = null;
function setupUpdates() {
  const info = { app: app.getVersion(), chromium: process.versions.chrome, electron: process.versions.electron };
  send('versions', info);
  if (!app.isPackaged) { send('update', { state: 'dev', text: 'DEV-BUILD // KEINE UPDATES' }); return; }
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
    updater.autoDownload = true;
    updater.on('checking-for-update', () => send('update', { state: 'checking', text: 'SUCHE UPDATE …' }));
    updater.on('update-not-available', () => send('update', { state: 'ok', text: 'AKTUELL' }));
    updater.on('download-progress', (p) => send('update', { state: 'loading', text: `LADE UPDATE ${Math.round(p.percent)} %` }));
    updater.on('update-downloaded', (u) => send('update', { state: 'ready', text: `v${u.version} BEREIT // NEUSTART` }));
    updater.on('error', (e) => send('update', { state: 'error', text: 'UPDATE-FEHLER', detail: String(e.message || e) }));
    updater.checkForUpdates().catch(() => {});
    setInterval(() => updater.checkForUpdates().catch(() => {}), 6 * 3600 * 1000);
  } catch (e) {
    send('update', { state: 'error', text: 'UPDATER FEHLT', detail: e.message });
  }
}

// ───────────── IPC von der Oberflaeche ─────────────
function setupIpc() {
  ipcMain.on('navigate', (_e, input) => { const t = active(); if (t) t.view.webContents.loadURL(toUrl(input)); });
  ipcMain.on('new-tab', (_e, url) => createTab(url ? toUrl(url) : NEWTAB));
  ipcMain.on('close-tab', (_e, id) => closeTab(id));
  ipcMain.on('activate-tab', (_e, id) => activateTab(id));
  ipcMain.on('back', () => active()?.view.webContents.navigationHistory.goBack());
  ipcMain.on('forward', () => active()?.view.webContents.navigationHistory.goForward());
  ipcMain.on('reload', () => { const wc = active()?.view.webContents; if (wc) wc.isLoading() ? wc.stop() : wc.reload(); });
  ipcMain.on('toggle-bookmark', () => toggleBookmark());
  ipcMain.on('open-bookmark', (_e, url, newTab) => newTab ? createTab(url) : active()?.view.webContents.loadURL(url));
  ipcMain.on('remove-bookmark', (_e, url) => { bookmarks = bookmarks.filter((b) => b.url !== url); saveBookmarks(); send('bookmarks', bookmarks); });
  ipcMain.on('open-download', (_e, file) => shell.showItemInFolder(file));
  ipcMain.on('win', (_e, what) => {
    if (what === 'min') win.minimize();
    else if (what === 'max') win.isMaximized() ? win.unmaximize() : win.maximize();
    else if (what === 'close') win.close();
  });
  ipcMain.on('install-update', () => updater?.quitAndInstall());
  ipcMain.on('check-update', () => updater ? updater.checkForUpdates().catch(() => {}) : setupUpdates());
  ipcMain.on('ui-ready', () => {
    send('bookmarks', bookmarks);
    pushTabs();
    setupUpdates();
    send('blocked', blocked);
  });
  ipcMain.handle('get-bookmarks', () => bookmarks);
  ipcMain.on('bookmark-menu', (_e, url) => {
    Menu.buildFromTemplate([
      { label: 'In neuem Tab öffnen', click: () => createTab(url) },
      { label: 'Adresse kopieren', click: () => clipboard.writeText(url) },
      { type: 'separator' },
      { label: 'Lesezeichen entfernen', click: () => { bookmarks = bookmarks.filter((b) => b.url !== url); saveBookmarks(); send('bookmarks', bookmarks); } },
    ]).popup({ window: win });
  });
  ipcMain.on('main-menu', () => {
    const v = process.versions;
    Menu.buildFromTemplate([
      { label: 'Neuer Tab        Strg+T', click: () => createTab() },
      { label: 'Lesezeichen setzen  Strg+D', click: () => toggleBookmark() },
      { label: 'Downloads-Ordner öffnen', click: () => shell.openPath(app.getPath('downloads')) },
      { type: 'separator' },
      { label: 'Nach Updates suchen', click: () => (updater ? updater.checkForUpdates().catch(() => {}) : setupUpdates()) },
      { label: `Netrunner ${app.getVersion()}  ·  Chromium ${v.chrome}  ·  Electron ${v.electron}`, enabled: false },
      { type: 'separator' },
      { label: 'Entwicklertools (F12)', click: () => active()?.view.webContents.toggleDevTools() },
      { label: 'Beenden', click: () => app.quit() },
    ]).popup({ window: win });
  });
}

// ───────────── Start ─────────────
app.whenReady().then(async () => {
  loadBookmarks();
  // interne Seiten: netrunner://newtab -> src/newtab.html
  protocol.handle('netrunner', (req) => {
    const u = new URL(req.url);
    if (u.pathname === '/bookmarks.json') {
      return new Response(JSON.stringify(bookmarks), { headers: { 'content-type': 'application/json' } });
    }
    const file = u.pathname === '/' || u.pathname === '' ? 'newtab.html' : u.pathname.replace(/^\//, '');
    const safe = path.normalize(path.join(__dirname, file));
    if (!safe.startsWith(__dirname + path.sep)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(safe).toString());
  });

  Menu.setApplicationMenu(null);
  win = new BaseWindow({
    width: 1280, height: 800, minWidth: 520, minHeight: 360,
    frame: false, backgroundColor: '#07020A', title: 'Cyberdeck Netrunner',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
  });
  ui = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  ui.setBackgroundColor('#07020A');
  win.contentView.addChildView(ui);
  ui.webContents.loadFile(path.join(__dirname, 'ui.html'));
  ui.webContents.on('before-input-event', (e, input) => { if (handleShortcut(input)) e.preventDefault(); });
  win.on('resize', layout);
  win.on('closed', () => app.quit());
  setupIpc();
  setupDownloads(session.defaultSession);
  setupAdblock(session.defaultSession);

  const first = createTab(TEST.startsWith('url=') ? TEST.slice(4) : NEWTAB);
  if (TEST === 'tabs') { createTab('https://example.com', false); createTab(NEWTAB, false); activateTab(first.id); }
  layout();
  // Test-Hook: Screenshots der Oberflaeche + des aktiven Tabs, dann beenden (stoert keinen Desktop)
  const shot = process.env.NETRUNNER_SHOT;
  if (shot) {
    win.setContentSize(1280, 760);
    layout();
    setTimeout(async () => {
      if (process.env.NETRUNNER_ACTIVATE) activateTab(+process.env.NETRUNNER_ACTIVATE);
      await new Promise((r) => setTimeout(r, 1500));
      fs.writeFileSync(shot + '-ui.png', (await ui.webContents.capturePage()).toPNG());
      fs.writeFileSync(shot + '-tab.png', (await active().view.webContents.capturePage()).toPNG());
      fs.writeFileSync(shot + '-info.json', JSON.stringify({ blocked, tabs: tabs.map((t) => ({ title: t.title, url: t.url })) }));
      app.quit();
    }, +(process.env.NETRUNNER_WAIT || 8000));
  }
});

app.on('window-all-closed', () => app.quit());
// unsichere Navigationen der Oberflaeche verhindern
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-attach-webview', (e) => e.preventDefault());
});
module.exports = { toUrl };
