// Cyberdeck Netrunner – Chromium-Browser im Cyberpunk-Stil (Electron)
// Hauptprozess: Fenster, Tabs (WebContentsView), Downloads, Lesezeichen, Adblock, Updates.
'use strict';
const {
  app, BaseWindow, WebContentsView, ipcMain, session, Menu, MenuItem, shell, protocol, net, clipboard, dialog,
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
if (process.env.NETRUNNER_PROFILE) app.setPath('userData', process.env.NETRUNNER_PROFILE); // Test-Profil
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
let cookiesRejected = 0;
const cookieSeen = new Set(); // pro Tab+Seite nur einmal zaehlen
let extensions = null; // electron-chrome-extensions
const extDir = () => path.join(dataDir(), 'Extensions');
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

// ───────────── Einstellungen ─────────────
const setFile = () => path.join(dataDir(), 'settings.json');
let settings = { cookieBlock: true };
function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(setFile(), 'utf8')) }; } catch { /* Standard */ }
}
function saveSettings() {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(setFile(), JSON.stringify(settings, null, 2));
}

// ───────────── Selbstsignierte Zertifikate (z. B. FortiGate, Router, Lab-Server) ─────────────
// Wie in Chrome: Warnseite mit Details, Weiter nur nach Klick. Die Ausnahme gilt nur fuer
// genau diesen Host:Port UND genau dieses Zertifikat (Fingerabdruck). Aendert sich das
// Zertifikat, kommt die Warnung wieder.
const certFile = () => path.join(dataDir(), 'cert-exceptions.json');
let certSaved = {};            // dauerhaft: host -> { fp, subject, issuer, added }
const certSession = {};        // nur bis zum Beenden
const certPending = new Map(); // `${wcId}|${host}` -> Details des abgelehnten Zertifikats
function loadCertExceptions() {
  try { certSaved = JSON.parse(fs.readFileSync(certFile(), 'utf8')) || {}; } catch { certSaved = {}; }
}
function saveCertExceptions() {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(certFile(), JSON.stringify(certSaved, null, 2));
}
const hostOf = (u) => { try { const x = new URL(u); return x.protocol === 'https:' ? x.host : ''; } catch { return ''; } };
const certException = (host) => certSession[host] || certSaved[host] || null;
const certAllowed = (host, fp) => !!host && certException(host)?.fp === fp;

function setupCertificates() {
  loadCertExceptions();
  app.on('certificate-error', (event, wc, url, error, cert, callback) => {
    const host = hostOf(url);
    if (certAllowed(host, cert.fingerprint)) { event.preventDefault(); callback(true); return; }
    certPending.set(`${wc.id}|${host}`, {
      url, host, error, fp: cert.fingerprint,
      subject: cert.subjectName || cert.subject?.commonName || '',
      issuer: cert.issuerName || cert.issuer?.commonName || '',
      validStart: cert.validStart, validExpiry: cert.validExpiry,
    });
    callback(false); // Standard: ablehnen -> Warnseite (did-fail-load)
  });
  // Klick auf "Trotzdem fortfahren" auf der internen Warnseite
  ipcMain.on('cert-proceed', (e, d) => {
    const wc = e.sender;
    if (!tabs.some((t) => t.view.webContents === wc) || !isNewtab(wc.getURL())) return; // nur von der internen Seite
    const host = hostOf(d?.url);
    const p = certPending.get(`${wc.id}|${host}`);
    if (!p || p.fp !== d.fp) return; // nur das Zertifikat, das wirklich angezeigt wurde
    const entry = { fp: p.fp, subject: p.subject, issuer: p.issuer, added: new Date().toISOString() };
    if (d.remember) { certSaved[host] = entry; saveCertExceptions(); } else certSession[host] = entry;
    certPending.delete(`${wc.id}|${host}`);
    wc.loadURL(p.url);
  });
  ipcMain.on('cert-back', (e) => {
    const wc = e.sender;
    if (!tabs.some((t) => t.view.webContents === wc)) return;
    // zur letzten Seite VOR dem Versuch (Warnseite und den abgelehnten Host ueberspringen)
    const h = wc.navigationHistory;
    let bad = '';
    try { bad = new URLSearchParams(new URL(wc.getURL()).hash.slice(1)).get('host') || ''; } catch { /* egal */ }
    const entries = h.getAllEntries();
    let i = h.getActiveIndex() - 1;
    while (i >= 0 && ((isNewtab(entries[i].url) && entries[i].url.includes('#cert=')) || (bad && hostOf(entries[i].url) === bad))) i--;
    if (i >= 0) h.goToIndex(i); else wc.loadURL(NEWTAB);
  });
}
function forgetCertException(host) {
  delete certSession[host];
  if (certSaved[host]) { delete certSaved[host]; saveCertExceptions(); }
  pushTabs();
}

// ───────────── Import aus Firefox (Lesezeichen + Cookies) ─────────────
// Liest eine KOPIE der Firefox-Datenbanken (geht auch, waehrend Firefox laeuft).
// Passwoerter werden bewusst NICHT angefasst (dafuer gibt es Passwortmanager-Erweiterungen).
function firefoxProfiles() {
  const os = require('node:os');
  const roots = process.platform === 'win32'
    ? [path.join(process.env.APPDATA || '', 'Mozilla', 'Firefox')]
    : [path.join(os.homedir(), '.config', 'mozilla', 'firefox'), path.join(os.homedir(), '.mozilla', 'firefox'),
       path.join(os.homedir(), 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
       path.join(os.homedir(), '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox')];
  const found = [];
  for (const root of roots) {
    let ini;
    try { ini = fs.readFileSync(path.join(root, 'profiles.ini'), 'utf8'); } catch { continue; }
    const secs = []; let cur = null;
    for (const line of ini.split(/\r?\n/)) {
      const m = line.match(/^\[(.+)\]$/);
      if (m) { cur = { section: m[1] }; secs.push(cur); continue; }
      const kv = line.match(/^([^=]+)=(.*)$/);
      if (kv && cur) cur[kv[1].trim()] = kv[2].trim();
    }
    const installDefault = secs.find((x) => x.section.startsWith('Install') && x.Default)?.Default;
    for (const x of secs.filter((y) => y.Path)) {
      const dir = x.IsRelative === '0' ? x.Path : path.join(root, x.Path);
      if (!fs.existsSync(path.join(dir, 'places.sqlite'))) continue;
      found.push({ name: x.Name || x.Path, dir, preferred: x.Path === installDefault || x.Default === '1' });
    }
  }
  return found.sort((a, b) => (b.preferred - a.preferred) || (fs.statSync(path.join(b.dir, 'places.sqlite')).mtimeMs - fs.statSync(path.join(a.dir, 'places.sqlite')).mtimeMs));
}
function copyDb(dir, name, tmp) {
  const src = path.join(dir, name);
  if (!fs.existsSync(src)) return null;
  for (const ext of ['', '-wal']) if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, path.join(tmp, name + ext));
  return path.join(tmp, name);
}
async function importFirefox(opts = {}) {
  const profiles = firefoxProfiles();
  if (!profiles.length) {
    if (!opts.silent) dialog.showMessageBox(win, { type: 'info', title: 'Firefox-Import', message: 'Kein Firefox-Profil gefunden.' });
    return null;
  }
  const prof = profiles[0];
  if (!opts.silent) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', title: 'Firefox-Import',
      message: 'Lesezeichen und Cookies aus Firefox übernehmen?',
      detail: `Profil: ${prof.name}\n${prof.dir}\n\nCookies = du bleibst auf Webseiten angemeldet. Passwörter werden nicht übernommen.`,
      buttons: ['Importieren', 'Abbrechen'], defaultId: 0, cancelId: 1,
    });
    if (response !== 0) return null;
  }
  const { DatabaseSync } = require('node:sqlite');
  const tmp = fs.mkdtempSync(path.join(app.getPath('temp'), 'netrunner-ff-'));
  const res = { profile: prof.dir, bookmarks: 0, cookies: 0, cookieErrors: 0 };
  try {
    // Lesezeichen: erst Symbolleiste, dann Menue/Sonstige; Mozilla-Standardlinks weglassen
    const places = copyDb(prof.dir, 'places.sqlite', tmp);
    const db = new DatabaseSync(places, { readOnly: true });
    const rows = db.prepare(`WITH RECURSIVE t(id, root) AS (
        SELECT id, guid FROM moz_bookmarks WHERE guid IN ('toolbar_____','menu________','unfiled_____','mobile______')
        UNION ALL SELECT b.id, t.root FROM moz_bookmarks b JOIN t ON b.parent = t.id)
      SELECT b.title AS title, p.url AS url, t.root AS root FROM t
        JOIN moz_bookmarks b ON b.id = t.id JOIN moz_places p ON p.id = b.fk
      WHERE b.type = 1 AND p.url LIKE 'http%'
      ORDER BY CASE t.root WHEN 'toolbar_____' THEN 0 ELSE 1 END, b.position`).all();
    db.close();
    for (const r of rows) {
      if (/^https?:\/\/(support\.mozilla\.org|www\.mozilla\.org)\//.test(r.url)) continue;
      if (bookmarks.some((b) => b.url === r.url)) continue;
      bookmarks.push({ title: (r.title || new URL(r.url).hostname).slice(0, 40), url: r.url });
      res.bookmarks++;
    }
    saveBookmarks(); send('bookmarks', bookmarks);
    // Cookies (ohne Container/partitionierte Cookies, ohne abgelaufene)
    const cpath = copyDb(prof.dir, 'cookies.sqlite', tmp);
    if (cpath) {
      const cdb = new DatabaseSync(cpath, { readOnly: true });
      const cookies = cdb.prepare("SELECT name, value, host, path, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies WHERE originAttributes = ''").all();
      cdb.close();
      const now = Date.now() / 1000;
      const ses = session.defaultSession;
      for (const c of cookies) {
        let exp = Number(c.expiry);
        if (exp > 1e11) exp /= 1000; // neuere Firefox-Versionen speichern Millisekunden
        if (exp && exp < now) continue;
        const host = String(c.host).replace(/^\./, '');
        const secure = !!c.isSecure;
        const sameSite = c.sameSite === 2 ? 'strict' : c.sameSite === 1 ? 'lax' : (secure ? 'no_restriction' : 'lax');
        try {
          await ses.cookies.set({
            url: `${secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
            name: c.name, value: c.value, path: c.path || '/',
            ...(String(c.host).startsWith('.') ? { domain: c.host } : {}),
            secure, httpOnly: !!c.isHttpOnly, sameSite, ...(exp ? { expirationDate: exp } : {}),
          });
          res.cookies++;
        } catch { res.cookieErrors++; }
      }
      await ses.cookies.flushStore();
    }
  } catch (err) {
    res.error = String(err.message || err);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (!opts.silent) {
    dialog.showMessageBox(win, {
      type: res.error ? 'error' : 'info', title: 'Firefox-Import',
      message: res.error ? 'Import fehlgeschlagen' : 'Import abgeschlossen',
      detail: res.error || `${res.bookmarks} Lesezeichen übernommen\n${res.cookies} Cookies übernommen${res.cookieErrors ? ` (${res.cookieErrors} übersprungen)` : ''}\n\nOffene Tabs neu laden, damit die Anmeldungen greifen.`,
    });
  }
  return res;
}

// ───────────── Cookie-Banner automatisch ablehnen (DuckDuckGo Autoconsent) ─────────────
let acScript = null;
let acRules = null;
let ac = null;
function setupAutoconsent() {
  ac = require('@duckduckgo/autoconsent');
  const dir = path.join(path.dirname(require.resolve('@duckduckgo/autoconsent')), '..');
  acScript = fs.readFileSync(path.join(dir, 'dist', 'autoconsent.playwright.js'), 'utf8');
  acRules = JSON.parse(fs.readFileSync(path.join(dir, 'rules', 'compact-rules.json'), 'utf8'));
  ipcMain.handle('ac-script', () => (settings.cookieBlock ? acScript : null));
  ipcMain.on('ac-msg', async (e, msg) => {
    const frame = e.senderFrame;
    if (!frame || !msg || typeof msg !== 'object') return;
    const reply = (m) => { try { frame.send('ac-reply', m); } catch { /* Frame weg */ } };
    switch (msg.type) {
      case 'init': {
        const isMain = frame === e.sender.mainFrame;
        reply({
          type: 'initResp',
          rules: { autoconsent: [], compact: ac.filterCompactRules(acRules, { url: msg.url, mainFrame: isMain }) },
          config: {
            enabled: settings.cookieBlock, autoAction: 'optOut', disabledCmps: [],
            enablePrehide: true, enableCosmeticRules: true, enableGeneratedRules: true,
            enableHeuristicDetection: true, enablePopupMutationObserver: true, heuristicMode: 'tier1',
            detectRetries: 20, isMainWorld: false, prehideTimeout: 2000, visualTest: false,
            logs: { lifecycle: false, rulesteps: false, detectionsteps: false, evals: false, errors: false, messages: false, waits: false },
            performanceLoggingEnabled: false, heuristicPopupSearchTimeout: 100,
          },
        });
        break;
      }
      case 'eval': {
        // Regel-Schnipsel im Haupt-Kontext der Seite auswerten (nur bekannte Snippets der Engine)
        const fn = ac.evalSnippets[msg.snippetId];
        let result = false;
        if (fn) { try { result = await frame.executeJavaScript(`(${fn.toString()})()`); } catch { result = false; } }
        reply({ type: 'evalResp', id: msg.id, result });
        break;
      }
      case 'autoconsentDone':
        if (!cookieSeen.has(`${e.sender.id}|${msg.url}`)) {
          cookieSeen.add(`${e.sender.id}|${msg.url}`);
          cookiesRejected++;
          send('cookies', cookiesRejected);
        }
        if (process.env.NETRUNNER_SHOT) console.log('autoconsent:', msg.cmp, msg.url, 'cosmetic=' + msg.isCosmetic, 'clicks=' + msg.totalClicks);
        break;
      default:
        break;
    }
  });
}

// ───────────── Chrome-Erweiterungen ─────────────
async function setupExtensions(ses) {
  try {
    const { ElectronChromeExtensions } = require('electron-chrome-extensions');
    ElectronChromeExtensions.handleCRXProtocol(ses); // Symbole der Erweiterungen (crx://)
    extensions = new ElectronChromeExtensions({
      license: 'GPL-3.0',
      session: ses,
      createTab: async (details) => {
        const t = createTab(details.url ? toUrl(details.url) : NEWTAB, details.active !== false);
        return [t.view.webContents, win];
      },
      selectTab: (wc) => { const t = tabs.find((x) => x.view.webContents === wc); if (t) activateTab(t.id); },
      removeTab: (wc) => { const t = tabs.find((x) => x.view.webContents === wc); if (t) closeTab(t.id); },
      createWindow: async (details) => {
        const url = Array.isArray(details.url) ? details.url[0] : details.url;
        createTab(url ? toUrl(url) : NEWTAB, true);
        return win;
      },
    });
    const { installChromeWebStore } = require('electron-chrome-web-store');
    await installChromeWebStore({
      session: ses, extensionsPath: extDir(), autoUpdate: true,
      // vor jeder Installation nachfragen und die Berechtigungen anzeigen
      beforeInstall: async ({ localizedName, manifest, icon }) => {
        const perms = [...(manifest.permissions || []), ...(manifest.host_permissions || [])];
        const { response } = await dialog.showMessageBox(win, {
          type: 'question', icon, title: 'Erweiterung hinzufügen',
          message: `„${localizedName}“ hinzufügen?`,
          detail: perms.length ? `Berechtigungen:\n• ${perms.slice(0, 14).join('\n• ')}${perms.length > 14 ? '\n• …' : ''}` : 'Keine besonderen Berechtigungen.',
          buttons: ['Hinzufügen', 'Abbrechen'], defaultId: 0, cancelId: 1,
        });
        return { action: response === 0 ? 'allow' : 'deny' };
      },
    });
    for (const t of tabs) extensions.addTab(t.view.webContents, win);
    if (active()) extensions.selectTab(active().view.webContents);
    if (process.env.NETRUNNER_EXT) { // Test-Hook: Erweiterung aus dem Web Store installieren
      const { installExtension } = require('electron-chrome-web-store');
      await installExtension(process.env.NETRUNNER_EXT, { session: ses, extensionsPath: extDir() });
    }
    sendExtensions();
    ses.extensions.on('extension-loaded', sendExtensions);
    ses.extensions.on('extension-unloaded', sendExtensions);
  } catch (err) {
    console.error('extensions:', err);
  }
}
function extList() {
  return session.defaultSession.extensions.getAllExtensions().map((e) => ({ id: e.id, name: e.name, version: e.version }));
}
function sendExtensions() { send('extensions', extList()); }

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
      certWarn: !!certException(hostOf(t.url)),
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
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(__dirname, 'tab-preload.js'),
      nodeIntegrationInSubFrames: true, // nur damit Preloads (Cookie-Blocker) auch in iframes laufen
    },
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
    if (!isMain || code === -3) return;
    t.loading = false;
    const p = code <= -200 && code > -300 ? certPending.get(`${wc.id}|${hostOf(u)}`) : null;
    if (p) { // Zertifikatsfehler (-2xx): Warnseite mit Details
      const q = new URLSearchParams({
        cert: desc, url: p.url, host: p.host, fp: p.fp, subject: p.subject, issuer: p.issuer,
        from: p.validStart ? new Date(p.validStart * 1000).toLocaleDateString('de-AT') : '',
        to: p.validExpiry ? new Date(p.validExpiry * 1000).toLocaleDateString('de-AT') : '',
      });
      wc.loadURL(`${NEWTAB}#${q}`);
      return;
    }
    wc.loadURL(`${NEWTAB}#error=${encodeURIComponent(desc)}&url=${encodeURIComponent(u)}`);
  });
  // Links mit target=_blank / window.open -> neuer Tab
  wc.setWindowOpenHandler(({ url: u }) => { createTab(u, true); return { action: 'deny' }; });
  wc.on('before-input-event', (e, input) => { if (handleShortcut(input)) e.preventDefault(); });
  wc.on('context-menu', (_e, p) => contextMenu(wc, p));

  if (extensions) extensions.addTab(wc, win);
  wc.loadURL(url);
  if (activate) activateTab(t.id); else layout();
  pushTabs();
  return t;
}

function activateTab(id) {
  if (!tab(id)) return;
  activeId = id;
  layout();
  if (extensions) extensions.selectTab(tab(id).view.webContents);
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
  const extItems = extensions ? extensions.getContextMenuItems(wc, p) : [];
  if (extItems.length) items.push(...extItems, { type: 'separator' });
  items.push(
    { label: 'Zurück', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
    { label: 'Neu laden', click: () => wc.reload() },
    { type: 'separator' },
    { label: 'Untersuchen (F12)', click: () => wc.inspectElement(p.x, p.y) },
  );
  const m = new Menu();
  for (const it of items) m.append(it instanceof MenuItem ? it : new MenuItem(it));
  m.popup({ window: win });
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
    const cache = path.join(dataDir(), 'adblock-full.bin');
    const blocker = await ElectronBlocker.fromPrebuiltFull(fetch, // Werbung + Tracker + Cookie-Hinweise (EasyList Cookie, uBO Annoyances)
      {
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
    send('cookies', cookiesRejected);
    send('cookie-mode', settings.cookieBlock);
    if (extensions) sendExtensions();
  });
  ipcMain.handle('get-bookmarks', () => bookmarks);
  ipcMain.on('bookmark-overflow', (_e, urls, x, y) => {
    const list = (Array.isArray(urls) ? urls : []).map((u) => bookmarks.find((b) => b.url === u)).filter(Boolean);
    if (!list.length) return;
    Menu.buildFromTemplate(list.map((b) => ({
      label: b.title.length > 60 ? b.title.slice(0, 58) + '…' : b.title,
      // Klick oeffnet im aktuellen Tab, mit Strg in einem neuen Tab
      click: (_mi, _w, ev) => (ev?.ctrlKey ? createTab(b.url) : active()?.view.webContents.loadURL(b.url)),
    }))).popup({ window: win, x: Number(x) || undefined, y: Number(y) || undefined });
  });
  ipcMain.on('bookmark-menu', (_e, url) => {
    Menu.buildFromTemplate([
      { label: 'In neuem Tab öffnen', click: () => createTab(url) },
      { label: 'Adresse kopieren', click: () => clipboard.writeText(url) },
      { type: 'separator' },
      { label: 'Lesezeichen entfernen', click: () => { bookmarks = bookmarks.filter((b) => b.url !== url); saveBookmarks(); send('bookmarks', bookmarks); } },
    ]).popup({ window: win });
  });
  const extMenu = () => {
    const list = extList();
    return [
      { label: 'Chrome Web Store öffnen', click: () => createTab('https://chromewebstore.google.com/') },
      { type: 'separator' },
      ...(list.length ? list.map((e) => ({
        label: `${e.name}  ${e.version}`,
        submenu: [
          { label: 'Entfernen', click: async () => {
            const { uninstallExtension } = require('electron-chrome-web-store');
            await uninstallExtension(e.id, { session: session.defaultSession, extensionsPath: extDir() });
            sendExtensions();
          } },
        ],
      })) : [{ label: '(noch keine installiert)', enabled: false }]),
    ];
  };
  const certMenu = () => {
    const all = { ...certSaved, ...certSession };
    const hosts = Object.keys(all);
    if (!hosts.length) return [{ label: '(keine – Warnung kommt bei unsicheren Zertifikaten)', enabled: false }];
    return hosts.map((h) => ({
      label: `${h}${certSession[h] ? '  (nur diese Sitzung)' : ''}`,
      submenu: [
        { label: `Zertifikat: ${all[h].subject || '?'}`, enabled: false },
        { label: 'Ausnahme entfernen (wirkt nach Neustart)', click: () => forgetCertException(h) },
      ],
    }));
  };
  ipcMain.on('main-menu', () => {
    const v = process.versions;
    Menu.buildFromTemplate([
      { label: 'Neuer Tab        Strg+T', click: () => createTab() },
      { label: 'Lesezeichen setzen  Strg+D', click: () => toggleBookmark() },
      { label: 'Downloads-Ordner öffnen', click: () => shell.openPath(app.getPath('downloads')) },
      { label: 'Von Firefox importieren …', click: () => importFirefox() },
      { type: 'separator' },
      { label: 'Cookie-Banner automatisch ablehnen', type: 'checkbox', checked: settings.cookieBlock,
        click: (mi) => { settings.cookieBlock = mi.checked; saveSettings(); send('cookie-mode', settings.cookieBlock); } },
      { label: 'Erweiterungen', submenu: extMenu() },
      { label: 'Zertifikat-Ausnahmen', submenu: certMenu() },
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
  loadSettings();
  setupAutoconsent();
  setupCertificates();
  // Electron-Kennung aus dem User-Agent entfernen (Chrome Web Store, Google-Login)
  const ses = session.defaultSession;
  ses.setUserAgent(ses.getUserAgent().replace(/ (Electron|cyberdeck-netrunner|Cyberdeck Netrunner)\/\S+/g, ''));
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
    // sandbox aus: die Oberflaeche ist eine lokale Datei und braucht das Erweiterungs-Modul im Preload
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  ui.webContents.on('will-navigate', (e) => e.preventDefault());
  ui.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  ui.setBackgroundColor('#07020A');
  win.contentView.addChildView(ui);
  ui.webContents.loadFile(path.join(__dirname, 'ui.html'));
  if (process.env.NETRUNNER_SHOT) ui.webContents.on('console-message', (ev) => console.log('UI-CONSOLE', ev.level, ev.message));
  ui.webContents.on('before-input-event', (e, input) => { if (handleShortcut(input)) e.preventDefault(); });
  win.on('resize', layout);
  win.on('closed', () => app.quit());
  setupIpc();
  setupDownloads(session.defaultSession);
  setupAdblock(session.defaultSession);
  await setupExtensions(session.defaultSession);

  const first = createTab(TEST.startsWith('url=') ? TEST.slice(4) : NEWTAB);
  if (TEST === 'tabs') { createTab('https://example.com', false); createTab(NEWTAB, false); activateTab(first.id); }
  layout();
  if (process.env.NETRUNNER_CLICKEXT) { // Test-Hook: erstes Erweiterungs-Symbol anklicken
    setTimeout(() => ui.webContents.executeJavaScript("document.querySelector('browser-action-list').shadowRoot.querySelector('.action')?.dispatchEvent(new MouseEvent('click', {bubbles: true}))").catch(() => {}), 7000);
  }
  if (process.env.NETRUNNER_IMPORTFF) { // Test-Hook: Firefox-Import ohne Dialoge
    const r = await importFirefox({ silent: true });
    console.log('IMPORTFF', JSON.stringify(r));
    const n = (await session.defaultSession.cookies.get({})).length;
    console.log('COOKIES-IN-SESSION', n);
  }
  if (process.env.NETRUNNER_UIEVAL) { // Test-Hook: Ausdruck in der Oberflaeche auswerten
    setTimeout(() => ui.webContents.executeJavaScript(process.env.NETRUNNER_UIEVAL).then((r) => console.log('UIEVAL', JSON.stringify(r))).catch((e) => console.log('UIEVAL-ERR', e.message)), 3000);
  }
  if (process.env.NETRUNNER_THEN) setTimeout(() => active()?.view.webContents.loadURL(process.env.NETRUNNER_THEN), 4000); // Test-Hook
  if (process.env.NETRUNNER_CERTGO) { // Test-Hook: Knopf auf der Zertifikats-Warnseite (once|remember|back)
    const c = process.env.NETRUNNER_CERTGO;
    setTimeout(() => active()?.view.webContents.executeJavaScript(c === 'back' ? "document.getElementById('certback').click()"
      : `document.getElementById('remember').checked = ${c === 'remember'}; document.getElementById('certgo').click()`).catch((e) => console.log('certgo', e.message)),
    process.env.NETRUNNER_THEN ? 7000 : 3500);
  }
  if (process.env.NETRUNNER_CLICKADD) { // Test-Hook: im Web Store auf "Hinzufuegen" klicken
    setTimeout(() => active()?.view.webContents.executeJavaScript("[...document.querySelectorAll('button')].find(b => /Hinzuf|Add to/.test(b.textContent))?.click()", true).catch(() => {}), 10000);
  }
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
      fs.writeFileSync(shot + '-info.json', JSON.stringify({ blocked, cookiesRejected, extensions: extensions ? extList() : null, tabs: tabs.map((t) => ({ title: t.title, url: t.url })) }));
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
